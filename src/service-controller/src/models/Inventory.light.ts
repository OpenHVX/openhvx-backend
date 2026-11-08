// src/service-controller/src/models/Inventory.light.ts
// Mongoose model for light inventory snapshots

import { Schema, model, type HydratedDocument, type Model } from "mongoose";
import type { InventorySnapshot } from "./types";

export type InventoryLightDocument = HydratedDocument<InventorySnapshot>;

export type InventoryLightModel = Model<InventorySnapshot>;

const inventoryLightSchema = new Schema<InventorySnapshot>(
    {
        agentId: { type: String, required: true },
        ts: { type: Date, index: true },
        inventory: { type: Object },
        raw: { type: Object },
    },
    { minimize: false }
);

inventoryLightSchema.index({ agentId: 1 }, { unique: true });

const InventoryLight = model<InventorySnapshot>("InventoryLight", inventoryLightSchema);

export default InventoryLight;
