import type { Response } from "express";
import Heartbeat from "../models/Heartbeat";
import Inventory from "../models/Inventory.full";
import Task from "../models/Task";
import Tenant from "../models/Tenant";
import TenantResource from "../models/TenantResource";
import type { ControllerRequest } from "../types/express";
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

const pickRootDatastore = (
    ds: Array<{
        kind?: string;
        path?: string;
        totalBytes?: number;
        freeBytes?: number;
        sizeBytes?: number;
        free?: number;
        drive?: string;
    }> = []
) => {
    if (!Array.isArray(ds) || ds.length === 0) {
        return { totalBytes: 0, freeBytes: 0, item: null as unknown };
    }
    const root = ds.find(
        (d) =>
            String(d?.kind || "").toLowerCase() === "root" ||
            /[\\\/]openhvx[\\\/]?$/i.test(String(d?.path || ""))
    );
    if (root) {
        return {
            totalBytes: Number(root.totalBytes ?? root.sizeBytes ?? 0),
            freeBytes: Number(root.freeBytes ?? root.free ?? 0),
            item: root,
        };
    }
    const byDrive = new Map<string, { totalBytes: number; freeBytes: number; item: unknown }>();
    for (const d of ds) {
        const drive = String(d?.drive || "").toUpperCase();
        if (!drive) continue;
        const current = byDrive.get(drive);
        const total = Number(d.totalBytes ?? d.sizeBytes ?? 0);
        const free = Number(d.freeBytes ?? d.free ?? 0);
        if (!current || total > current.totalBytes) byDrive.set(drive, { totalBytes: total, freeBytes: free, item: d });
    }
    let totalBytes = 0;
    let freeBytes = 0;
    for (const value of byDrive.values()) {
        totalBytes += value.totalBytes;
        freeBytes += value.freeBytes;
    }
    return { totalBytes, freeBytes, item: null };
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
        const [hbs, invMap] = await Promise.all([
            Heartbeat.find({}, "agentId version lastSeen").lean(),
            latestInventoriesByAgent(),
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

            const ds = (doc?.inventory as Record<string, any>)?.datastores || [];
            const root = pickRootDatastore(ds);
            dsTotalBytes += root.totalBytes;
            dsFreeBytes += root.freeBytes;
        }

        const tasks = await tasksCountsLast24h();

        return respondEnvelope(res, req, "Quota", {
            success: true,
            agents,
            tenants,
            vms: { total: vmsTotal, byState: vmStates },
            compute: { cpuCores, memMB },
            datastores: { totalBytes: dsTotalBytes, freeBytes: dsFreeBytes },
            tasks: { last24h: tasks },
            ts: new Date().toISOString(),
        });
    } catch (error) {
        log.error("[metrics] adminOverview", { error });
        return res.status(500).json({ error: "metrics failed" });
    }
};

export const adminDatastores: Handler = async (req, res) => {
    try {
        const invMap = await latestInventoriesByAgent();
        const byAgent: Array<Record<string, unknown>> = [];
        let totalBytes = 0;
        let freeBytes = 0;

        for (const [agentId, doc] of invMap.entries()) {
            const ds = (doc?.inventory as Record<string, any>)?.datastores || [];
            const root = pickRootDatastore(ds);
            totalBytes += root.totalBytes;
            freeBytes += root.freeBytes;
            byAgent.push({
                agentId,
                totalBytes: root.totalBytes,
                freeBytes: root.freeBytes,
                root: root.item,
                all: ds,
            });
        }

        return respondEnvelope(res, req, "Quota", {
            success: true,
            totalBytes,
            freeBytes,
            byAgent,
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

        const [tasksSummary, resourceCount] = await Promise.all([
            tasksCountsLast24h({ tenantId }),
            TenantResource.countDocuments({ tenantId }),
        ]);

        return respondEnvelope(res, req, "Quota", {
            success: true,
            data: {
                tasks: tasksSummary,
                resources: resourceCount,
            },
        });
    } catch (error) {
        log.error("[metrics] tenantOverview", { error });
        return res.status(500).json({ error: "metrics failed" });
    }
};
