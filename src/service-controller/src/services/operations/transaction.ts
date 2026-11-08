import mongoose from "mongoose";
import { AsyncLocalStorage } from "node:async_hooks";

// Mongoose propagates the same session to queries, aggregates and saves in this
// async scope. Nested use cases join the outer transaction, never commit alone.
mongoose.set("transactionAsyncLocalStorage", true);
const scope = new AsyncLocalStorage<boolean>();
export async function transaction<T>(work: () => Promise<T>): Promise<T> {
  if (scope.getStore()) return work();
  return mongoose.connection.transaction(() => scope.run(true, work), {
    readPreference: "primary",
    readConcern: { level: "snapshot" },
    writeConcern: { w: "majority" },
    maxCommitTimeMS: 15000,
  });
}
