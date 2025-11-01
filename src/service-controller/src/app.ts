// @ts-nocheck
"use strict";

require("dotenv").config();
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const mongoose = require("mongoose");

const gRoutes = require("./routes/global.routes");
const aRoutes = require("./routes/admin.routes");
const tRoutes = require("./routes/tenant.routes");

const { startTelemetryConsumers, startResultsToMongo } = require("./services/amqp");
const { reapExpiredHolds } = require("./services/quota");

const Heartbeat = require("./models/Heartbeat");
const Task = require("./models/Task");
const logger = require("./lib/logger");

const log = logger.child("core");
const logHttp = log.child("http");
const logReaper = log.child("reaper");

const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || "mongodb://localhost:27017/hvwm";

// Reaper scheduling
const REAPER_INTERVAL_MS = Number(process.env.QUOTA_REAPER_INTERVAL_MS || 5 * 60 * 1000); // 5 min
const REAPER_BATCH_LIMIT = Number(process.env.QUOTA_REAPER_BATCH || 200);

let reaperRunning = false;

async function runQuotaReaper() {
    if (reaperRunning) return; // avoid overlap if a run is slow
    reaperRunning = true;
    try {
        const released = await reapExpiredHolds({ limit: REAPER_BATCH_LIMIT });
        if (released > 0) {
            logReaper.info("expired holds released", { released });
        } else {
            logReaper.debug("no expired holds found");
        }
    } catch (err) {
        logReaper.error("reaper error", { error: err });
    } finally {
        reaperRunning = false;
    }
}

async function main() {
    // Mongo
    await mongoose.connect(MONGO_URL);
    log.info("Mongo connected", { url: MONGO_URL });

    // AMQP consumers
    await startTelemetryConsumers({ Heartbeat });
    await startResultsToMongo(Task);
    log.info("AMQP consumers started");

    // Kick off the reaper
    setTimeout(runQuotaReaper, 10_000);
    setInterval(runQuotaReaper, REAPER_INTERVAL_MS);
    logReaper.info("reaper scheduled", {
        intervalMs: REAPER_INTERVAL_MS,
        batch: REAPER_BATCH_LIMIT,
    });

    // Express
    const app = express();
    app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
    app.use(express.json({ limit: "1mb" }));

    // HTTP logging
    app.use(
        morgan("tiny", {
            stream: {
                write: (msg) => logHttp.debug(msg.trim()),
            },
        })
    );

    app.get("/healthz", (_req, res) => res.json({ ok: true }));

    app.use("/api/v1", gRoutes);
    app.use("/api/v1/admin", aRoutes);
    app.use("/api/v1/tenant", tRoutes);

    app.listen(PORT, () => log.info("listening", { port: PORT }));
}

// Entry point
main().catch((e) => {
    log.error("fatal", { error: e });
    process.exit(1);
});
