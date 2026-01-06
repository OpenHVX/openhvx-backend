// src/service-controller/src/models/types.ts


import type { CanonicalInventory } from "../types/inventory/canonical";

export interface InventorySnapshot {
    agentId: string;
    ts: Date;
    inventory?: CanonicalInventory | Record<string, unknown>;
    raw?: Record<string, unknown>;
}
