// @ts-nocheck
// controllers/authTenant.controller.js
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');
const UserTenant = require('../models/user.tenant.model'); // discriminator 'tenant'
const { signTenant, cfg } = require('../lib/jwt');

function norm(s) { return (s ?? '').toString().trim().toLowerCase(); }
function publicUser(u) {
    return {
        id: String(u._id),
        email: u.email,
        username: u.username ?? null,
        tenantId: u.tenantId,
        roles: Array.isArray(u.roles) ? u.roles : [],
        scopes: Array.isArray(u.scopes) ? u.scopes : [],
        createdAt: u.createdAt,
        updatedAt: u.updatedAt,
    };
}

/**
 * POST /auth/tenant/register
 * - Optional: protect with X-API-Key when enabled
 *   ENV: TENANT_REGISTER_APIKEY (required when defined)
 */
exports.register = async (req, res) => {
    try {
        // Apply a basic API-key guard if the option is set
        const expectedKey = process.env.TENANT_REGISTER_APIKEY;
        if (expectedKey) {
            const got = req.get('x-api-key');
            if (!got || got !== expectedKey) {
                return res.status(401).json({ error: 'unauthorized (x-api-key)' });
            }
        }

        let { email, password, tenantId, roles = [], scopes = [], username = null } = req.body || {};
        email = norm(email);
        username = username ? norm(username) : null;
        tenantId = norm(tenantId);

        if (!email || !password || !tenantId) {
            return res.status(400).json({ error: 'email, password, tenantId are required' });
        }

        // Block any attempt to escalate tenant tokens to admin
        if (Array.isArray(roles) && roles.includes('global-admin')) {
            return res.status(400).json({ error: 'global-admin not allowed for tenant users' });
        }
        if (Array.isArray(scopes) && scopes.includes('platform.admin')) {
            return res.status(400).json({ error: 'platform.admin not allowed for tenant users' });
        }

        const passwordHash = await bcrypt.hash(password, 12); // cost 12 (tune if needed)
        const user = await UserTenant.create({
            kind: 'tenant',
            email,
            username,
            passwordHash,
            tenantId,
            roles: Array.isArray(roles) ? roles : [],
            scopes: Array.isArray(scopes) ? scopes : [],
            isActive: true,
        });

        return res.status(201).json({ user: publicUser(user) });
    } catch (e) {
        if (e?.code === 11000) return res.status(409).json({ error: 'user already exists (email or username)' });
        return res.status(500).json({ error: e.message });
    }
};

/**
 * POST /auth/tenant/login
 * body: { email, password }
 */
exports.login = async (req, res) => {
    try {
        const { email, password } = req.body || {};
        if (!email || !password) return res.status(400).json({ error: 'email/password required' });

        const user = await UserTenant.findOne({ email: norm(email), isActive: true })
            .select('+passwordHash tenantId roles scopes email username createdAt updatedAt');

        if (!user) return res.status(401).json({ error: 'invalid credentials' });

        const ok = await bcrypt.compare(password, user.passwordHash);
        if (!ok) return res.status(401).json({ error: 'invalid credentials' });

        const token = signTenant(user);
        return res.json({
            access_token: token,
            token_type: 'Bearer',
            expires_in: cfg.tenant.expiresIn,
            user: publicUser(user),
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};

/**
 * POST /auth/tenant/introspect
 * body: { token }  (ou Authorization: Bearer ...)
 */
exports.introspect = async (req, res) => {
    try {
        let token = req.body?.token;
        if (!token) {
            const h = req.get('authorization') || '';
            token = h.startsWith('Bearer ') ? h.slice(7) : null;
        }
        if (!token) return res.status(400).json({ active: false, error: 'missing token' });

        try {
            const decoded = jwt.verify(token, cfg.tenant.secret, {
                issuer: cfg.tenant.iss,
                audience: cfg.tenant.aud,
            });
            return res.json({
                active: true,
                sub: decoded.sub,
                roles: decoded.roles || [],
                scopes: decoded.scopes || [],
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
        return res.status(500).json({ active: false, error: e.message });
    }
};

/**
 * GET /auth/tenant/me
 * header: Authorization: Bearer <token-tenant>
 */
exports.me = async (req, res) => {
    try {
        const h = req.get('authorization') || '';
        const token = h.startsWith('Bearer ') ? h.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'missing bearer token' });

        let decoded;
        try {
            decoded = jwt.verify(token, cfg.tenant.secret, {
                issuer: cfg.tenant.iss,
                audience: cfg.tenant.aud,
            });
        } catch {
            return res.status(401).json({ error: 'invalid token' });
        }

        const user = await UserTenant.findById(decoded.sub).lean();
        if (!user) return res.status(404).json({ error: 'user not found' });

        return res.json(publicUser(user));
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};

/**
 * GET /auth/tenant/userinfo
 * header: Authorization: Bearer <token-tenant>
 */
exports.userinfo = async (req, res) => {
    try {
        const h = req.get('authorization') || '';
        const token = h.startsWith('Bearer ') ? h.slice(7) : null;
        if (!token) return res.status(401).json({ error: 'missing bearer token' });

        let decoded;
        try {
            decoded = jwt.verify(token, cfg.tenant.secret, {
                issuer: cfg.tenant.iss,
                audience: cfg.tenant.aud,
            });
        } catch {
            return res.status(401).json({ error: 'invalid token' });
        }

        return res.json({
            sub: decoded.sub,
            roles: decoded.roles || [],
            scopes: decoded.scopes || [],
            tenantId: decoded.tenantId || null,
            tenants: decoded.tenantId ? [String(decoded.tenantId)] : [],
            defaultTenant: decoded.tenantId || null,
            exp: decoded.exp,
            iss: decoded.iss,
            aud: decoded.aud,
        });
    } catch (e) {
        return res.status(500).json({ error: e.message });
    }
};
