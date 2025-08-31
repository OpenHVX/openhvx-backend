const Tenant = require("../models/Tenant");

// POST /tenants
exports.create = async (req, res) => {
    try {
        const { tenantId, name, quotas, metadata } = req.body || {};
        if (!tenantId || !name) return res.status(400).json({ error: "tenantId and name are required" });
        const doc = await Tenant.create({ tenantId, name, quotas, metadata });
        res.status(201).json({ success: true, data: doc });
    } catch (e) {
        if (e.code === 11000) return res.status(409).json({ error: "tenantId already exists" });
        console.error("tenant.create error:", e);
        res.status(500).json({ error: "Server error" });
    }
};

// GET /tenants
exports.list = async (_req, res) => {
    const rows = await Tenant.find({}, { _id: 0, tenantId: 1, name: 1, status: 1 }).sort({ tenantId: 1 }).lean();
    res.json({ success: true, data: rows });
};

// GET /tenants/:tenantId
exports.get = async (req, res) => {
    const t = await Tenant.findOne({ tenantId: req.params.tenantId }).lean();
    if (!t) return res.status(404).json({ error: "Tenant not found" });
    res.json({ success: true, data: t });
};

// PATCH /tenants/:tenantId  (enable/disable/rename/quotas)
exports.update = async (req, res) => {
    const { name, status, quotas, metadata } = req.body || {};
    const t = await Tenant.findOneAndUpdate(
        { tenantId: req.params.tenantId },
        { $set: { ...(name && { name }), ...(status && { status }), ...(quotas && { quotas }), ...(metadata && { metadata }) } },
        { new: true }
    ).lean();
    if (!t) return res.status(404).json({ error: "Tenant not found" });
    res.json({ success: true, data: t });
};

// DELETE /tenants/:tenantId (optionnel : refuse si ressources encore liées)
exports.remove = async (req, res) => {
    const TenantResource = require("../models/TenantResource");
    const { tenantId } = req.params;
    const count = await TenantResource.countDocuments({ tenantId });
    if (count > 0) return res.status(409).json({ error: "Tenant has resources; unassign first", count });
    const r = await Tenant.deleteOne({ tenantId });
    if (r.deletedCount === 0) return res.status(404).json({ error: "Tenant not found" });
    res.json({ success: true });
};
