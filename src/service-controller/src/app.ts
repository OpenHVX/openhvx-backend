import { ensureOperationIndexes } from "./services/operations/indexes";
import ResourceLock from "./models/ResourceLock";
import { controllerIdentity, internalSecret } from "./middlewares/controllerIdentity";
import { startOutbox } from "./services/operations/outbox";
import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import mongoose from "mongoose";
import globalRoutes from "./routes/global.routes";
import adminRoutes from "./routes/admin.routes";
import tenantRoutes from "./routes/tenant.routes";
import { closeAmqp, amqpHealth, startTelemetryConsumers, startResultsToMongo } from "./services/amqp";
import { reapExpiredHolds } from "./services/quota";
import Heartbeat from "./models/Heartbeat";
import Task from "./models/Task";
import logger from "./lib/logger";

dotenv.config();

const log = logger.child("core");
const logHttp = log.child("http");
const logReaper = log.child("reaper");

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/hvwm";

const REAPER_INTERVAL_MS = Number(process.env.QUOTA_REAPER_INTERVAL_MS || 5 * 60 * 1000);
const REAPER_BATCH_LIMIT = Number(process.env.QUOTA_REAPER_BATCH || 200);

let reaperRunning = false;

const runQuotaReaper = async () => {
    if (reaperRunning) return;
    reaperRunning = true;
    try {
        const released = await reapExpiredHolds({ limit: REAPER_BATCH_LIMIT });
        if (released > 0) {
            logReaper.info("expired holds released", { released });
        } else {
            logReaper.debug("no expired holds found");
        }
    } catch (error) {
        logReaper.error("reaper error", { error });
    } finally {
        reaperRunning = false;
    }
};

const startAmqpConsumers = async () => {
    await startTelemetryConsumers({ Heartbeat });
    await startResultsToMongo(Task);
    log.info("AMQP consumers started");
};

const main = async () => {
    internalSecret();
    await mongoose.connect(MONGO_URL, { serverSelectionTimeoutMS: 10000, retryWrites: true, writeConcern: { w: "majority" } });
    const hello = await mongoose.connection.db!.admin().command({ hello: 1 });
    if (!hello.setName && hello.msg !== "isdbgrid") throw new Error("MongoDB replica set required for transactional operations");
    await ensureOperationIndexes();
    const lockIndexes = await ResourceLock.collection.indexes();
    if (lockIndexes.some(index => index.expireAfterSeconds !== undefined)) throw new Error("Run migrate:distributed -- --apply to remove legacy lock TTL before startup");
    log.info("Mongo connected");
    if (await Task.exists({ status: { $in: ["queued", "sent", "reconciling"] }, contractVersion: { $ne: 2 } })) throw new Error("Drain or reconcile legacy tasks before starting protocol v2 workers");
    const stopOutbox = startOutbox();

    const firstReap = setTimeout(runQuotaReaper, 10_000);
    const reapTimer = setInterval(runQuotaReaper, REAPER_INTERVAL_MS);
    logReaper.info("reaper scheduled", {
        intervalMs: REAPER_INTERVAL_MS,
        batch: REAPER_BATCH_LIMIT,
    });

    const app = express();
    app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
    app.use(express.json({ limit: "1mb" }));

    app.use(
        morgan("tiny", {
            stream: {
                write: (msg) => logHttp.debug(msg.trim()),
            },
        })
    );

    let draining = false;
    app.get("/healthz", (_req, res) => res.json({ ok: true }));
    app.get("/readyz", (_req, res) => {
        const mongoReady = mongoose.connection.readyState === 1;
        const amqp = amqpHealth();
        const ready = !draining && mongoReady && amqp.ready;
        return res.status(ready ? 200 : 503).json({
            ok: ready,
            dependencies: {
                mongo: { ready: mongoReady },
                amqp,
            },
        });
    });

    app.use("/api/v1", globalRoutes);
    app.use("/api/v1/admin", controllerIdentity("admin"), adminRoutes);
    app.use("/api/v1/tenant", controllerIdentity("tenant"), tenantRoutes);

    const server = app.listen(PORT, () => log.info("listening", { port: PORT }));
    process.once("SIGTERM", () => {
        draining = true;
        clearTimeout(firstReap); clearInterval(reapTimer);
        server.close();
        void stopOutbox().then(() => closeAmqp()).then(() => mongoose.disconnect()).finally(() => process.exit(0));
        setTimeout(() => process.exit(1), 25000).unref();
    });
    void startAmqpConsumers().catch((error) => {
        log.error("AMQP consumers bootstrap failed", { error });
    });
};

main().catch((error) => {
    if (error instanceof Error) {
        log.error("fatal", { message: error.message, stack: error.stack });
    } else {
        log.error("fatal", { error });
    }
    process.exit(1);
});
