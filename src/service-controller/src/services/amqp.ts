import { saveSnapshot } from "./operations/snapshots";
import { applyTaskResult, InvalidResult } from "./operations/results";
import "dotenv/config";
// src/service-controller/src/services/amqp.ts
// AMQP service for task publishing and telemetry consumption

import {
    connect as connectAmqp,
    type Channel,
    type ChannelModel as Connection,
    type ConfirmChannel,
    type ConsumeMessage,
    type Options,
} from "amqplib";


import type { Model } from "mongoose";
import InventoryFull from "../models/Inventory.full";
import InventoryLight from "../models/Inventory.light";
import InventoryStorage from "../models/Inventory.storage";
import type { TaskRecord } from "../models/Task";
import type { Heartbeat } from "../models/Heartbeat";
import logger from "../lib/logger";
import { parseTaskResult, type TaskResultPayload } from "../lib/schemas/task-result";

const log = logger.child("amqp");
const logPub = log.child("publish");
const logTel = log.child("telemetry");
const logInv = log.child(["telemetry", "inventory"]);
const logRes = log.child("results");
// A channel can close between commit and ack. The broker owns redelivery;
// attempting a second nack on a closed channel must not crash the process.
const settleDelivery = (channel: Channel, msg: ConsumeMessage, requeue?: boolean) => {
    try {
        if (requeue === undefined) channel.ack(msg);
        else channel.nack(msg, false, requeue);
    } catch { log.warn("Delivery channel closed before settlement; awaiting broker redelivery"); }
};


const RMQ_URL = process.env.RMQ_URL || "amqp://guest:guest@localhost:5672/";
if (process.env.NODE_ENV === "production") {
    const url = new URL(RMQ_URL);
    if (!process.env.RMQ_URL || url.username === "guest" || ["guest", "change-me-rabbitmq"].includes(decodeURIComponent(url.password))) throw new Error("Production requires explicit RabbitMQ credentials");
}
const queueType = process.env.AMQP_QUEUE_TYPE || "classic";
if (!["classic", "quorum"].includes(queueType)) throw new Error("AMQP_QUEUE_TYPE must be classic or quorum");
const queueArguments = () => ({ "x-queue-type": queueType });
const JOBS_EX = process.env.JOBS_EXCHANGE || "jobs";
const TELE_EX = process.env.TELEMETRY_EXCHANGE || "agent.telemetry";
const RES_EX = process.env.RESULTS_EXCHANGE || "results";
const CONNECT_RETRY_BASE_MS = 1_000;
const CONNECT_RETRY_MAX_MS = 30_000;
const DEFAULT_CONNECT_MAX_ATTEMPTS = Number(process.env.AMQP_CONNECT_MAX_ATTEMPTS || 6);

let stopping = false;
let initialized = false;
let conn: Connection | null = null;
let ch: ConfirmChannel | null = null;
let connectPromise: Promise<ConfirmChannel> | null = null;
const assertedQueues = new Set<string>();
const consumerRegistrations = new Map<string, (channel: ConfirmChannel) => Promise<void>>();

export const amqpHealth = () => ({
    ready: Boolean(conn && ch && initialized),
    connecting: Boolean(connectPromise),
    consumers: consumerRegistrations.size,
});

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

const resetConnectionState = ({
    connection,
    channel,
    reason,
    error,
}: {
    connection?: Connection | null;
    channel?: Channel | null;
    reason: string;
    error?: unknown;
}) => {
    if (connection && conn && connection !== conn) return;
    if (channel && ch && channel !== ch) return;
    if (ch || conn) {
        log.warn("connection state reset", {
            reason,
            error: error instanceof Error ? error.message : error,
        });
    }
    const previous = conn;
    initialized = false;
    ch = null;
    conn = null;
    if (previous) void previous.close().catch(() => undefined);
    assertedQueues.clear();
};

const redactAmqpUrl = (url: string) => {
    try {
        const parsed = new URL(url);
        if (parsed.username) parsed.username = "***";
        if (parsed.password) parsed.password = "***";
        return parsed.toString();
    } catch {
        return "<invalid-amqp-url>";
    }
};

const scheduleReconnect = (reason: string) => {
    if (stopping || !consumerRegistrations.size) return;
    if (ch || connectPromise) return;
    void connect({ reason, maxAttempts: Number.POSITIVE_INFINITY }).catch((error) => {
        log.error("background reconnect failed", { reason, error });
    });
};

const wireConnectionLifecycle = (connection: Connection, channel: ConfirmChannel) => {
    channel.on("error", (error) => {
        log.error("channel error", { error });
        resetConnectionState({ connection, channel, reason: "channel error", error });
        scheduleReconnect("channel error");
    });
    channel.on("close", () => {
        log.error("channel closed");
        resetConnectionState({ connection, channel, reason: "channel close" });
        scheduleReconnect("channel close");
    });
    connection.on("error", (error) => {
        log.error("connection error", { error });
        resetConnectionState({ connection, channel, reason: "connection error", error });
        scheduleReconnect("connection error");
    });
    connection.on("close", () => {
        log.error("connection closed");
        resetConnectionState({ connection, channel, reason: "connection close" });
        scheduleReconnect("connection close");
    });
};

const registerConsumer = async (key: string, setup: (channel: ConfirmChannel) => Promise<void>) => {
    if (consumerRegistrations.has(key)) return;
    const hadLiveChannel = Boolean(ch && initialized);
    consumerRegistrations.set(key, setup);
    if (hadLiveChannel && ch) {
        initialized = false;
        await setup(ch);
        initialized = true;
        log.info("consumer registered", { key });
        return;
    }
    await connect({ reason: `register:${key}`, maxAttempts: Number.POSITIVE_INFINITY });
};

const initializeChannel = async (channel: ConfirmChannel) => {
    await channel.assertExchange(JOBS_EX, "direct", { durable: true });
    await channel.assertExchange(TELE_EX, "topic", { durable: true });
    await channel.assertExchange(RES_EX, "topic", { durable: true });

    await channel.assertQueue("telemetry.invalid.v2", { durable: true, arguments: queueArguments() });
    await channel.assertQueue("agent.heartbeats.v2", {
        durable: true,
        arguments: { ...queueArguments(), "x-dead-letter-exchange": "", "x-dead-letter-routing-key": "telemetry.invalid.v2", "x-message-ttl": 120_000, "x-max-length": 2000 },
    });
    await channel.assertQueue("agent.inventories.v2", { durable: true, arguments: { ...queueArguments(), "x-dead-letter-exchange": "", "x-dead-letter-routing-key": "telemetry.invalid.v2" } });
    await channel.assertQueue("storage.inventories.v2", { durable: true, arguments: { ...queueArguments(), "x-dead-letter-exchange": "", "x-dead-letter-routing-key": "telemetry.invalid.v2" } });

    await channel.bindQueue("agent.heartbeats.v2", TELE_EX, "heartbeat.*");
    await channel.bindQueue("agent.inventories.v2", TELE_EX, "inventory.*");
    await channel.bindQueue("storage.inventories.v2", TELE_EX, "inventory.storage.*");

    await channel.prefetch(50);

    for (const [key, setup] of consumerRegistrations.entries()) {
        await setup(channel);
        log.info("consumer re-registered", { key });
    }
};

const isLightInventory = (headers: Record<string, unknown>, env: Record<string, unknown>) => {
    const mode = headers?.["x-merge-mode"] || env?.mergeMode;
    const source = headers?.["x-source"] || env?.source;
    return mode === "patch-nondestructive" || source === "inventory.refresh.light";
};

const toInventoryPayload = (env: Record<string, unknown>) => {
    const candidate =
        (env?.inventory && typeof env.inventory === "object" ? env.inventory : env) ||
        {};

    const agentId =
        (env.agentId as string | undefined) ||
        (candidate as Record<string, unknown>).agentId ||
        undefined;

    const tsRawCandidate =
        (env.ts as unknown) ||
        (candidate as Record<string, unknown>).collectedAt ||
        (candidate as Record<string, unknown>).ts ||
        undefined;

    const tsRaw =
        typeof tsRawCandidate === "string" ||
        typeof tsRawCandidate === "number" ||
        tsRawCandidate instanceof Date
            ? tsRawCandidate
            : undefined;

    const parsedTs = tsRaw ? new Date(tsRaw) : new Date();
    const ts = Number.isFinite(parsedTs.getTime()) ? parsedTs : new Date();

    return {
        agentId,
        ts,
        inventory: candidate as Record<string, unknown>,
    };
};

const toStorageInventoryPayload = (env: Record<string, unknown>) => {
    const candidate =
        (env?.inventory && typeof env.inventory === "object" ? env.inventory : env) ||
        {};

    const storageId =
        (env.storageId as string | undefined) ||
        (candidate as Record<string, unknown>).storageId ||
        (candidate as Record<string, unknown>).clusterId ||
        undefined;

    const tsRawCandidate =
        (env.ts as unknown) ||
        (candidate as Record<string, unknown>).collectedAt ||
        (candidate as Record<string, unknown>).ts ||
        undefined;

    const tsRaw =
        typeof tsRawCandidate === "string" ||
        typeof tsRawCandidate === "number" ||
        tsRawCandidate instanceof Date
            ? tsRawCandidate
            : undefined;

    const parsedTs = tsRaw ? new Date(tsRaw) : new Date();
    const ts = Number.isFinite(parsedTs.getTime()) ? parsedTs : new Date();

    return {
        storageId,
        ts,
        inventory: candidate as Record<string, unknown>,
    };
};

export async function connect({
    reason = "demand",
    maxAttempts = DEFAULT_CONNECT_MAX_ATTEMPTS,
}: {
    reason?: string;
    maxAttempts?: number;
} = {}): Promise<ConfirmChannel> {
    if (ch && initialized) return ch;
    if (connectPromise) return connectPromise;

    connectPromise = (async () => {
        let attempt = 0;
        while (!stopping && (attempt < maxAttempts || !Number.isFinite(maxAttempts))) {
            attempt += 1;
            try {
                log.info("connecting", { url: redactAmqpUrl(RMQ_URL), reason, attempt });
                const connection = await connectAmqp(RMQ_URL, { timeout: 10000 });
                const channel = await connection.createConfirmChannel();
                conn = connection;
                ch = channel;
                assertedQueues.clear();
                wireConnectionLifecycle(connection, channel);
                await initializeChannel(channel);
                initialized = true;
                log.info("connected", { url: redactAmqpUrl(RMQ_URL), reason, attempt });
                return channel;
            } catch (error) {
                resetConnectionState({ reason: "connect failure", error });
                const delayMs = Math.min(CONNECT_RETRY_BASE_MS * 2 ** (attempt - 1), CONNECT_RETRY_MAX_MS);
                log.warn("connect attempt failed", { reason, attempt, delayMs, error });
                if (attempt >= maxAttempts && Number.isFinite(maxAttempts)) throw error;
                await sleep(delayMs);
            }
        }
        throw new Error("AMQP connect exhausted retries");
    })();

    try {
        return await connectPromise;
    } finally {
        connectPromise = null;
    }
}

export interface PublishTaskPayload {
    taskId: string;
    eventId?: string;
    contractVersion?: number;
    commandBody?: string;
    commandFingerprint?: string;
    tenantId?: string;
    agentId: string;
    action: string;
    data: Record<string, unknown>;
    correlationId?: string;
}

export async function publishTask(payload: PublishTaskPayload) {
    if (!payload?.agentId || !payload?.action) {
        throw new Error("agentId and action are required");
    }
    await connect({ reason: "publishTask" });
    const channel = await conn!.createConfirmChannel();
    let returned = false;
    channel.on("return", () => { returned = true; });
    // Avoid an unhandled EventEmitter error if RabbitMQ closes this channel.
    channel.on("error", () => undefined);
    try {

    const queueName = `agent.${payload.agentId}.tasks`;
    {
        await channel.assertQueue(queueName, { durable: true, arguments: queueArguments() });
        await channel.bindQueue(queueName, JOBS_EX, payload.agentId);

    }

    const props: Options.Publish = {
        mandatory: true,
        messageId: payload.eventId || payload.taskId,
        contentType: "application/json",
        deliveryMode: 2,
        correlationId: payload.correlationId || payload.taskId,
    };

    channel.publish(JOBS_EX, payload.agentId, Buffer.from(JSON.stringify({ ...payload, operationId: payload.taskId })), props);
    let timeout: NodeJS.Timeout | undefined;
    try {
        await Promise.race([channel.waitForConfirms(), new Promise<never>((_, reject) => {
            timeout = setTimeout(() => reject(new Error("Publisher confirm timed out")), 20000);
        })]);
    } finally { if (timeout) clearTimeout(timeout); }
    if (returned) throw new Error("Unroutable task publication");
    logPub.info("task published", {
        agentId: payload.agentId,
        action: payload.action,
        taskId: payload.taskId,
        correlationId: props.correlationId,
        queue: queueName,
    });
    } finally { await channel.close().catch(() => undefined); }
}

export async function startTelemetryConsumers({ Heartbeat }: { Heartbeat: Model<Heartbeat> }) {
    const handleHeartbeat = async (channel: Channel, msg: ConsumeMessage | null) => {
        if (!msg) return;
        try {
            const hb = JSON.parse(msg.content.toString()) as Record<string, unknown> & { agentId?: string; ts?: string };
            if (!hb.agentId) throw new Error("missing agentId");
            await saveSnapshot(Heartbeat,
                { agentId: hb.agentId },
                {
                    agentId: hb.agentId,
                    version: hb.version || "",
                    capabilities: Array.isArray(hb.capabilities) ? hb.capabilities : [],
                    host: hb.host ?? null,
                    lastSeen: hb.ts ? new Date(hb.ts) : new Date(),
                    raw: hb,
                },
                "lastSeen"
            );
            settleDelivery(channel, msg);
            logTel.debug("heartbeat", { agentId: hb.agentId, caps: hb.capabilities || [] });
        } catch (error) {
            settleDelivery(channel, msg, !(error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("missing "))));
            logTel.error("heartbeat error", { error });
        }
    };

    const handleInventory = async (channel: Channel, msg: ConsumeMessage | null) => {
        if (!msg) return;
        try {
            const headers = msg.properties?.headers || {};
            const env = JSON.parse(msg.content.toString()) as Record<string, unknown>;
            const looksLikeStorage = env?.storageId || String(env?.kind || "").toLowerCase() === "storage";
            if (looksLikeStorage) {
                settleDelivery(channel, msg);
                logInv.debug("inventory(light/full) skipped for storage payload", { storageId: env?.storageId });
                return;
            }
            const { agentId, ts, inventory } = toInventoryPayload(env);
            if (!agentId) throw new Error("missing agentId");

            const doc = {
                agentId,
                ts,
                inventory,
                raw: env,
            };

            if (isLightInventory(headers, env)) {
                await saveSnapshot(InventoryLight, { agentId }, doc);
                logInv.debug("inventory(light) stored", { agentId });
            } else {
                await saveSnapshot(InventoryFull, { agentId }, doc);
                logInv.debug("inventory(full) stored", { agentId });
            }

            settleDelivery(channel, msg);
        } catch (error) {
            settleDelivery(channel, msg, !(error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("missing "))));
            logInv.error("inventory error", { error });
        }
    };

    const handleStorageInventory = async (channel: Channel, msg: ConsumeMessage | null) => {
        if (!msg) return;
        try {
            const env = JSON.parse(msg.content.toString()) as Record<string, unknown>;
            const { storageId, ts, inventory } = toStorageInventoryPayload(env);
            if (!storageId) throw new Error("missing storageId");

            const doc = {
                storageId,
                ts,
                inventory,
                raw: env,
            };

            await saveSnapshot(InventoryStorage, { storageId }, doc);
            settleDelivery(channel, msg);
            logInv.debug("inventory(storage) stored", { storageId });
        } catch (error) {
            settleDelivery(channel, msg, !(error instanceof SyntaxError || (error instanceof Error && error.message.startsWith("missing "))));
            logInv.error("storage inventory error", { error });
        }
    };

    await registerConsumer("telemetry", async (channel) => {
        await channel.consume("agent.heartbeats.v2", (msg) => handleHeartbeat(channel, msg), { noAck: false });
        await channel.consume("agent.inventories.v2", (msg) => handleInventory(channel, msg), { noAck: false });
        await channel.consume("storage.inventories.v2", (msg) => handleStorageInventory(channel, msg), { noAck: false });
        logTel.info("telemetry consumers started");
    });
}

export async function startResultsToMongo(TaskModel: Model<TaskRecord>, { queueName }: { queueName?: string } = {}) {
    const queue = queueName || "results.controller.v2";
    await registerConsumer(`results:${queue}`, async (channel) => {
        const dlq = `${queue}.invalid`;
        await channel.assertQueue(dlq, { durable: true, arguments: queueArguments() });
        // A versioned queue avoids changing arguments of the existing queue.
        await channel.assertQueue(queue, { durable: true, arguments: { ...queueArguments(), "x-dead-letter-exchange": "", "x-dead-letter-routing-key": dlq } });
        await channel.bindQueue(queue, RES_EX, "task.#");

        logRes.info("results consumer started", { queue });

        await channel.consume(
            queue,
            async (msg) => {
                if (!msg) return;

                let payload: TaskResultPayload;
                try {
                    const parsed = parseTaskResult(JSON.parse(msg.content.toString()));
                    if (!parsed) throw new Error("invalid task result payload");
                    payload = parsed;
                } catch (error) {
                    logRes.error("results->mongo parse error (dead-lettered)", { error });
                    settleDelivery(channel, msg, false);
                    return;
                }

                try {
                    const rk = msg.fields.routingKey;

                    logRes.info("task result received", {
                        taskId: payload.taskId,
                        ok: !!payload.ok,
                        agentId: payload.agentId,
                        rk,
                    });

                    await applyTaskResult(TaskModel, payload, rk);

                    settleDelivery(channel, msg);
                } catch (error) {
                    logRes.error("results->mongo transient error (requeued)", { error, taskId: payload.taskId });
                    settleDelivery(channel, msg, !(error instanceof InvalidResult));
                }
            },
            { noAck: false }
        );
    });
}

export async function closeAmqp() {
    stopping = true;
    consumerRegistrations.clear();
    const connection = conn;
    ch = null; conn = null;
    await connection?.close();
}
