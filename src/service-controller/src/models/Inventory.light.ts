import { Schema, model, type HydratedDocument, type Model } from "mongoose";
import type { InventorySnapshot } from "./types";

export type InventoryLightDocument = HydratedDocument<InventorySnapshot>;

export type InventoryLightModel = Model<InventorySnapshot>;

const inventoryLightSchema = new Schema<InventorySnapshot>(
    {
        agentId: { type: String, index: true },
        ts: { type: Date, index: true },
        inventory: { type: Object },
        raw: { type: Object },
    },
    { minimize: false }
);

const InventoryLight = model<InventorySnapshot>("InventoryLight", inventoryLightSchema);

export default InventoryLight;
