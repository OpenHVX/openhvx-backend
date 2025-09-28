// app.js
require("dotenv").config();
const express = require("express");
const morgan = require("morgan");
const helmet = require("helmet");
const cors = require("cors");
const { v4: uuidv4 } = require("uuid");
const rateLimit = require("express-rate-limit");
const axios = require("axios");
const { mountWsProxy } = require("./ws/ws-proxy");

const CONTROLLER_URL = process.env.CONTROLLER_URL || "http://controller:3000";
const AUTH_URL = process.env.AUTH_URL || "http://auth:4000";
const PORT = process.env.PORT || 8080;
const BROKER_URL = process.env.BROKER_URL || "http://ws-broker:8081";

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
        "X-Api-Key",
    ],
    exposedHeaders: ["X-Request-Id"],
    optionsSuccessStatus: 204,
};

const app = express();

// Base middlewares
app.set("trust proxy", 1);

app.options(/.*/, (_req, res) => res.sendStatus(204));
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan("dev"));
app.use(rateLimit({ windowMs: 60_000, max: 600, standardHeaders: true, legacyHeaders: false }));
app.use(express.json({ limit: "1mb" })); // <-- important pour proxy (restream)

// Clients HTTP internes
app.locals.http = axios.create({ baseURL: CONTROLLER_URL, timeout: 10000 });
app.locals.authHttp = axios.create({ baseURL: AUTH_URL, timeout: 8000 });

// request-id + Vary
app.use((req, res, next) => {
    req.id = req.headers["x-request-id"] || uuidv4();
    res.setHeader("x-request-id", req.id);
    res.setHeader("Vary", "Origin");
    next();
});

// Health
app.get("/healthz", (_req, res) => res.json({ ok: true, service: "api-gateway" }));

// ============================================================================
// AUTH ROUTES (split admin/tenant)
// ============================================================================
const tenantAuthRoutes = require("./routes/tenant.auth.routes")({ AUTH_URL });
const adminAuthRoutes = require("./routes/admin.auth.routes")({ AUTH_URL });

// Nouveaux prefixes explicites
app.use("/api/v1/tenant/auth", tenantAuthRoutes);
app.use("/api/v1/admin/auth", adminAuthRoutes);

// (Optionnel) Compat temporaire: si tu veux encore accepter /api/auth/* pendant la migration,
// décommente la ligne ci-dessous et crée un petit routes/compat.auth.routes.js si besoin.
// app.use("/api/auth", require("./routes/compat.auth.routes")({ AUTH_URL }));

// ============================================================================
// Protected APIs
// ============================================================================
const verifyViaAuth = require("./middlewares/verifyViaAuth")({ AUTH_URL }); // version host-aware

// Global (public) — inchangé
app.use("/api/v1", require("./routes/global.routes")({ CONTROLLER_URL }));

// Admin (protégé)
app.use(
    "/api/v1/admin",
    verifyViaAuth, // doit vérifier iss/aud=admin + scope platform.admin quand host=admin-api.*
    require("./routes/admin.routes")({ CONTROLLER_URL })
);

// Tenant-scoped (protégé)
app.use(
    "/api/v1/tenant",
    verifyViaAuth, // doit vérifier iss/aud=tenant + présence tenantId quand host=api.*
    require("./routes/tenant.routes")({ CONTROLLER_URL })
);

// ============================================================================

const http = require("http");
const server = http.createServer(app);
console.log(CONTROLLER_URL);

// WS console (browser -> gateway -> broker)
mountWsProxy(app, server, BROKER_URL);

server.listen(PORT, () => {
    console.log(`[gateway] listening on :${PORT} → controller=${CONTROLLER_URL} auth=${AUTH_URL}`);
});
