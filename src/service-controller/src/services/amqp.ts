import {
    connect as connectAmqp,
    type Channel,
    type Connection,
    type ConsumeMessage,
    type Options,
} from "amqplib";


import type { Model } from "mongoose";
import InventoryFull from "../models/Inventory.full";
import InventoryLight from "../models/Inventory.light";
import TenantResource from "../models/TenantResource";
import type { TaskRecord } from "../models/Task";
import type { Heartbeat } from "../models/Heartbeat";
import * as quota from "../services/quota";
import logger from "../lib/logger";

const log = logger.child("amqp");
const logPub = log.child("publish");
const logTel = log.child("telemetry");
const logInv = log.child(["telemetry", "inventory"]);
const logRes = log.child("results");

const RMQ_URL = process.env.RMQ_URL || "amqp://guest:guest@localhost:5672/";
const JOBS_EX = process.env.JOBS_EXCHANGE || "jobs";
const TELE_EX = process.env.TELEMETRY_EXCHANGE || "agent.telemetry";
const RES_EX = process.env.RESULTS_EXCHANGE || "results";

let conn: Connection | null = null;
let ch: Channel | null = null;

const isLightInventory = (headers: Options.MessagePropertyHeaders, env: Record<string, unknown>) => {
    const mode = headers?.["x-merge-mode"] || env?.mergeMode;
    const source = headers?.["x-source"] || env?.source;
    return mode === "patch-nondestructive" || source === "inventory.refresh.light";
};

export async function connect(): Promise<Channel> {
    if (ch) return ch;

    const connection = await connectAmqp(RMQ_URL);
    conn = connection;
    ch = await connection.createChannel();

    await ch.assertExchange(JOBS_EX, "direct", { durable: true });
    await ch.assertExchange(TELE_EX, "topic", { durable: true });
    await ch.assertExchange(RES_EX, "topic", { durable: true });

    await ch.assertQueue("agent.heartbeats", {
        durable: true,
        arguments: { "x-message-ttl": 120_000, "x-max-length": 2000 },
    });
    await ch.assertQueue("agent.inventories", { durable: true });

    await ch.bindQueue("agent.heartbeats", TELE_EX, "heartbeat.*");
    await ch.bindQueue("agent.inventories", TELE_EX, "inventory.*");

    ch.on("error", (error) => log.error("channel error", { error }));
    connection.on("close", () => log.error("connection closed"));

    await ch.prefetch(50);
    log.info("connected", { url: RMQ_URL });
    return ch;
}

export interface PublishTaskPayload {
    taskId: string;
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
    const channel = await connect();

    const queueName = `agent.${payload.agentId}.tasks`;
    await channel.assertQueue(queueName, { durable: true });
    await channel.bindQueue(queueName, JOBS_EX, payload.agentId);

    const props: Options.Publish = {
        contentType: "application/json",
        deliveryMode: 2,
        correlationId: payload.correlationId || payload.taskId,
    };

    channel.publish(JOBS_EX, payload.agentId, Buffer.from(JSON.stringify(payload)), props);
    logPub.info("task published", {
        agentId: payload.agentId,
        action: payload.action,
        taskId: payload.taskId,
        correlationId: props.correlationId,
        queue: queueName,
    });
}

export async function startTelemetryConsumers({ Heartbeat }: { Heartbeat: Model<Heartbeat> }) {
    const channel = await connect();

    const handleHeartbeat = async (msg: ConsumeMessage | null) => {
        if (!msg) return;
        try {
            const hb = JSON.parse(msg.content.toString()) as Record<string, unknown> & { agentId?: string; ts?: string };
            if (!hb.agentId) throw new Error("missing agentId");
            await Heartbeat.findOneAndUpdate(
                { agentId: hb.agentId },
                {
                    agentId: hb.agentId,
                    version: hb.version,
                    capabilities: Array.isArray(hb.capabilities) ? hb.capabilities : [],
                    host: hb.host ?? null,
                    lastSeen: hb.ts ? new Date(hb.ts) : new Date(),
                    raw: hb,
                },
                { upsert: true, new: true, setDefaultsOnInsert: true }
            );
            channel.ack(msg);
            logTel.debug("heartbeat", { agentId: hb.agentId, caps: hb.capabilities || [] });
        } catch (error) {
            channel.nack(msg, false, false);
            logTel.error("heartbeat error", { error });
        }
    };

    const handleInventory = async (msg: ConsumeMessage | null) => {
        if (!msg) return;
        try {
            const headers = msg.properties?.headers || {};
            const env = JSON.parse(msg.content.toString()) as Record<string, unknown>;
            const agentId = env.agentId as string | undefined;
            if (!agentId) throw new Error("missing agentId");

            const doc = {
                agentId,
                ts: env.ts ? new Date(env.ts as string) : new Date(),
                inventory: env.inventory as Record<string, unknown>,
                raw: env,
            };

            if (isLightInventory(headers, env)) {
                await InventoryLight.findOneAndUpdate({ agentId }, { $set: doc }, { upsert: true });
                logInv.debug("inventory(light) stored", { agentId });
            } else {
                await InventoryFull.findOneAndUpdate({ agentId }, { $set: doc }, { upsert: true });
                logInv.debug("inventory(full) stored", { agentId });
            }

            channel.ack(msg);
        } catch (error) {
            channel.nack(msg, false, false);
            logInv.error("inventory error", { error });
        }
    };

    await channel.consume("agent.heartbeats", handleHeartbeat, { noAck: false });
    await channel.consume("agent.inventories", handleInventory, { noAck: false });
    logTel.info("telemetry consumers started");
}

type TaskModelInput = Model<TaskRecord>;

interface TaskResultPayload {
    taskId: string;
    agentId?: string;
    ok?: boolean;
    result?: Record<string, unknown>;
    error?: string;
    finishedAt?: string;
}

async function onTaskSucceededUpsertTenantLink(TaskModel: TaskModelInput, payload: TaskResultPayload) {
    const task = await TaskModel.findOne(
        { taskId: payload.taskId },
        { action: 1, tenantId: 1, agentId: 1 }
    ).lean<{ action: string; tenantId?: string; agentId?: string } | null>();
    if (!task?.tenantId || !task?.agentId) return;

    const { action, tenantId, agentId } = task;

    const vmResult = (payload.result as { vm?: { guid?: string; name?: string } } | undefined)?.vm;
    const refId = vmResult?.guid || vmResult?.name;

    if ((action === "vm.create" || action === "vm.clone") && refId) {
        await TenantResource.updateOne(
            { kind: "vm", agentId, refId },
            { $setOnInsert: { tenantId, assignedAt: new Date() } },
            { upsert: true }
        );
        return;
    }

    if (action === "vm.delete" && refId) {
        await TenantResource.deleteOne({ kind: "vm", agentId, refId });
        return;
    }

    if (action === "switch.create") {
        const sw = (payload.result as { switch?: { name?: string } } | undefined)?.switch;
        const switchRef = sw?.name;
        if (!switchRef) return;
        await TenantResource.updateOne(
            { kind: "switch", agentId, refId: switchRef },
            { $setOnInsert: { tenantId, assignedAt: new Date() } },
            { upsert: true }
        );
    }
}

export async function startResultsToMongo(TaskModel: TaskModelInput, { queueName }: { queueName?: string } = {}) {
    const channel = await connect();
    const queue = queueName || "results.controller";

    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, RES_EX, "task.#");

    logRes.info("results consumer started", { queue });

    await channel.consume(
        queue,
        async (msg) => {
            if (!msg) return;
            try {
                const payload = JSON.parse(msg.content.toString()) as TaskResultPayload;
                const rk = msg.fields.routingKey;

                const existing = await TaskModel.findOne(
                    { taskId: payload.taskId },
                    { hasQuotaHold: 1, action: 1, tenantId: 1, agentId: 1 }
                ).lean<{ hasQuotaHold?: boolean; action?: string; agentId?: string } | null>();

                const update = {
                    $set: {
                        status: payload.ok ? "done" : "error",
                        finishedAt: payload.finishedAt ? new Date(payload.finishedAt) : new Date(),
                        result: payload.result ?? null,
                        error: payload.error ?? null,
                        agentId: payload.agentId || existing?.agentId || undefined,
                        routingKey: rk,
                    },
                    $setOnInsert: {
                        taskId: payload.taskId,
                        queuedAt: new Date(),
                        action: existing?.action || "unknown",
                        data: {},
                        hasQuotaHold: existing?.hasQuotaHold || false,
                    },
                };

                await TaskModel.updateOne({ taskId: payload.taskId }, update, { upsert: true });
                logRes.debug("task result stored", {
                    taskId: payload.taskId,
                    ok: !!payload.ok,
                    rk,
                    hadHold: !!existing?.hasQuotaHold,
                });

                if (payload.ok) {
                    try {
                        await onTaskSucceededUpsertTenantLink(TaskModel, payload);
                    } catch (error) {
                        logRes.warn("tenant link upsert failed", { taskId: payload.taskId, error });
                    }
                }

                if (existing?.hasQuotaHold) {
                    try {
                        if (payload.ok) {
                            await quota.consumeHold(payload.taskId);
                            logRes.info("quota hold consumed", { taskId: payload.taskId });
                        } else {
                            await quota.releaseHold(payload.taskId);
                            logRes.info("quota hold released", { taskId: payload.taskId });
                        }
                    } catch (error) {
                        logRes.error("quota hold resolution error", { taskId: payload.taskId, error });
                    }
                }

                channel.ack(msg);
            } catch (error) {
                logRes.error("results->mongo error", { error });
                channel.nack(msg, false, false);
            }
        },
        { noAck: false }
    );
}
