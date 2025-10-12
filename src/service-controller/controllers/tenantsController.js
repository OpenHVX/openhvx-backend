// controllers/tenantsController.js
"use strict";

const { ERR, send } = require("../lib/errors/http-errors");
const Tenant = require("../models/Tenant");
const {
    validateCreate,
    validateUpdate,
    validateParams,
    normalizeCreate,
    normalizeUpdate,
} = require("../lib/schemas/tenant");

// Quota service + validators
const quota = require("../services/quota");
const {
    validatePatchLimits,
    validateReserveBody,
    validateRecalcBody,
} = require("../lib/schemas/quota");

/**
 * Helper: resolve string tenantId -> Mongo _id
 * Returns _id or sends 404 and returns null.
 */
async function getTenantObjectIdOr404(tenantId, req, res) {
    const t = await Tenant.findOne({ tenantId }, { _id: 1 }).lean();
    if (!t) {
        send(res, { status: 404, code: "TENANT_NOT_FOUND", message: "Tenant not found" }, req);
        return null;
    }
    return t._id;
}

// -----------------------------------------------------------------------------
// CRUD tenants
// -----------------------------------------------------------------------------

// POST /tenants
exports.create = async (req, res) => {
    try {
        const pre = validateCreate(req.body);
        if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);

        // Normalize flat quotas -> { key: {limit, used} } and drop junk values (e.g., booleans)
        const norm = normalizeCreate(pre.value);
        const { tenantId, name, quotas, metadata, description, status } = norm;

        const doc = await Tenant.create({ tenantId, name, quotas, metadata, description, status });
        return res.status(201).json({ success: true, data: doc });
    } catch (e) {
        if (e && e.code === 11000) {
            return send(res, { status: 409, code: "TENANT_CONFLICT", message: "tenantId already exists" }, req);
        }
        console.error("tenant.create error:", e);
        return send(res, ERR.internal(), req);
    }
};

// GET /tenants
exports.list = async (_req, res) => {
    try {
        const rows = await Tenant.find({}, { _id: 0, tenantId: 1, name: 1, status: 1 })
            .sort({ tenantId: 1 })
            .lean();

        return res.json({ success: true, data: rows });
    } catch (e) {
        console.error("tenant.list error:", e);
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
            return send(res, { status: 404, code: "TENANT_NOT_FOUND", message: "Tenant not found" }, req);
        }
        return res.json({ success: true, data: t });
    } catch (e) {
        console.error("tenant.get error:", e);
        return send(res, ERR.internal(), req);
    }
};

// PATCH /tenants/:tenantId  (enable/disable/rename/quotas passthrough if needed)
exports.update = async (req, res) => {
    try {
        const preParams = validateParams(req.params);
        if (!preParams.ok) return send(res, ERR.validationPre(preParams.errors), req);
        const { tenantId } = preParams.value;

        const preBody = validateUpdate(req.body);
        if (!preBody.ok) return send(res, ERR.validationPre(preBody.errors), req);

        // Normalize before applying: converts flat quotas into model shape; removes invalid shapes
        const updateFields = normalizeUpdate(preBody.value) || {};
        if (Object.keys(updateFields).length === 0) {
            return send(
                res,
                { status: 400, code: "NO_UPDATABLE_FIELDS", message: "No valid fields supplied for update" },
                req
            );
        }

        const t = await Tenant.findOneAndUpdate({ tenantId }, { $set: updateFields }, { new: true }).lean();

        if (!t) {
            return send(res, { status: 404, code: "TENANT_NOT_FOUND", message: "Tenant not found" }, req);
        }
        return res.json({ success: true, data: t });
    } catch (e) {
        console.error("tenant.update error:", e);
        return send(res, ERR.internal(), req);
    }
};

// DELETE /tenants/:tenantId
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
                { status: 409, code: "TENANT_HAS_RESOURCES", message: "Tenant has resources; unassign first", details: { count } },
                req
            );
        }

        const r = await Tenant.deleteOne({ tenantId });
        if (r.deletedCount === 0) {
            return send(res, { status: 404, code: "TENANT_NOT_FOUND", message: "Tenant not found" }, req);
        }

        return res.json({ success: true });
    } catch (e) {
        console.error("tenant.remove error:", e);
        return send(res, ERR.internal(), req);
    }
};

// -----------------------------------------------------------------------------
// Quotas (nested under tenant)
// -----------------------------------------------------------------------------

/**
 * GET /tenants/:tenantId/quotas
 * Returns hydrated limits + used
 */
exports.getQuotas = async (req, res) => {
    try {
        const pre = validateParams(req.params);
        if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);

        const _id = await getTenantObjectIdOr404(pre.value.tenantId, req, res);
        if (!_id) return;

        const data = await quota.getTenantQuotas(_id);
        return res.json({ success: true, data });
    } catch (e) {
        console.error("tenant.getQuotas error:", e);
        return send(res, ERR.internal(), req);
    }
};

/**
 * PATCH /tenants/:tenantId/quotas
 * Body: { limits: { cpu?, memoryMB?, storageMB?, vmCount?, networkCount? } }
 */
exports.patchQuotaLimits = async (req, res) => {
    try {
        const p1 = validateParams(req.params);
        if (!p1.ok) return send(res, ERR.validationPre(p1.errors), req);

        const p2 = validatePatchLimits(req.body);
        if (!p2.ok) return send(res, ERR.validationPre(p2.errors), req);

        const tId = p1.value.tenantId;
        const _id = await getTenantObjectIdOr404(tId, req, res);
        if (!_id) return;

        const ok = Object.values(p2.value?.limits || {}).every(v => v === true);
        if (!ok)
            return send(res, ERR.validationPre([{ path: "limits", message: "Invalid fields" }]), req);

        const data = await quota.setTenantQuotaLimits(_id, req.body.limits);
        res.json({ success: true, data });
    } catch (e) {
        console.error("tenant.patchQuotaLimits error:", e);
        send(res, e?.status || e?.code ? e : ERR.internal(), req);
    }
};

/**
 * POST /tenants/:tenantId/quotas/reserve
 * Body: { deltas: { cpu?, memoryMB?, storageMB?, vmCount?, networkCount? } }
 */
exports.reserveQuotas = async (req, res) => {
    try {
        const preParams = validateParams(req.params);
        if (!preParams.ok) return send(res, ERR.validationPre(preParams.errors), req);

        const preBody = validateReserveBody(req.body);
        if (!preBody.ok) return send(res, ERR.validationPre(preBody.errors), req);

        const _id = await getTenantObjectIdOr404(preParams.value.tenantId, req, res);
        if (!_id) return;

        const data = await quota.checkAndReserve(_id, preBody.value.deltas);
        return res.status(200).json({ success: true, data });
    } catch (e) {
        if (e?.code === "QUOTA_EXCEEDED") {
            return send(res, e, req);
        }
        console.error("tenant.reserveQuotas error:", e);
        return send(res, ERR.internal(), req);
    }
};

/**
 * POST /tenants/:tenantId/quotas/release
 * Body: { deltas: { ... } }  // releases usage (clamped >= 0)
 */
exports.releaseQuotas = async (req, res) => {
    try {
        const preParams = validateParams(req.params);
        if (!preParams.ok) return send(res, ERR.validationPre(preParams.errors), req);

        const preBody = validateReserveBody(req.body);
        if (!preBody.ok) return send(res, ERR.validationPre(preBody.errors), req);

        const _id = await getTenantObjectIdOr404(preParams.value.tenantId, req, res);
        if (!_id) return;

        const data = await quota.release(_id, preBody.value.deltas);
        return res.status(200).json({ success: true, data });
    } catch (e) {
        console.error("tenant.releaseQuotas error:", e);
        return send(res, ERR.internal(), req);
    }
};

/**
 * POST /tenants/:tenantId/quotas/recalculate
 * Body: { tenantId, fullInventory, tenantResourceLinks? }
 * Enforces that body.tenantId matches route param.
 */
exports.recalculateQuotas = async (req, res) => {
    try {
        const preParams = validateParams(req.params);
        if (!preParams.ok) return send(res, ERR.validationPre(preParams.errors), req);

        const body = { ...req.body, tenantId: preParams.value.tenantId };

        const preBody = validateRecalcBody(body);
        if (!preBody.ok) return send(res, ERR.validationPre(preBody.errors), req);

        const _id = await getTenantObjectIdOr404(preParams.value.tenantId, req, res);
        if (!_id) return;

        const data = await quota.recalcUsedFromInventory({
            tenantId: _id,
            fullInventory: preBody.value.fullInventory,
            tenantResourceLinks: preBody.value.tenantResourceLinks,
        });

        return res.status(200).json({ success: true, data });
    } catch (e) {
        console.error("tenant.recalculateQuotas error:", e);
        return send(res, ERR.internal(), req);
    }
};
