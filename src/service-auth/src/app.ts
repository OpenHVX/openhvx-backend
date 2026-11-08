// @ts-nocheck
// auth-service/app.js
require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const connectMongo = require("./config/mongoose");
const reqlog = require('./middlewares/req.log');

const PORT = process.env.PORT || 4000;

const mongoose = require("mongoose");
let draining = false;
const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));
app.use(reqlog);
app.get("/healthz", (req, res) => res.json({ ok: true, service: "auth-service" }));

app.get("/readyz", (_req, res) => res.status(!draining && mongoose.connection.readyState === 1 ? 200 : 503).json({ ok: !draining && mongoose.connection.readyState === 1 }));

// routes

app.use("/auth", require("./routes/user.routes"));

connectMongo()
    .then(() => {
        const server = app.listen(PORT, () => console.log(`[auth] listening on :${PORT}`));
        process.once("SIGTERM", () => {
            draining = true;
            server.close(() => { void mongoose.disconnect().finally(() => process.exit(0)); });
            setTimeout(() => process.exit(1), 25000).unref();
        });
    })
    .catch((err) => {
        console.error("Mongo connect failed:", err.message);
        process.exit(1);
    });