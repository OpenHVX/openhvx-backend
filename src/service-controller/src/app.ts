import dotenv from "dotenv";
import express from "express";
import cors from "cors";
import morgan from "morgan";
import mongoose from "mongoose";
import globalRoutes from "./routes/global.routes";
import adminRoutes from "./routes/admin.routes";
import tenantRoutes from "./routes/tenant.routes";
import { startTelemetryConsumers, startResultsToMongo } from "./services/amqp";
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

const main = async () => {
    await mongoose.connect(MONGO_URL);
    log.info("Mongo connected", { url: MONGO_URL });

    await startTelemetryConsumers({ Heartbeat });
    await startResultsToMongo(Task);
    log.info("AMQP consumers started");

    setTimeout(runQuotaReaper, 10_000);
    setInterval(runQuotaReaper, REAPER_INTERVAL_MS);
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

    app.get("/healthz", (_req, res) => res.json({ ok: true }));

    app.use("/api/v1", globalRoutes);
    app.use("/api/v1/admin", adminRoutes);
    app.use("/api/v1/tenant", tenantRoutes);

    app.listen(PORT, () => log.info("listening", { port: PORT }));
};

main().catch((error) => {
    if (error instanceof Error) {
        log.error("fatal", { message: error.message, stack: error.stack });
    } else {
        log.error("fatal", { error });
    }
    process.exit(1);
});
