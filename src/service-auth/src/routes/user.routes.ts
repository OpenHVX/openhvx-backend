// @ts-nocheck
// routes/auth.routes.js
const router = require('express').Router();
const authTenant = require('../controllers/authTenant.controller');
const authAdmin = require('../controllers/authAdmin.controller');

router.post('/tenant/register', authTenant.register); // keep if you allow self-registration
router.post('/tenant/login', authTenant.login);
router.post('/tenant/introspect', authTenant.introspect);
router.get('/tenant/me', authTenant.me);
router.get('/tenant/userinfo', authTenant.userinfo);
router.post('/tenant/pats', authTenant.createPat);
router.get('/tenant/pats', authTenant.listPats);
router.delete('/tenant/pats/:patId', authTenant.revokePat);

router.post('/admin/login', authAdmin.login);
router.post('/admin/introspect', authAdmin.introspect);
router.get('/admin/me', authAdmin.me);
router.get('/admin/userinfo', authAdmin.userinfo);
router.post('/admin/register', authAdmin.register);
router.post('/admin/pats', authAdmin.createPat);
router.get('/admin/pats', authAdmin.listPats);
router.delete('/admin/pats/:patId', authAdmin.revokePat);
module.exports = router;
