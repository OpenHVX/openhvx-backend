// middlewares/verifyViaAuth.js
const axios = require("axios");

// Helpers
function hostKind(req) {
    const host = (req.headers.host || "").toLowerCase();
    if (host.startsWith("admin-api.")) return "admin";
    if (host.startsWith("api.")) return "tenant";
    return "unknown";
}
const toArray = (x) => (Array.isArray(x) ? x : x ? [x] : []);

module.exports = ({ AUTH_URL }) => {
    // Cache simple en mémoire : (token|kind) -> { data, expTs }
    const cache = new Map();
    const SKEW = 10; // secondes de marge à l'expiration (anti race condition)

    // Client HTTP vers auth-service
    const http = axios.create({
        baseURL: AUTH_URL,
        headers: { "content-type": "application/json", accept: "application/json" },
        timeout: 5000,
    });

    return async (req, res, next) => {
        try {
            const kind = hostKind(req);
            if (kind === "unknown") {
                return res.status(400).json({ error: "Unknown host" });
            }

            const auth = (req.headers.authorization || "").trim();
            if (!auth.startsWith("Bearer ")) {
                return res.status(401).json({ error: "Missing bearer token" });
            }
            const token = auth.slice(7);

            // Cache hit ?
            const now = Math.floor(Date.now() / 1000);
            const cacheKey = `${kind}|${token}`;
            const cached = cache.get(cacheKey);
            if (cached && cached.expTs > now) {
                req.user = cached.data;
                if (kind === "tenant" && cached.data.tenantId) req.tenantId = cached.data.tenantId;
                return next();
            }

            // Introspection selon le host
            const path = kind === "tenant" ? "/auth/tenant/introspect" : "/auth/admin/introspect";
            const { data } = await http.post(path, { token }); // introspect accepte body.token

            if (!data || !data.active) {
                return res.status(401).json({ error: "Token inactive" });
            }

            // Normalisation
            const roles = toArray(data.roles);
            const scopes = toArray(data.scopes);

            // Enforcement spécifique par host
            if (kind === "tenant") {
                if (!data.tenantId) {
                    return res.status(403).json({ error: "tenantId required" });
                }
                // Empêche d'utiliser un token admin sur le host tenant
                if (roles.includes("global-admin") || scopes.includes("platform.admin")) {
                    return res.status(403).json({ error: "Admin token not allowed on tenant host" });
                }
            } else {
                // kind === 'admin' : accepte role OU scope admin
                if (!(roles.includes("global-admin") || scopes.includes("platform.admin"))) {
                    return res.status(403).json({ error: "Admin privilege required" });
                }
            }

            // Mise en cache jusqu’à (exp - skew)
            const exp = Number.isFinite(data.exp) ? Number(data.exp) : now + 60;
            const normalized = {
                ...data,
                roles,
                scopes,
                kind,
            };
            cache.set(cacheKey, { data: normalized, expTs: exp - SKEW });

            // Hydrate req pour l’upstream
            req.user = normalized;
            if (kind === "tenant") req.tenantId = data.tenantId;

            return next();
        } catch (e) {
            console.error("[gateway] verifyViaAuth error:", e?.message || e);
            // 401 conservateur (on ne révèle pas l'upstream)
            return res.status(401).json({ error: "Auth service unreachable" });
        }
    };
};
