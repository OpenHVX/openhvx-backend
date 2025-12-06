export interface InventorySnapshot {
    agentId: string;
    ts: Date;
    inventory?: Record<string, unknown>;
    raw?: Record<string, unknown>;
}
