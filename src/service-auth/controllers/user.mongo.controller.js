const bcrypt = require("bcryptjs");
const jwt = require("jsonwebtoken");
const User = require("../models/user.mongo.model");

// Helpers
function signJwt(user) {
    const secret = process.env.JWT_SECRET || "devsecret";
    const expiresIn = process.env.JWT_EXPIRES || "8h";
    const issuer = process.env.JWT_ISS || "auth-service";

    const payload = {
        sub: String(user._id),
        roles: user.roles || [],
        scopes: user.scopes || [],
        ...(user.tenantId ? { tenantId: String(user.tenantId) } : {}),
    };

    return jwt.sign(payload, secret, { expiresIn, issuer });
}

// POST /auth/register (protégé par x-api-key)
exports.register = async (req, res) => {
    try {
        let { email, password, tenantId, roles = [], scopes = [], username = null } = req.body || {};
        email = email?.trim()?.toLowerCase();
        username = username?.trim()?.toLowerCase() || null;
        tenantId = (tenantId ?? req.headers['x-tenant-id'] ?? '').toString().trim();

        const hasGlobalAdmin = Array.isArray(roles) && roles.includes('global-admin');

        if (!email || !password) {
            return res.status(400).json({ error: "email and password are required" });
        }
        if (!hasGlobalAdmin && !tenantId) {
            return res.status(400).json({ error: "tenantId is required for non-global-admin users" });
        }

        const passwordHash = await bcrypt.hash(password, 10);
        const user = await User.create({
            email,
            ...(username ? { username } : {}),
            passwordHash,
            ...(tenantId ? { tenantId } : {}),
            roles, scopes, isActive: true
        });

        return res.status(201).json({
            user: {
                id: String(user._id),
                email: user.email,
                username: user.username,
                tenantId: user.tenantId ?? null,
                roles: user.roles || [],
                scopes: user.scopes || []
            }
        });
    } catch (e) {
        if (e.code === 11000) return res.status(409).json({ error: "user already exists (email)" });
        return res.status(500).json({ error: e.message });
    }
};

// POST /auth/login (email + password)
exports.login = async (req, res) => {
    try {
        let { email, password } = req.body || {};
        if (!email || !password) {
            return res.status(400).json({ error: "email and password are required" });
        }

        email = email.trim().toLowerCase();
        const user = await User.findOne({ email, isActive: true })
            .select('+passwordHash tenantId roles scopes username email');

        if (!user) return res.status(401).json({ error: "invalid credentials" });

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return res.status(401).json({ error: "invalid credentials" });

        const token = signJwt(user);
        return res.json({
            access_token: token,
            token_type: "Bearer",
            expires_in: process.env.JWT_EXPIRES || "8h",
            user: {
                id: String(user._id),
                email: user.email,
                username: user.username,
                tenantId: user.tenantId ?? null,
                roles: user.roles || [],
                scopes: user.scopes || []
            }
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};

// POST /auth/introspect (inchangé sauf tolérance tenantId absent)
exports.introspect = async (req, res) => {
    try {
        const { token } = req.body || {};
        if (!token) return res.status(400).json({ active: false, error: "missing token" });

        const secret = process.env.JWT_SECRET || "devsecret";
        try {
            const decoded = jwt.verify(token, secret, { issuer: 'auth-service' });
            return res.json({
                active: true,
                sub: decoded.sub,
                roles: Array.isArray(decoded.roles) ? decoded.roles : (decoded.roles ? [decoded.roles] : []),
                scopes: Array.isArray(decoded.scopes) ? decoded.scopes : (decoded.scopes ? [decoded.scopes] : []),
                tenantId: decoded.tenantId || null,
                tenants: decoded.tenantId ? [String(decoded.tenantId)] : [],
                defaultTenant: decoded.tenantId || null,
                exp: decoded.exp,
                iss: decoded.iss,
                aud: decoded.aud,
            });
        } catch {
            return res.json({ active: false });
        }
    } catch (e) {
        res.status(500).json({ active: false, error: e.message });
    }
};

// GET /users/me (idem)
exports.me = async (req, res) => {
    try {
        const h = req.headers.authorization || "";
        const token = h.startsWith("Bearer ") ? h.slice(7) : null;
        if (!token) return res.status(401).json({ error: "missing bearer token" });

        const secret = process.env.JWT_SECRET || "devsecret";
        let decoded;
        try { decoded = jwt.verify(token, secret, { issuer: 'auth-service' }); }
        catch { return res.status(401).json({ error: "invalid token" }); }

        const user = await User.findById(decoded.sub).lean();
        if (!user) return res.status(404).json({ error: "user not found" });

        res.json({
            id: String(user._id),
            email: user.email,
            username: user.username,
            tenantId: user.tenantId ?? null,
            roles: user.roles || [],
            scopes: user.scopes || [],
            createdAt: user.createdAt,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};

exports.userinfo = async (req, res) => {
    try {
        const h = req.headers.authorization || "";
        const token = h.startsWith("Bearer ") ? h.slice(7) : null;
        if (!token) return res.status(401).json({ error: "missing bearer token" });

        const secret = process.env.JWT_SECRET || "devsecret";
        let decoded;
        try { decoded = jwt.verify(token, secret, { issuer: 'auth-service' }); }
        catch { return res.status(401).json({ error: "invalid token" }); }

        const roles = Array.isArray(decoded.roles) ? decoded.roles : (decoded.roles ? [decoded.roles] : []);
        const scopes = Array.isArray(decoded.scopes) ? decoded.scopes : (decoded.scopes ? [decoded.scopes] : []);

        res.json({
            sub: decoded.sub,
            roles, scopes,
            tenantId: decoded.tenantId || null,
            tenants: decoded.tenantId ? [String(decoded.tenantId)] : [],
            defaultTenant: decoded.tenantId || null,
            exp: decoded.exp,
            iss: decoded.iss,
            aud: decoded.aud,
        });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
};
