import Heartbeat from "../models/Heartbeat";
import "dotenv/config";
import mongoose, { type Model } from "mongoose";
import InventoryFull from "../models/Inventory.full";
import InventoryLight from "../models/Inventory.light";
import InventoryStorage from "../models/Inventory.storage";

type DuplicateGroup = {
    _id: string;
    ids: mongoose.Types.ObjectId[];
    count: number;
};

const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/hvwm";
const apply = process.argv.includes("--apply");

async function dedupe(model: Model<any>, key: "agentId" | "storageId", timestamp = "ts") {
    const groups = await model.aggregate<DuplicateGroup>([
        { $sort: { [timestamp]: -1, _id: -1 } },
        {
            $group: {
                _id: `$${key}`,
                ids: { $push: "$_id" },
                count: { $sum: 1 },
            },
        },
        { $match: { _id: { $ne: null }, count: { $gt: 1 } } },
    ]);

    let redundant = 0;
    for (const group of groups) redundant += Math.max(0, group.ids.length - 1);
    console.info(`${model.modelName}: duplicateGroups=${groups.length} redundantDocuments=${redundant}`);

    if (!apply) return;
    for (const group of groups) {
        await model.deleteMany({ _id: { $in: group.ids.slice(1) } });
    }
    await model.syncIndexes();
    console.info(`${model.modelName}: unique index synchronized`);
}

async function main() {
    await mongoose.connect(MONGO_URL, { autoIndex: false, autoCreate: false });
    try {
        await dedupe(InventoryFull, "agentId");
        await dedupe(InventoryLight, "agentId");
        await dedupe(InventoryStorage, "storageId");
        await dedupe(Heartbeat, "agentId", "lastSeen");
        if (!apply) {
            console.info("Dry run only. Re-run with --apply to delete stale duplicates and synchronize indexes.");
        }
    } finally {
        await mongoose.disconnect();
    }
}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});
