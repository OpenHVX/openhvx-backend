import { resolvePath, type ImageEntry } from "../services/images";
import { planNetTunnelOpen, planSerialOpen, type TunnelPlan } from "../services/console";

type EnrichPayload = Record<string, unknown>;
type MutablePayload = Record<string, unknown>;
type Target = { ip: string; port: number };

interface EnrichContext {
    tenantId?: string;
    agentId?: string;
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

const ensureImagePath = async (object: EnrichPayload) => {
    if (object.imagePath || !object.imageId) return { ...object };
    const result = await resolvePath(object.imageId as string);
    if (!result?.path) throw new Error(`imageId not found: ${object.imageId}`);
    return { ...object, imagePath: result.path };
};

const vmCreateAuto: EnrichHandler = async ({ object }) => {
    const out = (await ensureImagePath(object)) as MutablePayload;
    out.generation = out.generation ?? 2;
    out.storageMB = out.storageMB ?? 10_240;
    if (!out.switch) out.switch = "fabric0";
    return out;
};

const vmDetermineImage: EnrichHandler = async ({ object }) => {
    if (object.imagePath) return { ...object };
    if (!object.imageId) throw new Error("imageId is required for determineImage");
    const result = await resolvePath(object.imageId as string);
    if (!result?.path) throw new Error(`imageId not found: ${object.imageId}`);
    return { ...object, imagePath: result.path };
};

const consoleSerialAuto: EnrichHandler = async ({ object, ctx }) => {
    const refId = (object.refId as string) || (object.vmId as string) || ctx?.refId || (ctx?.vm?._id as string);
    if (!refId) throw new Error("refId/vmId is required");

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
    const refId = (object.refId as string) || (object.vmId as string) || ctx?.refId || (ctx?.vm?._id as string);
    if (!refId) throw new Error("refId/vmId is required");
    const targetCandidate = object.target as { ip?: string; port?: number } | undefined;
    const target: Target = {
        ip: targetCandidate?.ip || "",
        port: targetCandidate?.port ?? 0,
    };
    if (!target?.ip || !target?.port) {
        throw new Error("target.ip and target.port are required");
    }

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

const registerDefaultHandlers = () => {
    register("vm.create", "auto", vmCreateAuto);
    register("vm.create", "determineImage", vmDetermineImage);
    register("vm.clone", "auto", vmCreateAuto);
    register("vm.clone", "determineImage", vmDetermineImage);
    register("vm.edit", "auto", async ({ object }) => ({ ...object }));
    register("console.serial.open", "auto", consoleSerialAuto);
    register("net.tunnel.open", "auto", netTunnelAuto);
};

registerDefaultHandlers();

export async function enrich(action: string, opts: EnrichOptions): Promise<EnrichResponse> {
    const act = String(action || "");
    if (!act) return { ok: false, error: "action is required" };
    if (!opts || typeof opts !== "object") return { ok: false, error: "opts must be an object" };

    const operation = String(opts.operation || "");
    const { object, ctx } = opts;
    if (!operation) return { ok: false, error: "opts.operation is required" };
    if (!object) return { ok: false, error: "opts.object is required" };

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
