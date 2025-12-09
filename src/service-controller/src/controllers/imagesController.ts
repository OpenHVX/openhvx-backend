import type { Response } from "express";
import { cacheInfo, getById, list, resolvePath, reloadNow } from "../services/images";
import type { ControllerRequest } from "../types/express";
import logger from "../lib/logger";
import { respondEnvelope } from "../middlewares/addEnveloppe";

const log = logger.child(["controller", "images"]);
type Handler = (req: ControllerRequest, res: Response) => Promise<Response | void>;

export const listImages: Handler = async (req, res) => {
    try {
        const data = await list({
            q: req.query.q as string | undefined,
            gen: req.query.gen as string | undefined,
            os: req.query.os as string | undefined,
            arch: req.query.arch as string | undefined,
        });
        return respondEnvelope(res, req, "Images", { success: true, count: data.length, data });
    } catch (error) {
        log.error("images.list error", { error });
        return res.status(500).json({ error: "Server error" });
    }
};

export const getImage: Handler = async (req, res) => {
    try {
        const img = await getById(req.params.imageId);
        if (!img) return res.status(404).json({ error: "Not found" });
        return respondEnvelope(res, req, "Images", { success: true, data: img });
    } catch (error) {
        log.error("images.getOne error", { error });
        return res.status(500).json({ error: "Server error" });
    }
};

export const resolveImage: Handler = async (req, res) => {
    try {
        const result = await resolvePath(req.params.imageId);
        if (!result) return res.status(404).json({ error: "Unknown imageId" });
        return respondEnvelope(res, req, "Images", { success: true, data: result });
    } catch (error) {
        log.error("images.resolve error", { error });
        return res.status(500).json({ error: "Server error" });
    }
};

export const reloadImages: Handler = async (req, res) => {
    try {
        const imgs = await reloadNow();
        return respondEnvelope(res, req, "Images", { success: true, reloaded: imgs.length });
    } catch (error) {
        log.error("images.reload error", { error });
        return res.status(500).json({ error: "Server error" });
    }
};

export const diag: Handler = async (req, res) => {
    try {
        return respondEnvelope(res, req, "Images", { success: true, data: cacheInfo() });
    } catch (error) {
        log.error("images.diag error", { error });
        return res.status(500).json({ error: "Server error" });
    }
};
