import jwt from "jsonwebtoken";
import { randomUUID } from "node:crypto";
import { isValidObjectId, Types } from "mongoose";
import TenantResource from "../models/TenantResource";
import type { TenantResourceLink } from "../models/TenantResource";

type TunnelMode = "serial" | "net";

interface BasePlanOptions {
    refId: string;
    tenantId?: string;
    agentId?: string;
    sub?: string;
    ttlSeconds?: number;
}

export interface SerialPlanOptions extends BasePlanOptions {}

export interface NetTunnelPlanOptions extends BasePlanOptions {
    target: {
        ip: string;
        port: number;
    };
    mode?: TunnelMode;
}

export interface TunnelPlan {
    agentData: {
        vmId: string;
        tunnelId: string;
        ticket: string;
        agentWsUrl: string;
        ttlSeconds: number;
        target?: NetTunnelPlanOptions["target"];
    };
    ui: {
        tunnelId: string;
        wsUrl: string;
        expiresAt: string;
        mode: TunnelMode;
    };
    vm: TenantResourceLink & { _id: Types.ObjectId };
}

const requiredEnv = (name: string) => {
    const value = process.env[name];
    if (!value) throw new Error(`${name} is required`);
    return value;
};

const AGENT_SECRET = () => requiredEnv("JWT_AGENT_SECRET");
const BROWSER_SECRET = () => requiredEnv("JWT_BROWSER_SECRET");

const publicWsBase = () => {
    const base = requiredEnv("PUBLIC_WS_BASE").replace(/\/$/, "");
    return base.endsWith("/api") ? base : `${base}/api`;
};

const brokerWsBase = () => requiredEnv("BROKER_WS_BASE").replace(/\/$/, "");

const browserWsUrl = (mode: TunnelMode, token: string) => {
    if (mode === "serial") return `${publicWsBase()}/v1/console/serial/ws?t=${token}`;
    return `${publicWsBase()}/v1/console/net/ws?t=${token}`;
};

const agentWsUrl = (tunnelId: string, agentTicket: string) => {
    return `${brokerWsBase()}/ws/tunnel/${tunnelId}?ticket=${agentTicket}`;
};

const genTunnelId = () => randomUUID().replace(/-/g, "").slice(0, 22);

const signAgentTicket = (payload: {
    tunnelId: string;
    vmId: string;
    tenantId: string;
    agentId?: string;
    action: string;
}) => {
    return jwt.sign({ aud: "agent", ...payload }, AGENT_SECRET(), { expiresIn: "2m" });
};

const signBrowserToken = (payload: {
    tunnelId: string;
    vmId: string;
    tenantId: string;
    sub?: string;
    mode: TunnelMode;
}) => {
    return jwt.sign({ aud: "browser", ...payload }, BROWSER_SECRET(), { expiresIn: "5m" });
};

type VmQuery = {
    refId: string;
    tenantId?: string;
    agentId?: string;
};

type VmDocument = (TenantResourceLink & { _id: Types.ObjectId }) | null;

const findVm = async (filter: Record<string, unknown>): Promise<VmDocument> => {
    return TenantResource.findOne(filter).lean<VmDocument>().catch(() => null);
};

async function loadVmOrThrow({ refId, tenantId, agentId }: VmQuery): Promise<NonNullable<VmDocument>> {
    if (!refId) throw new Error("vm refId is required");

    const base: Record<string, unknown> = { kind: "vm" };
    if (tenantId) base.tenantId = tenantId;
    if (agentId) base.agentId = agentId;

    if (typeof refId === "string" && isValidObjectId(refId)) {
        const doc = await findVm({ ...base, _id: refId });
        if (doc) return doc;
    }

    const byRef = await findVm({ ...base, refId });
    if (byRef) return byRef;

    const byGuid = await findVm({ ...base, guid: refId });
    if (byGuid) return byGuid;

    throw new Error("vm not found");
}

const assertAgent = (vm: TenantResourceLink & { _id?: Types.ObjectId }, agentId?: string) => {
    if (agentId && vm.agentId && vm.agentId !== agentId) {
        throw new Error(`agentId mismatch for vm ${vm._id ?? vm.refId}`);
    }
};

const buildUiPayload = (tunnelId: string, mode: TunnelMode, browserToken: string) => ({
    tunnelId,
    wsUrl: browserWsUrl(mode, browserToken),
    expiresAt: new Date(Date.now() + 5 * 60e3).toISOString(),
    mode,
});

export async function planSerialOpen(options: SerialPlanOptions): Promise<TunnelPlan> {
    const { refId, tenantId, agentId, sub, ttlSeconds } = options;
    const vm = await loadVmOrThrow({ refId, tenantId, agentId });
    assertAgent(vm, agentId);

    const vmId = String(vm._id);
    const tunnelId = genTunnelId();

    const ticket = signAgentTicket({
        tunnelId,
        vmId,
        tenantId: vm.tenantId,
        agentId: agentId || vm.agentId,
        action: "console.serial.open",
    });

    const browserToken = signBrowserToken({
        tunnelId,
        vmId,
        tenantId: vm.tenantId,
        sub,
        mode: "serial",
    });

    return {
        agentData: {
            vmId,
            tunnelId,
            ticket,
            agentWsUrl: agentWsUrl(tunnelId, ticket),
            ttlSeconds: ttlSeconds || 900,
        },
        ui: buildUiPayload(tunnelId, "serial", browserToken),
        vm,
    };
}

export async function planNetTunnelOpen(options: NetTunnelPlanOptions): Promise<TunnelPlan> {
    const { refId, tenantId, agentId, target, mode, ttlSeconds, sub } = options;
    if (!target?.ip || !target?.port) throw new Error("target.ip and target.port are required");

    const vm = await loadVmOrThrow({ refId, tenantId, agentId });
    assertAgent(vm, agentId);

    const vmId = String(vm._id);
    const tunnelId = genTunnelId();
    const resolvedMode: TunnelMode = mode || "net";

    const ticket = signAgentTicket({
        tunnelId,
        vmId,
        tenantId: vm.tenantId,
        agentId: agentId || vm.agentId,
        action: "net.tunnel.open",
    });

    const browserToken = signBrowserToken({
        tunnelId,
        vmId,
        tenantId: vm.tenantId,
        sub,
        mode: resolvedMode,
    });

    return {
        agentData: {
            vmId,
            tunnelId,
            ticket,
            agentWsUrl: agentWsUrl(tunnelId, ticket),
            ttlSeconds: ttlSeconds || 900,
            target,
        },
        ui: buildUiPayload(tunnelId, resolvedMode, browserToken),
        vm,
    };
}
