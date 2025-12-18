import "dotenv/config";
import http from "node:http";
import express, { type NextFunction, type Request, type Response } from "express";
import morgan from "morgan";
import helmet from "helmet";
import cors, { type CorsOptions } from "cors";
import rateLimit from "express-rate-limit";
import axios from "axios";
import { v4 as uuidv4 } from "uuid";
import swaggerUi from "swagger-ui-express";
import { mountWsProxy } from "./ws/ws-proxy";
import tenantAuthRoutes from "./routes/tenant.auth.routes";
import adminAuthRoutes from "./routes/admin.auth.routes";
import globalRoutes from "./routes/global.routes";
import adminRoutes from "./routes/admin.routes";
import tenantRoutes from "./routes/tenant.routes";
import verifyViaAuth from "./middlewares/verifyViaAuth";
import { swaggerSpec } from "./lib/swagger";

const CONTROLLER_URL = process.env.CONTROLLER_URL ?? "http://controller:3000";
const AUTH_URL = process.env.AUTH_URL ?? "http://auth:4000";
const PORT = Number(process.env.PORT ?? "8080");
const BROKER_URL = process.env.BROKER_URL ?? "http://ws-broker:8081";
const ENABLE_APIDOCS = String(process.env.ENABLE_APIDOCS ?? "").toLowerCase() === "true";

const RAW_ORIGINS = process.env.CORS_ORIGIN ?? "http://localhost:5173";
const WHITELIST = RAW_ORIGINS.split(",")
    .map((origin) => origin.trim())
    .filter(Boolean);

const corsOptions: CorsOptions = {
    origin(origin, callback) {
        if (!origin || RAW_ORIGINS === "*" || WHITELIST.includes(origin)) {
            callback(null, true);
            return;
        }
        callback(new Error("Not allowed by CORS"));
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

app.set("trust proxy", 1);

app.options(/.*/, (_req, res) => res.sendStatus(204));
app.use(helmet({ crossOriginResourcePolicy: false }));
app.use(morgan("dev"));
app.use(
    rateLimit({
        windowMs: 60_000,
        max: 600,
        standardHeaders: true,
        legacyHeaders: false,
    }),
);
app.use(cors(corsOptions));

app.locals.http = axios.create({ baseURL: CONTROLLER_URL, timeout: 10_000 });
app.locals.authHttp = axios.create({ baseURL: AUTH_URL, timeout: 8_000 });

app.use((req: Request, res: Response, next: NextFunction) => {
    const headerId = req.headers["x-request-id"];
    const incomingId = Array.isArray(headerId) ? headerId[0] : headerId;
    req.id = incomingId ?? uuidv4();
    res.setHeader("x-request-id", req.id);
    res.setHeader("Vary", "Origin");
    next();
});

app.get("/healthz", (_req: Request, res: Response) => res.json({ ok: true, service: "api-gateway" }));

app.use("/api/v1/tenant/auth", tenantAuthRoutes({ AUTH_URL }));
app.use("/api/v1/admin/auth", adminAuthRoutes({ AUTH_URL }));

app.use(express.json({ limit: "1mb" }));

const verifyMiddleware = verifyViaAuth({ AUTH_URL });

if (ENABLE_APIDOCS) {
    app.use("/docs", swaggerUi.serve, swaggerUi.setup(swaggerSpec, { explorer: true }));
}

app.use("/api/v1", globalRoutes({ CONTROLLER_URL }));

app.use("/api/v1/admin", verifyMiddleware, adminRoutes({ CONTROLLER_URL }));
app.use("/api/v1/tenant", verifyMiddleware, tenantRoutes({ CONTROLLER_URL }));

const server = http.createServer(app);

mountWsProxy(app, server, BROKER_URL);

server.listen(PORT, () => {
    // eslint-disable-next-line no-console
    console.log(
        `[gateway] listening on :${PORT} → controller=${CONTROLLER_URL} auth=${AUTH_URL}`,
    );
});
