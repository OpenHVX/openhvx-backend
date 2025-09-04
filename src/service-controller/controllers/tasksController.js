// controllers/tasksController.js
const { publishTask } = require('../services/amqp');
const { randomUUID } = require('node:crypto');
const Task = require('../models/Task');
const Heartbeat = require('../models/Heartbeat');
const TenantResource = require('../models/TenantResource');
const { enrich } = require('../lib/enrich');

function requiredCapability(action) {
    const map = {
        'inventory.refresh': 'inventory',
        'vm.power': 'vm.power',
        'vm.delete': 'vm.delete',
        'vm.create': 'vm.create',
        'vm.clone': 'vm.clone',
        'echo': 'echo',
    };
    if (map[action]) return map[action];
    const dot = action.indexOf('.');
    const prefix = dot > 0 ? action.slice(0, dot) : action;
    return action || prefix;
}

function actionRequiresRefId(action) {
    return /^vm\.(delete|power|start|stop|restart|resize|attach|detach|snapshot|revert|rename|clone)$/i.test(action);
}

// Récupère un tenantId en “tout venant” (JWT, champ middleware, body, query)
function getTenantIdFromReq(req) {
    return (
        req?.tenant?.tenantId ||
        req?.tenantId ||
        req?.body?.tenantId ||
        req?.query?.tenantId ||
        null
    );
}

// Strict: pour les NON-admins on ne lit QUE le contexte JWT/middleware (jamais le body)
function getTenantIdFromJWT(req) {
    return req?.tenant?.tenantId || req?.tenantId || null;
}

exports.enqueueTask = async (req, res) => {
    try {
        const admin = !!req.isAdmin;
        const body = req.body || {};
        const action = String(body.action || '').trim();
        if (!action) return res.status(400).json({ error: "Missing 'action' in body" });

        const target = (body.target && typeof body.target === 'object') ? body.target : null;
        if (!target?.kind || !target?.agentId) {
            return res.status(400).json({ error: 'Missing target.kind / target.agentId' });
        }

        const needsRefId = actionRequiresRefId(action);
        if (needsRefId && !target.refId) {
            return res.status(400).json({ error: 'Missing target.refId for this action' });
        }

        const agentId = target.agentId;

        // --- Tenant effectif ---
        const tenantId = admin ? (body.tenantId || getTenantIdFromReq(req)) : getTenantIdFromJWT(req);
        if (!tenantId) {
            return res.status(400).json({ error: admin ? 'tenantId is required for admin operations' : 'Missing tenant context' });
        }

        // --- Ownership check (désactivé en admin) ---
        if (!admin && needsRefId) {
            const link = await TenantResource.findOne({
                tenantId, kind: target.kind, agentId, refId: target.refId,
            }).lean();
            if (!link) {
                return res.status(403).json({
                    error: 'Forbidden: resource not owned by this tenant',
                    details: { tenantId, target }
                });
            }
        }

        // --- Capabilities agent ---
        const needCap = requiredCapability(action);
        const hb = await Heartbeat.findOne({ agentId }).lean();
        if (!hb) return res.status(404).json({ error: 'Agent not found (no heartbeat yet)', agentId });

        const caps = Array.isArray(hb.capabilities) ? hb.capabilities : [];
        if (!caps.includes(needCap)) {
            return res.status(422).json({
                error: 'Capability not supported by agent',
                requiredCapability: needCap, agentCapabilities: caps, action, agentId,
            });
        }

        // --- Online? ---
        const staleMs = Number(process.env.AGENT_STALE_MS || 120000);
        const lastSeen = hb.lastSeen ? new Date(hb.lastSeen).getTime() : 0;
        const agentOnline = !!(lastSeen && Date.now() - lastSeen < staleMs);

        // --- Données envoyées à l’agent ---
        const data = { ...(body.data || {}) };
        if (needsRefId && !data.id && target.refId) data.id = target.refId; // l’agent lit data.id
        let dataForAgent = { ...data, target }; // garde target pour l’audit

        // 🔹 ENRICH GÉNÉRIQUE (AUCUNE logique d’image ici)
        // On tente toujours 'auto' sur l’action telle quelle.
        // - Si non supporté → no-op (on garde dataForAgent intact)
        // - Si erreur réelle → 400
        const enr = await enrich(action, {
            operation: 'auto',
            object: dataForAgent,
            ctx: { tenantId, agentId },
        });

        if (enr.ok) {
            dataForAgent = enr.data;
        } else {
            const isUnsupported =
                enr.error?.startsWith('unsupported action:') ||
                enr.error?.includes('unsupported operation');
            if (!isUnsupported) {
                return res.status(400).json({ error: `enrichment failed: ${enr.error}` });
            }
            // sinon no-op
        }

        // --- Créer + publier la task ---
        const taskId = randomUUID();
        const doc = await Task.create({
            taskId,
            tenantId,
            agentId,
            action,
            data: dataForAgent,
            correlationId: taskId,
            status: 'queued',
            queuedAt: new Date(),
        });

        await publishTask({
            taskId: doc.taskId,
            tenantId: doc.tenantId,
            agentId: doc.agentId,
            action: doc.action,
            data: doc.data,
            correlationId: doc.correlationId,
        });

        await Task.updateOne({ taskId }, { $set: { status: 'sent', publishedAt: new Date() } });

        const base = admin ? '/api/v1/admin' : '/api/v1/tenant';
        return res.status(202).json({ queued: true, taskId, agentOnline, statusUrl: `${base}/tasks/${taskId}` });
    } catch (err) {
        console.error('enqueueTask error:', err);
        return res.status(500).json({ error: 'Failed to publish task' });
    }
};

exports.getTask = async (req, res) => {
    try {
        const admin = !!req.isAdmin;
        const { taskId } = req.params;

        if (admin) {
            const doc = await Task.findOne({ taskId }).lean();
            if (!doc) return res.status(404).json({ error: 'Task not found' });
            return res.json({ success: true, data: doc });
        }

        const tenantId = getTenantIdFromJWT(req); // non-admin: JWT only
        if (!tenantId) return res.status(400).json({ error: 'Missing tenant context' });

        const doc = await Task.findOne({ taskId, tenantId }).lean();
        if (!doc) return res.status(404).json({ error: 'Task not found' });

        return res.json({ success: true, data: doc });
    } catch (err) {
        console.error('getTask error:', err);
        return res.status(500).json({ error: 'Server error' });
    }
};
