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
import InventoryStorage from "../models/Inventory.storage";
import type { ControllerRequest } from "../types/express";
import type { StorageInventoryV1 } from "../types/inventory/storage";
import {
    type InventoryDatastore,
    type InventoryDoc,
    type InventoryNetworkAdapter,
    type InventoryRoot,
    type InventorySwitch,
    type InventoryVm,
    type InventoryDisk,
    type PickedResource,
    type ResourceData,
} from "../types/resources";
import logger from "../lib/logger";
import { respondEnvelope } from "../middlewares/addEnveloppe";
import Heartbeat from "../models/Heartbeat";

const log = logger.child(["controller", "resources"]);
type Handler = (req: ControllerRequest, res: Response) => Promise<Response | void>;

const normalizeTenantId = (value: string | null | undefined) =>
    typeof value === "string" ? value.trim().toLowerCase() || null : null;
const normTenantStr = (value: string) => value.trim().toLowerCase();

const getTenantId = (req: ControllerRequest) => {
    const candidates = [
        req.params?.tenantId,
        req.tenantId,
        (req.user as Record<string, unknown> | undefined)?.tenantId,
    ];
    const first = candidates.find((id): id is string => typeof id === "string") || null;
    return normalizeTenantId(first);
};

// Small helpers for defensively handling partially shaped inventories.
const arr = <T = unknown>(value: unknown): T[] => (Array.isArray(value) ? (value as T[]) : []);
const normPath = (input?: string | null) =>
    typeof input === "string" ? input.replace(/\//g, "\\").toLowerCase() : input ?? undefined;

const normalizeIpList = (value?: unknown): string[] => {
    const seen = new Set<string>();
    const visit = (v: unknown) => {
        if (!v) return;
        if (typeof v === "string") {
            const trimmed = v.trim();
            if (trimmed) seen.add(trimmed);
            return;
        }
        if (Array.isArray(v)) {
            for (const item of v) visit(item);
            return;
        }
        if (typeof v === "object") {
            const addr = (v as { address?: unknown }).address;
            if (addr) visit(addr);
            for (const val of Object.values(v as Record<string, unknown>)) visit(val);
        }
    };
    visit(value);
    return Array.from(seen);
};

const normalizeNicIpAddresses = (nic?: InventoryNetworkAdapter | null): InventoryNetworkAdapter | null => {
    if (!nic || typeof nic !== "object") return null;
    const ipAddresses = normalizeIpList((nic as { ipAddresses?: unknown }).ipAddresses);
    return { ...nic, ipAddresses };
};

const normalizeVmIpAddresses = (vm?: InventoryVm | null): InventoryVm => {
    if (!vm || typeof vm !== "object") return {} as InventoryVm;
    const vmLevelIps = normalizeIpList((vm as { ipAddresses?: unknown }).ipAddresses);
    const nicsRaw = Array.isArray(vm.nics) ? vm.nics : undefined;
    const networkAdaptersRaw = Array.isArray(vm.networkAdapters) ? vm.networkAdapters : undefined;
    const nics = nicsRaw ? nicsRaw.map(normalizeNicIpAddresses).filter(Boolean) : undefined;
    const networkAdapters = networkAdaptersRaw
        ? networkAdaptersRaw.map(normalizeNicIpAddresses).filter(Boolean)
        : undefined;
    const nicIps = [
        ...(nics || []).flatMap((n) => normalizeIpList((n as { ipAddresses?: unknown }).ipAddresses)),
        ...(networkAdapters || []).flatMap((n) => normalizeIpList((n as { ipAddresses?: unknown }).ipAddresses)),
    ];
    const ipAddresses = Array.from(new Set<string>([...vmLevelIps, ...nicIps]));

    return {
        ...vm,
        ipAddresses,
        ...(nicsRaw ? { nics: nics as InventoryNetworkAdapter[] } : {}),
        ...(networkAdaptersRaw ? { networkAdapters: networkAdapters as InventoryNetworkAdapter[] } : {}),
    };
};

// Pull the canonical inventory root; if missing, work with an empty object.
const root = (doc?: InventoryDoc | null): InventoryRoot =>
    (doc?.inventory as InventoryRoot | undefined) || ({} as InventoryRoot);

// Normalize networks to an array; the agent always sends an array in the canonical shape.
const networksOf = (inv: InventoryRoot): InventorySwitch[] => {
    const nets = inv?.networks;
    return Array.isArray(nets) ? nets : [];
};

const vmKey = (vm: InventoryVm) => vm.id || vm.name || null;

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

const lcase = (value?: string | number | null) => (value == null ? "" : String(value).toLowerCase());
const looksLikeIqn = (value?: string | null) => /^iqn\./i.test(String(value || "").trim());

// Single staleness threshold driven by heartbeat age.
const STALE_MS = Number(process.env.AGENT_STALE_MS || 3 * 60 * 1000);

const agentLastTs = (fullDoc?: InventoryDoc | null, lightDoc?: InventoryDoc | null) => {
    const t1 = getTs(fullDoc) ?? -Infinity;
    const t2 = getTs(lightDoc) ?? -Infinity;
    return Math.max(t1, t2);
};

const isStale = (fullDoc?: InventoryDoc | null, lightDoc?: InventoryDoc | null, now = Date.now()) => {
    const last = agentLastTs(fullDoc, lightDoc);
    return !Number.isFinite(last) || now - last > STALE_MS;
};

const isHeartbeatStale = (hb?: { lastSeen?: Date | string } | null, now = Date.now()) => {
    const ts = hb?.lastSeen ? new Date(hb.lastSeen).getTime() : NaN;
    return !Number.isFinite(ts) || now - ts > STALE_MS;
};

const stripDiskIqn = (disk: InventoryDisk) => {
    if (!disk || typeof disk !== "object") return disk;
    const { iqn, ...rest } = disk;
    return rest;
};

const sanitizeVmDisks = (vm: InventoryVm) => {
    const disks = Array.isArray(vm?.disks) ? vm.disks : null;
    if (!disks) return { ...vm };
    return { ...vm, disks: disks.map(stripDiskIqn) };
};

const stripIqnField = (value: Record<string, unknown>) => {
    const { iqn, ...rest } = value;
    return rest;
};

const VOLATILE_FIELDS = [
    "state",
    "powerState",
    "uptimeSec",
    "cpuUsagePct",
    "memoryAssignedMB",
    "memoryMb",
    "automaticStart",
    "automaticStop",
];

// Overlay volatile runtime fields from the light inventory onto the full snapshot.
const mergeVm = (baseVm: InventoryVm, overlayVm?: InventoryVm) => {
    if (!overlayVm) return { ...baseVm };
    const out: InventoryVm = { ...baseVm };

    for (const key of VOLATILE_FIELDS) {
        if ((overlayVm as Record<string, unknown>)[key] != null) {
            (out as Record<string, unknown>)[key] = (overlayVm as Record<string, unknown>)[key];
        }
    }

    return out;
};

const vmKeysAll = (vm: InventoryVm) =>
    [vm.id, (vm as { uuid?: string }).uuid, (vm as { _id?: string })._id, vm.name]
        .filter(Boolean)
        .map((key) => String(key));

const combineAgent = (
    fullDoc?: InventoryDoc | null,
    lightDoc?: InventoryDoc | null,
    allowLightOnlyKeys: Set<string> | null = null
) => {
    // Merge full + light inventories into a single VM list:
    // - prefer light for volatile state if it is newer
    // - optionally allow light-only VMs when they match allowed refIds
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

const sizeMbFromStorageImage = (image: Record<string, unknown>) => {
    const sizeMB =
        (image.sizeMB as number | undefined) ??
        (image.sizeMiB as number | undefined) ??
        (image.sizeGB as number | undefined) ??
        (image.sizeBytes as number | undefined) ??
        (image.virtualSizeBytes as number | undefined) ??
        (image.usedBytes as number | undefined);

    if (sizeMB == null) return 0;
    if (image.sizeGB !== undefined) return Math.max(0, (image.sizeGB as number) * 1024);
    if (image.sizeBytes !== undefined) return Math.max(0, Math.round((image.sizeBytes as number) / 1024 / 1024));
    if (image.virtualSizeBytes !== undefined) return Math.max(0, Math.round((image.virtualSizeBytes as number) / 1024 / 1024));
    if (image.usedBytes !== undefined) return Math.max(0, Math.round((image.usedBytes as number) / 1024 / 1024));
    return Number.isFinite(sizeMB) ? Math.max(0, (sizeMB as number) | 0) : 0;
};

const pickFromInv = (
    doc?: InventoryDoc | null,
    filter: { kind?: string; agentId?: string } = {}
): PickedResource[] => {
    // Flatten a single inventory doc into PickedResource entries for VM/switch
    if (!doc) return [];
    const out: Array<{
        kind: string;
        agentId: string;
        refId: string;
        data: ResourceData;
    }> = [];
    const agentId = filter.agentId || doc.agentId;
    if (!agentId) return out;

    const inv: InventoryRoot = root(doc);
    const includeVm = !filter.kind || filter.kind === "vm";
    const includeSwitch = !filter.kind || filter.kind === "switch";

    if (includeVm) {
        for (const vm of arr<InventoryVm>(inv.vms)) {
            const refId = vmKey(vm);
            if (!refId) continue;
            const vmSafe = normalizeVmIpAddresses(sanitizeVmDisks(vm));
            const ipAddresses = Array.isArray(vmSafe.ipAddresses) ? vmSafe.ipAddresses : [];
            const vmWithIp = { ...vmSafe, ipAddresses };
            out.push({
                kind: "vm",
                agentId,
                refId: String(refId),
                data: {
                    name: vmWithIp?.name ?? null,
                    guid: vmWithIp?.id ?? null,
                    state: vmWithIp?.state ?? vmWithIp?.powerState ?? null,
                    cpu: (vmWithIp?.cpu as { vcpus?: number | null })?.vcpus ?? null,
                    ramMB: vmWithIp?.memoryMb ?? null,
                    switches: [
                        ...arr<InventoryNetworkAdapter>(vmWithIp?.nics as InventoryNetworkAdapter[] | undefined)
                            .map((n) => n?.networkId || n?.switch)
                            .filter(Boolean),
                        ...arr<InventoryNetworkAdapter>(vmWithIp?.networkAdapters)
                            .map((n) => n?.switch || n?.networkId)
                            .filter(Boolean),
                    ],
                    ...(ipAddresses.length ? { ipAddresses } : {}),
                    raw: vmWithIp,
                },
            });
        }
    }

    if (includeSwitch) {
        const switches = networksOf(inv);
        for (const sw of switches) {
            const name = sw?.name || sw?.id;
            if (!name) continue;
            out.push({
                kind: "switch",
                agentId,
                refId: String(name),
                data: {
                    name: name ?? null,
                    type: sw.type ?? sw.switchType ?? null,
                    isExternal: sw.isExternal ?? null,
                    raw: sw,
                },
            });
        }
    }

    return out;
};

const buildAllowByAgent = (links: TenantResourceLink[]) => {
    const allowByAgent = new Map<string, Set<string>>();
    for (const link of links) {
        if (link.kind !== "vm") continue;
        const set = allowByAgent.get(link.agentId) || new Set<string>();
        if (link.refId) set.add(link.refId.toLowerCase());
        if (link.name) set.add(link.name.toLowerCase());
        allowByAgent.set(link.agentId, set);
    }
    return allowByAgent;
};

const buildStaleByAgent = (
    agentIds: string[],
    hbBy: Map<string, { lastSeen?: Date | string }>,
    now: number
) => {
    const staleByAgent = new Map<string, boolean>();
    for (const id of agentIds) {
        const hbDoc = hbBy.get(id);
        const hbStale = isHeartbeatStale(hbDoc, now);
        // If no heartbeat, consider the agent stale.
        staleByAgent.set(id, hbDoc ? hbStale : true);
    }
    return staleByAgent;
};

const buildVmIndexByAgent = (
    agentIds: string[],
    fullBy: Map<string, InventoryDoc>,
    lightBy: Map<string, InventoryDoc>,
    allowByAgent: Map<string, Set<string>>
) => {
    const vmIdxByAgent = new Map<string, Map<string, InventoryVm>>();
    for (const id of agentIds) {
        const merged = combineAgent(
            fullBy.get(id) || null,
            lightBy.get(id) || null,
            allowByAgent.get(id) || null
        );
        const idx = new Map<string, InventoryVm>();
        for (const vm of merged) {
            const keys = [vm.id, (vm as { uuid?: string }).uuid, (vm as { _id?: string })._id, vm.name]
                .filter(Boolean)
                .map(String);
            keys.forEach((key) => idx.set(key, vm));
        }
        vmIdxByAgent.set(id, idx);
    }
    return vmIdxByAgent;
};

const buildAttachedDisksByVm = (links: TenantResourceLink[]) => {
    const attachedDisksByVm = new Map<
        string,
        Array<{ refId?: string; agentId?: string; name?: string; attachedAt?: Date }>
    >();
    for (const link of links) {
        if (link.kind !== "storage") continue;
        if (!link.attachedVmRefId || !link.attachedVmAgentId) continue;
        const key = `${link.attachedVmAgentId}|${link.attachedVmRefId}`;
        const safeRefId = looksLikeIqn(link.refId) ? (link.name || link.refId) : link.refId;
        const list = attachedDisksByVm.get(key) || [];
        list.push({
            refId: safeRefId,
            agentId: link.agentId,
            name: link.name,
            attachedAt: link.attachedAt,
        });
        attachedDisksByVm.set(key, list);
    }
    return attachedDisksByVm;
};

const findVmForLink = (idx: Map<string, InventoryVm>, link: TenantResourceLink) => {
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
    return vm;
};

const recordVmIqnLinks = (
    vm: InventoryVm,
    link: TenantResourceLink,
    iqnToTenantVm: Map<string, { refId: string; agentId: string; name?: string }>
) => {
    for (const disk of Array.isArray(vm?.disks) ? vm.disks : []) {
        const iqn = typeof disk?.iqn === "string" ? disk.iqn.trim() : "";
        if (!iqn) continue;
        const key = iqn.toLowerCase();
        if (!iqnToTenantVm.has(key)) {
            iqnToTenantVm.set(key, {
                refId: link.refId,
                agentId: link.agentId,
                name: (vm as { name?: string }).name || link.name || link.refId,
            });
        }
    }
};

const buildVmOutput = (
    link: TenantResourceLink,
    ensuredTenantId: string,
    vm: InventoryVm,
    stale: boolean,
    attachedDisks?: Array<{ refId?: string; agentId?: string; name?: string; attachedAt?: Date }>
) => {
    const vmSafe = normalizeVmIpAddresses(sanitizeVmDisks(vm));
    const ipAddresses = Array.isArray(vmSafe.ipAddresses) ? vmSafe.ipAddresses : [];
    const vmWithIp = { ...vmSafe, ipAddresses };
    const vmOut = {
        ...vmWithIp,
        tenantId: ensuredTenantId,
        agentId: link.agentId,
        kind: "vm",
        refId: link.refId,
        ha: link.ha ?? false,
        ...(attachedDisks ? { attachedDisks } : {}),
        _staleAgent: stale,
    };
    if (stale) vmOut.powerState = "Unknown";
    return vmOut;
};

const buildStorageOutput = (
    link: TenantResourceLink,
    ensuredTenantId: string,
    vol: Record<string, unknown>,
    stale: boolean,
    state: string,
    attached?: { refId?: string; agentId?: string; name?: string; attachedAt?: Date }
) => {
    const volSafe = stripIqnField(vol);
    const safeRefId = String(vol.refId || link.name || link.refId || "");
    const usedBytes =
        typeof vol?.usedBytes === "number" && Number.isFinite(vol.usedBytes)
            ? Math.max(0, vol.usedBytes)
            : undefined;
    return {
        ...volSafe,
        tenantId: ensuredTenantId,
        agentId: link.agentId,
        kind: "storage",
        refId: safeRefId,
        name: link.name || vol.refId,
        sizeMB: sizeMbFromStorageImage(vol),
        ...(usedBytes !== undefined ? { usedBytes, usedMB: Math.round(usedBytes / 1024 / 1024) } : {}),
        ha: link.ha ?? false,
        state: stale ? "Unknown" : state,
        ...(attached ? { attachedTo: attached } : {}),
        _staleAgent: stale,
    };
};

export const listResources: Handler = async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return send(res, ERR.tenantContextMissing(), req);
        const ensuredTenantId = normTenantStr(tenantId as string);

        const vq = validateListQuery(req.query || {});
        if (!vq.ok) return send(res, ERR.validationPre(vq.errors), req);

        const { kind, agentId, includeOrphans } = vq.value!;
        const showOrphans = String(includeOrphans).toLowerCase() === "true";

        const query: Record<string, string> = { tenantId: ensuredTenantId };
        if (kind) query.kind = kind;
        if (agentId) query.agentId = agentId;

        const links = await TenantResource.find(query).lean<TenantResourceLink[]>();
        if (!links.length) return respondEnvelope(res, req, "Resources", { success: true, data: [] });

        const agentIds = Array.from(new Set(links.map((link) => String(link.agentId))));
        const storageAgentIds = Array.from(
            new Set(links.filter((l) => l.kind === "storage").map((l) => String(l.agentId)))
        );
        const [fullDocs, lightDocs, storageDocs, heartbeatDocs] = await Promise.all([
            InventoryFull.find(
                { agentId: { $in: agentIds } },
                { agentId: 1, inventory: 1, ts: 1 }
            ).lean<InventoryDoc[]>(),
            InventoryLight.find(
                { agentId: { $in: agentIds } },
                { agentId: 1, inventory: 1, ts: 1 }
            ).lean<InventoryDoc[]>(),
            storageAgentIds.length
                ? InventoryStorage.find(
                      { storageId: { $in: storageAgentIds } },
                      { storageId: 1, inventory: 1, ts: 1 }
                  ).lean<Array<{ storageId: string; inventory?: Record<string, unknown> }>>()
                : Promise.resolve([]),
            agentIds.length
                ? Heartbeat.find(
                      { agentId: { $in: agentIds } },
                      { agentId: 1, lastSeen: 1 }
                  ).lean<Array<{ agentId: string; lastSeen?: Date | string }>>()
                : Promise.resolve([]),
        ]);

        const fullBy = new Map(fullDocs.map((doc) => [doc.agentId, doc]));
        const lightBy = new Map(lightDocs.map((doc) => [doc.agentId, doc]));
        const storageBy = new Map(storageDocs.map((doc) => [doc.storageId, doc]));
        const hbBy = new Map(heartbeatDocs.map((hb) => [hb.agentId, hb]));

        const allowByAgent = buildAllowByAgent(links);

        const now = Date.now();
        const staleByAgent = buildStaleByAgent(agentIds, hbBy, now);
        const vmIdxByAgent = buildVmIndexByAgent(agentIds, fullBy, lightBy, allowByAgent);
        const attachedDisksByVm = buildAttachedDisksByVm(links);

        const iqnToTenantVm = new Map<string, { refId: string; agentId: string; name?: string }>();

        const out: Array<Record<string, unknown>> = [];
        for (const link of links) {
            if (link.kind === "vm") {
                const idx = vmIdxByAgent.get(link.agentId) || new Map<string, InventoryVm>();
                const vm = findVmForLink(idx, link);

                if (vm) {
                    const stale = !!staleByAgent.get(link.agentId);
                    const attachedKey = `${link.agentId}|${link.refId}`;
                    const attachedDisks = attachedDisksByVm.get(attachedKey);
                    recordVmIqnLinks(vm, link, iqnToTenantVm);
                    out.push(buildVmOutput(link, ensuredTenantId, vm, stale, attachedDisks));
                } else if (showOrphans) {
                    out.push({
                        tenantId: ensuredTenantId,
                        agentId: link.agentId,
                        kind: "vm",
                        refId: link.refId,
                        name: link.name || "(unknown)",
                        state: "NotFound",
                        ha: link.ha ?? false,
                        orphaned: true,
                        assignedAt: link.assignedAt,
                    });
                }
                continue;
            }

            if (link.kind === "storage") {
                const inv = storageBy.get(link.agentId)?.inventory as StorageInventoryV1 | undefined;
                const volumes = Array.isArray(inv?.volumes) ? inv.volumes : [];
                const refRaw = String(link.refId || "");
                const ref = refRaw.toLowerCase();
                let vol = volumes.find((v) => String(v.refId || "").toLowerCase() === ref);
                if (!vol && looksLikeIqn(refRaw)) {
                    vol = volumes.find((v) => String(v.iqn || "").toLowerCase() === ref);
                }
                const stale = !!staleByAgent.get(link.agentId);
                const attachedTask =
                    link.attachedVmRefId || link.attachedVmAgentId || link.attachedVmName || link.attachedAt
                        ? {
                              refId: link.attachedVmRefId,
                              agentId: link.attachedVmAgentId,
                              name: link.attachedVmName,
                              attachedAt: link.attachedAt,
                          }
                        : undefined;
                const iqn =
                    typeof vol?.iqn === "string"
                        ? vol.iqn
                        : looksLikeIqn(refRaw)
                        ? refRaw
                        : "";
                const computeAttachment = iqn ? iqnToTenantVm.get(iqn.toLowerCase()) : undefined;
                const attachedFromCompute = !!computeAttachment;
                const attachedFromStorage = !!vol?.isAttached;
                const state = attachedFromCompute || attachedFromStorage ? "attached" : attachedTask ? "mismatch" : "unattached";
                const attached =
                    attachedTask ||
                    (computeAttachment
                        ? {
                              refId: computeAttachment.refId,
                              agentId: computeAttachment.agentId,
                              name: computeAttachment.name,
                          }
                        : undefined);

                if (vol) {
                    out.push(
                        buildStorageOutput(
                            link,
                            ensuredTenantId,
                            vol as Record<string, unknown>,
                            stale,
                            state,
                            attached
                        )
                    );
                } else if (showOrphans) {
                    const safeRefId = looksLikeIqn(refRaw) ? (link.name || "(unknown)") : link.refId;
                    out.push({
                        tenantId: ensuredTenantId,
                        agentId: link.agentId,
                        kind: "storage",
                        refId: safeRefId,
                        name: link.name || safeRefId,
                        state: "NotFound",
                        ha: link.ha ?? false,
                        ...(attached ? { attachedTo: attached } : {}),
                        orphaned: true,
                        assignedAt: link.assignedAt,
                    });
                }
                continue;
            }

            if (link.kind === "switch") {
                const invFull = root(fullBy.get(link.agentId));
                const sw = networksOf(invFull).find(
                    (s) => s.name === link.refId || s.id === link.refId
                );

                if (sw) {
                    out.push({
                        ...sw,
                        tenantId: ensuredTenantId,
                        agentId: link.agentId,
                        kind: "switch",
                        refId: link.refId,
                        ha: link.ha ?? false,
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
                        ha: link.ha ?? false,
                        orphaned: true,
                        assignedAt: link.assignedAt,
                    });
                }
                continue;
            }
        }

        return respondEnvelope(res, req, "Resources", { success: true, data: out });
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

        const { kind, agentId, refIds, ha } = vb.value;
        const ensuredTenantId = normTenantStr(tenantId as string);
        const ops = refIds.map((refId) => {
            const update: Record<string, unknown> = {
                $setOnInsert: { tenantId: ensuredTenantId, assignedAt: new Date() },
            };
            if (typeof ha === "boolean") {
                update.$set = { ha };
            }
            return {
                updateOne: {
                    filter: { kind, agentId, refId },
                    update,
                    upsert: true,
                },
            };
        });

        await TenantResource.bulkWrite(ops);
        return respondEnvelope(res, req, "Resources", { success: true });
    } catch (error) {
        log.error("claimResources error", { error });
        return send(res, ERR.internal(), req);
    }
};

export const unclaimResource: Handler = async (req, res) => {
    try {
        const tenantId = getTenantId(req);
        if (!tenantId) return send(res, ERR.tenantContextMissing(), req);
        const ensuredTenantId = normTenantStr(tenantId as string);

        const vp = validateUnclaimParams(req.params || {});
        if (!vp.ok) return send(res, ERR.validationPre(vp.errors), req);

        const vq = validateUnclaimQuery(req.query || {});
        if (!vq.ok) return send(res, ERR.validationPre(vq.errors), req);

        const { resourceId } = vp.value!;
        const { kind, agentId } = vq.value!;

        await TenantResource.deleteOne({
            tenantId: ensuredTenantId,
            kind,
            agentId,
            refId: resourceId,
        });
        return respondEnvelope(res, req, "Resources", { success: true });
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

        const storageFilter: Record<string, unknown> = {};
        if (agentId) storageFilter.storageId = agentId;
        const wantStorage = !kind || kind === "storage";
        const storageInvs = wantStorage
            ? await InventoryStorage.find(storageFilter, {
                  storageId: 1,
                  inventory: 1,
                  ts: 1,
              }).lean<Array<{ storageId: string; inventory?: StorageInventoryV1; ts?: Date | string }>>()
            : [];

        const heartbeatAgentIds = new Set<string>();
        for (const doc of invs) heartbeatAgentIds.add(doc.agentId);
        for (const doc of storageInvs) heartbeatAgentIds.add(doc.storageId);
        const heartbeatDocs = heartbeatAgentIds.size
            ? await Heartbeat.find(
                  { agentId: { $in: Array.from(heartbeatAgentIds) } },
                  { agentId: 1, lastSeen: 1 }
              ).lean<Array<{ agentId: string; lastSeen?: Date | string }>>()
            : [];
        const hbBy = new Map(heartbeatDocs.map((hb) => [hb.agentId, hb]));

        const cand: ReturnType<typeof pickFromInv> = [];
        for (const doc of invs) cand.push(...pickFromInv(doc, { kind, agentId: doc.agentId }));
        if (!kind || kind === "storage") {
            for (const doc of storageInvs) {
                const volumes = Array.isArray(doc?.inventory?.volumes)
                    ? (doc.inventory!.volumes as Array<Record<string, unknown>>)
                    : [];
                for (const vol of volumes) {
                    const refId =
                        typeof vol?.refId === "string" && vol.refId.trim()
                            ? vol.refId.trim()
                            : typeof vol?.iqn === "string"
                            ? vol.iqn.trim()
                            : null;
                    if (!refId) continue;
                    cand.push({
                        kind: "storage",
                        agentId: doc.storageId,
                        refId,
                        data: {
                            name: vol.refId ?? refId,
                            iqn: vol.iqn,
                            sizeMB: sizeMbFromStorageImage(vol as Record<string, unknown>),
                            state: vol.isAttached ? "attached" : "unattached",
                            raw: vol,
                        },
                    });
                }
            }
        }

        if (cand.length === 0) return respondEnvelope(res, req, "Resources", { success: true, data: [] });

        const key = (r: { kind: string; agentId: string; refId: string }) =>
            `${String(r.kind).toLowerCase()}|${String(r.agentId).toLowerCase()}|${String(r.refId).toLowerCase()}`;
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

        if (wantStorage) {
            const linkFilter: Record<string, unknown> = { kind: "storage" };
            if (agentId) linkFilter.agentId = agentId;
            const storageLinks = await TenantResource.find(linkFilter, {
                kind: 1,
                agentId: 1,
                refId: 1,
                name: 1,
            }).lean<TenantResourceLink[]>();
            for (const link of storageLinks) {
                assignedSet.add(key(link));
                if (link.name) {
                    assignedSet.add(
                        key({ kind: "storage", agentId: link.agentId, refId: link.name })
                    );
                }
            }
        }

        const out: PickedResource[] = [];
        for (const candidate of cand) {
            if (!assignedSet.has(key(candidate))) out.push(candidate);
            if (out.length >= limit) break;
        }

        const now = Date.now();
        const staleAgents = new Set<string>();
        for (const [id, hb] of hbBy.entries()) {
            if (isHeartbeatStale(hb, now)) staleAgents.add(id);
        }
        for (const id of heartbeatAgentIds) {
            if (!hbBy.has(id)) staleAgents.add(id);
        }

        return respondEnvelope(res, req, "Resources", {
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
                    ipAddresses: data.ipAddresses,
                    raw: data,
                    _staleAgent: staleAgent,
                };
                if (base.kind === "vm" && staleAgent) {
                    base.powerState = "Unknown";
                }
                if (base.kind === "storage" && staleAgent && base.state !== "NotFound") {
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
