// middlewares/ensureAdmin.js
module.exports = function ensureAdmin(req, res, next) {
    try {
        const u = req.user || req.auth || {};
        const roles = Array.isArray(u.roles) ? u.roles
            : Array.isArray(u.scope) ? u.scope
                : typeof u.role === 'string' ? [u.role]
                    : [];
        if (roles.includes('global-admin')) return next();
        return res.status(403).json({ error: 'Forbidden: admin only' });
    } catch {
        return res.status(403).json({ error: 'Forbidden: admin only' });
    }
};
