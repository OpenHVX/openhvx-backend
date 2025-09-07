/**
 * Resources Controller
 * --------------------
 * Objectif:
 *  - Exposer les ressources d'un tenant (VMs, switches) à partir de deux inventaires :
 *    * FULL  : riche, périodique (lent)
 *    * LIGHT : léger, post-tâche (rapide)
 *
 * Principes:
 *  - On NE REJETTE JAMAIS le LIGHT : on construit l'UNION FULL ∪ LIGHT.
 *  - Base d'une VM = entrée FULL si dispo, sinon LIGHT.
 *  - Champs volatils (state/uptime/cpu/ram/autoStart/autoStop + vhd.fileSizeMB) =
 *    source la plus RÉCENTE (FULL vs LIGHT).
 *  - Compat structure: { inventory: { ... } } et { inventory: { inventory: { ... } } }
 */

const TenantResource = require("../models/TenantResource");
const InventoryFull = require("../models/Inventory.full");
const InventoryLight = require("../models/Inventory.light");

/* ==================================================================== */
/* Utilities                                                            */
/* ==================================================================== */

/** Récupère le tenantId depuis l’URL, le middleware ou le JWT. */
const getTenantId = (req) =>
    req.params?.tenantId || req.tenantId || req.user?.tenantId || null;

/** Norme: tableau (sécurise les boucles). */
const arr = (v) => (Array.isArray(v) ? v : []);

/** Normalise un chemin Windows pour comparer insensiblement à la casse et aux / vs \. */
const normPath = (p) =>
    typeof p === "string" ? p.replace(/\//g, "\\").toLowerCase() : p;

/** Racine d’inventaire (FULL & LIGHT actuels + rétro-compat). */
const root = (doc) => doc?.inventory?.inventory || doc?.inventory || {};

/** Clé d’index d’une VM : guid > id > name. */
const vmKey = (vm) => vm?.guid || vm?.id || vm?.name || null;

/** Fabrique une Map<K,V> depuis une liste en extrayant une clé. */
const mapBy = (list, keyFn) => {
    const m = new Map();
    for (const x of arr(list)) {
        const k = keyFn(x);
        if (k) m.set(String(k), x);
    }
    return m;
};

/** Timestamp fiable depuis doc.ts ou inventory.collectedAt (sinon null). */
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

/* ==================================================================== */
/* VM merging (FULL ∪ LIGHT)                                            */
/* ==================================================================== */

/** Champs volatils que l’on surcouche depuis la source la plus fraîche. */
const VOLATILE_FIELDS = [
    "state",
    "uptimeSec",
    "cpuUsagePct",
    "memoryAssignedMB",
    "automaticStart",
    "automaticStop",
];

/**
 * Fusionne une VM “base” avec une VM “overlay” (volatils + VHD fileSizeMB).
 * - Les champs structurels (ex: stockage) proviennent du base.
 * - On surcouche:
 *    * champs volatils
 *    * vhd.fileSizeMB (max entre base et overlay, pour VHDX dynamiques)
 */
function mergeVm(baseVm, overlayVm) {
    if (!overlayVm) return { ...baseVm };

    const out = { ...baseVm };

    // 1) Champs volatils
    for (const k of VOLATILE_FIELDS) {
        if (overlayVm[k] != null) out[k] = overlayVm[k];
    }

    // 2) Disques: conserver structure du base, surcoucher infos connues
    const baseDisks = arr(baseVm.storage);
    const ovDisks = arr(overlayVm.storage);
    const byPath = mapBy(ovDisks, (d) => normPath(d?.path));

    out.storage = baseDisks.map((bd) => {
        const od = byPath.get(normPath(bd?.path));
        if (!od) return bd;

        const bv = bd?.vhd || {};
        const ov = od?.vhd || {};

        const cur = typeof bv.fileSizeMB === "number" ? bv.fileSizeMB : -Infinity;
        const nxt =
            typeof ov.fileSizeMB === "number" ? Math.max(cur, ov.fileSizeMB) : cur;

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
 * Construit, pour un agent, l’UNION des VMs FULL ∪ LIGHT.
 * - Base = FULL si dispo, sinon LIGHT.
 * - Overlay = VM issue de la source la plus fraîche (FULL vs LIGHT), si différente.
 */
function combineAgent(fullDoc, lightDoc) {
    const fullVms = arr(root(fullDoc).vms);
    const lightVms = arr(root(lightDoc).vms);

    const tFull = getTs(fullDoc) ?? -Infinity;
    const tLight = getTs(lightDoc) ?? -Infinity;

    const byFull = mapBy(fullVms, vmKey);
    const byLight = mapBy(lightVms, vmKey);

    // Union des clés (guid/id/name) connues dans FULL et/ou LIGHT
    const keys = new Set([...byFull.keys(), ...byLight.keys()]);

    const out = [];
    for (const k of keys) {
        const vf = byFull.get(k);
        const vl = byLight.get(k);

        // Base: FULL si dispo, sinon LIGHT
        const base = vf || vl;
        if (!base) continue;

        // Overlay: source la plus fraîche (si elle existe)
        const overlay =
            tFull >= tLight ? (tFull === -Infinity ? null : vf) : (tLight === -Infinity ? null : vl);

        out.push(mergeVm(base, overlay));
    }

    return out;
}

/* ==================================================================== */
/* Non-VM extraction (switches, etc.)                                   */
/* ==================================================================== */

/** Extrait (kind=vm|switch) depuis un document d’inventaire. */
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

        // 1) Liens (ressources revendiquées par le tenant)
        const q = { tenantId };
        if (kind) q.kind = kind;
        if (agentId) q.agentId = agentId;

        const links = await TenantResource.find(q).lean();
        if (!links.length) return res.json({ success: true, data: [] });

        // 2) Inventaires FULL & LIGHT pour tous les agents impliqués
        const agentIds = Array.from(new Set(links.map((l) => l.agentId)));

        const [fullDocs, lightDocs] = await Promise.all([
            InventoryFull.find(
                { agentId: { $in: agentIds } },
                { agentId: 1, inventory: 1, ts: 1 }
            ).lean(),
            InventoryLight.find(
                { agentId: { $in: agentIds } },
                { agentId: 1, inventory: 1, ts: 1 }
            ).lean(),
        ]);

        const fullBy = new Map(fullDocs.map((d) => [d.agentId, d]));
        const lightBy = new Map(lightDocs.map((d) => [d.agentId, d]));

        // 3) Pour chaque agent, on prépare un index VM fusionné (FULL ∪ LIGHT)
        const vmIdxByAgent = new Map();
        for (const aId of agentIds) {
            const merged = combineAgent(fullBy.get(aId) || null, lightBy.get(aId) || null);
            const idx = new Map();
            for (const vm of merged) {
                for (const k of [vm.guid, vm.id, vm.name].filter(Boolean).map(String)) {
                    idx.set(k, vm);
                }
            }
            vmIdxByAgent.set(aId, idx);
        }

        // 4) Reconstitue la réponse dans l’ordre des liens
        const out = [];
        for (const l of links) {
            if (l.kind === "vm") {
                const idx = vmIdxByAgent.get(l.agentId) || new Map();

                // Recherche par refId, puis fallback par name (case-insensitive)
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
                // Pour les switches, on reste FULL-first (structure généralement plus riche)
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

            // kind "image" géré ailleurs
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

        // Dédupliquer & retirer ce qui est déjà assigné
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
            const assigned = await TenantResource.find(
                { $or: or },
                { kind: 1, agentId: 1, refId: 1 }
            ).lean();
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
