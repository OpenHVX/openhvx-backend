// controllers/metrics.controller.js
const Heartbeat = require('../models/Heartbeat');
const Inventory = require('../models/Inventory.full');
const Task = require('../models/Task');
let Tenant; try { Tenant = require('../models/Tenant'); } catch { Tenant = null; }
const TenantResource = require('../models/TenantResource');

const ONLINE_THRESHOLD_MS = Number(process.env.AGENT_STALE_MS || 120000);

// ---- helpers ---------------------------------------------------------------

async function latestInventoriesByAgent() {
    // renvoie Map(agentId -> { agentId, invDoc })
    const rows = await Inventory.aggregate([
        { $sort: { agentId: 1, ts: -1 } },
        { $group: { _id: '$agentId', doc: { $first: '$$ROOT' } } },
    ]).allowDiskUse(true);
    const m = new Map();
    for (const r of rows) m.set(r._id, r.doc);
    return m;
}

// Ne compter que le "root" (ou fallback: 1 par lettre de lecteur)
function pickRootDatastore(ds = []) {
    if (!Array.isArray(ds) || ds.length === 0) {
        return { totalBytes: 0, freeBytes: 0, item: null };
    }
    // 1) priorité au kind === 'root' (agent)
    const root = ds.find(d =>
        String(d?.kind || '').toLowerCase() === 'root' ||
        /[\\\/]openhvx[\\\/]?$/i.test(String(d?.path || ''))
    );
    if (root) {
        return {
            totalBytes: Number(root.totalBytes || 0),
            freeBytes: Number(root.freeBytes || 0),
            item: root
        };
    }
    // 2) fallback: dédupliquer par lettre de lecteur (C:, D:...)
    const byDrive = new Map();
    for (const d of ds) {
        const drive = String(d?.drive || '').toUpperCase();
        if (!drive) continue;
        const cur = byDrive.get(drive);
        const tot = Number(d.totalBytes || 0);
        const fre = Number(d.freeBytes || 0);
        // garde la plus grande capacité rencontrée sur ce drive
        if (!cur || tot > cur.totalBytes) byDrive.set(drive, { totalBytes: tot, freeBytes: fre, item: d });
    }
    let totalBytes = 0, freeBytes = 0;
    for (const v of byDrive.values()) {
        totalBytes += v.totalBytes;
        freeBytes += v.freeBytes;
    }
    return { totalBytes, freeBytes, item: null };
}


function countVmStates(vms = []) {
    const byState = {};
    for (const v of (vms || [])) {
        const s = String(v.state || 'Unknown');
        byState[s] = (byState[s] || 0) + 1;
    }
    const total = Object.values(byState).reduce((a, b) => a + b, 0);
    return { total, byState };
}

async function tasksCountsLast24h(filter = {}) {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const base = { queuedAt: { $gte: since }, ...filter };
    const [queued, done, error] = await Promise.all([
        Task.countDocuments({ ...base, status: 'queued' }),
        Task.countDocuments({ ...base, status: 'done' }),
        Task.countDocuments({ ...base, status: 'error' }),
    ]);
    return { queued, done, error, since };
}

// ---- ADMIN: /admin/metrics/overview ---------------------------------------

exports.adminOverview = async (req, res) => {
    try {
        const now = Date.now();
        const [hbs, invMap] = await Promise.all([
            Heartbeat.find({}, 'agentId version lastSeen').lean(),
            latestInventoriesByAgent(),
        ]);
        // agents
        const agents = { total: hbs.length, online: 0, offline: 0 };
        for (const h of hbs) {
            const ts = h.lastSeen ? new Date(h.lastSeen).getTime() : 0;
            const online = ts && (now - ts) < ONLINE_THRESHOLD_MS;
            if (online) agents.online++; else agents.offline++;
        }

        // tenants
        let tenants = { total: 0 };
        try {
            tenants.total = Tenant ? await Tenant.countDocuments() : 0;
        } catch { tenants.total = 0; }

        // compute, vms, datastores
        let cpuCores = 0, memMB = 0;
        let vmsTotal = 0;
        const vmStates = {};
        let dsTotalBytes = 0, dsFreeBytes = 0;

        for (const [agentId, doc] of invMap.entries()) {
            const inv = doc?.inventory?.inventory || doc?.inventory || {};
            // compute
            const cores = inv.host?.hypervHost?.logicalProcessors ??
                inv.host?.cpu?.logicalProcessors ?? 0;
            const hostMemMB = inv.host?.hypervHost?.memoryCapacityMB ??
                inv.host?.memMB ?? 0;
            cpuCores += Number(cores || 0);
            memMB += Number(hostMemMB || 0);

            // vms
            const vms = inv.vms || [];
            vmsTotal += vms.length;
            for (const v of vms) {
                const s = String(v.state || 'Unknown');
                vmStates[s] = (vmStates[s] || 0) + 1;
            }

            // datastores
            // datastores -> ne prendre que le "root" par agent
            const ds = doc?.inventory?.datastores || [];
            const rootAgg = pickRootDatastore(ds);
            dsTotalBytes += rootAgg.totalBytes;
            dsFreeBytes += rootAgg.freeBytes;
        }

        const tasks = await tasksCountsLast24h();

        return res.json({
            agents,
            tenants,
            vms: { total: vmsTotal, byState: vmStates },
            compute: { cpuCores, memMB },
            datastores: { totalBytes: dsTotalBytes, freeBytes: dsFreeBytes },
            tasks: { last24h: tasks },
            ts: new Date().toISOString(),
        });
    } catch (e) {
        console.error('[metrics] adminOverview', e);
        res.status(500).json({ error: 'metrics failed' });
    }
};

// ---- ADMIN: /admin/metrics/datastores -------------------------------------

exports.adminDatastores = async (_req, res) => {
    try {
        const invMap = await latestInventoriesByAgent();
        const byAgent = [];
        let totalBytes = 0, freeBytes = 0;

        for (const [agentId, doc] of invMap.entries()) {
            const ds = doc?.inventory?.datastores || [];
            const rootAgg = pickRootDatastore(ds);
            totalBytes += rootAgg.totalBytes;
            freeBytes += rootAgg.freeBytes;
            byAgent.push({
                agentId,
                totalBytes: rootAgg.totalBytes,
                freeBytes: rootAgg.freeBytes,
                root: rootAgg.item,   // l’entrée root retenue (utile pour debug/UI)
                all: ds               // (optionnel) les entrées brutes si tu veux afficher le détail
            });
        }

        res.json({ totalBytes, freeBytes, byAgent, ts: new Date().toISOString() });
    } catch (e) {
        console.error('[metrics] adminDatastores', e);
        res.status(500).json({ error: 'metrics failed' });
    }
};

// ---- ADMIN: /admin/metrics/compute ----------------------------------------

exports.adminCompute = async (_req, res) => {
    try {
        const invMap = await latestInventoriesByAgent();
        const rows = [];

        let cpuCores = 0, memMB = 0;
        for (const [agentId, doc] of invMap.entries()) {
            const inv = doc?.inventory?.inventory || doc?.inventory || {};
            const cores = inv.host?.hypervHost?.logicalProcessors ??
                inv.host?.cpu?.logicalProcessors ?? 0;
            const hostMemMB = inv.host?.hypervHost?.memoryCapacityMB ??
                inv.host?.memMB ?? 0;
            cpuCores += Number(cores || 0);
            memMB += Number(hostMemMB || 0);

            rows.push({
                agentId,
                cpuCores: Number(cores || 0),
                memMB: Number(hostMemMB || 0),
                hostname: inv.host?.hostname || null,
                os: inv.host?.os || null,
            });
        }

        res.json({ total: { cpuCores, memMB }, byAgent: rows, ts: new Date().toISOString() });
    } catch (e) {
        console.error('[metrics] adminCompute', e);
        res.status(500).json({ error: 'metrics failed' });
    }
};

// ---- ADMIN: /admin/metrics/vms --------------------------------------------

exports.adminVMs = async (req, res) => {
    try {
        const invMap = await latestInventoriesByAgent();
        const filterAgent = req.query.agentId || null;

        const byAgent = [];
        let all = { total: 0, byState: {} };

        for (const [agentId, doc] of invMap.entries()) {
            if (filterAgent && agentId !== filterAgent) continue;
            const inv = doc?.inventory?.inventory || doc?.inventory || {};
            const states = countVmStates(inv.vms || []);
            all.total += states.total;
            for (const [k, v] of Object.entries(states.byState)) {
                all.byState[k] = (all.byState[k] || 0) + v;
            }
            byAgent.push({ agentId, total: states.total, byState: states.byState });
        }
        res.json({ all, byAgent, ts: new Date().toISOString() });
    } catch (e) {
        console.error('[metrics] adminVMs', e);
        res.status(500).json({ error: 'metrics failed' });
    }
};
// ---- TENANT: /tenant/metrics/overview -------------------------------------

// --- helper commun ----------------------------------------------------------
async function computeTenantOverview(tenantId) {
    const [links, invMap, tasks] = await Promise.all([
        TenantResource.find({ tenantId, kind: 'vm' }, { agentId: 1, refId: 1 }).lean(),
        latestInventoriesByAgent(),
        tasksCountsLast24h({ tenantId }),
    ]);

    let total = 0;
    const byState = {};
    let vcpus = 0, memMB = 0;
    let provMB = 0, usedMB = 0;
    const bySwitch = {};

    for (const link of links) {
        const doc = invMap.get(link.agentId);
        const inv = doc?.inventory?.inventory || doc?.inventory || {};
        const vms = inv?.vms || [];

        const vm = vms.find(v =>
            (v.id === link.refId) || (v.guid === link.refId) || (v.name === link.refId)
        );
        if (!vm) continue;

        total++;
        const s = String(vm.state || 'Unknown');
        byState[s] = (byState[s] || 0) + 1;

        const cpuCount = vm?.configuration?.cpu?.count ?? 0;
        vcpus += Number(cpuCount || 0);

        const ram = vm?.configuration?.memory?.startupMB ?? vm?.memoryAssignedMB ?? 0;
        memMB += Number(ram || 0);

        const disks = vm?.storage || [];
        for (const d of disks) {
            const vhd = d?.vhd || {};
            provMB += Number(vhd.sizeMB || 0);
            usedMB += Number(vhd.fileSizeMB || 0);
        }

        const nics = vm?.networkAdapters || [];
        for (const n of nics) {
            const sw = n?.switch || '—';
            bySwitch[sw] = (bySwitch[sw] || 0) + 1;
        }
    }

    return {
        tenantId,
        vms: { total, byState },
        compute: { vcpus, memMB },
        storage: { provisionedMB: provMB, usedMB },
        networks: { bySwitch },
        tasks: { last24h: tasks },
        ts: new Date().toISOString(),
    };
}

// ---- TENANT: /tenant/metrics/overview -------------------------------------
exports.tenantOverview = async (req, res) => {
    try {
        // ⚠️ ne JAMAIS lire tenantId depuis la query ici
        const tenantId = req?.tenant?.tenantId || req?.tenantId;
        if (!tenantId) return res.status(400).json({ error: 'Missing tenant context' });

        const data = await computeTenantOverview(tenantId);
        res.json(data);
    } catch (e) {
        console.error('[metrics] tenantOverview', e);
        res.status(500).json({ error: 'metrics failed' });
    }
};

// ---- ADMIN: /admin/metrics/tenant/overview?tenantId=TEN-XXX ---------------
exports.adminTenantOverview = async (req, res) => {
    try {
        if (!req.isAdmin) return res.status(403).json({ error: 'Admin only' });
        const tenantId = String(req.query.tenantId || '').trim();
        if (!tenantId) return res.status(400).json({ error: 'Missing tenantId (query)' });

        const data = await computeTenantOverview(tenantId);
        res.json(data);
    } catch (e) {
        console.error('[metrics] adminTenantOverview', e);
        res.status(500).json({ error: 'metrics failed' });
    }
};