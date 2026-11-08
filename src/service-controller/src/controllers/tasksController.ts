import type { Response } from "express";
import Task from "../models/Task";
import Outbox from "../models/Outbox";
import {
  submitOperation,
  requiresReference,
} from "../services/operations/submit";
import { isKnownAction, preValidate } from "../lib/schemas/task";
import { ERR, send } from "../lib/errors/http-errors";
import { isHttpErrorPayload } from "../services/resourceLocks";
import logger from "../lib/logger";
import type { ControllerRequest } from "../types/express";
import { respondEnvelope } from "../middlewares/addEnveloppe";
type Handler = (
  req: ControllerRequest,
  res: Response,
) => Promise<Response | void>;
const log = logger.child(["controller", "tasks"]);

const getTenantIdFromReq = (req: ControllerRequest): string | null => {
  return (
    req?.tenant?.tenantId ||
    req?.tenantId ||
    (req.body?.tenantId as string | undefined) ||
    (req.query?.tenantId as string | undefined) ||
    null
  );
};

const getTenantIdFromJWT = (req: ControllerRequest) =>
  req?.tenant?.tenantId || req?.tenantId || null;
const normalizeTenantId = (id: string | null | undefined) =>
  typeof id === "string" ? id.trim().toLowerCase() || null : null;

export const enqueueTask: Handler = async (req, res) => {
  let idemKey = "";
  let action: string | undefined;
  let tenantId: string | null | undefined;
  let targetSnapshot: Record<string, unknown> | null = null;
  let dataSnapshot: Record<string, unknown> | null = null;
  try {
    // Parse + validate request ------------------------------------------------
    const admin = !!req.isAdmin;
    const body = (req.body || {}) as Record<string, unknown>;

    action = String(body.action || "").trim();
    if (!action) return send(res, ERR.missingAction(), req);

    const target = (
      body.target && typeof body.target === "object" ? body.target : null
    ) as Record<string, unknown> | null;
    if (!target?.kind) return send(res, ERR.missingTargetKind(), req);
    const targetKind = String(target.kind).toLowerCase();
    const knownKinds = new Set(["vm", "storage", "network"]);
    if (!knownKinds.has(targetKind))
      return send(res, ERR.missingTargetKind(), req);
    for (const field of ["agentId", "refId"]) {
      if (
        target[field] !== undefined &&
        (typeof target[field] !== "string" ||
          !(target[field] as string).trim() ||
          (target[field] as string).length > 200)
      )
        return send(
          res,
          ERR.validationPre([
            {
              path: `target.${field}`,
              message: "must be a non-empty string of at most 200 characters",
            },
          ]),
          req,
        );
    }
    target.kind = targetKind;
    targetSnapshot = target as Record<string, unknown>;

    if (!isKnownAction(action))
      return send(res, ERR.unknownAction(action), req);

    const needsRefId = requiresReference(action);
    if (needsRefId && !target.refId) {
      return send(res, ERR.missingTargetRefId(action), req);
    }

    const pre = preValidate(action, body.data || {});
    if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);
    const userData = pre.value as Record<string, unknown>;
    dataSnapshot = userData;

    tenantId = normalizeTenantId(
      admin
        ? (body.tenantId as string) || getTenantIdFromReq(req)
        : getTenantIdFromJWT(req),
    );
    if (!tenantId) {
      return send(
        res,
        admin ? ERR.tenantIdRequiredForAdmin() : ERR.tenantContextMissing(),
        req,
      );
    }

    idemKey = req.get("Idempotency-Key") || "";
    if (!idemKey || idemKey.length > 200)
      return res
        .status(400)
        .json({ error: "Idempotency-Key required (1..200 characters)" });
    const actor = req.get("x-user-id");
    if (!actor)
      return res.status(401).json({ error: "Missing authenticated actor" });
    const resp = await submitOperation({
      actorId: actor,
      tenantId,
      admin,
      key: idemKey,
      action,
      target: target as Record<string, unknown> & { kind: string },
      data: userData,
      user: req.user,
    });
    return respondEnvelope(res.status(202), req, "Tasks", resp);
  } catch (error) {
    if (isHttpErrorPayload(error)) return send(res, error, req);
    const err = error as Error;
    log.error("enqueueTask error", {
      error: err?.message || err,
      stack: err?.stack,
      action,
      tenantId,
      admin: !!req.isAdmin,
      target: targetSnapshot,
      dataKeys: dataSnapshot ? Object.keys(dataSnapshot) : null,
    });
    return send(res, ERR.internal(), req);
  }
};

export const getTask: Handler = async (req, res) => {
  try {
    const admin = !!req.isAdmin;
    const { taskId } = req.params;

    if (admin) {
      const doc = await Task.findOne({ taskId }).lean();
      if (!doc) return send(res, ERR.taskNotFound(), req);
      const delivery = await Outbox.findOne(
        { operationId: taskId },
        { _id: 0, state: 1, attempts: 1, availableAt: 1, deliveredAt: 1 },
      ).lean();
      return respondEnvelope(res, req, "Tasks", {
        success: true,
        data: { ...doc, delivery },
      });
    }

    const tenantId = normalizeTenantId(getTenantIdFromJWT(req));
    if (!tenantId) return send(res, ERR.tenantContextMissing(), req);

    const doc = await Task.findOne(
      { taskId, tenantId },
      {
        _id: 0,
        taskId: 1,
        action: 1,
        status: 1,
        outcome: 1,
        lastAgentSequence: 1,
        queuedAt: 1,
        publishedAt: 1,
        finishedAt: 1,
        error: 1,
        "result.vm.guid": 1,
        "result.vm.name": 1,
        "result.disk.refId": 1,
        "result.disk.name": 1,
        "result.switch.name": 1,
      },
    ).lean();
    if (!doc) return send(res, ERR.taskNotFound(), req);

    const delivery = await Outbox.findOne(
      { operationId: taskId },
      { _id: 0, state: 1 },
    ).lean();
    return respondEnvelope(res, req, "Tasks", {
      success: true,
      data: { ...doc, delivery },
    });
  } catch (error) {
    log.error("getTask error", { error });
    return send(res, ERR.internal(), req);
  }
};
