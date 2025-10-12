// services/amqp.js
"use strict";

const amqplib = require("amqplib");

const InvFull = require("../models/Inventory.full");
const InvLight = require("../models/Inventory.light");
const TenantResource = require("../models/TenantResource");
const quota = require("../services/quota"); // consumeHold / releaseHold

const logger = require("../lib/logger");
const log = logger.child("amqp");
const logPub = log.child("publish");
const logTel = log.child("telemetry");
const logInv = log.child(["telemetry", "inventory"]);
const logRes = log.child("results");

const RMQ_URL = process.env.RMQ_URL || "amqp://guest:guest@localhost:5672/";
const JOBS_EX = process.env.JOBS_EXCHANGE || "jobs";                 // direct
const TELE_EX = process.env.TELEMETRY_EXCHANGE || "agent.telemetry"; // topic
const RES_EX = process.env.RESULTS_EXCHANGE || "results";           // topic

let conn, ch;

// Light vs full inventory
function isLight(headers, env) {
    const mode = headers?.["x-merge-mode"] || env?.mergeMode;
    const source = headers?.["x-source"] || env?.source;
    return mode === "patch-nondestructive" || source === "inventory.refresh.light";
}

async function connect() {
    if (ch) return ch;

    conn = await amqplib.connect(RMQ_URL);
    ch = await conn.createChannel();

    await ch.assertExchange(JOBS_EX, "direct", { durable: true });
    await ch.assertExchange(TELE_EX, "topic", { durable: true });
    await ch.assertExchange(RES_EX, "topic", { durable: true });

    await ch.assertQueue("agent.heartbeats", {
        durable: true,
        arguments: { "x-message-ttl": 120000, "x-max-length": 2000 },
    });
    await ch.assertQueue("agent.inventories", { durable: true });

    await ch.bindQueue("agent.heartbeats", TELE_EX, "heartbeat.*");
    await ch.bindQueue("agent.inventories", TELE_EX, "inventory.*");

    ch.on("error", (e) => log.error("channel error", { error: e }));
    conn.on("close", () => log.error("connection closed"));

    await ch.prefetch(50);
    log.info("connected", { url: RMQ_URL });
    return ch;
}

// Publish a task to the agent queue
async function publishTask(payload) {
    if (!payload?.agentId || !payload?.action) {
        throw new Error("agentId and action are required");
    }
    const channel = await connect();

    const qName = `agent.${payload.agentId}.tasks`;
    await channel.assertQueue(qName, { durable: true });
    await channel.bindQueue(qName, JOBS_EX, payload.agentId);

    const props = {
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
        queue: qName,
    });
}

// Telemetry consumers (heartbeats + inventories)
async function startTelemetryConsumers({ Heartbeat }) {
    const channel = await connect();

    // Heartbeats
    await channel.consume(
        "agent.heartbeats",
        async (msg) => {
            if (!msg) return;
            try {
                const hb = JSON.parse(msg.content.toString());
                await Heartbeat.findOneAndUpdate(
                    { agentId: hb.agentId },
                    {
                        agentId: hb.agentId,
                        version: hb.version,
                        capabilities: hb.capabilities || [],
                        host: hb.host ?? null,
                        lastSeen: hb.ts ? new Date(hb.ts) : new Date(),
                        raw: hb,
                    },
                    { upsert: true, new: true, setDefaultsOnInsert: true }
                );
                channel.ack(msg);
                logTel.debug("heartbeat", { agentId: hb.agentId, caps: hb.capabilities || [] });
            } catch (e) {
                channel.nack(msg, false, false);
                logTel.error("heartbeat error", { error: e });
            }
        },
        { noAck: false }
    );

    // Inventories (full or light)
    await channel.consume(
        "agent.inventories",
        async (msg) => {
            if (!msg) return;
            try {
                const headers = msg.properties?.headers || {};
                const env = JSON.parse(msg.content.toString()); // { agentId, ts, inventory, ... }
                const agentId = env.agentId;
                if (!agentId) throw new Error("missing agentId");

                const doc = {
                    agentId,
                    ts: env.ts ? new Date(env.ts) : new Date(),
                    inventory: env.inventory,
                    raw: env,
                };

                if (isLight(headers, env)) {
                    await InvLight.findOneAndUpdate({ agentId }, { $set: doc }, { upsert: true });
                    logInv.debug("inventory(light) stored", { agentId });
                } else {
                    await InvFull.findOneAndUpdate({ agentId }, { $set: doc }, { upsert: true });
                    logInv.debug("inventory(full) stored", { agentId });
                }

                channel.ack(msg);
            } catch (e) {
                channel.nack(msg, false, false);
                logInv.error("inventory error", { error: e });
            }
        },
        { noAck: false }
    );

    logTel.info("telemetry consumers started");
}

/* ------------------------------ Tenant link ------------------------------ */

// Create/cleanup Tenant ↔ Resource links on successful tasks.
async function onTaskSucceededUpsertTenantLink(TaskModel, payload) {
    const t = await TaskModel.findOne(
        { taskId: payload.taskId },
        { action: 1, tenantId: 1, agentId: 1 }
    ).lean();
    if (!t) return;

    const { action, tenantId, agentId } = t;
    if (!tenantId || !agentId) return;

    // VM create / clone
    if (action === "vm.create" || action === "vm.clone") {
        const vm = payload?.result?.vm;
        const refId = vm?.guid || vm?.name;
        if (!refId) return;

        await TenantResource.updateOne(
            { kind: "vm", agentId, refId },
            { $setOnInsert: { tenantId, assignedAt: new Date() } },
            { upsert: true }
        );
        return;
    }

    // VM delete
    if (action === "vm.delete") {
        const vm = payload?.result?.vm;
        const refId = vm?.guid || vm?.name;
        if (!refId) return;

        await TenantResource.deleteOne({ kind: "vm", agentId, refId });
        return;
    }

    // vSwitch create (if exposed)
    if (action === "switch.create") {
        const sw = payload?.result?.switch;
        const refId = sw?.name;
        if (!refId) return;

        await TenantResource.updateOne(
            { kind: "switch", agentId, refId },
            { $setOnInsert: { tenantId, assignedAt: new Date() } },
            { upsert: true }
        );
        return;
    }
}

/* ------------------------------------------------------------------------ */

// Results -> Mongo (update Task) — listens on task.# (no tenant key)
async function startResultsToMongo(TaskModel, { queueName } = {}) {
    const channel = await connect();
    const q = queueName || "results.controller";

    await channel.assertQueue(q, { durable: true });
    await channel.bindQueue(q, RES_EX, "task.#");

    logRes.info("results consumer started", { queue: q });

    await channel.consume(
        q,
        async (msg) => {
            if (!msg) return;
            try {
                const payload = JSON.parse(msg.content.toString()); // { taskId, agentId, ok, result, error, finishedAt }
                const rk = msg.fields.routingKey;

                // Read current task state to know if a quota hold exists
                const existing = await TaskModel.findOne(
                    { taskId: payload.taskId },
                    { hasQuotaHold: 1, action: 1, tenantId: 1, agentId: 1 }
                ).lean();

                // Upsert task status/result
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

                // On success, link tenant ↔ resource (idempotent)
                if (payload.ok) {
                    try {
                        await onTaskSucceededUpsertTenantLink(TaskModel, payload);
                    } catch (e) {
                        logRes.warn("tenant link upsert failed", { taskId: payload.taskId, error: e });
                    }
                }

                // Resolve quota hold only if the task had one
                if (existing?.hasQuotaHold) {
                    try {
                        if (payload.ok) {
                            await quota.consumeHold(payload.taskId);
                            logRes.info("quota hold consumed", { taskId: payload.taskId });
                        } else {
                            await quota.releaseHold(payload.taskId);
                            logRes.info("quota hold released", { taskId: payload.taskId });
                        }
                    } catch (e) {
                        // Don’t block the ACK; reaper/inventory recalc will self-heal if needed
                        logRes.error("quota hold resolution error", { taskId: payload.taskId, error: e });
                    }
                }

                channel.ack(msg);
            } catch (e) {
                logRes.error("results->mongo error", { error: e });
                channel.nack(msg, false, false);
            }
        },
        { noAck: false }
    );
}

module.exports = {
    connect,
    publishTask,
    startTelemetryConsumers,
    startResultsToMongo,
};
