// controllers/tenantsController.js
const { ERR, send } = require('../lib/errors/http-errors');
const Tenant = require("../models/Tenant");
const { validateCreate, validateUpdate, validateParams } = require('../lib/schemas/tenant');

// POST /tenants
exports.create = async (req, res) => {
    try {
        // Validate user input
        const pre = validateCreate(req.body);
        if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);

        const { tenantId, name, quotas, metadata } = pre.value;
        const doc = await Tenant.create({ tenantId, name, quotas, metadata });
        return res.status(201).json({ success: true, data: doc });
    } catch (e) {
        // Duplicate key
        if (e && e.code === 11000) {
            return send(
                res,
                { status: 409, code: 'TENANT_CONFLICT', message: 'tenantId already exists' },
                req
            );
        }
        console.error('tenant.create error:', e);
        return send(res, ERR.internal(), req);
    }
};

// GET /tenants
exports.list = async (_req, res) => {
    try {
        const rows = await Tenant
            .find({}, { _id: 0, tenantId: 1, name: 1, status: 1 })
            .sort({ tenantId: 1 })
            .lean();

        return res.json({ success: true, data: rows });
    } catch (e) {
        console.error('tenant.list error:', e);
        return send(res, ERR.internal(), _req);
    }
};

// GET /tenants/:tenantId
exports.get = async (req, res) => {
    try {
        const pre = validateParams(req.params);
        if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);

        const { tenantId } = pre.value;
        const t = await Tenant.findOne({ tenantId }).lean();
        if (!t) {
            return send(res, { status: 404, code: 'TENANT_NOT_FOUND', message: 'Tenant not found' }, req);
        }
        return res.json({ success: true, data: t });
    } catch (e) {
        console.error('tenant.get error:', e);
        return send(res, ERR.internal(), req);
    }
};

// PATCH /tenants/:tenantId  (enable/disable/rename/quotas)
exports.update = async (req, res) => {
    try {
        const preParams = validateParams(req.params);
        if (!preParams.ok) return send(res, ERR.validationPre(preParams.errors), req);
        const { tenantId } = preParams.value;

        const preBody = validateUpdate(req.body);
        if (!preBody.ok) return send(res, ERR.validationPre(preBody.errors), req);

        // Ensure at least one updatable field was provided
        const updateFields = preBody.value || {};
        if (Object.keys(updateFields).length === 0) {
            return send(
                res,
                { status: 400, code: 'NO_UPDATABLE_FIELDS', message: 'No valid fields supplied for update' },
                req
            );
        }

        const t = await Tenant.findOneAndUpdate(
            { tenantId },
            { $set: updateFields },
            { new: true }
        ).lean();

        if (!t) {
            return send(res, { status: 404, code: 'TENANT_NOT_FOUND', message: 'Tenant not found' }, req);
        }
        return res.json({ success: true, data: t });
    } catch (e) {
        console.error('tenant.update error:', e);
        return send(res, ERR.internal(), req);
    }
};

// DELETE /tenants/:tenantId (optional: refuse if still linked resources)
exports.remove = async (req, res) => {
    try {
        const pre = validateParams(req.params);
        if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);

        const { tenantId } = pre.value;
        const TenantResource = require("../models/TenantResource");

        const count = await TenantResource.countDocuments({ tenantId });
        if (count > 0) {
            return send(
                res,
                { status: 409, code: 'TENANT_HAS_RESOURCES', message: 'Tenant has resources; unassign first', details: { count } },
                req
            );
        }

        const r = await Tenant.deleteOne({ tenantId });
        if (r.deletedCount === 0) {
            return send(res, { status: 404, code: 'TENANT_NOT_FOUND', message: 'Tenant not found' }, req);
        }

        return res.json({ success: true });
    } catch (e) {
        console.error('tenant.remove error:', e);
        return send(res, ERR.internal(), req);
    }
};
