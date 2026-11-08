import type { Model, FilterQuery } from "mongoose";

// Keep the newest producer timestamp even when older messages arrive later.
// $literal prevents inventory values being interpreted as aggregation syntax.
export async function saveSnapshot<T>(
  model: Model<T>,
  key: FilterQuery<T>,
  snapshot: Record<string, unknown>,
  timestamp = "ts",
) {
  const newer = {
    $lte: [
      { $ifNull: [`$${timestamp}`, new Date(0)] },
      { $literal: snapshot[timestamp] },
    ],
  };
  const set = Object.fromEntries(
    Object.entries(snapshot).map(([field, value]) => [
      field,
      { $cond: [newer, { $literal: value }, `$${field}`] },
    ]),
  );
  try {
    await model.updateOne(key, [{ $set: set }], { upsert: true });
  } catch (error) {
    if ((error as { code?: number }).code !== 11000) throw error;
    // A simultaneous first snapshot won the unique key. Retry as an update.
    await model.updateOne(key, [{ $set: set }]);
  }
}
