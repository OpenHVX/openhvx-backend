// controllers/resourcesController.js
const TenantResource = require("../models/TenantResource");
const Inventory = require("../models/Inventory");

/**
 * Résout le tenantId selon la route:
 * - admin.routes.js : /:tenantId/resources  -> req.params.tenantId
 * - tenant.routes.js : /resources           -> req.tenantId (fourni par middleware/JWT)
 */
function resolveTenantId(req) {
    return req.params?.tenantId || req.tenantId || req.user?.tenantId || null;
}

/**
 * Helpers: extraire les ressources depuis l'inventaire brut
 * Convention: refId VM = guid si dispo, sinon id, sinon name ; switch refId = name
 */
function extractResourcesFromInventoryDoc(invDoc, { kind, agentId }) {
    const out = [];
    const aId = agentId || invDoc.agentId;
    const inv = invDoc?.inventory?.inventory || {};

    if (!kind || kind === "vm") {
        const vms = Array.isArray(inv.vms) ? inv.vms : [];
        for (const vm of vms) {
            const refId = vm?.guid || vm?.id || vm?.name;
            if (refId) out.push({ kind: "vm", agentId: aId, refId, data: vm });
        }
    }

    if (!kind || kind === "switch") {
        const switches = Array.isArray(inv.switches) ? inv.switches : [];
        for (const sw of switches) {
            const refId = sw?.name;
            if (refId) out.push({ kind: "switch", agentId: aId, refId, data: sw });
        }
    }

    return out;
}

/**
 * GET (tenant)  /api/v1/tenant/resources?kind=vm&agentId=HOST-1
 * GET (admin)   /api/v1/admin/:tenantId/resources?kind=vm&agentId=HOST-1
 * Retourne les ressources (infos enrichies depuis Inventory) appartenant au tenant.
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

        // Récupère tous les inventories nécessaires en un seul round-trip
        const agentIds = Array.from(new Set(links.map(l => l.agentId)));
        const invDocs = await Inventory.find(
            { agentId: { $in: agentIds } },
            { agentId: 1, inventory: 1 }
        ).lean();
        const invByAgent = new Map(invDocs.map(d => [d.agentId, d]));

        const resources = [];
        for (const link of links) {
            const inv = invByAgent.get(link.agentId);
            if (!inv) continue;

            if (link.kind === "vm") {
                const vms = Array.isArray(inv.inventory?.inventory?.vms) ? inv.inventory.inventory.vms : [];
                const vm = vms.find(
                    v => v.guid === link.refId || v.id === link.refId || v.name === link.refId
                );
                if (vm) resources.push({ ...vm, tenantId, agentId: link.agentId, kind: "vm", refId: link.refId });
            }

            if (link.kind === "switch") {
                const switches = Array.isArray(inv.inventory?.inventory?.switches) ? inv.inventory.inventory.switches : [];
                const sw = switches.find(s => s.name === link.refId);
                if (sw) resources.push({ ...sw, tenantId, agentId: link.agentId, kind: "switch", refId: link.refId });
            }
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

        const ops = refIds.map(refId => ({
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
 * Liste les ressources présentes dans Inventory mais absentes de TenantResource.
 * (Pas de tenantId ici, c'est un listing global pour “à assigner”)
 */
exports.listUnassignedResources = async (req, res) => {
    try {
        const { kind, agentId } = req.query;
        const limit = Math.min(parseInt(req.query.limit || "100", 10), 500);

        // 1) Charger les inventories pertinents
        const invFilter = {};
        if (agentId) invFilter.agentId = agentId;
        const invDocs = await Inventory.find(invFilter, { agentId: 1, inventory: 1 }).lean();

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
