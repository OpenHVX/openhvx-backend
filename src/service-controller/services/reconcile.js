// services/resourcesReconcile.js
// Remove TenantResource links for VMs no longer present in agent inventory.
// Strategy:
//  - Build PRESENT SET from FULL ∪ LIGHT (by guid, id, name as fallbacks).
//  - For each tenant having VM links on this agent, delete links whose refId ∉ PRESENT.
// Notes:
//  - Run on FULL inventory commit (not LIGHT) to avoid transient false negatives.

const TenantResource = require("../models/TenantResource");
const InventoryFull = require("../models/Inventory.full");
const InventoryLight = require("../models/Inventory.light");

// helpers
const arr = (v) => (Array.isArray(v) ? v : []);
const root = (doc) => doc?.inventory?.inventory || doc?.inventory || {};

function canon(x) {
    return typeof x === "string" ? x.trim().toLowerCase() : x;
}
function vmKeys(vm) {
    // prefer guid/id; name only as last resort (for legacy links)
    const keys = [];
    if (vm?.guid) keys.push(String(vm.guid));
    if (vm?.id && vm.id !== vm.guid) keys.push(String(vm.id));
    if (vm?.name && vm.name !== vm.guid && vm.name !== vm.id) keys.push(String(vm.name));
    return keys;
}

async function buildPresentKeySet(agentId) {
    const [fullDoc, lightDoc] = await Promise.all([
        InventoryFull.findOne({ agentId }, { inventory: 1 }).lean(),
        InventoryLight.findOne({ agentId }, { inventory: 1 }).lean(),
    ]);

    const present = new Set();

    // FULL
    for (const vm of arr(root(fullDoc).vms)) {
        for (const k of vmKeys(vm)) present.add(canon(k));
    }
    // LIGHT (union) — harmless if FULL is already complete
    for (const vm of arr(root(lightDoc).vms)) {
        for (const k of vmKeys(vm)) present.add(canon(k));
    }

    return present;
}

/**
 * Reconcile a single tenant on a given agent (kind=vm).
 * Deletes TenantResource links whose refId is not present in FULL ∪ LIGHT.
 */
async function reconcileTenantAgentVMs({ tenantId, agentId }) {
    const present = await buildPresentKeySet(agentId);

    // Load existing links for this tenant/agent/kind=vm
    const links = await TenantResource.find(
        { tenantId, agentId, kind: "vm" },
        { _id: 1, refId: 1 }
    ).lean();

    const toDeleteIds = [];
    const missing = [];

    for (const l of links) {
        const refK = canon(l.refId);
        if (!present.has(refK)) {
            toDeleteIds.push(l._id);
            missing.push(l.refId);
        }
    }

    if (toDeleteIds.length) {
        await TenantResource.deleteMany({ _id: { $in: toDeleteIds } });
    }

    return { removed: toDeleteIds.length, refIds: missing };
}

/**
 * Reconcile all tenants that have VM links on this agent.
 */
async function reconcileAllTenantsForAgent(agentId) {
    const tenants = await TenantResource.distinct("tenantId", {
        agentId,
        kind: "vm",
    });
    const results = [];
    for (const tenantId of tenants) {
        const r = await reconcileTenantAgentVMs({ tenantId, agentId });
        results.push({ tenantId, ...r });
    }
    return results;
}

module.exports = {
    reconcileTenantAgentVMs,
    reconcileAllTenantsForAgent,
};
