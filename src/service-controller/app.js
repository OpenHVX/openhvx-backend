require('dotenv').config()
const express = require("express");
const cors = require("cors");
const morgan = require("morgan");
const mongoose = require("mongoose");
const gRoutes = require("./routes/global.routes");
const aRoutes = require("./routes/admin.routes");
const tRoutes = require("./routes/tenant.routes");
const { startTelemetryConsumers, startResultsToMongo } = require("./services/amqp");
const Heartbeat = require("./models/Heartbeat");

const Task = require("./models/Task");


const PORT = process.env.PORT || 3000;
const MONGO_URL = process.env.MONGO_URL || "mongodb://mongo:27017/hvwm";

console.log(MONGO_URL)
async function main() {
    await mongoose.connect(MONGO_URL);
    console.log("[controller] Mongo connected");

    await startTelemetryConsumers({ Heartbeat });
    await startResultsToMongo(Task); // <-- important

    const app = express();
    app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
    app.use(express.json({ limit: "1mb" }));
    app.use(morgan("dev"));
    app.get("/healthz", (_req, res) => res.json({ ok: true }));

    app.use('/api/v1', gRoutes);
    app.use('/api/v1/admin', aRoutes);
    app.use('/api/v1/tenant', tRoutes);

    app.listen(PORT, () => console.log(`[controller] listening on :${PORT}`));
}

main().catch((e) => {
    console.error("fatal:", e);
    process.exit(1);
});

