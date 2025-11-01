// @ts-nocheck
// middlewares/requireAdmin.js
// Ensure the caller carries an "admin" role.
// Usually enforced by the API Gateway; this is just a safety net.

module.exports = function requireAdmin() {
    return (req, res, next) => {
        // Look for roles injected by the gateway headers or the decoded user payload
        const rolesHeader = req.headers["x-roles"] || req.headers["x-role"];
        const roles = rolesHeader
            ? rolesHeader.split(",").map(r => r.trim().toLowerCase())
            : [];

        // Merge roles coming from req.user when the gateway already decoded the token
        if (req.user?.roles) {
            roles.push(...req.user.roles.map(r => r.toLowerCase()));
        }

        if (!roles.includes("admin")) {
            return res.status(403).json({ error: "Admin role required" });
        }

        next();
    };
};
