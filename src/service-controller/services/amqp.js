
// services/amqp.js
const amqplib = require("amqplib");

const InvFull = require("../models/Inventory.full");
const InvLight = require("../models/Inventory.light");

const RMQ_URL = process.env.RMQ_URL || "amqp://guest:guest@localhost:5672/";
const JOBS_EX = process.env.JOBS_EXCHANGE || "jobs";                 // direct
const TELE_EX = process.env.TELEMETRY_EXCHANGE || "agent.telemetry"; // topic
const RES_EX = process.env.RESULTS_EXCHANGE || "results";           // topic

let conn, ch;

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

    // heartbeat.<agentId> / inventory.<agentId>
    await ch.bindQueue("agent.heartbeats", TELE_EX, "heartbeat.*");
    await ch.bindQueue("agent.inventories", TELE_EX, "inventory.*");

    ch.on("error", (e) => console.error("[amqp] channel error:", e));
    conn.on("close", () => console.error("[amqp] connection closed"));

    await ch.prefetch(50);
    return ch;
}

// Publier une tâche (asynchrone)
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
}

// Télémétrie -> Mongo (sans notion de tenant)
async function startTelemetryConsumers({ Heartbeat }) {
    const channel = await connect();

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
            } catch (e) {
                console.error("[amqp] heartbeat error:", e.message);
                channel.nack(msg, false, false);
            }
        },
        { noAck: false }
    );

    await channel.consume("agent.inventories", async (msg) => {
        if (!msg) return;
        try {
            const headers = msg.properties?.headers || {};
            const env = JSON.parse(msg.content.toString()); // { agentId, ts, inventory, ... }
            const agentId = env.agentId;
            if (!agentId) throw new Error("missing agentId");

            const doc = {
                agentId,
                ts: env.ts ? new Date(env.ts) : new Date(),
                inventory: env.inventory, // { inventory:{...}, datastores:[...] }
                raw: env,
            };
            if (isLight(headers, env)) {
                await InvLight.findOneAndUpdate(
                    { agentId }, { $set: doc }, { upsert: true }
                );
            } else {
                await InvFull.findOneAndUpdate(
                    { agentId }, { $set: doc }, { upsert: true }
                );
            }

            channel.ack(msg);
        } catch (e) {
            console.error("[amqp] inventory error:", e.message);
            channel.nack(msg, false, false);
        }
    }, { noAck: false });


    console.log("[controller] telemetry consumers started");
}
/* ------------------------------ Tenant link ------------------------------ */

const TenantResource = require("../models/TenantResource");

// Création automatique du lien Tenant ↔ Ressource quand une task réussit
async function onTaskSucceededUpsertTenantLink(TaskModel, payload) {
    // Re-lecture de la Task pour obtenir action + tenantId + agentId

    const t = await TaskModel.findOne(
        { taskId: payload.taskId },
        { action: 1, tenantId: 1, agentId: 1 }
    ).lean();


    if (!t) return; // task inconnue (edge case)
    const { action, tenantId, agentId } = t;
    if (!tenantId || !agentId) return; // sécurité (la task est notre source de vérité métier)

    // VM créées / clonées
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

    // VM Delete 

    if (action === "vm.delete") {
        const vm = payload?.result?.vm;
        const refId = vm?.guid || vm?.name;
        if (!refId) return;

        await TenantResource.deleteOne({
            kind: "vm",
            agentId,
            refId,
        });

        return;
    }

    // vSwitch créé (si tu as une action dédiée)
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


    // (Tu pourras ajouter d’autres actions ici: disk.create, nic.add, etc.)
}

/* ------------------------------------------------------------------------ */

// Results -> Mongo (met à jour la Task) — écoute uniquement task.# (pas de tenant)
async function startResultsToMongo(TaskModel, { queueName } = {}) {
    const channel = await connect();
    const q = queueName || "results.controller";

    await channel.assertQueue(q, { durable: true });
    await channel.bindQueue(q, RES_EX, "task.#");

    console.log(`[controller] results->mongo consuming on queue="${q}"`);

    await channel.consume(
        q,
        async (msg) => {
            if (!msg) return;
            try {
                const payload = JSON.parse(msg.content.toString()); // { taskId, agentId, ok, result, error, finishedAt }
                const rk = msg.fields.routingKey;

                // 1) Upsert de la Task (statut + résultats)
                const update = {
                    $set: {
                        status: payload.ok ? "done" : "error",
                        finishedAt: payload.finishedAt ? new Date(payload.finishedAt) : new Date(),
                        result: payload.result ?? null,
                        error: payload.error ?? null,
                        agentId: payload.agentId || undefined,
                        routingKey: rk,
                    },
                    $setOnInsert: {
                        taskId: payload.taskId,
                        queuedAt: new Date(),
                        action: "unknown",
                        data: {},
                    },
                };

                await TaskModel.updateOne({ taskId: payload.taskId }, update, { upsert: true });

                // 2) Si succès → créer le lien Tenant ↔ Ressource (idempotent)
                if (payload.ok) {
                    try {
                        await onTaskSucceededUpsertTenantLink(TaskModel, payload);
                    } catch (e) {
                        console.error("[results] tenant link error:", e.message);
                        // on log seulement; on n'empêche pas l'ACK du résultat
                    }
                }

                // 3) ACK
                channel.ack(msg);
            } catch (e) {
                console.error("[amqp] results->mongo error:", e.message);
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
