import type { Response } from "express";
import { ERR, send } from "../lib/errors/http-errors";
import {
    validateClaimBody,
    validateListQuery,
    validateUnassignedQuery,
    validateUnclaimParams,
    validateUnclaimQuery,
} from "../lib/schemas/resource";
import TenantResource, { type TenantResourceLink } from "../models/TenantResource";
import InventoryFull from "../models/Inventory.full";
import InventoryLight from "../models/Inventory.light";
import type { ControllerRequest } from "../types/express";
import {
    type InventoryDatastore,
    type InventoryDoc,
    type InventoryNetworkAdapter,
    type InventoryRoot,
    type InventorySwitch,
    type InventoryVm,
    type PickedResource,
    type ResourceData,
    type VmStorage,
} from "../types/resources";
import logger from "../lib/logger";

const log = logger.child(["controller", "resources"]);
type Handler = (req: ControllerRequest, res: Response) => Promise<Response | void>;

const getTenantId = (req: ControllerRequest) =>
    req.params?.tenantId || req.tenantId || req.user?.tenantId || null;

const arr = <T = unknown>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const normPath = (input?: string | null) =>
    typeof input === "string" ? input.replace(/\//g, "\\").toLowerCase() : input ?? undefined;

const root = (doc?: InventoryDoc | null): InventoryRoot =>
    (doc?.inventory?.inventory || doc?.inventory || {}) as InventoryRoot;

const vmKey = (vm: InventoryVm) => vm.guid || vm.id || vm.name || null;

const mapBy = <T>(list: T[], keyFn: (item: T) => string | null | undefined) => {
    const map = new Map<string, T>();
    for (const item of list) {
        const key = keyFn(item);
        if (key) map.set(String(key), item);
    }
    return map;
};

const getTs = (doc?: InventoryDoc | null) => {
    if (!doc) return null;
    if (doc.ts) {
        const t = new Date(doc.ts).getTime();
        if (Number.isFinite(t)) return t;
    }
    const collected = root(doc)?.collectedAt as string | Date | undefined;
    if (collected) {
        const t = new Date(collected).getTime();
        if (Number.isFinite(t)) return t;
    }
    return null;
};

const vmKeysAll = (vm: InventoryVm) =>
    [vm.guid, vm.id, vm.name].filter(Boolean).map((key) => String(key));

const lcase = (value?: string | null) => (typeof value === "string" ? value.toLowerCase() : value);

const STALE_MS = Number(
    process.env.AGENT_STALE_MS ||
        process.env.RESOURCE_STATE_STALE_MS ||
        3 * 60 * 1000
);

const agentLastTs = (fullDoc?: InventoryDoc | null, lightDoc?: InventoryDoc | null) => {
    const t1 = getTs(fullDoc) ?? -Infinity;
    const t2 = getTs(lightDoc) ?? -Infinity;
    return Math.max(t1, t2);
};

const isStale = (fullDoc?: InventoryDoc | null, lightDoc?: InventoryDoc | null, now = Date.now()) => {
    const last = agentLastTs(fullDoc, lightDoc);
    return !Number.isFinite(last) || now - last > STALE_MS;
};

const VOLATILE_FIELDS = [
    "state",
    "uptimeSec",
    "cpuUsagePct",
    "memoryAssignedMB",
    "automaticStart",
    "automaticStop",
];

const mergeVm = (baseVm: InventoryVm, overlayVm?: InventoryVm) => {
    if (!overlayVm) return { ...baseVm };
    const out: InventoryVm = { ...baseVm };

    for (const key of VOLATILE_FIELDS) {
        if ((overlayVm as Record<string, unknown>)[key] != null) {
            (out as Record<string, unknown>)[key] = (overlayVm as Record<string, unknown>)[key];
        }
    }

    const baseDisks = arr<VmStorage>(baseVm.storage);
    const ovDisks = arr<VmStorage>(overlayVm.storage);
    const byPath = mapBy(ovDisks, (disk) => normPath(disk?.path || disk?.vhd?.path));

    out.storage = baseDisks.map((bd) => {
        const od = byPath.get(normPath(bd?.path || bd?.vhd?.path) || "");
        if (!od) return bd;

        const baseVhd = bd?.vhd || {};
        const ov = od?.vhd || {};

        const current = typeof baseVhd.fileSizeMB === "number" ? baseVhd.fileSizeMB : -Infinity;
        const next =
            typeof ov.fileSizeMB === "number" ? Math.max(current, ov.fileSizeMB) : current;

        return {
            ...bd,
            vhd: {
                ...baseVhd,
                format: baseVhd.format ?? ov.format ?? null,
                type: baseVhd.type ?? ov.type ?? null,
                sizeMB: baseVhd.sizeMB ?? null,
                fileSizeMB: Number.isFinite(next) ? next : baseVhd.fileSizeMB ?? null,
                parentPath: baseVhd.parentPath ?? null,
                blockSize: baseVhd.blockSize ?? null,
                logicalSectorSize: baseVhd.logicalSectorSize ?? null,
                physicalSectorSize: baseVhd.physicalSectorSize ?? null,
            },
        };
    });

    return out;
};

const combineAgent = (
    fullDoc?: InventoryDoc | null,
    lightDoc?: InventoryDoc | null,
    allowLightOnlyKeys: Set<string> | null = null
) => {
    const fullVms = arr<InventoryVm>(root(fullDoc).vms);
    const lightVms = arr<InventoryVm>(root(lightDoc).vms);

    const tFull = getTs(fullDoc) ?? -Infinity;
    const tLight = getTs(lightDoc) ?? -Infinity;
    const lightIsNewer = tLight > tFull;

    const byLight = new Map<string, InventoryVm>();
    for (const vm of lightVms) {
        for (const key of vmKeysAll(vm)) {
            if (!byLight.has(key)) byLight.set(key, vm);
        }
    }

    if (fullVms.length === 0) {
        return lightVms.map((vm) => ({ ...vm }));
    }

    const presentKeyLC = new Set<string>();
    const out: InventoryVm[] = [];

    for (const fullVm of fullVms) {
        let lv: InventoryVm | null = null;
        for (const key of vmKeysAll(fullVm)) {
            if (byLight.has(key)) {
                lv = byLight.get(key) || null;
                break;
            }
        }
        const merged = lightIsNewer && lv ? mergeVm(fullVm, lv) : { ...fullVm };
        out.push(merged);
        vmKeysAll(fullVm).forEach((key) => presentKeyLC.add(lcase(key) || ""));
    }

    if (lightIsNewer && allowLightOnlyKeys && allowLightOnlyKeys.size) {
        for (const lv of lightVms) {
            const keys = vmKeysAll(lv);
            const alreadyPresent = keys.some((key) => presentKeyLC.has(lcase(key) || ""));
            if (alreadyPresent) continue;

            const allowed = keys.some((key) => allowLightOnlyKeys.has(lcase(key) || ""));
            if (allowed) {
                out.push({ ...lv });
                keys.forEach((key) => presentKeyLC.add(lcase(key) || ""));
            }
        }
    }

    return out;
};

const pickFromInv = (
    doc?: InventoryDoc | null,
    filter: { kind?: string; agentId?: string } = {}
): PickedResource[] => {
    if (!doc) return [];
    const out: Array<{
        kind: string;
        agentId: string;
        refId: string;
        data: ResourceData;
    }> = [];
    const agentId = filter.agentId || doc.agentId;
    if (!agentId) return out;

    const inv = root(doc) as { vms?: InventoryVm[]; networks?: { switches?: InventorySwitch[] } };
    const includeVm = !filter.kind || filter.kind === "vm";
    const includeSwitch = !filter.kind || filter.kind === "switch";
    const includeDisk = !filter.kind || filter.kind === "disk";

    if (includeVm) {
        for (const vm of arr<InventoryVm>(inv.vms)) {
            const refId = vmKey(vm);
            if (!refId) continue;
            out.push({
                kind: "vm",
                agentId,
                refId: String(refId),
                data: {
                    name: vm?.name ?? null,
                    guid: vm?.guid ?? null,
                    state: vm?.state ?? null,
                    cpu: vm?.configuration?.processors?.count ?? vm?.cpu ?? null,
                    ramMB:
                        vm?.memoryAssignedMB ??
                        vm?.configuration?.memory?.startupMB ??
                        null,
                    switches: arr<InventoryNetworkAdapter>(vm?.networkAdapters)
                        .map((n) => n?.switch)
                        .filter(Boolean),
                    raw: vm,
                },
            });
        }
    }

    if (includeSwitch) {
        const switches = arr<InventorySwitch>(inv?.networks?.switches);
        for (const sw of switches) {
            if (!sw?.name) continue;
            out.push({
                kind: "switch",
                agentId,
                refId: String(sw.name),
                data: {
                    name: sw.name ?? null,
                    type: sw.type ?? sw.switchType ?? null,
                    isExternal: sw.isExternal ?? null,
                    raw: sw,
                },
            });
        }
    }

    if (includeDisk) {
        for (const vm of arr<InventoryVm>(inv.vms)) {
            for (const disk of arr<VmStorage>(vm?.storage)) {
                const vhdPath = disk?.vhd?.path || disk?.path;
                if (!vhdPath) continue;
                out.push({
                    kind: "disk",
                    agentId,
                    refId: String(vhdPath),
                    data: {
                        name: vm?.name ?? null,
                        vmGuid: vm?.guid ?? null,
                        path: vhdPath,
                        sizeMB: disk?.vhd?.sizeMB ?? null,
                        fileSizeMB: disk?.vhd?.fileSizeMB ?? null,
                        raw: disk,
                    },
                });
            }
        }
    }

    return out;
};

export const listResources: Handler = async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return send(res, ERR.tenantContextMissing(), req);
        const ensuredTenantId = tenantId as string;

        const vq = validateListQuery(req.query || {});
        if (!vq.ok) return send(res, ERR.validationPre(vq.errors), req);

        const { kind, agentId, includeOrphans } = vq.value!;
        const showOrphans = String(includeOrphans).toLowerCase() === "true";

        const query: Record<string, string> = { tenantId: ensuredTenantId };
        if (kind) query.kind = kind;
        if (agentId) query.agentId = agentId;

        const links = await TenantResource.find(query).lean<TenantResourceLink[]>();
        if (!links.length) return res.json({ success: true, data: [] });

        const agentIds = Array.from(new Set(links.map((link) => String(link.agentId))));
        const [fullDocs, lightDocs] = await Promise.all([
            InventoryFull.find(
                { agentId: { $in: agentIds } },
                { agentId: 1, inventory: 1, ts: 1 }
            ).lean<InventoryDoc[]>(),
            InventoryLight.find(
                { agentId: { $in: agentIds } },
                { agentId: 1, inventory: 1, ts: 1 }
            ).lean<InventoryDoc[]>(),
        ]);

        const fullBy = new Map(fullDocs.map((doc) => [doc.agentId, doc]));
        const lightBy = new Map(lightDocs.map((doc) => [doc.agentId, doc]));

        const allowByAgent = new Map<string, Set<string>>();
        for (const link of links) {
            if (link.kind !== "vm") continue;
            const set = allowByAgent.get(link.agentId) || new Set<string>();
            if (link.refId) set.add(link.refId.toLowerCase());
            if (link.name) set.add(link.name.toLowerCase());
            allowByAgent.set(link.agentId, set);
        }

        const staleByAgent = new Map<string, boolean>();
        for (const id of agentIds) {
            staleByAgent.set(id, isStale(fullBy.get(id), lightBy.get(id)));
        }

        const vmIdxByAgent = new Map<string, Map<string, InventoryVm>>();
        for (const id of agentIds) {
            const merged = combineAgent(
                fullBy.get(id) || null,
                lightBy.get(id) || null,
                allowByAgent.get(id) || null
            );
            const idx = new Map<string, InventoryVm>();
            for (const vm of merged) {
                for (const key of [vm.guid, vm.id, vm.name].filter(Boolean).map(String)) {
                    idx.set(key, vm);
                }
            }
            vmIdxByAgent.set(id, idx);
        }

        const out: Array<Record<string, unknown>> = [];
        for (const link of links) {
            if (link.kind === "vm") {
                const idx = vmIdxByAgent.get(link.agentId) || new Map<string, InventoryVm>();
                let vm = idx.get(String(link.refId));
                if (!vm && link.name) {
                    vm = idx.get(String(link.name));
                    if (!vm) {
                        const wanted = link.name.toLowerCase();
                        for (const candidate of idx.values()) {
                            if ((candidate?.name || "").toLowerCase() === wanted) {
                                vm = candidate;
                                break;
                            }
                        }
                    }
                }
                if (!vm && /^[a-z0-9._-]+$/i.test(String(link.refId))) {
                    const wanted = String(link.refId).toLowerCase();
                    for (const candidate of idx.values()) {
                        if ((candidate?.name || "").toLowerCase() === wanted) {
                            vm = candidate;
                            break;
                        }
                    }
                }

                if (vm) {
                    const stale = !!staleByAgent.get(link.agentId);
                    const vmOut = {
                        ...vm,
                        tenantId: ensuredTenantId,
                        agentId: link.agentId,
                        kind: "vm",
                        refId: link.refId,
                        _staleAgent: stale,
                    };
                    if (stale && vmOut.state !== "NotFound") vmOut.state = "Unknown";
                    out.push(vmOut);
                } else if (showOrphans) {
                    out.push({
                        tenantId: ensuredTenantId,
                        agentId: link.agentId,
                        kind: "vm",
                        refId: link.refId,
                        name: link.name || "(unknown)",
                        state: "NotFound",
                        orphaned: true,
                        assignedAt: link.assignedAt,
                    });
                }
                continue;
            }

            if (link.kind === "switch") {
                const invFull = root(fullBy.get(link.agentId));
                const sw = arr<InventorySwitch>(invFull?.networks?.switches).find((s) => s.name === link.refId);

                if (sw) {
                    out.push({
                        ...sw,
                        tenantId: ensuredTenantId,
                        agentId: link.agentId,
                        kind: "switch",
                        refId: link.refId,
                        _staleAgent: !!staleByAgent.get(link.agentId),
                    });
                } else if (showOrphans) {
                    out.push({
                        tenantId: ensuredTenantId,
                        agentId: link.agentId,
                        kind: "switch",
                        refId: link.refId,
                        name: link.refId,
                        state: "NotFound",
                        orphaned: true,
                        assignedAt: link.assignedAt,
                    });
                }
                continue;
            }
        }

        return res.json({ success: true, data: out });
    } catch (error) {
        log.error("listResources error", { error });
        return send(res, ERR.internal(), req);
    }
};

export const claimResources: Handler = async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return send(res, ERR.tenantContextMissing(), req);

        const vb = validateClaimBody(req.body || {});
        if (!vb.ok) return send(res, ERR.validationPre(vb.errors), req);

        if (!vb.value?.refIds?.length) {
            return send(res, ERR.validationPre([{ path: "body.refIds", message: "must contain at least one id" }]), req);
        }

        const { kind, agentId, refIds } = vb.value;
        const ops = refIds.map((refId) => ({
            updateOne: {
                filter: { kind, agentId, refId },
                update: { $setOnInsert: { tenantId, assignedAt: new Date() } },
                upsert: true,
            },
        }));

        await TenantResource.bulkWrite(ops);
        return res.json({ success: true });
    } catch (error) {
        log.error("claimResources error", { error });
        return send(res, ERR.internal(), req);
    }
};

export const unclaimResource: Handler = async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return send(res, ERR.tenantContextMissing(), req);

        const vp = validateUnclaimParams(req.params || {});
        if (!vp.ok) return send(res, ERR.validationPre(vp.errors), req);

        const vq = validateUnclaimQuery(req.query || {});
        if (!vq.ok) return send(res, ERR.validationPre(vq.errors), req);

        const { resourceId } = vp.value!;
        const { kind, agentId } = vq.value!;

        await TenantResource.deleteOne({ tenantId, kind, agentId, refId: resourceId });
        return res.json({ success: true });
    } catch (error) {
        log.error("unclaimResource error", { error });
        return send(res, ERR.internal(), req);
    }
};

export const listUnassignedResources: Handler = async (req, res) => {
    try {
        const vq = validateUnassignedQuery(req.query || {});
        if (!vq.ok) return send(res, ERR.validationPre(vq.errors), req);

        const { kind, agentId } = vq.value!;
        const limit = Math.min(parseInt((req.query.limit as string) || "100", 10), 500);

        const filter: Record<string, unknown> = {};
        if (agentId) filter.agentId = agentId;

        const invs = await InventoryFull.find(filter, {
            agentId: 1,
            inventory: 1,
            ts: 1,
        }).lean<InventoryDoc[]>();

        const cand: ReturnType<typeof pickFromInv> = [];
        for (const doc of invs) cand.push(...pickFromInv(doc, { kind, agentId: doc.agentId }));
        if (cand.length === 0) return res.json({ success: true, data: [] });

        const key = (r: { kind: string; agentId: string; refId: string }) =>
            `${r.kind}|${r.agentId}|${r.refId}`;
        const uniq = Array.from(new Set(cand.map(key)));

        const assignedSet = new Set<string>();
        const BATCH = 500;

        for (let i = 0; i < uniq.length; i += BATCH) {
            const slice = uniq.slice(i, i + BATCH);
            const or = slice.map((k) => {
                const [knd, aId, ref] = k.split("|");
                return { kind: knd, agentId: aId, refId: ref };
            });
            const assigned = await TenantResource.find(
                { $or: or },
                { kind: 1, agentId: 1, refId: 1 }
            ).lean<TenantResourceLink[]>();
            for (const item of assigned) assignedSet.add(key(item));
        }

        const out: PickedResource[] = [];
        for (const candidate of cand) {
            if (!assignedSet.has(key(candidate))) out.push(candidate);
            if (out.length >= limit) break;
        }

        const staleAgents = new Set(
            invs.filter((doc) => isStale(doc, undefined)).map((doc) => doc.agentId)
        );

        return res.json({
            success: true,
            count: out.length,
            data: out.map((r) => {
                const data: ResourceData = r.data || {};
                const staleAgent = staleAgents.has(r.agentId);
                const base: Record<string, unknown> = {
                    kind: r.kind,
                    agentId: r.agentId,
                    refId: r.refId,
                    name: data.name,
                    guid: data.guid,
                    state: data.state,
                    cpu: data.cpu,
                    ramMB: data.ramMB,
                    switches: data.switches,
                    raw: data,
                    _staleAgent: staleAgent,
                };
                if (base.kind === "vm" && staleAgent && base.state !== "NotFound") {
                    base.state = "Unknown";
                }
                return base;
            }),
        });
    } catch (error) {
        log.error("listUnassignedResources error", { error });
        return send(res, ERR.internal(), req);
    }
};
