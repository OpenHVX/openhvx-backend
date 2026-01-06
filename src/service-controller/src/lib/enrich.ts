// Enrich and augment operation payloads before processing (pushing to agents, etc)

import { resolveImageRef } from "../services/images";
import { planNetTunnelOpen, planSerialOpen, type TunnelPlan } from "../services/console";
import InventoryStorage from "../models/Inventory.storage";
import type { StorageInventoryV1 } from "../types/inventory/storage";

type EnrichPayload = Record<string, unknown>;
type MutablePayload = Record<string, unknown>;
type Target = { ip: string; port: number };

interface EnrichContext {
    tenantId?: string;
    agentId?: string;
    storageAgentId?: string;
    user?: Record<string, unknown>;
    refId?: string;
    vm?: Record<string, unknown>;
}

interface EnrichOptions {
    operation: string;
    object: EnrichPayload;
    ctx?: EnrichContext;
}

interface EnrichResponse {
    ok: boolean;
    data?: EnrichPayload;
    error?: string;
}

type EnrichHandler = (args: { object: EnrichPayload; ctx?: EnrichContext }) => Promise<EnrichPayload>;

type Registry = Record<string, Record<string, EnrichHandler>>;

const registry: Registry = {};

const normalizeAction = (action?: string) => String(action || "").trim();
const normalizeOperation = (operation?: string) => String(operation || "").trim();

const resolveRefId = (object: EnrichPayload, ctx?: EnrichContext) =>
    (object.refId as string) || (object.vmId as string) || ctx?.refId || (ctx?.vm?._id as string) || "";

const requireRefId = (object: EnrichPayload, ctx?: EnrichContext) => {
    const refId = resolveRefId(object, ctx);
    if (!refId) throw new Error("refId/vmId is required");
    return refId;
};

const requireTarget = (object: EnrichPayload): Target => {
    const targetCandidate = object.target as { ip?: string; port?: number } | undefined;
    const target: Target = {
        ip: targetCandidate?.ip || "",
        port: targetCandidate?.port ?? 0,
    };
    if (!target.ip || !target.port) {
        throw new Error("target.ip and target.port are required");
    }
    return target;
};

const ensureImageMeta = async (object: EnrichPayload) => {
    if (!object.imageId) return { ...object };
    const result = await resolveImageRef(object.imageId as string);
    if (!result) throw new Error(`imageId not found: ${object.imageId}`);

    const out: MutablePayload = { ...object };
    out.imageRefId = result.refId;
    out.storageId = out.storageId || result.storageId;
    out.imagePool = result.pool;
    out.imageName = result.name;
    if (result.source) out.imageSource = result.source;
    return out;
};

const toMb = (bytes: number | undefined | null) => {
    if (!Number.isFinite(bytes || 0)) return 0;
    return Math.max(0, Math.round((bytes as number) / 1024 / 1024));
};

const pickStorageSizeMB = (image: Record<string, unknown>) => {
    const sizeMB =
        (image.sizeMB as number | undefined) ??
        (image.sizeMiB as number | undefined) ??
        (image.sizeGB as number | undefined) ??
        (image.sizeBytes as number | undefined) ??
        (image.virtualSizeBytes as number | undefined) ??
        (image.usedBytes as number | undefined);

    if (sizeMB == null) return 0;
    if (image.sizeGB !== undefined) return Math.max(0, (image.sizeGB as number) * 1024);
    if (image.sizeBytes !== undefined) return toMb(image.sizeBytes as number);
    if (image.virtualSizeBytes !== undefined) return toMb(image.virtualSizeBytes as number);
    if (image.usedBytes !== undefined) return toMb(image.usedBytes as number);
    return Number.isFinite(sizeMB) ? Math.max(0, (sizeMB as number) | 0) : 0;
};

const backfillStorageSizeFromInventory = async ({
    agentId,
    refId,
}: {
    agentId: string | undefined;
    refId: string | undefined;
}) => {
    if (!agentId || !refId) return 0;
    const doc = await InventoryStorage.findOne({ storageId: agentId }, { inventory: 1 }).lean();
    const images = (doc?.inventory as { images?: Array<Record<string, unknown>> } | undefined)?.images || [];
    if (!Array.isArray(images)) return 0;

    const refLower = String(refId).toLowerCase();
    const match = images.find((img) => {
        const ids = [img.refId, img.id, img.name].filter(Boolean).map((v) => String(v).toLowerCase());
        return ids.includes(refLower);
    });
    if (!match) return 0;

    return pickStorageSizeMB(match);
};

const lookupStorageDiskMeta = async ({
    storageId,
    refId,
}: {
    storageId?: string | null;
    refId?: string | null;
}) => {
    if (!storageId || !refId) return null;
    const doc = await InventoryStorage.findOne({ storageId }, { inventory: 1 }).lean<{
        inventory?: StorageInventoryV1;
    }>();
    const volumes = Array.isArray(doc?.inventory?.volumes) ? doc.inventory!.volumes : [];
    const refLower = String(refId).toLowerCase();
    const match = volumes.find((volume) => String(volume.refId || "").toLowerCase() === refLower);
    if (!match?.iqn) return null;
    const portal =
        match.portal && typeof match.portal === "object"
            ? {
                  host: typeof match.portal.host === "string" ? match.portal.host : undefined,
                  ip: typeof match.portal.ip === "string" ? match.portal.ip : undefined,
              }
            : undefined;
    return { iqn: String(match.iqn), portal };
};

const vmCreateAuto: EnrichHandler = async ({ object, ctx }) => {
    const out = (await ensureImageMeta(object)) as MutablePayload;
    out.generation = out.generation ?? 2;
    out.storageMB = out.storageMB ?? 10_240;
    if (!out.switch) out.switch = "fabric0";
    if (typeof out.diskId === "string" && out.diskId) {
        const storageId = ctx?.storageAgentId;
        if (!storageId) throw new Error("storage agent id is required to resolve disk IQN");
        const diskMeta = await lookupStorageDiskMeta({ storageId, refId: out.diskId as string });
        if (!diskMeta?.iqn) throw new Error("storage disk IQN not found for provided diskId");
        out.iqn = diskMeta.iqn;
        if (diskMeta.portal?.host || diskMeta.portal?.ip) {
            out.portal = {
                ...(diskMeta.portal.host ? { host: diskMeta.portal.host } : {}),
                ...(diskMeta.portal.ip ? { ip: diskMeta.portal.ip } : {}),
            };
        }
    }
    return out;
};

const vmDetermineImage: EnrichHandler = async ({ object }) => {
    if (!object.imageId) throw new Error("imageId is required for determineImage");
    const result = await ensureImageMeta(object);
    return { ...result };
};

const consoleSerialAuto: EnrichHandler = async ({ object, ctx }) => {
    const refId = requireRefId(object, ctx);

    const { agentData, ui } = await planSerialOpen({
        refId,
        tenantId: ctx?.tenantId,
        agentId: (ctx?.agentId as string) || (object.agentId as string),
        sub: ctx?.user?.id as string | undefined,
        ttlSeconds: object.ttlSeconds as number | undefined,
    });

    return { ...object, ...agentData, _console: ui };
};

const netTunnelAuto: EnrichHandler = async ({ object, ctx }) => {
    const refId = requireRefId(object, ctx);
    const target = requireTarget(object);

    const { agentData, ui } = await planNetTunnelOpen({
        refId,
        tenantId: ctx?.tenantId,
        agentId: (ctx?.agentId as string) || (object.agentId as string),
        sub: ctx?.user?.id as string | undefined,
        target,
        mode: (object.mode as "serial" | "net") || "net",
        ttlSeconds: object.ttlSeconds as number | undefined,
    });

    return { ...object, ...agentData, _console: ui };
};

const storageDeleteAuto: EnrichHandler = async ({ object, ctx }) => {
    const out = { ...object };

    // Ne fais pas confiance aux tailles fournies par l'appelant: on force la valeur depuis l'inventaire.
    delete out.sizeMB;
    delete out.sizeMiB;
    delete out.sizeGB;
    delete out.sizeBytes;
    delete out.virtualSizeBytes;

    const sizeMB = await backfillStorageSizeFromInventory({
        agentId: (ctx?.agentId as string) || (out.agentId as string),
        refId: resolveRefId(out, ctx),
    });
    if (sizeMB > 0) {
        out.sizeMB = sizeMB;
    }

    return out;
};

const registerDefaultHandlers = () => {
    const defaults: Array<{ action: string; operation: string; handler: EnrichHandler }> = [
        { action: "vm.create", operation: "auto", handler: vmCreateAuto },
        { action: "vm.create", operation: "determineImage", handler: vmDetermineImage },
        { action: "vm.clone", operation: "auto", handler: vmCreateAuto },
        { action: "vm.clone", operation: "determineImage", handler: vmDetermineImage },
        { action: "vm.edit", operation: "auto", handler: async ({ object }) => ({ ...object }) },
        { action: "console.serial.open", operation: "auto", handler: consoleSerialAuto },
        { action: "net.tunnel.open", operation: "auto", handler: netTunnelAuto },
        { action: "disk.delete", operation: "auto", handler: storageDeleteAuto },
        { action: "storage.delete", operation: "auto", handler: storageDeleteAuto },
    ];

    defaults.forEach(({ action, operation, handler }) => register(action, operation, handler));
};

registerDefaultHandlers();

export async function enrich(action: string, opts: EnrichOptions): Promise<EnrichResponse> {
    const act = normalizeAction(action);
    if (!act) return { ok: false, error: "action is required" };
    if (!opts || typeof opts !== "object") return { ok: false, error: "opts must be an object" };

    const operation = normalizeOperation(opts.operation);
    const { object, ctx } = opts;

    if (!operation) return { ok: false, error: "opts.operation is required" };
    if (!object || typeof object !== "object") return { ok: false, error: "opts.object is required" };

    const ops = registry[act];
    if (!ops) return { ok: false, error: `unsupported action: ${act}` };

    const handler = ops[operation];
    if (typeof handler !== "function") {
        return { ok: false, error: `unsupported operation for ${act}: ${operation}` };
    }

    try {
        const data = await handler({ object, ctx });
        return { ok: true, data };
    } catch (error) {
        return { ok: false, error: (error as Error)?.message || String(error) };
    }
}

export function register(action: string, operation: string, handler: EnrichHandler) {
    if (!registry[action]) registry[action] = {};
    registry[action][operation] = handler;
}
