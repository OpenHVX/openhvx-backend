import type { Response } from "express";
import Heartbeat from "../models/Heartbeat";
import Inventory from "../models/Inventory.full";
import type { ControllerRequest } from "../types/express";
import logger from "../lib/logger";
import { respondEnvelope, scopeForReq } from "../middlewares/addEnveloppe";

const ONLINE_THRESHOLD_MS = parseInt(process.env.AGENT_ONLINE_THRESHOLD_MS || "90000", 10);

type ControllerHandler = (req: ControllerRequest, res: Response) => Promise<Response | void>;
const log = logger.child(["controller", "agents"]);

const isOnline = (lastSeen?: Date | string | null) => {
    const ts = lastSeen ? new Date(lastSeen).getTime() : 0;
    return !!(ts && Date.now() - ts < ONLINE_THRESHOLD_MS);
};

export const getStatus: ControllerHandler = async (req, res) => {
    try {
        const { agentId } = req.params;
        const doc = await Heartbeat.findOne(
            { agentId },
            "agentId version lastSeen capabilities host raw"
        ).lean();
        if (!doc) return res.status(404).json({ error: "Not found" });

        const online = isOnline(doc.lastSeen);
        return respondEnvelope(res, req, "Agents", {
            success: true,
            data: {
                id: doc.agentId,
                host: doc.host,
                capabilities: doc.capabilities,
                version: doc.version || null,
                status: online ? "online" : "offline",
                heartbeatOk: online,
                lastHeartbeat: doc.lastSeen || null,
            },
        });
    } catch (error) {
        log.error("getAgentStatus error", { error });
        return res.status(500).json({ error: "Server error" });
    }
};

export const getInventory: ControllerHandler = async (req, res) => {
    try {
        const { agentId } = req.params;
        const inv = await Inventory.findOne({ agentId }).lean();
        if (!inv) return res.status(404).json({ error: "Not found" });
        return respondEnvelope(res, req, "Agents", { success: true, data: inv });
    } catch (error) {
        log.error("getInventory error", { error });
        return res.status(500).json({ error: "Server error" });
    }
};

export const getAgents: ControllerHandler = async (_req, res) => {
    try {
        const now = Date.now();
        const docs = await Heartbeat.find({}, "agentId version lastSeen host capabilities raw").lean();
        const data = docs.map((doc) => {
            const online = doc.lastSeen ? now - new Date(doc.lastSeen).getTime() < ONLINE_THRESHOLD_MS : false;
            return {
                id: doc.agentId,
                host: doc.host,
                capabilities: doc.capabilities,
                version: doc.version || null,
                status: online ? "online" : "offline",
                heartbeatOk: online,
                lastHeartbeat: doc.lastSeen || null,
            };
        });
        return respondEnvelope(res, _req, "Agents", { success: true, data });
    } catch (error) {
        log.error("getAgents error", { error });
        return res.status(500).json({ error: "Server error" });
    }
};
