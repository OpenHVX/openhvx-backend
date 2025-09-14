// controllers/tasksController.js
const { publishTask } = require('../services/amqp');
const { randomUUID } = require('node:crypto');
const Task = require('../models/Task');
const Heartbeat = require('../models/Heartbeat');
const TenantResource = require('../models/TenantResource');
const { enrich } = require('../lib/enrich');
const { election } = require('../services/election')


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

// Get TenantID from multiple source (JWT, middleware, body, query)
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
        if (!target?.kind) {
            return res.status(400).json({ error: 'Missing target.kind' });
        }

        const needsRefId = actionRequiresRefId(action);
        if (needsRefId && !target.refId) {
            return res.status(400).json({ error: 'Missing target.refId for this action' });
        }

        // --- Tenant ---
        const tenantId = admin ? (body.tenantId || getTenantIdFromReq(req)) : getTenantIdFromJWT(req);
        if (!tenantId) {
            return res.status(400).json({ error: admin ? 'tenantId is required for admin operations' : 'Missing tenant context' });
        }

        // -------------------------------
        // Agent Election (vm.create)
        // -------------------------------
        if (action === 'vm.create' && !target.agentId) {
            const freshness = Number(process.env.AGENT_FRESHNESS_SEC || 60);
            const needCap = requiredCapability(action); // => 'vm.create'
            const agentIdSelected = await election({ freshness, capabilities: [needCap] });

            target.agentId = agentIdSelected;

            body.target = { ...target };
        }

        const agentId = target?.agentId;
        if (!agentId) {
            return res.status(400).json({ error: 'Missing target.agentId (no election performed or selection failed)' });
        }

        // --- Ownership check (désactivé en admin) ---
        if (!admin && needsRefId) {
            const link = await TenantResource.findOne({ tenantId, kind: target.kind, agentId, refId: target.refId }).lean();
            if (!link) {
                return res.status(403).json({ error: 'Forbidden: resource not owned by this tenant', details: { tenantId, target } });
            }
        }

        // --- Capabilities agent (assert) ---
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

        // --- Data sent to agent ---
        const data = { ...(body.data || {}) };
        if (needsRefId && !data.id && target.refId) data.id = target.refId;
        let dataForAgent = { ...data, target };

        // Enrich
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
            if (!isUnsupported) return res.status(400).json({ error: `enrichment failed: ${enr.error}` });
        }

        // --- Create the task and publish it ---
        // Task will be updated based on the result in services/amqp.js
        const taskId = randomUUID();
        const doc = await Task.create({
            taskId, tenantId, agentId, action, data: dataForAgent,
            correlationId: taskId, status: 'queued', queuedAt: new Date(),
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
