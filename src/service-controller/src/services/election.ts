// src/service-controller/src/services/election.ts
// Service for agent election based on inventory scores and heartbeat freshness

import Inventory from "../models/Inventory.full";
import Heartbeat from "../models/Heartbeat";
import type { Heartbeat as HeartbeatDoc } from "../models/Heartbeat";
import { validateElectionPayload } from "../lib/schemas/election";
import type { ElectionRequirements } from "../types/domain";
import { cpuScore, memScore, Score } from "../lib/score";

interface AgentScore {
    mem: Awaited<ReturnType<typeof memScore>>;
    cpu: Awaited<ReturnType<typeof cpuScore>>;
}

interface ScoredAgent extends HeartbeatDoc {
    scores: AgentScore;
    globalScore: number;
}

const DEFAULT_CPU_WEIGHT = 0.6;
const DEFAULT_MEM_WEIGHT = 0.4;

const readWeight = (raw: string | undefined, fallback: number) => {
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
};

const hasCapability = (declared: string[], needed: string) =>
    declared.some((cap) => needed === cap || needed.startsWith(`${cap}.`));

export async function listAgents(): Promise<HeartbeatDoc[]> {
    const docs = await Heartbeat.find({}, "agentId version lastSeen host capabilities raw").lean<HeartbeatDoc[]>();
    return Array.isArray(docs) ? docs : [];
}

export async function election(requirements: ElectionRequirements): Promise<string | null> {
    const validation = validateElectionPayload({ requirements });
    if (!validation.ok || !validation.value) {
        const errors = validation.errors.join(", ");
        throw new Error(`Invalid requirements payload: ${errors}`);
    }

    const { freshness, capabilities } = validation.value.requirements;
    const cpuWeight = readWeight(process.env.ELECTION_WEIGHT_CPU, DEFAULT_CPU_WEIGHT);
    const memWeight = readWeight(process.env.ELECTION_WEIGHT_MEM, DEFAULT_MEM_WEIGHT);
    const agents = await listAgents();
    const cutoff = Date.now() - freshness * 1000;
    const eligible = agents.filter((agent) => {
        const ts = agent.lastSeen ? new Date(agent.lastSeen).getTime() : 0;
        if (ts < cutoff) return false;
        const declaredCaps = Array.isArray(agent.capabilities) ? agent.capabilities.map(String) : [];
        return capabilities.every((cap) => hasCapability(declaredCaps, cap));
    });

    if (!eligible.length) return null;

    const scoredAgents: ScoredAgent[] = await Promise.all(
        eligible.map(async (agent) => {
            const inv = (await Inventory.findOne({ agentId: agent.agentId }).lean()) as unknown;
            const scores = {
                mem: await memScore(inv),
                cpu: await cpuScore(inv),
            };
            return {
                ...agent,
                scores,
                globalScore: Score({ scores }, { cpu: cpuWeight, mem: memWeight }),
            };
        })
    );

    scoredAgents.sort((a, b) => {
        const diff = b.globalScore - a.globalScore;
        if (diff !== 0) return diff;
        const tsA = a.lastSeen ? new Date(a.lastSeen).getTime() : 0;
        const tsB = b.lastSeen ? new Date(b.lastSeen).getTime() : 0;
        return tsB - tsA;
    });

    return scoredAgents[0]?.agentId ?? null;
}
