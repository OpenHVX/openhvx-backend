// middlewares/accessMode.js
exports.asTenantMode = () => (req, _res, next) => {
    req.enforceTenant = true;
    req.isAdmin = false;
    next();
};

exports.asAdminMode = () => (req, _res, next) => {
    req.enforceTenant = false;
    req.isAdmin = true;     // <-- important
    next();
};