// controllers/agentController.js
const Heartbeat = require("../models/Heartbeat");
const Inventory = require("../models/Inventory");

const ONLINE_THRESHOLD_MS = parseInt(process.env.AGENT_ONLINE_THRESHOLD_MS || '90000', 10);

exports.getStatus = async (req, res) => {
    try {
        const { agentId } = req.params;
        const d = await Heartbeat.findOne({ agentId }, 'agentId version lastSeen capabilities host raw').lean();
        if (!d) return res.status(404).json({ error: 'Not found' });

        const ts = d.lastSeen ? new Date(d.lastSeen).getTime() : 0;
        const online = ts && (Date.now() - ts) < ONLINE_THRESHOLD_MS;


        res.json({
            id: d.agentId,
            host: d.host,
            capabilities: d.capabilities,
            version: d.version || null,
            status: online ? 'online' : 'offline',
            heartbeatOk: online,
            lastHeartbeat: d.lastSeen || null,
        });
    } catch (e) {
        console.error('getAgentStatus error:', e);
        res.status(500).json({ error: 'Server error' });
    }
};


exports.getInventory = async (req, res) => {
    try {
        const { agentId } = req.params;
        const inv = await Inventory.findOne({ agentId }).lean(); // unique par agent

        if (!inv) return res.status(404).json({ error: "Not found" });
        res.json({ success: true, data: inv });
    } catch (e) {
        console.error("getInventory error:", e);
        res.status(500).json({ error: "Server error" });
    }
};

// controllers/admin.controller.js
// Assumptions :
// - Modèle Heartbeat avec au moins: agentId (string), createdAt (Date) et idéalement ts (Date), host, version, heartbeatOk (bool)
// - Index recommandé : { agentId: 1, ts: -1 } ou { agentId: 1, createdAt: -1 }


exports.getAgents = async (req, res) => {
    try {
        const now = Date.now();

        // on lit tous les heartbeats (1 doc/agent) – léger et suffisant
        const docs = await Heartbeat.find({}, 'agentId version lastSeen host capabilities raw').lean();
        const data = docs.map(d => {
            const ts = d.lastSeen ? new Date(d.lastSeen).getTime() : 0;
            const online = ts && (now - ts) < ONLINE_THRESHOLD_MS;

            return {
                id: d.agentId,
                host: d.host,
                capabilities: d.capabilities,
                version: d.version || null,
                status: online ? 'online' : 'offline',
                heartbeatOk: online,
                lastHeartbeat: d.lastSeen || null,
            };
        });

        // ⚠️ renvoie un tableau directement pour matcher l’UI existante
        res.json(data);
    } catch (e) {
        console.error('getAgents error:', e);
        res.status(500).json({ error: 'Server error' });
    }
};
