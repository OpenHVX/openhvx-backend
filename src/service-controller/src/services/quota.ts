// @ts-nocheck
"use strict";

/**
 * Quota Service (with holds/leases) + logger(lib)
 * -----------------------------------------------
 * Keeps per-tenant resource limits and usage.
 * Provides:
 *  - read/patch limits
 *  - atomic check+reserve and release
 *  - TTL-based "hold" reservations for async tasks (enqueue → hold; success → consume; failure/timeout → release)
 *  - recalc 'used' from full inventory
 *  - helpers to compute deltas from VM specs
 *
 * Conventions:
 *  - Limit -1 means "unlimited"
 *  - memory/storage in MB
 *  - All ints
 */

const Tenant = require("../models/Tenant");
const TenantResource = require("../models/TenantResource"); // only used in recalc fallback
const QuotaHold = require("../models/quota/hold");
const { ERR } = require("../lib/errors/http-errors");

// --- logger -----------------------------------------------------------------
const logger = require("../lib/logger");
const log = logger.child("quota");            // → [quota]
const logHold = log.child("hold");            // → [quota:hold]
const logReaper = log.child("reaper");        // → [quota:reaper]

// --- small helpers ----------------------------------------------------------

function safeJson(obj) { try { return JSON.stringify(obj); } catch { return "[unserializable-meta]"; } }
function compactDeltas(d) {
    if (!d || typeof d !== "object") return d;
    const out = {};
    for (const [k, v] of Object.entries(d)) if (v) out[k] = v | 0;
    return out;
}
function tid(x) { return typeof x === "string" ? x : String(x); }

function parseSizeToMB(v) {
    if (v == null) return 0;
    if (Number.isFinite(v)) return v | 0;
    if (typeof v !== "string") return 0;
    const s = v.trim().toLowerCase();
    // support "2048", "2048mb", "2gb", "2 g", "2gib", etc.
    const m = s.match(/^(\d+(?:\.\d+)?)\s*(k|kb|kib|m|mb|mib|g|gb|gib)?$/i);
    if (!m) return 0;
    const num = parseFloat(m[1]);
    const unit = (m[2] || "mb").toLowerCase();
    const MB = 1;
    const KB = 1 / 1024;
    const GB = 1024;
    switch (unit) {
        case "k":
        case "kb":
        case "kib": return Math.round(num * KB);
        case "m":
        case "mb":
        case "mib": return Math.round(num * MB);
        case "g":
        case "gb":
        case "gib": return Math.round(num * GB);
        default: return 0;
    }
}

// Default limits if a tenant has no quotas yet.
const DEFAULTS = Object.freeze({
    cpu: 0,
    memoryMB: 0,
    storageMB: 0,
    vmCount: 0,
    networkCount: 0,
});

// Default hold TTL (can be overridden per call)
const DEFAULT_HOLD_TTL_MS = 15 * 60 * 1000; // 15 minutes

// ----  validation / shape helpers ------------------------------------------

/** Ensure integer limits (partial). -1 allowed. */
function sanitizeLimits(obj) {
    const out = {};
    if (!obj || typeof obj !== "object") return out;
    for (const [k, v] of Object.entries(obj)) {
        if (v == null) continue;
        if (!Number.isFinite(v) || (v | 0) !== v) {
            throw ERR.validationPre([{ path: `quotas.${k}.limit`, message: "must be integer" }]);
        }
        out[k] = v | 0;
    }
    return out;
}

/** Ensure integer deltas (partial). */
function sanitizeDeltas(obj) {
    const out = {};
    if (!obj || typeof obj !== "object") {
        throw ERR.validationPre([{ path: "deltas", message: "must be an object" }]);
    }
    for (const [k, v] of Object.entries(obj)) {
        if (v == null) continue;
        let n = v;
        if (typeof n === "string" && /^-?\d+$/.test(n.trim())) n = Number(n.trim());
        if (!Number.isFinite(n) || (n | 0) !== n) {
            throw ERR.validationPre([{ path: `limits.${k}`, message: "must be integer" }]);
        }
        out[k] = n | 0;
    }
    return out;
}

/** Merge with defaults and coerce used>=0. */
function hydrateWithDefaults(quotas = {}) {
    const keys = new Set([...Object.keys(DEFAULTS), ...Object.keys(quotas)]);
    const out = {};
    for (const k of keys) {
        const q = quotas[k] || {};
        out[k] = {
            limit: Number.isFinite(q.limit) ? (q.limit | 0) : (DEFAULTS[k] | 0),
            used: Number.isFinite(q.used) ? Math.max(0, q.used | 0) : 0,
        };
    }
    return out;
}

// ---- public API: quotas read/patch ----------------------------------------

/** Read quotas for a tenant (_id). */
async function getTenantQuotas(tenantId) {
    const t = await Tenant.findById(tenantId, { quotas: 1 }).lean();
    if (!t) throw ERR.notFound("Tenant not found");
    return hydrateWithDefaults(t.quotas);
}

/** Patch quota limits (partial). */
async function setTenantQuotaLimits(tenantId, partialLimits) {
    const limits = sanitizeLimits(partialLimits);
    const $set = {};
    for (const [k, v] of Object.entries(limits)) $set[`quotas.${k}.limit`] = v;

    const t = await Tenant.findByIdAndUpdate(
        tenantId,
        { $set },
        { new: true, projection: { quotas: 1 }, runValidators: true }
    ).lean();
    if (!t) throw ERR.notFound("Tenant not found");

    log.info("limits patched", { tenantId: tid(tenantId), limits: $set });
    return hydrateWithDefaults(t.quotas);
}

// ---- core primitives: check/reserve/release (direct) ----------------------

/**
 * Atomically check and reserve usage.
 * Positive deltas reserve; -1 limit is unlimited.
 * NOTE: used internally by holdQuota, can also be used for sync/inline ops.
 */
async function checkAndReserve(tenantId, deltas) {
    const incs = sanitizeDeltas(deltas);

    // Build $expr constraints for positive deltas.
    const and = [];
    for (const [key, inc] of Object.entries(incs)) {
        if (inc <= 0) continue;
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

    const filter = { _id: tenantId };
    if (and.length) filter.$expr = { $and: and };

    const $inc = {};
    for (const [k, v] of Object.entries(incs)) {
        if (v !== 0) $inc[`quotas.${k}.used`] = v;
    }

    const updated = await Tenant.findOneAndUpdate(
        filter,
        Object.keys($inc).length ? { $inc } : {},
        { new: true, projection: { quotas: 1 }, runValidators: true }
    ).lean();

    if (!updated) {
        // Build reason from current values
        const current = await Tenant.findById(tenantId, { quotas: 1 }).lean();
        if (!current) throw ERR.notFound("Tenant not found");
        const reasons = [];
        for (const [k, v] of Object.entries(incs)) {
            if (v <= 0) continue;
            const limit = current.quotas?.[k]?.limit ?? 0;
            const used = current.quotas?.[k]?.used ?? 0;
            if (limit !== -1 && used + v > limit) reasons.push(`${k}: ${used} + ${v} > ${limit}`);
        }
        log.warn("reserve denied (quota exceeded)", {
            tenantId: tid(tenantId),
            deltas: compactDeltas(incs),
            reasons,
        });
        throw ERR.quotaExceeded(reasons.length ? `Quota exceeded (${reasons.join(", ")})` : "Quota exceeded");
    }

    log.info("reserved", { tenantId: tid(tenantId), deltas: compactDeltas(incs) });
    return hydrateWithDefaults(updated.quotas);
}

/** Release usage (clamped to >=0). */
async function release(tenantId, deltas) {
    const incs = sanitizeDeltas(deltas);
    const $inc = {};
    for (const [k, v] of Object.entries(incs)) {
        if (v !== 0) $inc[`quotas.${k}.used`] = -Math.abs(v);
    }

    let t = await Tenant.findByIdAndUpdate(
        tenantId,
        Object.keys($inc).length ? { $inc } : {},
        { new: true, projection: { quotas: 1 }, runValidators: true }
    ).lean();
    if (!t) throw ERR.notFound("Tenant not found");

    const quotas = hydrateWithDefaults(t.quotas);
    let needClamp = false;
    for (const [k, q] of Object.entries(quotas)) {
        if (q.used < 0) { quotas[k].used = 0; needClamp = true; }
    }
    if (needClamp) {
        const $set = {};
        for (const [k, q] of Object.entries(quotas)) $set[`quotas.${k}.used`] = q.used;
        await Tenant.updateOne({ _id: tenantId }, { $set });
    }

    log.info("released", { tenantId: tid(tenantId), deltas: compactDeltas(incs) });
    return quotas;
}

// ---- HOLD (lease) API ------------------------------------------------------

/**
 * Place a hold at enqueue:
 * - Idempotent on taskId (if already held/consumed/released, returns existing)
 * - Atomically reserves quotas via checkAndReserve
 * - Creates QuotaHold with status=held and TTL
 */
async function holdQuota(tenantId, deltas, taskId, { ttlMs = DEFAULT_HOLD_TTL_MS } = {}) {
    if (!taskId) throw ERR.validationPre([{ path: "taskId", message: "required" }]);
    const incs = sanitizeDeltas(deltas);
    console.log(deltas)
    // Idempotence quick path
    const existing = await QuotaHold.findOne({ taskId }).lean();
    if (existing) {
        logHold.debug("hold exists (idempotent)", {
            taskId,
            tenantId: tid(existing.tenantId || tenantId),
            status: existing.status,
        });
        return existing;
    }

    // Reserve first
    await checkAndReserve(tenantId, incs);

    try {
        const hold = await QuotaHold.create({
            tenantId,
            taskId,
            deltas: incs,
            status: "held",
            expiresAt: new Date(Date.now() + ttlMs),
        });
        logHold.info("hold created", {
            taskId,
            tenantId: tid(tenantId),
            ttlMs,
            deltas: compactDeltas(incs),
        });
        return hold.toObject();
    } catch (e) {
        // Duplicate taskId (rare race) -> rollback reservation and return the existing hold
        if (e && e.code === 11000) {
            await release(tenantId, incs);
            const again = await QuotaHold.findOne({ taskId }).lean();
            logHold.warn("hold duplicate on create (rolled back reserve)", { taskId, tenantId: tid(tenantId) });
            if (again) return again;
        }
        // Other error: rollback and throw
        try { await release(tenantId, incs); } catch (_) { /* ignore */ }
        logHold.error("hold create failed (rolled back reserve)", {
            taskId,
            tenantId: tid(tenantId),
            error: e?.message || String(e),
        });
        throw e;
    }
}

/** Extend hold TTL (e.g., on agent "started"/ACK). */
async function extendHold(taskId, { ttlMs = DEFAULT_HOLD_TTL_MS } = {}) {
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

/** Consume hold on success: mark consumed (no change to 'used' — already reserved). */
async function consumeHold(taskId) {
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

/** Release hold on failure/abort/timeout: decrement used and mark released. */
async function releaseHold(taskId) {
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
    // consumed/released -> idempotent no-op
    logHold.debug("release idempotent (already terminal)", { taskId, status: hold.status });
    return hold;
}

/** Reaper: free all expired holds still in 'held' status. */
async function reapExpiredHolds({ limit = 200 } = {}) {
    const now = new Date();
    const expired = await QuotaHold.find({ status: "held", expiresAt: { $lte: now } })
        .limit(limit).lean();

    let ok = 0, fail = 0;
    for (const h of expired) {
        try {
            await release(h.tenantId, h.deltas);
            await QuotaHold.updateOne({ _id: h._id }, { $set: { status: "released" } });
            ok++;
            logReaper.info("reaped hold", {
                taskId: h.taskId,
                tenantId: tid(h.tenantId),
                deltas: compactDeltas(h.deltas),
            });
        } catch (e) {
            fail++;
            logReaper.error("reap failed", {
                taskId: h.taskId,
                tenantId: tid(h.tenantId),
                error: e?.message || String(e),
            });
        }
    }
    if (ok || fail) logReaper.info("reap summary", { released: ok, failed: fail });
    return expired.length;
}

// ---- recalc from inventory --------------------------------------------------

/**
 * Recalculate 'used' from FULL inventory (authoritative).
 * Falls back to TenantResource for VM ownership if links not provided.
 */
async function recalcUsedFromInventory({ tenantId, fullInventory, tenantResourceLinks }) {
    if (!tenantId) throw ERR.validationPre([{ path: "tenantId", message: "required" }]);
    if (!fullInventory) throw ERR.validationPre([{ path: "fullInventory", message: "required" }]);

    // Build membership check
    let belongs;
    if (tenantResourceLinks && typeof tenantResourceLinks === "object") {
        const set = tenantResourceLinks instanceof Set ? tenantResourceLinks : new Set(Object.keys(tenantResourceLinks));
        belongs = (vmId) => set.has(String(vmId));
    } else {
        const links = await TenantResource.find(
            { tenantId },
            { "resource.kind": 1, "resource.ref": 1 }
        ).lean();
        const set = new Set(
            links.filter(l => l?.resource?.kind === "vm").map(l => String(l.resource.ref))
        );
        belongs = (vmId) => set.has(String(vmId));
    }

    const vms = Array.isArray(fullInventory?.vms) ? fullInventory.vms : [];
    const nets = Array.isArray(fullInventory?.networks) ? fullInventory.networks : [];

    let cpu = 0, memoryMB = 0, storageMB = 0, vmCount = 0, networkCount = 0;

    for (const vm of vms) {
        const id = vm?.id || vm?.uuid || vm?._id || vm?.name;
        if (!id || !belongs(String(id))) continue;

        const vcpu = Number.isFinite(vm?.cpu) ? (vm.cpu | 0) :
            (Number.isFinite(vm?.vCPU) ? (vm.vCPU | 0) : 0);
        const mem = Number.isFinite(vm?.memoryMB) ? (vm.memoryMB | 0) :
            (Number.isFinite(vm?.memoryMiB) ? (vm.memoryMiB | 0) : 0);

        let vmStorageMB = 0;
        if (Array.isArray(vm?.disks)) {
            for (const d of vm.disks) {
                const bytes = Number.isFinite(d?.sizeBytes) ? d.sizeBytes :
                    Number.isFinite(d?.virtualSizeBytes) ? d.virtualSizeBytes : 0;
                if (bytes > 0) vmStorageMB += Math.round(bytes / (1024 * 1024));
            }
        } else if (Number.isFinite(vm?.storageMB)) {
            vmStorageMB = vm.storageMB | 0;
        }

        cpu += Math.max(0, vcpu);
        memoryMB += Math.max(0, mem);
        storageMB += Math.max(0, vmStorageMB);
        vmCount += 1;
    }

    for (const n of nets) {
        const owned =
            String(n?.tenantId || "") === String(tenantId) ||
            (Array.isArray(n?.tenants) && n.tenants.map(String).includes(String(tenantId)));
        if (owned) networkCount += 1;
    }

    const used = { cpu, memoryMB, storageMB, vmCount, networkCount };
    const $set = {};
    for (const [k, v] of Object.entries(used)) $set[`quotas.${k}.used`] = v | 0;

    const t = await Tenant.findByIdAndUpdate(
        tenantId,
        { $set },
        { new: true, projection: { quotas: 1 }, runValidators: true }
    ).lean();
    if (!t) throw ERR.notFound("Tenant not found");

    log.info("recalc used from inventory", { tenantId: tid(tenantId), used });
    return hydrateWithDefaults(t.quotas);
}

// ---- deltas helpers --------------------------------------------------------

/** Convert a VM spec to quota deltas for create/resize. */
function deltasFromVmSpec(vmSpec = {}) {
    // CPU
    const cpu = Math.max(0, (Number.isFinite(vmSpec.cpu) ? vmSpec.cpu : vmSpec.vCPU) | 0);

    // Memory (accept memoryMB or memoryMiB; fallback to string "ram")
    let memoryMB = 0;
    if (Number.isFinite(vmSpec.memoryMB)) memoryMB = vmSpec.memoryMB | 0;
    else if (Number.isFinite(vmSpec.memoryMiB)) memoryMB = vmSpec.memoryMiB | 0;
    else if (vmSpec.ram) memoryMB = parseSizeToMB(vmSpec.ram);

    // If dynamic memory is enabled, reserve at least the startup/min value
    if (vmSpec.dynamic_memory) {
        const startup = vmSpec.ram ? parseSizeToMB(vmSpec.ram) : memoryMB;
        const minRam = vmSpec.min_ram ? parseSizeToMB(vmSpec.min_ram) : 0;
        memoryMB = Math.max(minRam, startup, 0);
    }


    let storageMB = 0;
    if (Array.isArray(vmSpec.disks) && vmSpec.disks.length) {
        for (const d of vmSpec.disks) {
            if (Number.isFinite(d?.sizeMB)) storageMB += d.sizeMB | 0;
            else if (Number.isFinite(d?.sizeMiB)) storageMB += d.sizeMiB | 0;
            else if (Number.isFinite(d?.sizeGB)) storageMB += (d.sizeGB | 0) * 1024;
            else if (Number.isFinite(d?.sizeBytes)) storageMB += Math.round(d.sizeBytes / (1024 * 1024));
            else if (Number.isFinite(d?.virtualSizeBytes)) storageMB += Math.round(d.virtualSizeBytes / (1024 * 1024));
        }
    } else {
        if (Number.isFinite(vmSpec.rootDiskMB)) storageMB += vmSpec.rootDiskMB | 0;
        if (Number.isFinite(vmSpec.osDiskMB)) storageMB += vmSpec.osDiskMB | 0;
        if (Number.isFinite(vmSpec.imageSizeMB)) storageMB += vmSpec.imageSizeMB | 0;
        else if (Number.isFinite(vmSpec.imageSizeBytes)) storageMB += Math.round(vmSpec.imageSizeBytes / (1024 * 1024));
    }

    return { cpu, memoryMB: Math.max(0, memoryMB | 0), storageMB: Math.max(0, storageMB | 0), vmCount: 1 };
}

/** Map action → deltas. Extend as you add actions. */
function computeDeltas(action, payload) {
    if (action === "vm.create") return deltasFromVmSpec(payload || {});
    // TODO: add vm.resize, disk.attach, vm.clone, etc.
    return null;
}

/** Resolve tenantId (string) → _id (ObjectId) */
async function getTenantObjectIdOrThrow(tenantIdStr) {
    const t = await Tenant.findOne({ tenantId: tenantIdStr }, { _id: 1 }).lean();
    if (!t) throw ERR.notFound("Tenant not found");
    return t._id;
}

// ---- legacy helper (kept for sync paths) -----------------------------------

/**
 * Legacy: reserve quotas then run critical section in-process.
 * For async tasks, prefer the hold API.
 */
async function reserveAndRun({ tenantIdStr, action, payload }, runFn) {
    const deltas = computeDeltas(action, payload);
    if (!deltas) return runFn();

    const tenantObjectId = await getTenantObjectIdOrThrow(tenantIdStr);
    await checkAndReserve(tenantObjectId, deltas);

    try {
        return await runFn();
    } catch (err) {
        try { await release(tenantObjectId, deltas); } catch (_) { /* ignore */ }
        throw err;
    }
}

module.exports = {
    // read/patch
    getTenantQuotas,
    setTenantQuotaLimits,

    // primitives
    checkAndReserve,
    release,

    // holds
    holdQuota,
    extendHold,
    consumeHold,
    releaseHold,
    reapExpiredHolds,
    DEFAULT_HOLD_TTL_MS,

    // recalc & helpers
    recalcUsedFromInventory,
    deltasFromVmSpec,
    computeDeltas,
    getTenantObjectIdOrThrow,

    // legacy
    reserveAndRun,
};
