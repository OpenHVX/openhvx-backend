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

export async function listAgents(): Promise<HeartbeatDoc[]> {
    const docs = await Heartbeat.find({}, "agentId version lastSeen host capabilities raw").lean<HeartbeatDoc[]>();
    if (!Array.isArray(docs) || docs.length === 0) {
        throw new Error("No agent exists yet in database");
    }
    return docs;
}

export async function election(requirements: ElectionRequirements): Promise<string | null> {
    const validation = validateElectionPayload({ requirements });
    if (!validation.ok || !validation.value) {
        const errors = validation.errors.join(", ");
        throw new Error(`Invalid requirements payload: ${errors}`);
    }

    const { freshness } = validation.value.requirements;
    const agents = await listAgents();
    const cutoff = Date.now() - freshness * 1000;
    const eligible = agents.filter((agent) => {
        const ts = agent.lastSeen ? new Date(agent.lastSeen).getTime() : 0;
        return ts >= cutoff;
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
                globalScore: Score({ scores }, { cpu: 0.6, mem: 0.4 }),
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
