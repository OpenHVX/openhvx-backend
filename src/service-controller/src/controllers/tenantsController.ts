import type { Response } from "express";
import { ERR, send } from "../lib/errors/http-errors";
import Tenant from "../models/Tenant";
import {
    validateCreate,
    validateParams,
    validateUpdate,
    normalizeCreate,
    normalizeUpdate,
} from "../lib/schemas/tenant";
import {
    validatePatchLimits,
    validateRecalcBody,
    validateReserveBody,
} from "../lib/schemas/quota";
import {
    getTenantQuotas,
    setTenantQuotaLimits,
    holdQuota,
    releaseHold,
    recalcUsedFromInventory,
} from "../services/quota";
import TenantResource from "../models/TenantResource";
import type { ControllerRequest } from "../types/express";
import logger from "../lib/logger";

const log = logger.child(["controller", "tenants"]);
type Handler = (req: ControllerRequest, res: Response) => Promise<Response | void>;

const getTenantObjectIdOr404 = async (tenantId: string, req: ControllerRequest, res: Response) => {
    const tenant = await Tenant.findOne({ tenantId }, { _id: 1 }).lean();
    if (!tenant) {
        send(res, { status: 404, code: "TENANT_NOT_FOUND", message: "Tenant not found" }, req);
        return null;
    }
    return tenant._id;
};

export const createTenant: Handler = async (req, res) => {
    try {
        const pre = validateCreate(req.body);
        if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);
        const norm = normalizeCreate(pre.value!);
        const doc = await Tenant.create(norm);
        return res.status(201).json({ success: true, data: doc });
    } catch (error: unknown) {
        if ((error as { code?: number })?.code === 11000) {
            return send(res, { status: 409, code: "TENANT_CONFLICT", message: "tenantId already exists" }, req);
        }
        log.error("tenant.create error", { error });
        return send(res, ERR.internal(), req);
    }
};

export const listTenants: Handler = async (_req, res) => {
    try {
        const rows = await Tenant.find({}, { _id: 0, tenantId: 1, name: 1, status: 1 })
            .sort({ tenantId: 1 })
            .lean();
        return res.json({ success: true, data: rows });
    } catch (error) {
        log.error("tenant.list error", { error });
        return res.status(500).json({ error: "Server error" });
    }
};

export const getTenant: Handler = async (req, res) => {
    try {
        const pre = validateParams(req.params);
        if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);

        const { tenantId } = pre.value!;
        const tenant = await Tenant.findOne({ tenantId }).lean();
        if (!tenant) {
            return send(res, { status: 404, code: "TENANT_NOT_FOUND", message: "Tenant not found" }, req);
        }
        return res.json({ success: true, data: tenant });
    } catch (error) {
        log.error("tenant.get error", { error });
        return send(res, ERR.internal(), req);
    }
};

export const updateTenant: Handler = async (req, res) => {
    try {
        const params = validateParams(req.params);
        if (!params.ok) return send(res, ERR.validationPre(params.errors), req);
        const { tenantId } = params.value!;

        const preBody = validateUpdate(req.body);
        if (!preBody.ok) return send(res, ERR.validationPre(preBody.errors), req);

        const updateFields = normalizeUpdate(preBody.value!) || {};
        if (Object.keys(updateFields).length === 0) {
            return send(
                res,
                { status: 400, code: "NO_UPDATABLE_FIELDS", message: "No valid fields supplied for update" },
                req
            );
        }

        const tenant = await Tenant.findOneAndUpdate(
            { tenantId },
            { $set: updateFields },
            { new: true }
        ).lean();

        if (!tenant) {
            return send(res, { status: 404, code: "TENANT_NOT_FOUND", message: "Tenant not found" }, req);
        }
        return res.json({ success: true, data: tenant });
    } catch (error) {
        log.error("tenant.update error", { error });
        return send(res, ERR.internal(), req);
    }
};

export const removeTenant: Handler = async (req, res) => {
    try {
        const pre = validateParams(req.params);
        if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);

        const { tenantId } = pre.value!;
        const count = await TenantResource.countDocuments({ tenantId });
        if (count > 0) {
            return send(
                res,
                {
                    status: 409,
                    code: "TENANT_HAS_RESOURCES",
                    message: "Tenant has resources; unassign first",
                    details: { count },
                },
                req
            );
        }

        const result = await Tenant.deleteOne({ tenantId });
        if (result.deletedCount === 0) {
            return send(res, { status: 404, code: "TENANT_NOT_FOUND", message: "Tenant not found" }, req);
        }

        return res.json({ success: true });
    } catch (error) {
        log.error("tenant.remove error", { error });
        return send(res, ERR.internal(), req);
    }
};

export const getQuotas: Handler = async (req, res) => {
    try {
        const pre = validateParams(req.params);
        if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);

        const _id = await getTenantObjectIdOr404(pre.value!.tenantId, req, res);
        if (!_id) return;

        const data = await getTenantQuotas(_id);
        return res.json({ success: true, data });
    } catch (error) {
        log.error("tenant.getQuotas error", { error });
        return send(res, ERR.internal(), req);
    }
};

export const patchQuotaLimits: Handler = async (req, res) => {
    try {
        const params = validateParams(req.params);
        if (!params.ok) return send(res, ERR.validationPre(params.errors), req);

        const body = validatePatchLimits(req.body);
        if (!body.ok) return send(res, ERR.validationPre(body.errors), req);

        const tId = params.value!.tenantId;
        const _id = await getTenantObjectIdOr404(tId, req, res);
        if (!_id) return;

        const data = await setTenantQuotaLimits(_id, req.body.limits);
        return res.json({ success: true, data });
    } catch (error) {
        log.error("tenant.patchQuotaLimits error", { error });
        return send(res, ERR.internal(), req);
    }
};

export const reserveQuotas: Handler = async (req, res) => {
    try {
        const params = validateParams(req.params);
        if (!params.ok) return send(res, ERR.validationPre(params.errors), req);

        const body = validateReserveBody(req.body);
        if (!body.ok) return send(res, ERR.validationPre(body.errors), req);

        const _id = await getTenantObjectIdOr404(params.value!.tenantId, req, res);
        if (!_id) return;

        const result = await holdQuota(_id, body.value!.deltas, req.body.taskId, {
            ttlMs: req.body.ttlMs,
        });
        return res.json({ success: true, data: result });
    } catch (error) {
        log.error("tenant.reserveQuotas error", { error });
        return send(res, ERR.internal(), req);
    }
};

export const releaseQuotas: Handler = async (req, res) => {
    try {
        await releaseHold(req.body.taskId);
        return res.json({ success: true });
    } catch (error) {
        log.error("tenant.releaseQuotas error", { error });
        return send(res, ERR.internal(), req);
    }
};

export const recalculateQuotas: Handler = async (req, res) => {
    try {
        const params = validateParams(req.params);
        if (!params.ok) return send(res, ERR.validationPre(params.errors), req);

        const body = validateRecalcBody(req.body);
        if (!body.ok) return send(res, ERR.validationPre(body.errors), req);

        const _id = await getTenantObjectIdOr404(params.value!.tenantId, req, res);
        if (!_id) return;

        const data = await recalcUsedFromInventory({
            tenantId: _id,
            fullInventory: body.value!.fullInventory,
            tenantResourceLinks: body.value!.tenantResourceLinks,
        });
        return res.json({ success: true, data });
    } catch (error) {
        log.error("tenant.recalculateQuotas error", { error });
        return send(res, ERR.internal(), req);
    }
};
