// app.js
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const helmet = require("helmet");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const axios = require("axios");

const CONTROLLER_URL = process.env.CONTROLLER_URL || "http://controller:3000";
const AUTH_URL = process.env.AUTH_URL || "http://auth:4000";
const PORT = process.env.PORT || 8080;



// CORS
const RAW = process.env.CORS_ORIGIN || "http://localhost:5173";
const WHITELIST = RAW.split(",").map((s) => s.trim()).filter(Boolean);
const corsOptions = {
    origin(origin, cb) {
        if (!origin) return cb(null, true);
        if (RAW === "*" || WHITELIST.includes(origin)) return cb(null, true);
        return cb(new Error("Not allowed by CORS"));
    },
    credentials: true,
    methods: ["GET", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
    allowedHeaders: [
        "Content-Type",
        "Authorization",
        "X-Request-Id",
        "X-Requested-With",
        "X-Tenant-Id",
        "X-Api-Key"
    ],
    exposedHeaders: ["X-Request-Id"],
    optionsSuccessStatus: 204,
};

const app = express();
app.use(cors(corsOptions));
app.options(/.*/, cors(corsOptions));
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan("dev"));
app.use(rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false }));

// après helmet/morgan/json…
app.locals.http = axios.create({ baseURL: CONTROLLER_URL, timeout: 10000 });
app.locals.authHttp = axios.create({ baseURL: AUTH_URL, timeout: 8000 });

// request-id + Vary
app.use((req, res, next) => {
    req.id = req.headers["x-request-id"] || uuidv4();
    res.setHeader("x-request-id", req.id);
    res.setHeader("Vary", "Origin");
    next();
});

// Health du gateway
app.get("/healthz", (_req, res) => res.json({ ok: true, service: "api-gateway" }));

// Routes AUTH publiques (ton service-auth **tel quel**)
app.use("/api/auth",
    express.json({ limit: "1mb" }),
    require("./routes/auth.routes")({ AUTH_URL })
);

// Middlewares d’auth / tenant
const verifyViaAuth = require("./middlewares/verifyViaAuth")({ AUTH_URL });

// ---- Routes GLOBAL (pas de tenant, publiques) ----
app.use("/api/v1", require("./routes/global.routes")({ CONTROLLER_URL }));

// ---- Routes ADMIN (protégées rôle global-admin) ----
app.use("/api/v1/admin",
    verifyViaAuth,
    require("./routes/admin.routes")({ CONTROLLER_URL })
);

// ---- Routes TENANT-SCOPED (toutes les autres APIs nécessitant un tenant) ----
app.use("/api/v1/tenant",
    verifyViaAuth,
    require("./routes/tenant.routes")({ CONTROLLER_URL })
);

app.listen(PORT, () => {
    console.log(`[gateway] listening on :${PORT} → controller=${CONTROLLER_URL} auth=${AUTH_URL}`);
});
