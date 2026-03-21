// @ts-nocheck
// middlewares/req.log.js
const { randomUUID } = require('node:crypto');

module.exports = function reqlog(req, res, next) {
    req._rid = req._rid || randomUUID();
    const start = Date.now();
    res.on('finish', () => {
        // niveau "access"
        console.info(`[auth][${req._rid}] ${req.method} ${req.originalUrl} -> ${res.statusCode} in ${Date.now() - start}ms`);
    });
    next();
};