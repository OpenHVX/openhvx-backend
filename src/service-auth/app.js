// auth-service/app.js
require("dotenv").config();
const express = require("express");
const helmet = require("helmet");
const cors = require("cors");
const morgan = require("morgan");
const connectMongo = require("./config/mongoose");

const PORT = process.env.PORT || 4000;

const app = express();
app.use(helmet());
app.use(cors({ origin: process.env.CORS_ORIGIN || "*" }));
app.use(express.json({ limit: "1mb" }));
app.use(morgan("dev"));

app.get("/healthz", (req, res) => res.json({ ok: true, service: "auth-service" }));

// routes
app.use("/", require("./routes/user.routes"));

connectMongo()
    .then(() => {
        app.listen(PORT, () => console.log(`[auth] listening on :${PORT}`));
    })
    .catch((err) => {
        console.error("Mongo connect failed:", err.message);
        process.exit(1);
    });