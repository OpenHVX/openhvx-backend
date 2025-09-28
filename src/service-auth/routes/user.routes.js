// routes/auth.routes.js
const router = require('express').Router();
const authTenant = require('../controllers/authTenant.controller');
const authAdmin = require('../controllers/authAdmin.controller');

router.post('/tenant/register', authTenant.register); // si tu l’actives
router.post('/tenant/login', authTenant.login);
router.post('/tenant/introspect', authTenant.introspect);
router.get('/tenant/me', authTenant.me);
router.get('/tenant/userinfo', authTenant.userinfo);

router.post('/admin/login', authAdmin.login);
router.post('/admin/introspect', authAdmin.introspect);
router.get('/admin/me', authAdmin.me);
router.get('/admin/userinfo', authAdmin.userinfo);
router.post('/admin/register', authAdmin.register);
module.exports = router;
