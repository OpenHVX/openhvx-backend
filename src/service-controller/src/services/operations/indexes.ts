import Task from "../../models/Task";
import ResourceLock from "../../models/ResourceLock";
import Outbox from "../../models/Outbox";
import Inbox from "../../models/Inbox";
import Idempotency from "../../models/Idempotency";
import QuotaHold from "../../models/quota/hold";
import Heartbeat from "../../models/Heartbeat";
import TenantResource from "../../models/TenantResource";

// Shared by startup and migration. Explicit creation also works with autoIndex disabled.
// Await before starting workers or accepting requests; a conflicting index must fail closed.
export async function ensureOperationIndexes(): Promise<void> {
  for (const model of [Task, ResourceLock, Outbox, Inbox, Idempotency, QuotaHold, Heartbeat, TenantResource]) {
    await model.createIndexes();
  }
}
