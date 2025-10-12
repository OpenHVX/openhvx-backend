// controllers/tasksController.js
"use strict";

const { publishTask } = require('../services/amqp');
const { randomUUID } = require('node:crypto');
const Task = require('../models/Task');
const Heartbeat = require('../models/Heartbeat');
const TenantResource = require('../models/TenantResource');
const { enrich } = require('../lib/enrich');
const { election } = require('../services/election');
const { isKnownAction, preValidate } = require('../lib/schemas/task');
const { ERR, send } = require('../lib/errors/http-errors');
const quota = require('../services/quota');

// ----- Helpers -------

function requiredCapability(action) {
    const map = {
        'inventory.refresh': 'inventory',
        'vm.power': 'vm.power',
        'vm.delete': 'vm.delete',
        'vm.create': 'vm.create',
        'vm.clone': 'vm.clone',
        'console.serial.open': 'console',
        'net.tunnel.open': 'console',
        'echo': 'echo',
    };
    if (map[action]) return map[action];
    const dot = action.indexOf('.');
    const prefix = dot > 0 ? action.slice(0, dot) : action;
    return action || prefix;
}

function actionRequiresRefId(action) {
    if (/^console\.serial\.open$/i.test(action)) return true;
    if (/^net\.tunnel\.open$/i.test(action)) return true;
    return /^vm\.(delete|power|start|stop|restart|resize|attach|detach|snapshot|revert|rename|clone)$/i.test(action);
}

function ttlForAction(action) {
    // Ajuste au besoin par type d’action
    switch (action) {
        case 'vm.create': return 30 * 60 * 1000; // 30 min
        case 'vm.edit': return 30 * 60 * 1000; // 30 min
        case 'vm.clone': return 45 * 60 * 1000; // 45 min
        default: return quota.DEFAULT_HOLD_TTL_MS; // 15 min par défaut
    }
}

// Tenant ID can come from several places; for non-admin we only trust JWT/middleware.
function getTenantIdFromReq(req) {
    return (
        req?.tenant?.tenantId ||
        req?.tenantId ||
        req?.body?.tenantId ||
        req?.query?.tenantId ||
        null
    );
}
function getTenantIdFromJWT(req) {
    return req?.tenant?.tenantId || req?.tenantId || null;
}

exports.enqueueTask = async (req, res) => {
    try {
        const admin = !!req.isAdmin;
        const body = req.body || {};

        // ---- Envelope checks (action/target) ----
        const action = String(body.action || '').trim();
        if (!action) return send(res, ERR.missingAction(), req);

        const target = (body.target && typeof body.target === 'object') ? body.target : null;
        if (!target?.kind) return send(res, ERR.missingTargetKind(), req);

        if (!isKnownAction(action)) return send(res, ERR.unknownAction(action), req);

        const needsRefId = actionRequiresRefId(action);
        if (needsRefId && !target.refId) {
            return send(res, ERR.missingTargetRefId(action), req);
        }

        // ---- CONTRACT PRE-VALIDATION (user payload) ----
        const pre = preValidate(action, body.data || {});
        if (!pre.ok) return send(res, ERR.validationPre(pre.errors), req);
        const userData = pre.value;

        // ---- Tenant context ----
        const tenantId = admin ? (body.tenantId || getTenantIdFromReq(req)) : getTenantIdFromJWT(req);
        if (!tenantId) {
            return send(res, admin ? ERR.tenantIdRequiredForAdmin() : ERR.tenantContextMissing(), req);
        }

        // ---- Agent election (vm.create) ----
        if (action === 'vm.create' && !target.agentId) {
            const freshness = Number(process.env.AGENT_FRESHNESS_SEC || 60);
            const needCap = requiredCapability(action); // => 'vm.create'
            const agentIdSelected = await election({ freshness, capabilities: [needCap] });
            target.agentId = agentIdSelected;
            body.target = { ...target };
        }

        const agentId = target?.agentId;
        if (!agentId) return send(res, ERR.missingAgentId(), req);

        // ---- Ownership (non-admin) ----
        if (!admin && needsRefId) {
            const link = await TenantResource.findOne({
                tenantId, kind: target.kind, agentId, refId: target.refId
            }).lean();
            if (!link) {
                return send(res, ERR.forbiddenOwnership(tenantId, target), req);
            }
        }

        // ---- Agent capabilities ----
        const needCap = requiredCapability(action);
        const hb = await Heartbeat.findOne({ agentId }).lean();
        if (!hb) return send(res, ERR.agentNotFound(agentId), req);

        const caps = Array.isArray(hb.capabilities) ? hb.capabilities : [];
        if (!caps.includes(needCap)) {
            return send(res, ERR.capabilityUnsupported(needCap, caps, action, agentId), req);
        }

        // ---- Agent online? (FYI flag, not an error) ----
        const staleMs = Number(process.env.AGENT_STALE_MS || 120000);
        const lastSeen = hb.lastSeen ? new Date(hb.lastSeen).getTime() : 0;
        const agentOnline = !!(lastSeen && Date.now() - lastSeen < staleMs);

        // ---- Build data for the agent (start from validated userData) ----
        const data = { ...userData };
        if (needsRefId && !data.id && target.refId) data.id = target.refId;
        let dataForAgent = { ...data, target };

        // ---- Enrich (internal normalization; not re-validated) ----
        let consoleMeta = null;
        const enr = await enrich(action, {
            operation: 'auto',
            object: dataForAgent,
            ctx: { user: req.user || null, refId: target.refId || null, tenantId, agentId },
        });

        if (enr.ok) {
            dataForAgent = enr.data || dataForAgent;
            if (dataForAgent && dataForAgent._console) {
                consoleMeta = dataForAgent._console;
                try { delete dataForAgent._console; } catch { }
            }
        } else {
            const isUnsupported = enr.error?.startsWith('unsupported action:') || enr.error?.includes('unsupported operation');
            if (!isUnsupported) return send(res, ERR.enrichFailed(enr.error || 'unknown'), req);
        }

        // ---- Persist & publish with HOLD reservation ----
        const taskId = randomUUID();
        let hasQuotaHold = false;

        // 1) (si l’action consomme des quotas) place un hold (réserve immédiatement)
        const deltas = quota.computeDeltas(action, dataForAgent);
        if (deltas) {
            const tenantObjectId = await quota.getTenantObjectIdOrThrow(tenantId);
            try {
                await quota.holdQuota(tenantObjectId, deltas, taskId, { ttlMs: ttlForAction(action) });
                hasQuotaHold = true;
            } catch (e) {
                if (e?.code === 'QUOTA_EXCEEDED' || e?.status === 409) {
                    return send(res, e, req); // Refus immédiat si pas assez de quota
                }
                throw e;
            }
        }

        // 2) Crée la tâche et publie au broker
        const doc = await Task.create({
            taskId, tenantId, agentId, action, data: dataForAgent,
            correlationId: taskId, status: 'queued', queuedAt: new Date(),
            hasQuotaHold,
        });

        await publishTask({
            taskId: doc.taskId, tenantId: doc.tenantId, agentId: doc.agentId,
            action: doc.action, data: doc.data, correlationId: doc.correlationId,
        });

        await Task.updateOne({ taskId }, { $set: { status: 'sent', publishedAt: new Date() } });

        const base = admin ? '/api/v1/admin' : '/api/v1/tenant';
        const resp = { queued: true, taskId, agentOnline, statusUrl: `${base}/tasks/${taskId}` };
        if (consoleMeta) resp.console = consoleMeta;

        return res.status(202).json(resp);
    } catch (err) {
        console.error('enqueueTask error:', err);
        return send(res, ERR.internal(), req);
    }
};


exports.getTask = async (req, res) => {
    try {
        const admin = !!req.isAdmin;
        const { taskId } = req.params;

        if (admin) {
            const doc = await Task.findOne({ taskId }).lean();
            if (!doc) return send(res, ERR.taskNotFound(), req);
            return res.json({ success: true, data: doc });
        }

        const tenantId = getTenantIdFromJWT(req); // non-admin: JWT only
        if (!tenantId) return send(res, ERR.tenantContextMissing(), req);

        const doc = await Task.findOne({ taskId, tenantId }).lean();
        if (!doc) return send(res, ERR.taskNotFound(), req);

        return res.json({ success: true, data: doc });
    } catch (err) {
        console.error('getTask error:', err);
        return send(res, ERR.internal(), req);
    }
};
