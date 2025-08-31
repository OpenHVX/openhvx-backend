// middlewares/loadTenant.js
const Tenant = require("../models/Tenant");

module.exports = function loadTenant() {
    return async (req, res, next) => {
        const tenantId = req.tenantId || req.headers['x-tenant-id'];
        if (!tenantId) return res.status(400).json({ error: "Missing tenant context" });

        const t = await Tenant.findOne({ tenantId: String(tenantId) }).lean();
        if (!t) return res.status(404).json({ error: "Unknown tenant", tenantId });
        if (t.status === "disabled") return res.status(403).json({ error: "Tenant disabled", tenantId });

        req.tenant = t;
        req.tenantId = String(t.tenantId);
        next();
    };
};
