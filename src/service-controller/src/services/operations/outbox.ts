import { unseal } from "./secrets";
import { randomUUID } from "node:crypto";
import Outbox, { type OutboxPayload } from "../../models/Outbox";
import Task from "../../models/Task";
import { publishTask } from "../amqp";
import { transaction } from "./transaction";
import logger from "../../lib/logger";
const log = logger.child("outbox");
const LEASE_MS = 60000;
export async function dispatchOne(
  publish: typeof publishTask = publishTask,
): Promise<boolean> {
  const owner = randomUUID();
  const now = new Date();
  const item = await Outbox.findOneAndUpdate(
    {
      $or: [
        { state: "pending", availableAt: { $lte: now } },
        { state: "sending", leaseUntil: { $lte: now } },
      ],
    },
    {
      $set: {
        state: "sending",
        owner,
        leaseUntil: new Date(Date.now() + LEASE_MS),
      },
      $inc: { attempts: 1 },
    },
    { new: true, sort: { availableAt: 1 } },
  ).lean();
  if (!item) return false;
  const fence = { _id: item._id, owner, state: "sending" };
  const renew = setInterval(() => {
    void Outbox.updateOne(fence, {
      $set: { leaseUntil: new Date(Date.now() + LEASE_MS) },
    }).catch((error) =>
      log.warn("lease renewal failed", { eventId: item.eventId, error }),
    );
  }, LEASE_MS / 3);
  try {
    const payload = unseal<OutboxPayload>(item.payload);
    await publish({
      ...payload,
      eventId: item.eventId,
      contractVersion: item.contractVersion,
    });
    await transaction(async () => {
      const updated = await Outbox.updateOne(fence, {
        $set: { state: "delivered", deliveredAt: new Date() },
        $unset: { payload: 1, owner: 1, leaseUntil: 1, lastError: 1 },
      });
      if (updated.modifiedCount)
        await Task.updateOne(
          { taskId: item.operationId, status: "queued" },
          { $set: { status: "sent", publishedAt: new Date() } },
        );
    });
  } catch (error) {
    const delay =
      Math.min(300000, 1000 * 2 ** Math.min(item.attempts, 8)) *
      (0.75 + Math.random() / 2);
    await Outbox.updateOne(fence, {
      $set: {
        state: item.attempts >= 20 ? "quarantined" : "pending",
        availableAt: new Date(Date.now() + delay),
        lastError:
          "Publication failed; inspect broker connectivity and routing",
      },
      $unset: { owner: 1, leaseUntil: 1 },
    });
    log.warn("publication deferred", {
      eventId: item.eventId,
      attempts: item.attempts,
    });
  } finally {
    clearInterval(renew);
  }
  return true;
}
export function startOutbox() {
  let stopped = false;
  const done = (async () => {
    while (!stopped) {
      try {
        if (await dispatchOne()) continue;
      } catch (error) {
        log.error("dispatcher failed", { error });
      }
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  })();
  return async () => {
    stopped = true;
    await done;
  };
}
