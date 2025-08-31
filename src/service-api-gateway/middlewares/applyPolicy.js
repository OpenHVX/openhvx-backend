const fs = require('fs');
const path = require('path');

function ensureJsonExt(name) {
    return name.endsWith('.json') ? name : `${name}.json`;
}

function loadPolicyByName(name) {
    const file = ensureJsonExt(name);
    // On cherche d'abord depuis le CWD, puis relatif au fichier (../policies)
    const candidates = [
        path.resolve(process.cwd(), 'policies', file),
        path.resolve(__dirname, '..', 'policies', file),
    ];
    for (const p of candidates) {
        try {
            const txt = fs.readFileSync(p, 'utf8');
            console.log(`[policy] loaded: ${p}`);
            return JSON.parse(txt);
        } catch { }
    }
    throw new Error(`Policy not found: ${file} (searched in: ${candidates.join(' | ')})`);
}

/**
 * applyPolicy('TenantPolicy', { strip: false })
 * Policy JSON très simple:
 * {
 *   "actions": {
 *     "vm.create": ["vhd_path","vhdPath","path"]
 *   }
 * }
 *
 * strip=false => 403 si un champ interdit est présent
 * strip=true  => supprime silencieusement les champs interdits
 */
function applyPolicy(policyName, { strip = false } = {}) {
    let pol;
    try {
        pol = loadPolicyByName(policyName);
    } catch (e) {
        console.error('[policy] load error:', e.message);
        // Par défaut si introuvable, policy vide -> ne bloque rien
        pol = { actions: {} };
    }

    return (req, res, next) => {
        if (req.isAdmin) return next(); // admins non concernés

        const action = String(req.body?.action || '').toLowerCase();
        const data = req.body?.data;
        if (!action || typeof data !== 'object') return next();

        const denyList = pol.actions?.[action];
        if (!Array.isArray(denyList) || denyList.length === 0) return next();

        const hits = denyList.filter(k => Object.prototype.hasOwnProperty.call(data, k));
        if (hits.length === 0) return next();

        if (strip) {
            hits.forEach(k => delete data[k]);
            return next();
        }
        return res.status(403).json({ error: 'Forbidden field(s) for tenants', fields: hits });
    };
}

module.exports = applyPolicy;
