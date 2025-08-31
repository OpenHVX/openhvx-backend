// middlewares/requireAdmin.js
module.exports = (req, res, next) => {
    const roles = (req.user?.roles || []).map((r) => String(r).toLowerCase());
    if (!roles.includes("admin")) return res.status(403).json({ error: "Admin role required" });
    next();
};
