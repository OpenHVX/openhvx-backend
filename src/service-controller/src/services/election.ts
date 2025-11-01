// @ts-nocheck
// /services/election.js
const Inventory = require("../models/Inventory.full");
const Heartbeat = require("../models/Heartbeat");
const { validate } = require("../lib/validate");
const { AgentsSchema } = require("../lib/schemas/election");
const { cpuScore, memScore, storageScore, Score } = require("../lib/score");

async function listAgents() {
    const docs = await Heartbeat.find({}, 'agentId version lastSeen host capabilities raw').lean();

    if (!Array.isArray(docs) || docs.length === 0) {
        throw new Error("No agent exists yet in database");
    }
    return docs;
}


async function election(requirements) {
    // 1) Validation
    const res = validate(AgentsSchema, { requirements });
    if (!res.ok) {
        throw new Error("Invalid requirements payload: " + res.errors.join(", "));
    }

    const { requirements: r } = res.value;
    const list = await listAgents()
    const cutoff = Date.now() - r.freshness * 1000;
    const eligible = list.filter(a => new Date(a.lastSeen).getTime() >= cutoff);

    const agents = await Promise.all(
        eligible.map(async a => {
            const inv = await Inventory.findOne({ agentId: a.agentId }).lean();
            // Get MEM score
            const mem = await memScore(inv);
            // Get CPU Score
            const cpu = await cpuScore(inv);
            // Get Storage score
            const storage = await storageScore(inv);

            return {
                ...a,
                scores: {
                    mem,
                    cpu,
                    storage
                },
            };
        })
    );

    agents.forEach(a => {
        a.globalScore = Score(a, { cpu: 0.5, mem: 0.3, storage: 0.2 })
    })

    agents.sort((x, y) => {
        (x.globalScore - y.globalScore) || (new Date(y.lastSeen) - new Date(x.lastSeen))
    })

    const agentId = agents[0]?.agentId;

    return agentId;
}



module.exports = { election };
