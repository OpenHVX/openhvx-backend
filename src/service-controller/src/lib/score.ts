// Simple scoring functions for agent capacity based on inventory snapshots used by election service
interface InventoryVm {
    state?: string | null;
    powerState?: string | null;
    configuration?: {
        processors?: {
            count?: number | null;
        };
    };
    cpu?: { vcpus?: number | null };
    memoryAssignedMB?: number | null;
    memoryMb?: number | null;
}

interface InventoryHost {
    hypervHost?: {
        logicalProcessors?: number;
        memoryCapacityMB?: number;
    };
    cpu?: {
        logicalProcessors?: number;
        sockets?: number | null;
        cores?: number | null;
        threads?: number | null;
        [key: string]: unknown;
    };
    memMB?: number;
    memoryMb?: number;
    [key: string]: unknown;
}

interface InventoryDatastore {
    id?: string | null;
    kind?: string | null;
    path?: string | null;
    drive?: string | null;
    totalBytes?: number | null;
    freeBytes?: number | null;
    sizeBytes?: number | null;
    free?: number | null;
}

type InventoryDoc = {
    inventory?: Record<string, unknown> | null;
} | null;

export interface ScoreResult {
    score: number;
}

// Simple helpers to score agent capacity from a canonical inventory snapshot.
const roundTo = (value: number, decimals = 3) => {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
};

const extractRoot = (inv?: InventoryDoc | null) => {
    const payload = inv?.inventory;
    if (!payload || typeof payload !== "object") return {};
    return {
        host: (payload as { host?: InventoryHost }).host,
        vms: (payload as { vms?: InventoryVm[] }).vms,
        datastores: (payload as { datastores?: InventoryDatastore[] }).datastores,
    };
};

const runningVm = (vm: InventoryVm) =>
    String(vm.state || vm.powerState || "").toLowerCase() === "running";

export async function cpuScore(inv: unknown): Promise<ScoreResult> {
    // CPU score = ratio of assigned vCPUs of running VMs to host logical CPUs (clamped 0-1).
    const r = extractRoot(inv as InventoryDoc | null);
    const host = r.host;
    const vms = r.vms ?? [];

    const totalLogicalCPU =
        host?.hypervHost?.logicalProcessors ??
        host?.cpu?.logicalProcessors ??
        0;

    const assignedVcpu = vms.reduce((sum, vm) => {
        if (!runningVm(vm)) return sum;
        const count = vm.cpu?.vcpus ?? vm.configuration?.processors?.count ?? 0;
        return sum + count;
    }, 0);

    const ratio = totalLogicalCPU > 0 ? assignedVcpu / totalLogicalCPU : Infinity;
    const score = roundTo(Number.isFinite(ratio) ? Math.max(0, Math.min(1, 1 - ratio)) : 0, 3);
    return { score };
}

export async function memScore(inv: unknown): Promise<ScoreResult> {
    // Memory score = ratio of assigned memory on running VMs to host capacity (clamped 0-1).
    const r = extractRoot(inv as InventoryDoc | null);
    const host = r.host;
    const vms = r.vms ?? [];

    const totalMemMB =
        host?.hypervHost?.memoryCapacityMB ??
        host?.memMB ??
        host?.memoryMb ??
        0;

    const assignedMemMB = vms.reduce((sum, vm) => {
        if (!runningVm(vm)) return sum;
        return sum + (vm.memoryAssignedMB ?? vm.memoryMb ?? 0);
    }, 0);

    const ratio = totalMemMB > 0 ? assignedMemMB / totalMemMB : Infinity;
    const score = roundTo(Number.isFinite(ratio) ? Math.max(0, Math.min(1, 1 - ratio)) : 0, 3);
    return { score };
}

export async function storageScore(inv: unknown): Promise<ScoreResult> {
    // Storage score = ratio of used bytes on the root datastore (clamped 0-1).
    const r = extractRoot(inv as InventoryDoc | null);
    const datastores = r.datastores ?? [];

    const roots = datastores.filter((d) => d?.kind === "root");

    if (roots.length === 0) {
        throw new Error("No root datastore found for this agent");
    }
    if (roots.length > 1) {
        throw new Error(`Multiple root datastores found (${roots.length}) for this agent`);
    }

    const rootDs = roots[0];
    const totalBytes = Number(rootDs?.totalBytes ?? rootDs?.sizeBytes ?? 0);
    const freeBytes = Number(rootDs?.freeBytes ?? rootDs?.free ?? 0);
    const usedBytes = Math.max(0, totalBytes - freeBytes);

    const ratio = totalBytes > 0 ? usedBytes / totalBytes : Infinity;
    const score = roundTo(Number.isFinite(ratio) ? Math.max(0, Math.min(1, 1 - ratio)) : 0, 3);
    return { score };
}

interface WeightedAgentScores {
    scores?: {
        cpu?: ScoreResult;
        mem?: ScoreResult;
        storage?: ScoreResult;
    };
}

interface ScoreWeights {
    cpu?: number;
    mem?: number;
    storage?: number;
}

export function Score(agent: WeightedAgentScores, weights: ScoreWeights): number {
    const { cpu, mem, storage } = agent.scores || {};
    const wCpu = Number(weights.cpu ?? 0);
    const wMem = Number(weights.mem ?? 0);
    const wStorage = Number(weights.storage ?? 0);
    const norm = wCpu + wMem + wStorage || 1;

    const sCpu = cpu?.score ?? 0;
    const sMem = mem?.score ?? 0;
    const sStorage = storage?.score ?? 0;

    return roundTo((sCpu * wCpu + sMem * wMem + sStorage * wStorage) / norm, 3);
}
