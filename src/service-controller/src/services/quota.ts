// src/service-controller/src/services/quota.ts

// Quota service:
// - keeps tenant quota limits and usage sane
// - offers holds/reservations to make async tasks safer
// - recomputes usage from the latest stored inventory + TenantResource links
// This file tries to be resilient to partial/heterogeneous inventories.

import type { Types } from "mongoose";
import Tenant from "../models/Tenant";
import TenantResource, { type TenantResourceLink } from "../models/TenantResource";
import QuotaHold from "../models/quota/hold";
import InventoryFull from "../models/Inventory.full";
import InventoryStorage from "../models/Inventory.storage";
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

// Local, tolerant view of inventory VMs; we only care about fields needed for quota math
// and accept multiple key variants because stored inventories may vary over time.
interface InventoryVm {
    id?: string;
    uuid?: string;
    _id?: string;
    name?: string;
    cpu?: number | { vcpus?: number | null };
    vCPU?: number;
    memoryMB?: number;
    memoryMiB?: number;
    memoryMb?: number;
    disks?: Array<{
        sizeMB?: number;
        sizeMiB?: number;
        sizeGB?: number;
        sizeBytes?: number;
        virtualSizeBytes?: number;
        size?: number;
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

// Local, tolerant view of networks to check ownership/links.
interface InventoryNetwork {
    id?: string;
    name?: string;
    tenantId?: string;
    tenants?: string[];
}

const sizeMbFromStorageImage = (image: Record<string, unknown>) => {
    const sizeMB =
        (image.sizeMB as number | undefined) ??
        (image.sizeMiB as number | undefined) ??
        (image.sizeGB as number | undefined) ??
        (image.sizeBytes as number | undefined) ??
        (image.virtualSizeBytes as number | undefined) ??
        (image.usedBytes as number | undefined);

    if (sizeMB == null) return 0;
    if (image.sizeGB !== undefined) return Math.max(0, (image.sizeGB as number) * 1024);
    if (image.sizeBytes !== undefined) return Math.max(0, Math.round((image.sizeBytes as number) / 1024 / 1024));
    if (image.virtualSizeBytes !== undefined) return Math.max(0, Math.round((image.virtualSizeBytes as number) / 1024 / 1024));
    if (image.usedBytes !== undefined) return Math.max(0, Math.round((image.usedBytes as number) / 1024 / 1024));
    return Number.isFinite(sizeMB) ? Math.max(0, (sizeMB as number) | 0) : 0;
};

// Recompute usage by looking at TenantResource links and the latest inventories stored per agent:
// 1) load VM/switch links for the tenant
// 2) fetch inventories for the involved agents
// 3) match links to inventory entries (agentId + refId/name)
// 4) sum resources; drop links that no longer exist in the inventory
export async function recalcUsedFromInventory({
    tenantId,
}: {
    tenantId: TenantIdentifier;
}) {
    if (!tenantId) throw ERR.validationPre([{ path: "tenantId", message: "required" }]);

    let tenantKey: string | null = typeof tenantId === "string" ? tenantId : null;
    if (!tenantKey) {
        const tenantDoc = await Tenant.findById(tenantId, { tenantId: 1 }).lean<{ tenantId?: string } | null>();
        tenantKey = tenantDoc?.tenantId || null;
    }
    if (!tenantKey) throw ERR.notFound("Tenant not found");
    const links = await TenantResource.find(
        { tenantId: tenantKey, kind: { $in: ["vm", "switch", "storage"] } },
        { kind: 1, agentId: 1, refId: 1, name: 1 }
    ).lean<Array<TenantResourceLink & { _id: Types.ObjectId; name?: string }>>();

    const vmLinks = links.filter((l) => l.kind === "vm");
    const switchLinks = links.filter((l) => l.kind === "switch");
    const storageLinks = links.filter((l) => l.kind === "storage");

    const agentIds = Array.from(new Set(links.map((l) => String(l.agentId))));
    const inventories = agentIds.length
        ? await InventoryFull.find(
              { agentId: { $in: agentIds } },
              { agentId: 1, inventory: 1 }
          ).lean<Array<{ agentId: string; inventory?: { vms?: InventoryVm[]; networks?: InventoryNetwork[] } }>>()
        : [];

    const storageDocs = storageLinks.length
        ? await InventoryStorage.find(
              { storageId: { $in: storageLinks.map((l) => String(l.agentId)) } },
              { storageId: 1, inventory: 1 }
          ).lean<
              Array<{
                  storageId: string;
                  inventory?: { images?: Array<Record<string, unknown>>; volumes?: Array<Record<string, unknown>> };
              }>
          >()
        : [];

    const invByAgent = new Map<string, { vms?: InventoryVm[]; networks?: InventoryNetwork[] }>();
    for (const id of agentIds) invByAgent.set(id, {});
    for (const doc of inventories) {
        invByAgent.set(String(doc.agentId), (doc.inventory as { vms?: InventoryVm[]; networks?: InventoryNetwork[] }) || {});
    }

    const storageByAgent = new Map<string, { images?: Array<Record<string, unknown>>; volumes?: Array<Record<string, unknown>> }>();
    for (const doc of storageDocs) {
        storageByAgent.set(
            String(doc.storageId),
            (doc.inventory as { images?: Array<Record<string, unknown>>; volumes?: Array<Record<string, unknown>> }) || {}
        );
    }

    const arr = <T = unknown>(value: unknown): T[] =>
        Array.isArray(value) ? (value as T[]) : [];
    const norm = (value: string | number | undefined | null) =>
        value == null ? "" : String(value).toLowerCase();
    const looksLikeIqn = (value?: string | number | null) => /^iqn\./i.test(String(value || "").trim());

    const vmIdxByAgent = new Map<string, Map<string, InventoryVm>>();
    for (const [agentId, inv] of invByAgent.entries()) {
        const idx = new Map<string, InventoryVm>();
        for (const vm of arr<InventoryVm>(inv?.vms)) {
            const keys = [
                vm?.id,
                vm?.uuid,
                vm?._id,
                vm?.name,
            ].filter(Boolean) as string[];
            keys.forEach((key) => idx.set(norm(key), vm));
        }
        vmIdxByAgent.set(agentId, idx);
    }

    const netIdxByAgent = new Map<string, Map<string, InventoryNetwork>>();
    for (const [agentId, inv] of invByAgent.entries()) {
        const idx = new Map<string, InventoryNetwork>();
        for (const net of arr<InventoryNetwork>(inv?.networks)) {
            const keys = [
                net?.id,
                net?.name,
                net?.tenantId,
                ...(Array.isArray(net?.tenants) ? net!.tenants! : []),
            ].filter(Boolean) as string[];
            keys.forEach((key) => idx.set(norm(key), net));
        }
        netIdxByAgent.set(agentId, idx);
    }

    let cpu = 0;
    let memoryMB = 0;
    let storageMBFromStorage = 0;
    let vmCount = 0;
    let networkCount = 0;

    let missingVms = 0;
    let missingNets = 0;
    let missingStorage = 0;
    const missingVmIds: string[] = [];
    const missingNetIds: string[] = [];
    const missingStorageIds: string[] = [];

    for (const link of vmLinks) {
        const idx = vmIdxByAgent.get(String(link.agentId)) || new Map<string, InventoryVm>();
        const wanted = [link.refId, (link as { name?: string }).name].filter(Boolean).map(norm);
        let vm: InventoryVm | undefined;
        for (const key of wanted) {
            if (idx.has(key)) {
                vm = idx.get(key);
                break;
            }
        }
        if (!vm) {
            missingVms++;
            missingVmIds.push(String(link._id));
            continue;
        }

        const vcpu = Number.isFinite(vm?.cpu)
            ? (vm.cpu as number)
            : Number.isFinite((vm?.cpu as { vcpus?: number })?.vcpus)
            ? ((vm?.cpu as { vcpus?: number }).vcpus as number)
            : Number.isFinite(vm?.vCPU)
            ? (vm.vCPU as number)
            : 0;

        const mem = Number.isFinite(vm?.memoryMB)
            ? (vm.memoryMB as number)
            : Number.isFinite(vm?.memoryMiB)
            ? (vm.memoryMiB as number)
            : Number.isFinite(vm?.memoryMb)
            ? (vm.memoryMb as number)
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
                else if (Number.isFinite(disk?.size)) vmStorageMB += Math.round((disk!.size as number) / 1024 / 1024);
            }
        } else if (Number.isFinite(vm?.storageMB)) {
            vmStorageMB = vm.storageMB as number;
        }

        cpu += Math.max(0, vcpu | 0);
        memoryMB += Math.max(0, mem | 0);
        vmCount += 1;
    }

    for (const link of switchLinks) {
        const idx = netIdxByAgent.get(String(link.agentId)) || new Map<string, InventoryNetwork>();
        const wanted = [link.refId, (link as { name?: string }).name]
            .filter(Boolean)
            .map((v) => norm(v as string | number | null | undefined));
        const found = wanted.some((key) => idx.has(key));
        if (found) networkCount += 1;
        else {
            missingNets++;
            missingNetIds.push(String(link._id));
        }
    }

    for (const link of storageLinks) {
        const storageInv = storageByAgent.get(String(link.agentId)) || {};
        const volumes = storageInv.volumes || [];
        const images = storageInv.images || [];
        const wanted = [link.refId, (link as { name?: string }).name].filter(Boolean).map(norm);
        let match = volumes.find((vol) => {
            const keys = [vol.refId, vol.name]
                .filter(Boolean)
                .map((v) => norm(v as string | number | null | undefined));
            return keys.some((k) => wanted.includes(k));
        });
        if (!match && looksLikeIqn(link.refId)) {
            const refNorm = norm(link.refId);
            match = volumes.find((vol) => norm(vol.iqn as string | number | null | undefined) === refNorm);
        }
        if (match) {
            storageMBFromStorage += sizeMbFromStorageImage(match);
            continue;
        }

        const refNorm = norm(link.refId);
        const imgMatch = images.find((img) => {
            const keys = [img.refId, img.id, img.name]
                .filter(Boolean)
                .map((v) => norm(v as string | number | null | undefined));
            return keys.includes(refNorm);
        });
        if (!imgMatch) {
            missingStorage++;
            missingStorageIds.push(String(link._id));
            continue;
        }
        storageMBFromStorage += sizeMbFromStorageImage(imgMatch);
    }

    const storageMB = storageMBFromStorage;

    const used = { cpu, memoryMB, storageMB, vmCount, networkCount };
    const $set: Record<string, number> = {};
    for (const [key, value] of Object.entries(used)) $set[`quotas.${key}.used`] = value | 0;

    const tenant = await Tenant.findByIdAndUpdate(
        tenantId,
        { $set },
        { new: true, projection: { quotas: 1 }, runValidators: true }
    ).lean();
    if (!tenant) throw ERR.notFound("Tenant not found");

    if (missingVmIds.length) await TenantResource.deleteMany({ _id: { $in: missingVmIds } });
    if (missingNetIds.length) await TenantResource.deleteMany({ _id: { $in: missingNetIds } });
    if (missingStorageIds.length) await TenantResource.deleteMany({ _id: { $in: missingStorageIds } });

    log.info("recalc used from inventory", {
        tenantId: tenantKey,
        used,
        missingVms,
        missingNetworks: missingNets,
        missingStorage,
    });
    return hydrateWithDefaults(tenant.quotas);
}

export function deltasFromVmSpec(vmSpec: InventoryVm = {}) {
    const cpuVal = Number.isFinite(vmSpec.cpu)
        ? (vmSpec.cpu as number)
        : Number.isFinite((vmSpec.cpu as { vcpus?: number })?.vcpus)
        ? ((vmSpec.cpu as { vcpus?: number }).vcpus as number)
        : Number.isFinite(vmSpec.vCPU)
        ? (vmSpec.vCPU as number)
        : 0;
    const cpu = Math.max(0, cpuVal | 0);

    let memory = 0;
    if (Number.isFinite(vmSpec.memoryMB)) memory = vmSpec.memoryMB!;
    else if (Number.isFinite(vmSpec.memoryMiB)) memory = vmSpec.memoryMiB!;
    else if (Number.isFinite(vmSpec.memoryMb)) memory = vmSpec.memoryMb!;
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
    const storageSizeFromPayload = (p: unknown) => {
        const candidate =
            (p as Record<string, unknown>)?.sizeMB ??
            (p as Record<string, unknown>)?.sizeMiB ??
            (p as Record<string, unknown>)?.sizeGB ??
            (p as Record<string, unknown>)?.sizeBytes;
        if (typeof candidate !== "number" || !Number.isFinite(candidate)) return 0;
        if ((p as Record<string, unknown>)?.sizeGB !== undefined) return Math.max(0, candidate * 1024);
        if ((p as Record<string, unknown>)?.sizeBytes !== undefined) return Math.max(0, Math.round(candidate / 1024 / 1024));
        return Math.max(0, candidate | 0);
    };

    if (action === "disk.create" || action === "storage.create") {
        const storageMB = storageSizeFromPayload(payload);
        return {
            cpu: 0,
            memoryMB: 0,
            storageMB,
            vmCount: 0,
            networkCount: 0,
        };
    }
    if (action === "disk.delete" || action === "storage.delete") {
        const storageMB = storageSizeFromPayload(payload);
        if (!storageMB) return null;
        return {
            cpu: 0,
            memoryMB: 0,
            storageMB: -storageMB,
            vmCount: 0,
            networkCount: 0,
        };
    }
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
