const axios = require("axios");

module.exports = ({ AUTH_URL }) => {
    const cache = new Map(); // token -> { data, expTs }
    const SKEW = 10; // secondes de marge

    return async (req, res, next) => {
        try {
            const h = (req.headers.authorization || "").trim();
            if (!h.startsWith("Bearer ")) {
                return res.status(401).json({ error: "Missing bearer token" });
            }
            const token = h.slice(7);

            const now = Math.floor(Date.now() / 1000);
            const cached = cache.get(token);
            if (cached && cached.expTs > now) {
                req.user = cached.data;
                return next();
            }

            // introspection via auth-service
            const { data } = await axios.post(
                `${AUTH_URL}/auth/introspect`,
                { token },
                { headers: { "content-type": "application/json" }, timeout: 5000 }
            );

            if (!data.active) {
                return res.status(401).json({ error: "Token inactive" });
            }

            // normalisation
            data.roles = Array.isArray(data.roles) ? data.roles : (data.roles ? [data.roles] : []);
            data.scopes = Array.isArray(data.scopes) ? data.scopes : (data.scopes ? [data.scopes] : []);

            const exp = Number(data.exp || (now + 60));
            cache.set(token, { data, expTs: exp - SKEW });

            req.user = data;
            return next();
        } catch (e) {
            console.error("[gateway] verifyViaAuth error:", e.message);
            return res.status(401).json({ error: "Auth service unreachable" });
        }
    };
};
