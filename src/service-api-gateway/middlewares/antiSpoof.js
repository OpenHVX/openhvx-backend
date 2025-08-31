// middlewares/antiSpoof.js
module.exports = () => (req, res, next) => {
    if (!req || !req.headers) return next(); // garde-fou
    delete req.headers['x-tenant-id'];
    delete req.headers['x-tenant'];
    delete req.headers['x-roles'];
    delete req.headers['x-user-id'];
    next();
};