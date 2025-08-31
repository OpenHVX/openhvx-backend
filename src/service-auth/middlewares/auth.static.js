//auth.static.js
module.exports = function authStatic({ header = "x-api-key", env = "AUTH_ADMIN_API_KEY", optional = false } = {}) {
    return (req, res, next) => {
        const expected = process.env[env];
        if (!expected) return optional ? next() : res.status(500).json({ error: `Missing ${env} in env` });

        const provided = req.headers[header];
        if (!provided || provided !== expected) {
            return res.status(401).json({ error: "invalid api key" });
        }
        next();
    };
};