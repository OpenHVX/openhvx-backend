// utils/jwt.js
const jwt = require('jsonwebtoken');

function signJwt(user) {
    const payload = {
        sub: user._id.toString(),   // qui = user
        tid: user.tenantId.toString(), // tenant binding
        role: user.role,
        email: user.email
    };
    return jwt.sign(payload, process.env.JWT_SECRET, {
        expiresIn: process.env.JWT_EXPIRES || '8h',
        issuer: 'auth-service',
        audience: user.tenantId.toString()
    });
}

function verifyJwt(token) {
    return jwt.verify(token, process.env.JWT_SECRET, { issuer: 'auth-service' });
}

module.exports = { signJwt, verifyJwt };
