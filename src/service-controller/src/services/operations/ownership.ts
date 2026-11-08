import Tenant from "../../models/Tenant";
import TenantResource from "../../models/TenantResource";
import Task from "../../models/Task";
import QuotaHold from "../../models/quota/hold";
import ResourceLock from "../../models/ResourceLock";
import { ERR, make } from "../../lib/errors/http-errors";
import { transaction } from "./transaction";

// A tenant write fence serializes admission with disabling/removal/ownership edits.
export async function fenceTenant(tenantId: string, admin = true) {
  const tenant = await Tenant.findOneAndUpdate(
    { tenantId, ...(!admin ? { status: "active" } : {}) },
    { $inc: { __v: 1 } },
    { new: true },
  ).lean();
  if (!tenant) throw ERR.notFound("Tenant missing or disabled");
  return tenant;
}
export async function releaseResourceOwnership(
  tenantId: string,
  kind: string,
  agentId: string,
  refId: string,
) {
  return transaction(async () => {
    await fenceTenant(tenantId);
    if (
      await ResourceLock.exists({
        resourceKind: kind,
        refId: `${agentId}:${refId}`,
      })
    )
      throw ERR.resourceLocked(kind, refId);
    await TenantResource.deleteOne({ tenantId, kind, agentId, refId });
  });
}
export async function deleteTenant(tenantId: string) {
  return transaction(async () => {
    const tenant = await fenceTenant(tenantId);
    if (
      (await Task.exists({
        tenantId,
        status: { $in: ["queued", "sent", "reconciling"] },
      })) ||
      (await QuotaHold.exists({
        tenantId: tenant._id,
        status: { $in: ["held", "releasing"] },
      }))
    )
      throw make(
        409,
        "TENANT_HAS_OPERATIONS",
        "Tenant has unresolved operations",
      );
    const count = await TenantResource.countDocuments({ tenantId });
    if (count)
      throw make(
        409,
        "TENANT_HAS_RESOURCES",
        "Tenant has resources; unassign first",
        { count },
      );
    await Tenant.deleteOne({ _id: tenant._id });
  });
}

export async function claimResourceOwnership(
  tenantId: string,
  kind: string,
  agentId: string,
  refId: string,
  ha?: boolean,
): Promise<{
  refId: string;
  status: "claimed" | "already_claimed" | "conflict";
  tenantId?: string;
}> {
  try {
    return await transaction(async () => {
      await fenceTenant(tenantId);
      const key = { kind, agentId, refId };
      const existing = await TenantResource.findOne(key).lean();
      if (existing) {
        if (existing.tenantId !== tenantId)
          return { refId, status: "conflict", tenantId: existing.tenantId };
        if (typeof ha === "boolean")
          await TenantResource.updateOne(
            { ...key, tenantId },
            { $set: { ha } },
          );
        return { refId, status: "already_claimed" };
      }
      await TenantResource.create({
        ...key,
        tenantId,
        assignedAt: new Date(),
        ...(typeof ha === "boolean" ? { ha } : {}),
      });
      return { refId, status: "claimed" };
    });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    const winner = await TenantResource.findOne({
      kind,
      agentId,
      refId,
    }).lean();
    if (!winner) throw error;
    return {
      refId,
      status: winner.tenantId === tenantId ? "already_claimed" : "conflict",
      ...(winner.tenantId !== tenantId ? { tenantId: winner.tenantId } : {}),
    };
  }
}
