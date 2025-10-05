// controllers/resources.js
"use strict";

/**
 * Resources Controller
 * --------------------
 * Purpose:
 *  - Expose tenant resources (VMs, switches) by combining two inventories:
 *    * FULL  : rich, periodic (slow)
 *    * LIGHT : lightweight, posted after an agent task (fast)
 *
 * New, reliable merge rule:
 *  - FULL is authoritative for existence (a VM must be present in FULL to exist),
 *  - LIGHT may overlay volatile fields when LIGHT is newer than FULL, 
 *  - Exception (fast create): if LIGHT is newer than FULL AND the VM key is explicitly
 *    linked in TenantResource for this agent, we allow it to appear from LIGHT
 *    until the next FULL arrives.
 *
 * Rationale:
 *  - Prevent “ghost VMs” when deleted on the host (absent in FULL ⇒ not listed),
 *  - Still show newly created VMs right after a task completes, without waiting for FULL.
 */

const TenantResource = require("../models/TenantResource");
const InventoryFull = require("../models/Inventory.full");
const InventoryLight = require("../models/Inventory.light");

/* ==================================================================== */
/* Utilities                                                            */
/* ==================================================================== */

/** Get tenantId from URL, middleware, or JWT. */
const getTenantId = (req) =>
    req.params?.tenantId || req.tenantId || req.user?.tenantId || null;

/** Normalize to array (safe loop). */
const arr = (v) => (Array.isArray(v) ? v : []);

/** Normalize Windows path for case-insensitive + / vs \ comparison. */
const normPath = (p) =>
    typeof p === "string" ? p.replace(/\//g, "\\").toLowerCase() : p;

/** Root of inventory (support legacy shapes { inventory:{...} } and { inventory:{ inventory:{...} } }). */
const root = (doc) => doc?.inventory?.inventory || doc?.inventory || {};

/** VM key priority: guid > id > name. */
const vmKey = (vm) => vm?.guid || vm?.id || vm?.name || null;

/** Build a Map<K,V> from a list by extracting a key. */
const mapBy = (list, keyFn) => {
    const m = new Map();
    for (const x of arr(list)) {
        const k = keyFn(x);
        if (k) m.set(String(k), x);
    }
    return m;
};

/** Reliable timestamp from doc.ts or inventory.collectedAt (else null). */
const getTs = (doc) => {
    if (!doc) return null;
    if (doc.ts) {
        const t = new Date(doc.ts).getTime();
        if (Number.isFinite(t)) return t;
    }
    const col = root(doc)?.collectedAt;
    if (col) {
        const t = new Date(col).getTime();
        if (Number.isFinite(t)) return t;
    }
    return null;
};

/** All possible identity keys for a VM (stringified). */
const vmKeysAll = (vm) => [vm?.guid, vm?.id, vm?.name].filter(Boolean).map(String);

/** Lowercase helper. */
const lcase = (s) => (typeof s === "string" ? s.toLowerCase() : s);

/* ==================================================================== */
/* VM merge (FULL authoritative + LIGHT overlay + fast-create exception)*/
/* ==================================================================== */

const VOLATILE_FIELDS = [
    "state",
    "uptimeSec",
    "cpuUsagePct",
    "memoryAssignedMB",
    "automaticStart",
    "automaticStop",
];

/**
 * Overlay "overlayVm" onto "baseVm" for volatile fields and disk vhd.fileSizeMB.
 */
function mergeVm(baseVm, overlayVm) {
    if (!overlayVm) return { ...baseVm };

    const out = { ...baseVm };

    // 1) Volatile fields overlay (only if present in overlay)
    for (const k of VOLATILE_FIELDS) {
        if (overlayVm[k] != null) out[k] = overlayVm[k];
    }

    // 2) Disks - keep best (max) vhd.fileSizeMB seen across sources
    const baseDisks = arr(baseVm.storage);
    const ovDisks = arr(overlayVm.storage);
    const byPath = mapBy(ovDisks, (d) => normPath(d?.path));

    out.storage = baseDisks.map((bd) => {
        const od = byPath.get(normPath(bd?.path));
        if (!od) return bd;

        const bv = bd?.vhd || {};
        const ov = od?.vhd || {};

        const cur = typeof bv.fileSizeMB === "number" ? bv.fileSizeMB : -Infinity;
        const nxt = typeof ov.fileSizeMB === "number" ? Math.max(cur, ov.fileSizeMB) : cur;

        return {
            ...bd,
            vhd: {
                ...bv,
                format: bv.format ?? ov.format ?? null,
                type: bv.type ?? ov.type ?? null,
                sizeMB: bv.sizeMB ?? null,
                fileSizeMB: Number.isFinite(nxt) ? nxt : bv.fileSizeMB ?? null,
                parentPath: bv.parentPath ?? null,
                blockSize: bv.blockSize ?? null,
                logicalSectorSize: bv.logicalSectorSize ?? null,
                physicalSectorSize: bv.physicalSectorSize ?? null,
            },
        };
    });

    return out;
}

/**
 * Combine VMs for a given agent.
 *
 * Rules:
 *  - If FULL exists:
 *      • Only VMs present in FULL are returned (existence is FULL-authoritative),
 *      • LIGHT can overlay volatile fields when LIGHT is newer than FULL,
 *      • Exception: if LIGHT is newer AND the VM key is explicitly linked for the tenant/agent
 *        (allowLightOnlyKeys), allow LIGHT-only VMs to appear temporarily (fast create).
 *  - If no FULL exists at all (agent just started or first sync):
 *      • Return LIGHT (best effort) — still not a union with stale FULL.
 *
 * @param {Object|null} fullDoc
 * @param {Object|null} lightDoc
 * @param {Set<string>|null} allowLightOnlyKeys - allowed keys (refId/name) in lowercase
 * @returns {Array<Object>} merged list of VMs
 */
function combineAgent(fullDoc, lightDoc, allowLightOnlyKeys = null) {
    const fullVms = arr(root(fullDoc).vms);
    const lightVms = arr(root(lightDoc).vms);

    const tFull = getTs(fullDoc) ?? -Infinity;
    const tLight = getTs(lightDoc) ?? -Infinity;
    const lightIsNewer = tLight > tFull;

    // Index LIGHT by all possible keys (guid, id, name)
    const byLight = new Map();
    for (const lv of lightVms) {
        for (const k of vmKeysAll(lv)) {
            if (!byLight.has(k)) byLight.set(k, lv);
        }
    }

    // No FULL available yet → initial best-effort from LIGHT
    if (fullVms.length === 0) {
        return lightVms.map((v) => ({ ...v }));
    }

    // FULL present → base = FULL; overlay with LIGHT (if newer)
    const presentKeyLC = new Set();
    const out = [];

    for (const fv of fullVms) {
        // Try to find LIGHT counterpart by any identity key
        let lv = null;
        for (const k of vmKeysAll(fv)) {
            if (byLight.has(k)) {
                lv = byLight.get(k);
                break;
            }
        }
        const merged = lightIsNewer && lv ? mergeVm(fv, lv) : { ...fv };
        out.push(merged);

        // Track keys we already emitted (lowercase for easier set membership)
        for (const k of vmKeysAll(fv)) presentKeyLC.add(lcase(k));
    }

    // Fast-create exception: allow LIGHT-only VMs if LIGHT is newer AND explicitly linked
    if (lightIsNewer && allowLightOnlyKeys && allowLightOnlyKeys.size) {
        for (const lv of lightVms) {
            const keys = vmKeysAll(lv);
            const alreadyPresent = keys.some((k) => presentKeyLC.has(lcase(k)));
            if (alreadyPresent) continue;

            const allowed = keys.some((k) => allowLightOnlyKeys.has(lcase(k)));
            if (allowed) {
                out.push({ ...lv });
                for (const k of keys) presentKeyLC.add(lcase(k));
            }
        }
    }

    return out;
}

/* ==================================================================== */
/* Non-VM extraction (switches, etc.)                                   */
/* ==================================================================== */

/**
 * Extract resources (kind = vm|switch) from an inventory doc.
 * Used by the "unassigned resources" helper endpoint.
 */
function pickFromInv(invDoc, { kind, agentId }) {
    const out = [];
    const aId = agentId || invDoc.agentId;
    const inv = root(invDoc);

    if (!kind || kind === "vm") {
        for (const vm of arr(inv.vms)) {
            const k = vmKey(vm);
            if (k) out.push({ kind: "vm", agentId: aId, refId: k, data: vm });
        }
    }
    if (!kind || kind === "switch") {
        for (const sw of arr(inv?.networks?.switches)) {
            const name = sw?.name;
            if (name) out.push({ kind: "switch", agentId: aId, refId: name, data: sw });
        }
    }
    return out;
}

/* ==================================================================== */
/* Controllers                                                           */
/* ==================================================================== */

/**
 * GET /api/v1/tenant/resources
 * GET /api/v1/admin/:tenantId/resources
 * Query: kind, agentId, includeOrphans
 */
exports.listResources = async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return res.status(400).json({ error: "Missing tenant context" });

        const { kind, agentId, includeOrphans } = req.query;
        const showOrphans = String(includeOrphans).toLowerCase() === "true";

        // 1) All links (resources claimed by the tenant)
        const q = { tenantId };
        if (kind) q.kind = kind;
        if (agentId) q.agentId = agentId;

        const links = await TenantResource.find(q).lean();
        if (!links.length) return res.json({ success: true, data: [] });

        // 2) Get FULL & LIGHT for all involved agents
        const agentIds = Array.from(new Set(links.map((l) => l.agentId)));

        const [fullDocs, lightDocs] = await Promise.all([
            InventoryFull.find({ agentId: { $in: agentIds } }, { agentId: 1, inventory: 1, ts: 1 }).lean(),
            InventoryLight.find({ agentId: { $in: agentIds } }, { agentId: 1, inventory: 1, ts: 1 }).lean(),
        ]);

        const fullBy = new Map(fullDocs.map((d) => [d.agentId, d]));
        const lightBy = new Map(lightDocs.map((d) => [d.agentId, d]));

        // 3) Per agent, prepare allowed keys for LIGHT-only "fast create" (from links)
        //    We allow refId and (optionally) name as keys; store them lowercase for quick membership tests.
        const allowByAgent = new Map();
        for (const l of links) {
            if (l.kind !== "vm") continue;
            const set = allowByAgent.get(l.agentId) || new Set();
            if (l.refId) set.add(l.refId.toLowerCase());
            if (l.name) set.add(l.name.toLowerCase());
            allowByAgent.set(l.agentId, set);
        }

        // 4) For each agent, build a merged VM index (FULL with LIGHT overlay + exceptions)
        const vmIdxByAgent = new Map();
        for (const aId of agentIds) {
            const merged = combineAgent(
                fullBy.get(aId) || null,
                lightBy.get(aId) || null,
                allowByAgent.get(aId) || null
            );

            const idx = new Map();
            for (const vm of merged) {
                for (const k of [vm.guid, vm.id, vm.name].filter(Boolean).map(String)) {
                    idx.set(k, vm);
                }
            }
            vmIdxByAgent.set(aId, idx);
        }

        // 5) Rebuild response in link order; show orphans only if requested
        const out = [];
        for (const l of links) {
            if (l.kind === "vm") {
                const idx = vmIdxByAgent.get(l.agentId) || new Map();

                // Try by refId, then fallback by stored name (case-insensitive)
                let vm = idx.get(String(l.refId));
                if (!vm && l.name) {
                    vm = idx.get(String(l.name));
                    if (!vm) {
                        const wanted = String(l.name).toLowerCase();
                        for (const v of idx.values()) {
                            if ((v?.name || "").toLowerCase() === wanted) {
                                vm = v;
                                break;
                            }
                        }
                    }
                }
                // Final fallback: if refId is "name-like", try matching by VM name case-insensitively
                if (!vm && /^[a-z0-9._-]+$/i.test(String(l.refId))) {
                    const wanted = String(l.refId).toLowerCase();
                    for (const v of idx.values()) {
                        if ((v?.name || "").toLowerCase() === wanted) {
                            vm = v;
                            break;
                        }
                    }
                }

                if (vm) {
                    out.push({
                        ...vm,
                        tenantId,
                        agentId: l.agentId,
                        kind: "vm",
                        refId: l.refId,
                    });
                } else if (showOrphans) {
                    out.push({
                        tenantId,
                        agentId: l.agentId,
                        kind: "vm",
                        refId: l.refId,
                        name: l.name || "(unknown)",
                        state: "NotFound",
                        orphaned: true,
                        assignedAt: l.assignedAt,
                    });
                }
                continue;
            }

            if (l.kind === "switch") {
                // For switches we keep FULL-first (structure usually richer)
                const invFull = root(fullBy.get(l.agentId) || {});
                const sw = arr(invFull?.networks?.switches).find((s) => s.name === l.refId);

                if (sw) {
                    out.push({
                        ...sw,
                        tenantId,
                        agentId: l.agentId,
                        kind: "switch",
                        refId: l.refId,
                    });
                } else if (showOrphans) {
                    out.push({
                        tenantId,
                        agentId: l.agentId,
                        kind: "switch",
                        refId: l.refId,
                        name: l.refId,
                        state: "NotFound",
                        orphaned: true,
                        assignedAt: l.assignedAt,
                    });
                }
                continue;
            }

            // kind "image" or others handled elsewhere
        }

        return res.json({ success: true, data: out });
    } catch (e) {
        console.error("listResources error:", e);
        return res.status(500).json({ error: "Server error" });
    }
};

/**
 * POST /api/v1/tenant/resources/claim
 * POST /api/v1/admin/:tenantId/resources/claim
 * body: { kind, agentId, refIds: [...] }
 */
exports.claimResources = async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return res.status(400).json({ error: "Missing tenant context" });

        const { kind, agentId, refIds } = req.body;
        const valid = kind && agentId && Array.isArray(refIds) && refIds.length > 0;
        if (!valid) {
            return res
                .status(400)
                .json({ error: "kind, agentId and non-empty refIds[] required" });
        }

        const ops = refIds.map((refId) => ({
            updateOne: {
                filter: { kind, agentId, refId },
                update: { $setOnInsert: { tenantId, assignedAt: new Date() } },
                upsert: true,
            },
        }));

        await TenantResource.bulkWrite(ops);
        return res.json({ success: true });
    } catch (e) {
        console.error("claimResources error:", e);
        return res.status(500).json({ error: "Server error" });
    }
};

/**
 * DELETE /api/v1/tenant/resources/:resourceId?kind=vm&agentId=HOST
 * DELETE /api/v1/admin/:tenantId/resources/:resourceId?kind=vm&agentId=HOST
 */
exports.unclaimResource = async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return res.status(400).json({ error: "Missing tenant context" });

        const { resourceId } = req.params;
        const { kind, agentId } = req.query;
        if (!resourceId || !kind || !agentId) {
            return res
                .status(400)
                .json({ error: "resourceId param and kind/agentId query params are required" });
        }

        await TenantResource.deleteOne({ tenantId, kind, agentId, refId: resourceId });
        return res.json({ success: true });
    } catch (e) {
        console.error("unclaimResource error:", e);
        return res.status(500).json({ error: "Server error" });
    }
};

/**
 * GET /api/v1/admin/resources/unassigned?kind=vm|switch&agentId=HOST&limit=100
 * Helper endpoint: lists resources present in FULL but not claimed in TenantResource.
 */
exports.listUnassignedResources = async (req, res) => {
    try {
        const { kind, agentId } = req.query;
        const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);

        const f = {};
        if (agentId) f.agentId = agentId;

        const invs = await InventoryFull.find(f, { agentId: 1, inventory: 1 }).lean();

        const cand = [];
        for (const d of invs) cand.push(...pickFromInv(d, { kind, agentId: d.agentId }));
        if (cand.length === 0) return res.json({ success: true, data: [] });

        // De-duplicate and remove already assigned
        const key = (r) => `${r.kind}|${r.agentId}|${r.refId}`;
        const uniq = Array.from(new Set(cand.map(key)));

        const assignedSet = new Set();
        const BATCH = 500;

        for (let i = 0; i < uniq.length; i += BATCH) {
            const slice = uniq.slice(i, i + BATCH);
            const or = slice.map((k) => {
                const [knd, aId, ref] = k.split("|");
                return { kind: knd, agentId: aId, refId: ref };
            });
            const assigned = await TenantResource.find({ $or: or }, { kind: 1, agentId: 1, refId: 1 }).lean();
            for (const a of assigned) assignedSet.add(key(a));
        }

        const out = [];
        for (const c of cand) {
            if (!assignedSet.has(key(c))) out.push(c);
            if (out.length >= limit) break;
        }

        return res.json({
            success: true,
            count: out.length,
            data: out.map((r) => ({
                kind: r.kind,
                agentId: r.agentId,
                refId: r.refId,
                name: r.data?.name,
                guid: r.data?.guid,
                state: r.data?.state,
                cpu: r.data?.cpu,
                ramMB: r.data?.ramMB,
                switches: r.data?.switches,
                raw: r.data,
            })),
        });
    } catch (e) {
        console.error("listUnassignedResources error:", e);
        return res.status(500).json({ error: "Server error" });
    }
};
