// middlewares/requireAdmin.js
// Vérifie si l'appelant a un rôle "admin".
// Normalement géré par l'API Gateway, ici c'est un filet de sécurité.

module.exports = function requireAdmin() {
    return (req, res, next) => {
        // Récupère le rôle depuis un header injecté par la gateway ou un champ req.user
        const rolesHeader = req.headers["x-roles"] || req.headers["x-role"];
        const roles = rolesHeader
            ? rolesHeader.split(",").map(r => r.trim().toLowerCase())
            : [];

        // Si tu stockes aussi dans req.user (gateway qui décode le JWT)
        if (req.user?.roles) {
            roles.push(...req.user.roles.map(r => r.toLowerCase()));
        }

        if (!roles.includes("admin")) {
            return res.status(403).json({ error: "Admin role required" });
        }

        next();
    };
};
