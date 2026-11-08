// @ts-nocheck
// middlewares/req.log.js
const { randomUUID } = require('node:crypto');

module.exports = function reqlog(req, res, next) {
    req._rid = req._rid || randomUUID();
    const start = Date.now();
    res.on('finish', () => {
        // Never persist bearer tokens or API keys carried in a query string.
        const safePath = String(req.originalUrl || req.url || '').split('?')[0];
        // niveau "access"
        console.info(`[auth][${req._rid}] ${req.method} ${safePath} -> ${res.statusCode} in ${Date.now() - start}ms`);
    });
    next();
};
