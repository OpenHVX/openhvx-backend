import type { Types } from "mongoose";
import Tenant from "../models/Tenant";
import TenantResource from "../models/TenantResource";
import QuotaHold from "../models/quota/hold";
import type { QuotaDeltas, QuotaKey, QuotaLimits, Quotas } from "../types/domain";
import { ERR } from "../lib/errors/http-errors";
import logger from "../lib/logger";

const log = logger.child("quota");
const logHold = log.child("hold");
const logReaper = log.child("reaper");

const DEFAULTS: Record<QuotaKey, number> = Object.freeze({
    cpu: 0,
    memoryMB: 0,
    storageMB: 0,
    vmCount: 0,
    networkCount: 0,
});

export const DEFAULT_HOLD_TTL_MS = 15 * 60 * 1000;

type TenantIdentifier = Types.ObjectId | string;

const compactDeltas = (deltas: QuotaDeltas | undefined) => {
    if (!deltas || typeof deltas !== "object") return deltas;
    const out: QuotaDeltas = {};
    for (const [key, value] of Object.entries(deltas)) {
        if (value) out[key as QuotaKey] = value | 0;
    }
    return out;
};

const tid = (value: TenantIdentifier) => (typeof value === "string" ? value : String(value));

export const parseSizeToMB = (value: number | string | null | undefined) => {
    if (value == null) return 0;
    if (typeof value === "number" && Number.isFinite(value)) return value | 0;
    if (typeof value !== "string") return 0;
    const normalized = (value as string).trim().toLowerCase();
    const match = normalized.match(/^(\d+(?:\.\d+)?)\s*(k|kb|kib|m|mb|mib|g|gb|gib)?$/i);
    if (!match) return 0;
    const num = parseFloat(match[1]);
    const unit = (match[2] || "mb").toLowerCase();
    const KB = 1 / 1024;
    const MB = 1;
    const GB = 1024;
    switch (unit) {
        case "k":
        case "kb":
        case "kib":
            return Math.round(num * KB);
        case "m":
        case "mb":
        case "mib":
            return Math.round(num * MB);
        case "g":
        case "gb":
        case "gib":
            return Math.round(num * GB);
        default:
            return 0;
    }
};

const sanitizeLimits = (input: QuotaLimits | undefined) => {
    const out: QuotaLimits = {};
    if (!input || typeof input !== "object") return out;
    for (const [key, value] of Object.entries(input)) {
        if (value == null) continue;
        if (!Number.isFinite(value) || ((value as number) | 0) !== value) {
            throw ERR.validationPre([{ path: `quotas.${key}.limit`, message: "must be integer" }]);
        }
        out[key as QuotaKey] = (value as number) | 0;
    }
    return out;
};

const sanitizeDeltas = (input: Record<string, unknown> | undefined) => {
    if (!input || typeof input !== "object") {
        throw ERR.validationPre([{ path: "deltas", message: "must be an object" }]);
    }
    const out: QuotaDeltas = {};
    for (const [key, value] of Object.entries(input)) {
        if (value == null) continue;
        let val: number;
        if (typeof value === "string") {
            if (!/^-?\d+$/.test(value.trim())) {
                throw ERR.validationPre([{ path: `limits.${key}`, message: "must be integer" }]);
            }
            val = Number(value.trim());
        } else if (typeof value === "number") {
            val = value;
        } else {
            continue;
        }
        if (!Number.isFinite(val) || (val | 0) !== val) {
            throw ERR.validationPre([{ path: `limits.${key}`, message: "must be integer" }]);
        }
        out[key as QuotaKey] = val | 0;
    }
    return out;
};

const hydrateWithDefaults = (quotas: Partial<Quotas> = {}) => {
    const keys = new Set<QuotaKey>([...Object.keys(DEFAULTS), ...Object.keys(quotas)] as QuotaKey[]);
    const out = {} as Quotas;
    for (const key of keys) {
        const quota = quotas[key];
        out[key] = {
            limit: Number.isFinite(quota?.limit) ? (quota!.limit | 0) : DEFAULTS[key],
            used: Number.isFinite(quota?.used) ? Math.max(0, quota!.used | 0) : 0,
        };
    }
    return out;
};

export async function getTenantQuotas(tenantId: TenantIdentifier) {
    const tenant = await Tenant.findById(tenantId, { quotas: 1 }).lean();
    if (!tenant) throw ERR.notFound("Tenant not found");
    return hydrateWithDefaults(tenant.quotas);
}

export async function setTenantQuotaLimits(tenantId: TenantIdentifier, partialLimits: QuotaLimits) {
    const limits = sanitizeLimits(partialLimits);
    const $set: Record<string, number> = {};
    for (const [key, value] of Object.entries(limits)) {
        $set[`quotas.${key}.limit`] = value;
    }

    const tenant = await Tenant.findByIdAndUpdate(
        tenantId,
        { $set },
        { new: true, projection: { quotas: 1 }, runValidators: true }
    ).lean();
    if (!tenant) throw ERR.notFound("Tenant not found");

    log.info("limits patched", { tenantId: tid(tenantId), limits: $set });
    return hydrateWithDefaults(tenant.quotas);
}

export async function checkAndReserve(tenantId: TenantIdentifier, deltas: QuotaDeltas) {
    const increments = sanitizeDeltas(deltas);

    const and: Record<string, unknown>[] = [];
    for (const [key, inc] of Object.entries(increments)) {
        if ((inc as number) <= 0) continue;
        and.push({
            $or: [
                { $eq: [`$quotas.${key}.limit`, -1] },
                {
                    $lte: [
                        { $add: [{ $ifNull: [`$quotas.${key}.used`, 0] }, inc] },
                        { $ifNull: [`$quotas.${key}.limit`, 0] },
                    ],
                },
            ],
        });
    }

    const filter: Record<string, unknown> = { _id: tenantId };
    if (and.length) filter.$expr = { $and: and };

    const $inc: Record<string, number> = {};
    for (const [key, value] of Object.entries(increments)) {
        if (value !== 0) $inc[`quotas.${key}.used`] = value as number;
    }

    const updated = await Tenant.findOneAndUpdate(
        filter,
        Object.keys($inc).length ? { $inc } : {},
        { new: true, projection: { quotas: 1 }, runValidators: true }
    ).lean();

    if (!updated) {
        const current = await Tenant.findById(tenantId, { quotas: 1 }).lean();
        if (!current) throw ERR.notFound("Tenant not found");
        const reasons: string[] = [];
        for (const [key, inc] of Object.entries(increments)) {
            if ((inc as number) <= 0) continue;
            const limit = current.quotas?.[key as QuotaKey]?.limit ?? 0;
            const used = current.quotas?.[key as QuotaKey]?.used ?? 0;
            if (limit !== -1 && used + (inc as number) > limit) {
                reasons.push(`${key}: ${used} + ${inc} > ${limit}`);
            }
        }
        log.warn("reserve denied (quota exceeded)", {
            tenantId: tid(tenantId),
            deltas: compactDeltas(increments),
            reasons,
        });
        throw ERR.quotaExceeded(reasons.length ? `Quota exceeded (${reasons.join(", ")})` : "Quota exceeded");
    }

    log.info("reserved", { tenantId: tid(tenantId), deltas: compactDeltas(increments) });
    return hydrateWithDefaults(updated.quotas);
}

export async function release(tenantId: TenantIdentifier, deltas: QuotaDeltas) {
    const increments = sanitizeDeltas(deltas);
    const $inc: Record<string, number> = {};
    for (const [key, value] of Object.entries(increments)) {
        if (value !== 0) $inc[`quotas.${key}.used`] = -Math.abs(value as number);
    }

    const tenant = await Tenant.findByIdAndUpdate(
        tenantId,
        Object.keys($inc).length ? { $inc } : {},
        { new: true, projection: { quotas: 1 }, runValidators: true }
    ).lean();
    if (!tenant) throw ERR.notFound("Tenant not found");

    const quotas = hydrateWithDefaults(tenant.quotas);
    let needClamp = false;
    for (const [key, quota] of Object.entries(quotas)) {
        if (quota.used < 0) {
            quota.used = 0;
            quotas[key as QuotaKey] = quota;
            needClamp = true;
        }
    }
    if (needClamp) {
        const $set: Record<string, number> = {};
        for (const [key, quota] of Object.entries(quotas)) $set[`quotas.${key}.used`] = quota.used;
        await Tenant.updateOne({ _id: tenantId }, { $set });
    }

    log.info("released", { tenantId: tid(tenantId), deltas: compactDeltas(increments) });
    return quotas;
}

export async function holdQuota(
    tenantId: TenantIdentifier,
    deltas: QuotaDeltas,
    taskId: string,
    { ttlMs = DEFAULT_HOLD_TTL_MS }: { ttlMs?: number } = {}
) {
    if (!taskId) throw ERR.validationPre([{ path: "taskId", message: "required" }]);
    const increments = sanitizeDeltas(deltas);

    const existing = await QuotaHold.findOne({ taskId }).lean();
    if (existing) {
        logHold.debug("hold exists (idempotent)", {
            taskId,
            tenantId: tid(existing.tenantId || tenantId),
            status: existing.status,
        });
        return existing;
    }

    await checkAndReserve(tenantId, increments);

    try {
        const hold = await QuotaHold.create({
            tenantId,
            taskId,
            deltas: increments,
            status: "held",
            expiresAt: new Date(Date.now() + ttlMs),
        });
        logHold.info("hold created", {
            taskId,
            tenantId: tid(tenantId),
            ttlMs,
            deltas: compactDeltas(increments),
        });
        return hold.toObject();
    } catch (error: unknown) {
        if ((error as { code?: number })?.code === 11000) {
            await release(tenantId, increments);
            const again = await QuotaHold.findOne({ taskId }).lean();
            logHold.warn("hold duplicate on create (rolled back reserve)", { taskId, tenantId: tid(tenantId) });
            if (again) return again;
        }
        try {
            await release(tenantId, increments);
        } catch {
            // ignore
        }
        logHold.error("hold create failed (rolled back reserve)", {
            taskId,
            tenantId: tid(tenantId),
            error: (error as Error)?.message || String(error),
        });
        throw error;
    }
}

export async function extendHold(taskId: string, { ttlMs = DEFAULT_HOLD_TTL_MS } = {}) {
    const hold = await QuotaHold.findOneAndUpdate(
        { taskId, status: "held" },
        { $set: { expiresAt: new Date(Date.now() + ttlMs) } },
        { new: true }
    ).lean();
    if (!hold) {
        logHold.warn("extend ignored (not found or not held)", { taskId });
        throw ERR.notFound("Hold not found or not extendable");
    }
    logHold.debug("hold extended", { taskId, tenantId: tid(hold.tenantId), ttlMs });
    return hold;
}

export async function consumeHold(taskId: string) {
    const hold = await QuotaHold.findOneAndUpdate(
        { taskId, status: "held" },
        { $set: { status: "consumed" } },
        { new: true }
    ).lean();
    if (hold) {
        logHold.info("hold consumed", { taskId, tenantId: tid(hold.tenantId) });
        return hold;
    }
    const existing = await QuotaHold.findOne({ taskId }).lean();
    if (existing) {
        logHold.debug("consume idempotent (already terminal)", { taskId, status: existing.status });
    } else {
        logHold.warn("consume ignored (hold not found)", { taskId });
    }
    return existing || null;
}

export async function releaseHold(taskId: string) {
    const hold = await QuotaHold.findOne({ taskId }).lean();
    if (!hold) {
        logHold.warn("release ignored (hold not found)", { taskId });
        return null;
    }
    if (hold.status === "held") {
        await release(hold.tenantId, hold.deltas);
        await QuotaHold.updateOne({ _id: hold._id }, { $set: { status: "released" } });
        logHold.info("hold released", {
            taskId,
            tenantId: tid(hold.tenantId),
            deltas: compactDeltas(hold.deltas),
        });
        return { ...hold, status: "released" };
    }
    logHold.debug("release idempotent (already terminal)", { taskId, status: hold.status });
    return hold;
}

export async function reapExpiredHolds({ limit = 200 }: { limit?: number } = {}) {
    const now = new Date();
    const expired = await QuotaHold.find({ status: "held", expiresAt: { $lte: now } })
        .limit(limit)
        .lean();

    let ok = 0;
    let fail = 0;
    for (const hold of expired) {
        try {
            await release(hold.tenantId, hold.deltas);
            await QuotaHold.updateOne({ _id: hold._id }, { $set: { status: "released" } });
            ok++;
            logReaper.info("reaped hold", {
                taskId: hold.taskId,
                tenantId: tid(hold.tenantId),
                deltas: compactDeltas(hold.deltas),
            });
        } catch (error) {
            fail++;
            logReaper.error("reap failed", {
                taskId: hold.taskId,
                tenantId: tid(hold.tenantId),
                error: (error as Error)?.message || String(error),
            });
        }
    }
    if (ok || fail) logReaper.info("reap summary", { released: ok, failed: fail });
    return expired.length;
}

interface InventoryVm {
    id?: string;
    uuid?: string;
    _id?: string;
    name?: string;
    cpu?: number;
    vCPU?: number;
    memoryMB?: number;
    memoryMiB?: number;
    disks?: Array<{
        sizeMB?: number;
        sizeMiB?: number;
        sizeGB?: number;
        sizeBytes?: number;
        virtualSizeBytes?: number;
    }>;
    storageMB?: number;
    rootDiskMB?: number;
    osDiskMB?: number;
    imageSizeMB?: number;
    imageSizeBytes?: number;
    dynamic_memory?: boolean;
    ram?: string;
    min_ram?: string;
}

interface InventoryNetwork {
    tenantId?: string;
    tenants?: string[];
}

export async function recalcUsedFromInventory({
    tenantId,
    fullInventory,
    tenantResourceLinks,
}: {
    tenantId: TenantIdentifier;
    fullInventory: { vms?: InventoryVm[]; networks?: InventoryNetwork[] };
    tenantResourceLinks?: Record<string, unknown> | Set<string>;
}) {
    if (!tenantId) throw ERR.validationPre([{ path: "tenantId", message: "required" }]);
    if (!fullInventory) throw ERR.validationPre([{ path: "fullInventory", message: "required" }]);

    let belongs: (vmId: string) => boolean;
    if (tenantResourceLinks && typeof tenantResourceLinks === "object") {
        const set =
            tenantResourceLinks instanceof Set
                ? tenantResourceLinks
                : new Set(Object.keys(tenantResourceLinks));
        belongs = (vmId) => set.has(String(vmId));
    } else {
        const links = await TenantResource.find({ tenantId, kind: "vm" }, { refId: 1 }).lean();
        const set = new Set(links.map((link) => String(link.refId)));
        belongs = (vmId) => set.has(String(vmId));
    }

    const vms = Array.isArray(fullInventory?.vms) ? fullInventory.vms : [];
    const nets = Array.isArray(fullInventory?.networks) ? fullInventory.networks : [];

    let cpu = 0;
    let memoryMB = 0;
    let storageMB = 0;
    let vmCount = 0;
    let networkCount = 0;

    for (const vm of vms) {
        const id = vm?.id || vm?.uuid || vm?._id || vm?.name;
        if (!id || !belongs(String(id))) continue;

        const vcpu = Number.isFinite(vm?.cpu) ? (vm.cpu as number) : (Number.isFinite(vm?.vCPU) ? (vm.vCPU as number) : 0);
        const mem = Number.isFinite(vm?.memoryMB)
            ? (vm.memoryMB as number)
            : Number.isFinite(vm?.memoryMiB)
            ? (vm.memoryMiB as number)
            : 0;

        let vmStorageMB = 0;
        if (Array.isArray(vm?.disks)) {
            for (const disk of vm.disks) {
                if (Number.isFinite(disk?.sizeMB)) vmStorageMB += disk!.sizeMB!;
                else if (Number.isFinite(disk?.sizeMiB)) vmStorageMB += disk!.sizeMiB!;
                else if (Number.isFinite(disk?.sizeGB)) vmStorageMB += disk!.sizeGB! * 1024;
                else if (Number.isFinite(disk?.sizeBytes)) vmStorageMB += Math.round((disk!.sizeBytes as number) / 1024 / 1024);
                else if (Number.isFinite(disk?.virtualSizeBytes))
                    vmStorageMB += Math.round((disk!.virtualSizeBytes as number) / 1024 / 1024);
            }
        } else if (Number.isFinite(vm?.storageMB)) {
            vmStorageMB = vm.storageMB as number;
        }

        cpu += Math.max(0, vcpu | 0);
        memoryMB += Math.max(0, mem | 0);
        storageMB += Math.max(0, vmStorageMB | 0);
        vmCount += 1;
    }

    for (const net of nets) {
        const owned =
            String(net?.tenantId || "") === String(tenantId) ||
            (Array.isArray(net?.tenants) && net.tenants.map(String).includes(String(tenantId)));
        if (owned) networkCount += 1;
    }

    const used = { cpu, memoryMB, storageMB, vmCount, networkCount };
    const $set: Record<string, number> = {};
    for (const [key, value] of Object.entries(used)) $set[`quotas.${key}.used`] = value | 0;

    const tenant = await Tenant.findByIdAndUpdate(
        tenantId,
        { $set },
        { new: true, projection: { quotas: 1 }, runValidators: true }
    ).lean();
    if (!tenant) throw ERR.notFound("Tenant not found");

    log.info("recalc used from inventory", { tenantId: tid(tenantId), used });
    return hydrateWithDefaults(tenant.quotas);
}

export function deltasFromVmSpec(vmSpec: InventoryVm = {}) {
    const cpu = Math.max(0, (Number.isFinite(vmSpec.cpu) ? vmSpec.cpu : vmSpec.vCPU) || 0);

    let memory = 0;
    if (Number.isFinite(vmSpec.memoryMB)) memory = vmSpec.memoryMB!;
    else if (Number.isFinite(vmSpec.memoryMiB)) memory = vmSpec.memoryMiB!;
    else if (vmSpec.ram) memory = parseSizeToMB(vmSpec.ram);

    if (vmSpec.dynamic_memory) {
        const startup = vmSpec.ram ? parseSizeToMB(vmSpec.ram) : memory;
        const minRam = vmSpec.min_ram ? parseSizeToMB(vmSpec.min_ram) : 0;
        memory = Math.max(minRam, startup, 0);
    }

    let storage = 0;
    if (Array.isArray(vmSpec.disks) && vmSpec.disks.length) {
        for (const disk of vmSpec.disks) {
            if (Number.isFinite(disk?.sizeMB)) storage += disk!.sizeMB!;
            else if (Number.isFinite(disk?.sizeMiB)) storage += disk!.sizeMiB!;
            else if (Number.isFinite(disk?.sizeGB)) storage += disk!.sizeGB! * 1024;
            else if (Number.isFinite(disk?.sizeBytes)) storage += Math.round((disk!.sizeBytes as number) / 1024 / 1024);
            else if (Number.isFinite(disk?.virtualSizeBytes))
                storage += Math.round((disk!.virtualSizeBytes as number) / 1024 / 1024);
        }
    } else {
        if (Number.isFinite(vmSpec.storageMB)) storage += vmSpec.storageMB!;
        if (Number.isFinite(vmSpec.rootDiskMB)) storage += vmSpec.rootDiskMB!;
        if (Number.isFinite(vmSpec.osDiskMB)) storage += vmSpec.osDiskMB!;
        if (Number.isFinite(vmSpec.imageSizeMB)) storage += vmSpec.imageSizeMB!;
        else if (Number.isFinite(vmSpec.imageSizeBytes))
            storage += Math.round((vmSpec.imageSizeBytes as number) / 1024 / 1024);
    }

    return {
        cpu,
        memoryMB: Math.max(0, memory | 0),
        storageMB: Math.max(0, storage | 0),
        vmCount: 1,
    };
}

export function computeDeltas(action: string, payload: unknown) {
    if (action === "vm.create") return deltasFromVmSpec(payload as InventoryVm);
    return null;
}

export async function getTenantObjectIdOrThrow(tenantIdStr: string) {
    const tenant = await Tenant.findOne({ tenantId: tenantIdStr }, { _id: 1 }).lean();
    if (!tenant) throw ERR.notFound("Tenant not found");
    return tenant._id;
}

export async function reserveAndRun<T>(
    { tenantIdStr, action, payload }: { tenantIdStr: string; action: string; payload: unknown },
    runFn: () => Promise<T>
): Promise<T> {
    const deltas = computeDeltas(action, payload);
    if (!deltas) return runFn();

    const tenantObjectId = await getTenantObjectIdOrThrow(tenantIdStr);
    await checkAndReserve(tenantObjectId, deltas);

    try {
        return await runFn();
    } catch (error) {
        try {
            await release(tenantObjectId, deltas);
        } catch {
            // ignore
        }
        throw error;
    }
}
