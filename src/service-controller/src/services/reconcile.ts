// src/service-controller/src/services/reconcile.ts

// Not used today, but kept for possible future use.
// Reconcile service:
// - compares TenantResource VM links with the latest inventories (full + light) per agent
// - removes links whose refId/name no longer appear in the agent inventory
// - can run for a single tenant/agent or for all tenants of an agent
import TenantResource from "../models/TenantResource";
import InventoryFull from "../models/Inventory.full";
import InventoryLight from "../models/Inventory.light";
import type { InventorySnapshot } from "../models/types";
import type { TenantResourceLink } from "../models/TenantResource";

type InventoryVm = {
    id?: string;
    name?: string;
};

type InventoryRoot = {
    vms?: InventoryVm[];
};

// Defensively handle possibly missing/partial inventories.
const arr = <T = unknown>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);

const root = (doc?: InventorySnapshot | null): InventoryRoot => {
    const inv = doc?.inventory as InventoryRoot | undefined;
    if (inv && typeof inv === "object" && Object.keys(inv).length) return inv as InventoryRoot;
    return {} as InventoryRoot;
};

const canon = (value?: string | null) =>
    typeof value === "string" ? value.trim().toLowerCase() : "";

const vmKeys = (vm: InventoryVm) => {
    const keys: string[] = [];
    if (vm?.id) keys.push(String(vm.id));
    if (vm?.name && vm.name !== vm.id) keys.push(String(vm.name));
    return keys;
};

async function buildPresentKeySet(agentId: string) {
    const [fullDoc, lightDoc] = await Promise.all([
        InventoryFull.findOne({ agentId }, { inventory: 1 }).lean<InventorySnapshot | null>(),
        InventoryLight.findOne({ agentId }, { inventory: 1 }).lean<InventorySnapshot | null>(),
    ]);

    const present = new Set<string>();

    for (const vm of arr<InventoryVm>(root(fullDoc).vms)) {
        vmKeys(vm).forEach((key) => present.add(canon(key)));
    }
    for (const vm of arr<InventoryVm>(root(lightDoc).vms)) {
        vmKeys(vm).forEach((key) => present.add(canon(key)));
    }

    return present;
}

export interface ReconcileResult {
    removed: number;
    refIds: string[];
}

export async function reconcileTenantAgentVMs({ tenantId, agentId }: { tenantId: string; agentId: string }): Promise<ReconcileResult> {
    // Build a set of VM identifiers currently present in inventory (id and/or name).
    const presentKeys = await buildPresentKeySet(agentId);
    const links = await TenantResource.find(
        { tenantId, agentId, kind: "vm" },
        { _id: 1, refId: 1, name: 1 }
    ).lean<Array<TenantResourceLink & { _id: string; name?: string }>>();

    const toDeleteIds: string[] = [];
    const missing: string[] = [];

    for (const link of links) {
        const refKey = canon(link.refId);
        if (!presentKeys.has(refKey)) {
            toDeleteIds.push(String(link._id));
            missing.push(link.refId);
        }
    }

    if (toDeleteIds.length) {
        await TenantResource.deleteMany({ _id: { $in: toDeleteIds } });
    }

    return { removed: toDeleteIds.length, refIds: missing };
}

export async function reconcileAllTenantsForAgent(agentId: string) {
    const tenants = await TenantResource.distinct("tenantId", { agentId, kind: "vm" });
    const results: Array<{ tenantId: string } & ReconcileResult> = [];
    for (const tenantId of tenants) {
        const outcome = await reconcileTenantAgentVMs({ tenantId, agentId });
        results.push({ tenantId, ...outcome });
    }
    return results;
}
