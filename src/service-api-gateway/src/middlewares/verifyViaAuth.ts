import axios, { type AxiosInstance } from "axios";
import type { NextFunction, Request, Response } from "express";
import type { HostKind } from "../lib/_utils";

type TokenKind = Exclude<HostKind, "unknown">;

export interface AuthenticatedUser {
    sub?: string;
    roles: string[];
    scopes: string[];
    kind: TokenKind;
    tenantId?: string | null;
    exp?: number;
    iss?: string;
    aud?: string;
    [key: string]: unknown;
}

type CacheEntry = {
    data: AuthenticatedUser;
    expTs: number;
};

interface VerifyOptions {
    AUTH_URL: string;
}

interface IntrospectionResponse {
    active?: boolean;
    roles?: unknown;
    scopes?: unknown;
    tenantId?: string | null;
    exp?: number;
    [key: string]: unknown;
}

const asArray = (value: unknown): string[] => {
    if (Array.isArray(value)) return value.map((v) => String(v));
    if (value === undefined || value === null) return [];
    return [String(value)];
};

const hostKind = (req: Request): HostKind => {
    const host = (req.headers.host ?? "").toLowerCase();
    if (host.startsWith("admin-api.")) return "admin";
    if (host.startsWith("api.")) return "tenant";
    return "unknown";
};

export default function verifyViaAuth({ AUTH_URL }: VerifyOptions) {
    const cache = new Map<string, CacheEntry>();
    const SKEW_SECONDS = 10;

    const http: AxiosInstance = axios.create({
        baseURL: AUTH_URL,
        headers: {
            "content-type": "application/json",
            accept: "application/json",
        },
        timeout: 5_000,
    });

    return async (req: Request, res: Response, next: NextFunction): Promise<void> => {
        try {
            const kind = hostKind(req);
            if (kind === "unknown") {
                res.status(400).json({ error: "Unknown host" });
                return;
            }

            const authHeader = (req.headers.authorization ?? "").trim();
            if (!authHeader.startsWith("Bearer ")) {
                res.status(401).json({ error: "Missing bearer token" });
                return;
            }
            const token = authHeader.slice(7);

            const nowSeconds = Math.floor(Date.now() / 1000);
            const cacheKey = `${kind}|${token}`;
            const cached = cache.get(cacheKey);
            if (cached && cached.expTs > nowSeconds) {
                req.user = cached.data;
                req.isAdmin = cached.data.kind === "admin";
                if (kind === "tenant" && cached.data.tenantId) {
                    req.tenantId = String(cached.data.tenantId);
                }
                next();
                return;
            }

            const path = kind === "tenant" ? "/auth/tenant/introspect" : "/auth/admin/introspect";
            const { data } = await http.post<IntrospectionResponse>(path, { token });

            if (!data?.active) {
                res.status(401).json({ error: "Token inactive" });
                return;
            }

            const roles = asArray(data.roles);
            const scopes = asArray(data.scopes);

            if (kind === "tenant") {
                if (!data.tenantId) {
                    res.status(403).json({ error: "tenantId required" });
                    return;
                }
                if (roles.includes("global-admin") || scopes.includes("platform.admin")) {
                    res.status(403).json({ error: "Admin token not allowed on tenant host" });
                    return;
                }
            } else if (!(roles.includes("global-admin") || scopes.includes("platform.admin"))) {
                res.status(403).json({ error: "Admin privilege required" });
                return;
            }

            const expiry = Number.isFinite(data.exp) ? Number(data.exp) : nowSeconds + 60;
            const normalized: AuthenticatedUser = {
                ...data,
                roles,
                scopes,
                kind,
            };

            cache.set(cacheKey, { data: normalized, expTs: expiry - SKEW_SECONDS });

            req.user = normalized;
            req.isAdmin = kind === "admin";
            if (kind === "tenant" && data.tenantId) {
                req.tenantId = String(data.tenantId);
            }

            next();
        } catch (error) {
            // eslint-disable-next-line no-console
            console.error("[gateway] verifyViaAuth error:", (error as Error)?.message ?? error);
            res.status(401).json({ error: "Auth service unreachable" });
        }
    };
}
