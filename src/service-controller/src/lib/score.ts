interface InventoryVm {
    state?: string | null;
    configuration?: {
        processors?: {
            count?: number | null;
        };
    };
    memoryAssignedMB?: number | null;
}

interface InventoryHost {
    hypervHost?: {
        logicalProcessors?: number;
        memoryCapacityMB?: number;
    };
    cpu?: {
        logicalProcessors?: number;
    };
    memMB?: number;
}

interface InventoryDatastore {
    kind?: string | null;
    path?: string | null;
    drive?: string | null;
    totalBytes?: number | null;
    freeBytes?: number | null;
}

type InventoryDoc = {
    inventory?: {
        inventory?: {
            host?: InventoryHost;
            vms?: InventoryVm[];
            datastores?: InventoryDatastore[];
        };
        datastores?: InventoryDatastore[];
    };
};

export interface ScoreResult {
    score: number;
}

const roundTo = (value: number, decimals = 3) => {
    const factor = 10 ** decimals;
    return Math.round(value * factor) / factor;
};

const runningVm = (vm: InventoryVm) => String(vm.state || "").toLowerCase() === "running";

export async function cpuScore(inv: InventoryDoc | null | undefined): Promise<ScoreResult> {
    const host = inv?.inventory?.inventory?.host;
    const vms = inv?.inventory?.inventory?.vms ?? [];

    const totalLogicalCPU =
        host?.hypervHost?.logicalProcessors ??
        host?.cpu?.logicalProcessors ??
        0;

    const assignedVcpu = vms.reduce((sum, vm) => {
        if (!runningVm(vm)) return sum;
        const count = vm.configuration?.processors?.count ?? 0;
        return sum + count;
    }, 0);

    const ratio = totalLogicalCPU > 0 ? assignedVcpu / totalLogicalCPU : Infinity;
    const score = roundTo(Number.isFinite(ratio) ? Math.max(0, Math.min(1, 1 - ratio)) : 0, 3);
    return { score };
}

export async function memScore(inv: InventoryDoc | null | undefined): Promise<ScoreResult> {
    const host = inv?.inventory?.inventory?.host;
    const vms = inv?.inventory?.inventory?.vms ?? [];

    const totalMemMB =
        host?.hypervHost?.memoryCapacityMB ??
        host?.memMB ??
        0;

    const assignedMemMB = vms.reduce((sum, vm) => {
        if (!runningVm(vm)) return sum;
        return sum + (vm.memoryAssignedMB ?? 0);
    }, 0);

    const ratio = totalMemMB > 0 ? assignedMemMB / totalMemMB : Infinity;
    const score = roundTo(Number.isFinite(ratio) ? Math.max(0, Math.min(1, 1 - ratio)) : 0, 3);
    return { score };
}

export async function storageScore(inv: InventoryDoc | null | undefined): Promise<ScoreResult> {
    const datastores =
        inv?.inventory?.datastores ??
        inv?.inventory?.inventory?.datastores ??
        [];

    const roots = datastores.filter((d) => d?.kind === "root");

    if (roots.length === 0) {
        throw new Error("No root datastore found for this agent");
    }
    if (roots.length > 1) {
        throw new Error(`Multiple root datastores found (${roots.length}) for this agent`);
    }

    const root = roots[0];
    const totalBytes = Number(root?.totalBytes ?? 0);
    const freeBytes = Number(root?.freeBytes ?? 0);
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
