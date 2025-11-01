// @ts-nocheck

// lib/score.js
function roundTo(x, decimals = 3) {
    const f = Math.pow(10, decimals);
    return Math.round(x * f) / f;
}


// CPU: score = 1 - (vCPU_assigned_running / logicalCPU_total) ∈ [0..1]
async function cpuScore(inv) {
    const host = inv?.inventory?.inventory?.host || {};
    const vms = inv?.inventory?.inventory?.vms || [];

    const totalLogicalCPU =
        host?.hypervHost?.logicalProcessors ??
        host?.cpu?.logicalProcessors ??
        0;

    const assignedVcpu = vms.reduce((sum, vm) => {
        if (String(vm.state || "").toLowerCase() !== "running") return sum;
        const count = vm?.configuration?.processors?.count ?? 0; // chemin stable
        return sum + count;
    }, 0);

    const ratio = totalLogicalCPU > 0 ? assignedVcpu / totalLogicalCPU : Infinity;
    const score = roundTo(Number.isFinite(ratio) ? Math.max(0, Math.min(1, 1 - ratio)) : 0, 3);

    return {
        score
    };
}

// MEM: score = 1 - (mem_assigned_running / mem_total) ∈ [0..1]
async function memScore(inv) {
    const host = inv?.inventory?.inventory?.host || {};
    const vms = inv?.inventory?.inventory?.vms || [];

    const totalMemMB = host?.memMB ?? 0;

    const assignedMemMB = vms.reduce((sum, vm) => {
        if (String(vm.state || "").toLowerCase() !== "running") return sum;
        return sum + (vm?.memoryAssignedMB ?? 0);
    }, 0);

    const ratio = totalMemMB > 0 ? assignedMemMB / totalMemMB : Infinity;
    const score = roundTo(Number.isFinite(ratio) ? Math.max(0, Math.min(1, 1 - ratio)) : 0, 3);

    return {
        score
    };
}


// DISK (root unique): 1 - (used / total) sur le seul datastore kind:"root"
async function storageScore(inv) {
    const ds =
        inv?.inventory?.datastores ??
        inv?.inventory?.inventory?.datastores ??
        [];

    const roots = ds.filter(d => d?.kind === "root");

    if (roots.length === 0) {
        throw new Error("No root datastore found for this agent");
    }
    if (roots.length > 1) {
        throw new Error(`Multiple root datastores found (${roots.length}) for this agent`);
    }

    const d = roots[0];
    const totalBytes = Number(d?.totalBytes ?? 0);
    const freeBytes = Number(d?.freeBytes ?? 0);
    const usedBytes = Math.max(0, totalBytes - freeBytes);

    const ratio = totalBytes > 0 ? usedBytes / totalBytes : Infinity;
    const score = roundTo(Number.isFinite(ratio) ? Math.max(0, Math.min(1, 1 - ratio)) : 0, 3);

    return {
        score,
    };
}

function Score(agent, weights) {

    const { cpu, mem, storage } = agent.scores || {};
    const wCpu = Number(weights.cpu ?? 0);
    const wMem = Number(weights.mem ?? 0);
    const wStorage = Number(weights.storage ?? 0);
    const norm = (wCpu + wMem + wStorage) || 1;

    const sCpu = cpu?.score ?? 0;
    const sMem = mem?.score ?? 0;
    const sStorage = storage?.score ?? 0;

    return roundTo((sCpu * wCpu + sMem * wMem + sStorage * wStorage) / norm, 3);

}

module.exports = { cpuScore, memScore, storageScore, Score };
