const express = require("express");
const router = express.Router();

// Health
router.get("/healthz", (_req, res) => res.json({ ok: true }));

module.exports = router;
