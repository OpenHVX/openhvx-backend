//models/Inventory.full.ts
import { Schema, model, type HydratedDocument, type Model } from "mongoose";
import type { InventorySnapshot } from "./types";

export type InventoryDocument = HydratedDocument<InventorySnapshot>;

export type InventoryModel = Model<InventorySnapshot>;

const inventorySchema = new Schema<InventorySnapshot>(
    {
        agentId: { type: String, index: true },
        ts: { type: Date, index: true },
        inventory: { type: Object },
        raw: { type: Object },
    },
    { minimize: false }
);

const InventoryFull = model<InventorySnapshot>("InventoryFull", inventorySchema);

export default InventoryFull;
