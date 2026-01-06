import type { Response } from "express";
import Heartbeat from "../models/Heartbeat";
import Inventory from "../models/Inventory.full";
import InventoryStorage from "../models/Inventory.storage";
import Task from "../models/Task";
import Tenant from "../models/Tenant";
import TenantResource from "../models/TenantResource";
import type { ControllerRequest } from "../types/express";
import { getTenantQuotas } from "../services/quota";
import logger from "../lib/logger";
import { respondEnvelope } from "../middlewares/addEnveloppe";

const ONLINE_THRESHOLD_MS = Number(process.env.AGENT_STALE_MS || 120000);

const log = logger.child(["controller", "metrics"]);
type Handler = (req: ControllerRequest, res: Response) => Promise<Response | void>;

const latestInventoriesByAgent = async () => {
    const rows = await Inventory.aggregate([
        { $sort: { agentId: 1, ts: -1 } },
        { $group: { _id: "$agentId", doc: { $first: "$$ROOT" } } },
    ]).allowDiskUse(true);
    const map = new Map<string, Record<string, unknown>>();
    for (const row of rows) map.set(row._id as string, row.doc as Record<string, unknown>);
    return map;
};

const storageTotals = async () => {
    const docs = await InventoryStorage.find({}, { storageId: 1, inventory: 1 }).lean<
        Array<{ storageId: string; inventory?: Record<string, any> }>
    >();

    let totalBytes = 0;
    let usedBytes = 0;
    let freeBytes = 0;
    const byStorage: Array<Record<string, unknown>> = [];

    for (const doc of docs) {
        const inv = (doc?.inventory as Record<string, any>) || {};
        const capacity = inv.capacity || {};

        let storageTotal = 0;
        let storageUsed = 0;
        let storageFree = 0;

        // Use capacity block from storage.inventory.v1
        const capTotal = Number(capacity.totalBytes ?? 0);
        const capUsed = Number(capacity.usedBytes ?? 0);
        const capAvail = Number(capacity.availBytes ?? 0);

        storageTotal = Math.max(0, capTotal);
        if (capUsed > 0) storageUsed = capUsed;
        else if (capTotal > 0 && capAvail >= 0) storageUsed = Math.max(0, capTotal - capAvail);

        storageFree = capAvail > 0 ? capAvail : Math.max(0, storageTotal - storageUsed);

        if (!storageFree && storageTotal && storageUsed >= 0) storageFree = Math.max(0, storageTotal - storageUsed);

        totalBytes += storageTotal;
        usedBytes += storageUsed;
        freeBytes += storageFree;

        byStorage.push({
            storageId: doc.storageId,
            totalBytes: storageTotal,
            usedBytes: storageUsed,
            freeBytes: storageFree,
            capacity: capacity || undefined,
        });
    }

    return { totalBytes, usedBytes, freeBytes, byStorage };
};

const tasksCountsLast24h = async (filter: Record<string, unknown> = {}) => {
    const since = new Date(Date.now() - 24 * 3600 * 1000);
    const base = { queuedAt: { $gte: since }, ...filter };
    const [queued, done, error] = await Promise.all([
        Task.countDocuments({ ...base, status: "queued" }),
        Task.countDocuments({ ...base, status: "done" }),
        Task.countDocuments({ ...base, status: "error" }),
    ]);
    return { queued, done, error, since };
};

export const adminOverview: Handler = async (req, res) => {
    try {
        const now = Date.now();
        const [hbs, invMap, storage] = await Promise.all([
            Heartbeat.find({}, "agentId version lastSeen").lean(),
            latestInventoriesByAgent(),
            storageTotals(),
        ]);
        const agents = { total: hbs.length, online: 0, offline: 0 };
        for (const hb of hbs) {
            const ts = hb.lastSeen ? new Date(hb.lastSeen).getTime() : 0;
            const online = ts && now - ts < ONLINE_THRESHOLD_MS;
            if (online) agents.online++;
            else agents.offline++;
        }

        let tenants = { total: 0 };
        try {
            tenants.total = await Tenant.countDocuments();
        } catch {
            tenants = { total: 0 };
        }

        let cpuCores = 0;
        let memMB = 0;
        let vmsTotal = 0;
        const vmStates: Record<string, number> = {};
        let dsTotalBytes = 0;
        let dsFreeBytes = 0;

        for (const [agentId, doc] of invMap.entries()) {
            const inv = (doc?.inventory as Record<string, any>) || {};
            const cores =
                inv.host?.hypervHost?.logicalProcessors ??
                inv.host?.cpu?.logicalProcessors ??
                inv.host?.cpu?.threads ??
                inv.host?.cpu?.cores ??
                0;
            const hostMemMB =
                inv.host?.hypervHost?.memoryCapacityMB ??
                inv.host?.memMB ??
                inv.host?.memoryMb ??
                0;
            cpuCores += Number(cores || 0);
            memMB += Number(hostMemMB || 0);

            const vms = inv.vms || [];
            vmsTotal += vms.length;
            for (const vm of vms) {
                const state = String(vm.state || vm.powerState || "Unknown");
                vmStates[state] = (vmStates[state] || 0) + 1;
            }

        }

        const [tasks, latestTasks] = await Promise.all([
            tasksCountsLast24h(),
            Task.find(
                {},
                {
                    _id: 0,
                    taskId: 1,
                    tenantId: 1,
                    agentId: 1,
                    action: 1,
                    status: 1,
                    queuedAt: 1,
                    finishedAt: 1,
                    error: 1,
                }
            )
                .sort({ queuedAt: -1 })
                .limit(30)
                .lean(),
        ]);

        return respondEnvelope(res, req, "Quota", {
            success: true,
            agents,
            tenants,
            vms: { total: vmsTotal, byState: vmStates },
            compute: { cpuCores, memMB },
            storage: storage,
            tasks: { last24h: tasks, latest: latestTasks },
            ts: new Date().toISOString(),
        });
    } catch (error) {
        log.error("[metrics] adminOverview", { error });
        return res.status(500).json({ error: "metrics failed" });
    }
};

export const adminDatastores: Handler = async (req, res) => {
    try {
        const storage = await storageTotals();
        return respondEnvelope(res, req, "Quota", {
            success: true,
            totalBytes: storage.totalBytes,
            usedBytes: storage.usedBytes,
            freeBytes: storage.freeBytes,
            byStorage: storage.byStorage,
            ts: new Date().toISOString(),
        });
    } catch (error) {
        log.error("[metrics] adminDatastores", { error });
        return res.status(500).json({ error: "metrics failed" });
    }
};

export const adminCompute: Handler = async (req, res) => {
    try {
        const invMap = await latestInventoriesByAgent();
        const rows: Array<Record<string, unknown>> = [];
        let cpuCores = 0;
        let memMB = 0;

        for (const [agentId, doc] of invMap.entries()) {
            const inv = (doc?.inventory as Record<string, any>) || {};
            const cores =
                inv.host?.hypervHost?.logicalProcessors ??
                inv.host?.cpu?.logicalProcessors ??
                inv.host?.cpu?.threads ??
                inv.host?.cpu?.cores ??
                0;
            const hostMemMB =
                inv.host?.hypervHost?.memoryCapacityMB ??
                inv.host?.memMB ??
                inv.host?.memoryMb ??
                0;
            cpuCores += Number(cores || 0);
            memMB += Number(hostMemMB || 0);

            rows.push({
                agentId,
                cpuCores: Number(cores || 0),
                memMB: Number(hostMemMB || 0),
                host: inv.host || {},
            });
        }

        return respondEnvelope(res, req, "Quota", {
            success: true,
            total: { cpuCores, memMB },
            byAgent: rows,
            ts: new Date().toISOString(),
        });
    } catch (error) {
        log.error("[metrics] adminCompute", { error });
        return res.status(500).json({ error: "metrics failed" });
    }
};

export const adminVMs: Handler = async (req, res) => {
    try {
        const invMap = await latestInventoriesByAgent();
        const rows: Array<Record<string, unknown>> = [];

        for (const [agentId, doc] of invMap.entries()) {
            const inv = (doc?.inventory as Record<string, any>) || {};
            const vms = inv.vms || [];
            rows.push({ agentId, vms });
        }

        return respondEnvelope(res, req, "Quota", { success: true, rows, ts: new Date().toISOString() });
    } catch (error) {
        log.error("[metrics] adminComputeVms", { error });
        return res.status(500).json({ error: "metrics failed" });
    }
};

export const adminTenantOverview: Handler = async (req, res) => {
    try {
        const tenantId = (req.query?.tenantId as string | undefined)?.trim();
        const filter = tenantId ? { tenantId } : {};
        const tenants = await Tenant.find(filter, { tenantId: 1, name: 1, quotas: 1 }).lean();

        const tenantsWithTasks = await Promise.all(
            tenants.map(async (tenant) => {
                const tasks = await tasksCountsLast24h({ tenantId: tenant.tenantId });
                return { ...tenant, tasks };
            })
        );

        return respondEnvelope(res, req, "Quota", { success: true, data: tenantsWithTasks });
    } catch (error) {
        log.error("[metrics] adminTenantOverview", { error });
        return res.status(500).json({ error: "metrics failed" });
    }
};

export const tenantOverview: Handler = async (req, res) => {
    try {
        const tenantId = req.tenantId;
        if (!tenantId) return res.status(400).json({ error: "Missing tenant context" });

        const tenantDoc = await Tenant.findOne({ tenantId }, { _id: 1 }).lean();
        if (!tenantDoc?._id) return res.status(404).json({ error: "Tenant not found" });

        const [tasksSummary, resourceCount, quotas] = await Promise.all([
            tasksCountsLast24h({ tenantId }),
            TenantResource.countDocuments({ tenantId }),
            getTenantQuotas(tenantDoc._id),
        ]);

        return respondEnvelope(res, req, "Quota", {
            success: true,
            data: {
                tasks: tasksSummary,
                resources: resourceCount,
                quotas,
            },
        });
    } catch (error) {
        log.error("[metrics] tenantOverview", { error });
        return res.status(500).json({ error: "metrics failed" });
    }
};
