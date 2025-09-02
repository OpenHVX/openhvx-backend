// controllers/imagesController.js
const imagesService = require("../services/images");

// GET /api/v1/tenant/images?q=&gen=&os=&arch=
exports.list = async (req, res) => {
    try {
        const data = await imagesService.list({
            q: req.query.q,
            gen: req.query.gen,
            os: req.query.os,
            arch: req.query.arch,
        });
        res.json({ success: true, count: data.length, data });
    } catch (e) {
        console.error("images.list error:", e);
        res.status(500).json({ error: "Server error" });
    }
};

// GET /api/v1/tenant/images/:imageId
exports.getOne = async (req, res) => {
    try {
        const img = await imagesService.getById(req.params.imageId);
        if (!img) return res.status(404).json({ error: "Not found" });
        res.json({ success: true, data: img });
    } catch (e) {
        console.error("images.getOne error:", e);
        res.status(500).json({ error: "Server error" });
    }
};

// GET /api/v1/tenant/images/:imageId/resolve
// -> renvoie juste { id, path } pour la task agent (vm.create)
exports.resolve = async (req, res) => {
    try {
        const r = await imagesService.resolvePath(req.params.imageId);
        if (!r) return res.status(404).json({ error: "Unknown imageId" });
        res.json({ success: true, data: r });
    } catch (e) {
        console.error("images.resolve error:", e);
        res.status(500).json({ error: "Server error" });
    }
};

// (Optionnel) GET /api/v1/admin/images/reload
exports.reload = async (_req, res) => {
    try {
        const imgs = await imagesService._reloadNow();
        res.json({ success: true, reloaded: imgs.length });
    } catch (e) {
        console.error("images.reload error:", e);
        res.status(500).json({ error: "Server error" });
    }
};

// (Optionnel) GET /api/v1/admin/images/diag
exports.diag = async (_req, res) => {
    try {
        res.json({ success: true, data: imagesService._cacheInfo() });
    } catch (e) {
        res.status(500).json({ error: "Server error" });
    }
};
