// controllers/resourcesController.js
// NOTE: Images moved to Image Repository (SMB) -> handled by imagesController (no DB/inventory).
const TenantResource = require("../models/TenantResource");
const InventoryFull = require("../models/Inventory.full");
const InventoryLight = require("../models/Inventory.light");

/* ============================ Helpers généraux ============================ */

function resolveTenantId(req) {
    return req.params?.tenantId || req.tenantId || req.user?.tenantId || null;
}

function byIdOrName(vm) {
    return vm?.guid || vm?.id || vm?.name || null;
}

function indexBy(list, keyFn) {
    const m = new Map();
    (list || []).forEach((x) => {
        const k = keyFn(x);
        if (k) m.set(k, x);
    });
    return m;
}

function normalizePath(p) {
    return typeof p === "string" ? p.replace(/\//g, "\\").toLowerCase() : p;
}

function safeArray(v) {
    return Array.isArray(v) ? v : [];
}

/** Extrait la branche structure (VMs, networks...) depuis un doc (full ou light) */
function invRoot(doc) {
    // schéma attendu: { agentId, inventory: { inventory: {...}, datastores: [...], images: [...] } }
    // Ici on ne lit QUE la structure (vms, networks, etc.)
    return doc?.inventory?.inventory || {};
}

/* ========================= Fusion Full + Light (VM) ======================= */

function mergeVM(vmFull, vmLight) {
    if (!vmFull && !vmLight) return null;

    // base = full si dispo (structure + champs lourds), sinon light
    const out = vmFull ? { ...vmFull } : { ...vmLight };

    // champs dynamiques depuis le light (si présents)
    if (vmLight) {
        const dyn = [
            "state",
            "uptimeSec",
            "cpuUsagePct",
            "memoryAssignedMB",
            "automaticStart",
            "automaticStop",
        ];
        for (const k of dyn) {
            if (vmLight[k] != null) out[k] = vmLight[k];
        }
    }

    // storage: partir du full (sizeMB, structure) et n’actualiser QUE fileSizeMB depuis le light
    const fullDisks = safeArray(vmFull?.storage);
    const lightDisks = safeArray(vmLight?.storage);
    const lightByPath = indexBy(lightDisks, (d) => normalizePath(d?.path));

    const mergedDisks = fullDisks.map((fd) => {
        const key = normalizePath(fd?.path);
        const ld = lightByPath.get(key);
        if (!ld) return fd;

        const outDisk = { ...fd };
        // vhd: on garde sizeMB du full; fileSizeMB = max(cur, light)
        const fullVhd = fd?.vhd || {};
        const lightVhd = ld?.vhd || {};
        const curUsed = typeof fullVhd.fileSizeMB === "number" ? fullVhd.fileSizeMB : -Infinity;
        const newUsed =
            typeof lightVhd.fileSizeMB === "number" ? Math.max(curUsed, lightVhd.fileSizeMB) : curUsed;

        outDisk.vhd = {
            ...fullVhd,
            format: fullVhd.format ?? lightVhd.format ?? null,
            type: fullVhd.type ?? lightVhd.type ?? null,
            sizeMB: fullVhd.sizeMB ?? null,
            fileSizeMB: Number.isFinite(newUsed) ? newUsed : fullVhd.fileSizeMB ?? null,
            parentPath: fullVhd.parentPath ?? null,
            blockSize: fullVhd.blockSize ?? null,
            logicalSectorSize: fullVhd.logicalSectorSize ?? null,
            physicalSectorSize: fullVhd.physicalSectorSize ?? null,
        };

        return outDisk;
    });

    // si le full n’avait pas ce disque mais le light oui → on peut l’ajouter (sans sizeMB)
    for (const ld of lightDisks) {
        const key = normalizePath(ld?.path);
        if (!mergedDisks.some((d) => normalizePath(d?.path) === key)) {
            mergedDisks.push({ ...ld });
        }
    }
    out.storage = mergedDisks;

    return out;
}

/** Fusionne l’ensemble des VMs d’un agent (full + light) */
function aggregateVMs(fullDoc, lightDoc) {
    const fullVMs = safeArray(invRoot(fullDoc).vms);
    const lightVMs = safeArray(invRoot(lightDoc).vms);
    const byFull = indexBy(fullVMs, byIdOrName);
    const byLight = indexBy(lightVMs, byIdOrName);

    const ids = new Set([...byFull.keys(), ...byLight.keys()]);
    const merged = [];
    for (const id of ids) {
        merged.push(mergeVM(byFull.get(id), byLight.get(id)));
    }
    return merged.filter(Boolean);
}

/* =========================== Extraction ressources ======================== */

function extractResourcesFromInventoryDoc(invDoc, { kind, agentId }) {
    const out = [];
    const aId = agentId || invDoc.agentId;
    const inv = invRoot(invDoc);

    if (!kind || kind === "vm") {
        const vms = safeArray(inv.vms);
        for (const vm of vms) {
            const refId = byIdOrName(vm);
            if (refId) out.push({ kind: "vm", agentId: aId, refId, data: vm });
        }
    }

    if (!kind || kind === "switch") {
        const switches = safeArray(inv?.networks?.switches);
        for (const sw of switches) {
            const refId = sw?.name;
            if (refId) out.push({ kind: "switch", agentId: aId, refId, data: sw });
        }
    }

    return out;
}

/* =============================== Contrôleurs ============================== */

/**
 * GET (tenant)  /api/v1/tenant/resources?kind=vm&agentId=HOST-1
 * GET (admin)   /api/v1/admin/:tenantId/resources?kind=vm&agentId=HOST-1
 * -> renvoie les ressources (agrégées full+light) appartenant au tenant.
 *    (Images exclues: voir imagesController pour le repository SMB)
 */
exports.listResources = async (req, res) => {
    try {
        const tenantId = resolveTenantId(req);
        if (!tenantId) return res.status(400).json({ error: "Missing tenant context" });

        const { kind, agentId } = req.query;

        const filter = { tenantId };
        if (kind) filter.kind = kind;
        if (agentId) filter.agentId = agentId;

        const links = await TenantResource.find(filter).lean();
        if (!links.length) return res.json({ success: true, data: [] });

        // agents concernés
        const agentIds = Array.from(new Set(links.map((l) => l.agentId)));

        // lecture simultanée de full + light
        const [fullDocs, lightDocs] = await Promise.all([
            InventoryFull.find({ agentId: { $in: agentIds } }, { agentId: 1, inventory: 1 }).lean(),
            InventoryLight.find({ agentId: { $in: agentIds } }, { agentId: 1, inventory: 1 }).lean(),
        ]);
        const mapFull = new Map(fullDocs.map((d) => [d.agentId, d]));
        const mapLight = new Map(lightDocs.map((d) => [d.agentId, d]));

        const resources = [];
        for (const link of links) {
            const f = mapFull.get(link.agentId) || null;
            const l = mapLight.get(link.agentId) || null;

            if (link.kind === "vm") {
                const mergedVMs = aggregateVMs(f, l);
                const vm = mergedVMs.find(
                    (v) => v.guid === link.refId || v.id === link.refId || v.name === link.refId
                );
                if (vm) resources.push({ ...vm, tenantId, agentId: link.agentId, kind: "vm", refId: link.refId });
            }

            if (link.kind === "switch") {
                const inv = invRoot(f) || {};
                const swList = safeArray(inv?.networks?.switches);
                const sw = swList.find((s) => s.name === link.refId);
                if (sw) resources.push({ ...sw, tenantId, agentId: link.agentId, kind: "switch", refId: link.refId });
            }

            // NOTE: kind "image" n'est plus géré ici.
        }

        res.json({ success: true, data: resources });
    } catch (e) {
        console.error("listResources error:", e);
        res.status(500).json({ error: "Server error" });
    }
};

/**
 * POST (tenant)  /api/v1/tenant/resources/claim
 * POST (admin)   /api/v1/admin/:tenantId/resources/claim
 * body: { kind, agentId, refIds: ["<guid-or-name>", ...] }
 */
exports.claimResources = async (req, res) => {
    try {
        const tenantId = resolveTenantId(req);
        if (!tenantId) return res.status(400).json({ error: "Missing tenant context" });

        const { kind, agentId, refIds } = req.body;
        if (!kind || !agentId || !Array.isArray(refIds) || refIds.length === 0) {
            return res.status(400).json({ error: "kind, agentId and non-empty refIds[] required" });
        }

        const ops = refIds.map((refId) => ({
            updateOne: {
                filter: { kind, agentId, refId },
                update: { $setOnInsert: { tenantId, assignedAt: new Date() } },
                upsert: true,
            },
        }));

        await TenantResource.bulkWrite(ops);
        res.json({ success: true });
    } catch (e) {
        console.error("claimResources error:", e);
        res.status(500).json({ error: "Server error" });
    }
};

/**
 * DELETE (tenant)  /api/v1/tenant/resources/:resourceId?kind=vm&agentId=HOST-1
 * DELETE (admin)   /api/v1/admin/:tenantId/resources/:resourceId?kind=vm&agentId=HOST-1
 */
exports.unclaimResource = async (req, res) => {
    try {
        const tenantId = resolveTenantId(req);
        if (!tenantId) return res.status(400).json({ error: "Missing tenant context" });

        const { resourceId } = req.params; // == refId
        const { kind, agentId } = req.query;

        if (!resourceId || !kind || !agentId) {
            return res.status(400).json({ error: "resourceId param and kind/agentId query params are required" });
        }

        await TenantResource.deleteOne({ tenantId, kind, agentId, refId: resourceId });
        res.json({ success: true });
    } catch (e) {
        console.error("unclaimResource error:", e);
        res.status(500).json({ error: "Server error" });
    }
};

/**
 * GET (admin/global) /api/v1/admin/resources/unassigned?kind=vm|switch&agentId=HOST-1&limit=100
 * Liste les ressources présentes dans Inventory FULL (structure) mais absentes de TenantResource.
 * (Images exclues)
 */
exports.listUnassignedResources = async (req, res) => {
    try {
        const { kind, agentId } = req.query;
        const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);

        // 1) Charger les inventories full pertinents (structure suffisante)
        const invFilter = {};
        if (agentId) invFilter.agentId = agentId;
        const invDocs = await InventoryFull.find(invFilter, { agentId: 1, inventory: 1 }).lean();

        // 2) Extraire toutes les ressources candidates
        const candidates = [];
        for (const doc of invDocs) {
            candidates.push(...extractResourcesFromInventoryDoc(doc, { kind, agentId: doc.agentId }));
        }
        if (candidates.length === 0) return res.json({ success: true, data: [] });

        // 3) Rechercher les mappings existants pour exclure les déjà assignées
        const key = (r) => `${r.kind}|${r.agentId}|${r.refId}`;
        const uniqueTriples = Array.from(new Set(candidates.map(key)));

        const batchSize = 500;
        const assignedSet = new Set();
        for (let i = 0; i < uniqueTriples.length; i += batchSize) {
            const slice = uniqueTriples.slice(i, i + batchSize);
            const or = slice.map((k) => {
                const [knd, aId, ref] = k.split("|");
                return { kind: knd, agentId: aId, refId: ref };
            });
            const assigned = await TenantResource.find({ $or: or }, { kind: 1, agentId: 1, refId: 1 }).lean();
            for (const a of assigned) assignedSet.add(key(a));
        }

        // 4) Filtrer pour ne garder que les non assignées
        const unassigned = [];
        for (const c of candidates) {
            const k = key(c);
            if (!assignedSet.has(k)) unassigned.push(c);
            if (unassigned.length >= limit) break;
        }

        // 5) Réponse
        res.json({
            success: true,
            count: unassigned.length,
            data: unassigned.map((r) => ({
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
        res.status(500).json({ error: "Server error" });
    }
};
