//models/types.ts
import type { CanonicalInventory } from "../types/inventory/canonical";

export interface InventorySnapshot {
    agentId: string;
    ts: Date;
    /**
     * Canonical inventory payload as sent by the agent.
     * Stored verbatim so downstream readers can project whatever slices they need.
     */
    inventory?: CanonicalInventory | Record<string, unknown>;
    raw?: Record<string, unknown>;
}
