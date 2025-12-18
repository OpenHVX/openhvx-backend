import { Schema, model, type HydratedDocument, type Model } from "mongoose";
import type { StorageInventoryPayload } from "../types/inventory/storage";

export interface InventoryStorageSnapshot {
    storageId: string;
    ts: Date;
    inventory?: StorageInventoryPayload | Record<string, unknown>;
    raw?: Record<string, unknown>;
}

export type InventoryStorageDocument = HydratedDocument<InventoryStorageSnapshot>;

export type InventoryStorageModel = Model<InventoryStorageSnapshot>;

const inventoryStorageSchema = new Schema<InventoryStorageSnapshot>(
    {
        storageId: { type: String, index: true },
        ts: { type: Date, index: true },
        inventory: { type: Object },
        raw: { type: Object },
    },
    { minimize: false }
);

const InventoryStorage = model<InventoryStorageSnapshot>("InventoryStorage", inventoryStorageSchema);

export default InventoryStorage;
