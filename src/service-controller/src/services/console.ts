// @ts-nocheck
// services/console.js
const jwt = require('jsonwebtoken');
const { randomUUID } = require('node:crypto');
const mongoose = require('mongoose');
const TenantResource = require('../models/TenantResource');

function reqEnv(name) {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
}

// The browser always goes through the API Gateway (/api/v1/console/*)
const publicWsBase = () => {
    const base = reqEnv('PUBLIC_WS_BASE').replace(/\/$/, '');
    return base.endsWith('/api') ? base : `${base}/api`;
};

// Agents now connect to the dedicated WS broker instead of the controller
const brokerWsBase = () => reqEnv('BROKER_WS_BASE').replace(/\/$/, '');

const AGENT_SECRET = () => reqEnv('JWT_AGENT_SECRET');
const BROWSER_SECRET = () => reqEnv('JWT_BROWSER_SECRET');

function genTunnelId() {
    return randomUUID().replace(/-/g, '').slice(0, 22);
}

function isObjectIdLike(v) {
    return typeof v === 'string' && mongoose.Types.ObjectId.isValid(v);
}

/**
 * Robust lookup for a "TenantResource" VM
 * - when refId looks like an ObjectId, try _id first
 * - otherwise search by refId, then fall back to guid
 * - you can narrow by tenantId/agentId if provided
 */
async function loadVmOrThrow({ refId, tenantId, agentId }) {
    if (!refId) throw new Error('vm refId is required');

    const base = { kind: 'vm' };
    if (tenantId) base.tenantId = tenantId;
    if (agentId) base.agentId = agentId;

    let vm = null;

    // 1) direct lookup by _id when refId is a valid ObjectId
    if (isObjectIdLike(refId)) {
        vm = await TenantResource.findOne({ ...base, _id: refId }).lean().catch(() => null);
        if (vm) return vm;
    }

    // 2) fallback to refId (external GUID/UUID)
    vm = await TenantResource.findOne({ ...base, refId }).lean().catch(() => null);
    if (vm) return vm;

    // 3) final fallback on guid
    vm = await TenantResource.findOne({ ...base, guid: refId }).lean().catch(() => null);
    if (vm) return vm;

    throw new Error('vm not found');
}

// If the caller specifies agentId and the VM is linked to another agent → reject
function assertAgent(vm, agentId) {
    if (agentId && vm.agentId && vm.agentId !== agentId) {
        throw new Error(`agentId mismatch for vm ${vm._id}`);
    }
}

function makeAgentTicket({ tunnelId, vmId, tenantId, agentId, action }) {
    return jwt.sign(
        { aud: 'agent', act: action, tunnelId, vmId, tenantId, agentId },
        AGENT_SECRET(),
        { expiresIn: '2m' }
    );
}

function makeBrowserToken({ tunnelId, vmId, tenantId, sub, mode }) {
    return jwt.sign(
        { aud: 'browser', mode, tunnelId, vmId, tenantId, sub },
        BROWSER_SECRET(),
        { expiresIn: '5m' }
    );
}

function browserWsUrl(mode, browserToken) {
    if (mode === 'serial') return `${publicWsBase()}/v1/console/serial/ws?t=${browserToken}`;
    return `${publicWsBase()}/v1/console/net/ws?t=${browserToken}`;
}

function agentWsUrl(tunnelId, agentTicket) {
    // Agents connect straight to the WS broker
    return `${brokerWsBase()}/ws/tunnel/${tunnelId}?ticket=${agentTicket}`;
}

/** Serial console */
async function planSerialOpen({ refId, tenantId, agentId, sub, ttlSeconds }) {
    const vm = await loadVmOrThrow({ refId, tenantId, agentId });
    assertAgent(vm, agentId);

    const vmId = String(vm._id);
    const tunnelId = genTunnelId();

    const ticket = makeAgentTicket({
        tunnelId,
        vmId,
        tenantId: vm.tenantId,
        agentId: agentId || vm.agentId,
        action: 'console.serial.open',
    });
    const agentUrl = agentWsUrl(tunnelId, ticket);

    const browserToken = makeBrowserToken({
        tunnelId,
        vmId,
        tenantId: vm.tenantId,
        sub,
        mode: 'serial',
    });
    const browserUrl = browserWsUrl('serial', browserToken);

    return {
        agentData: {
            vmId,
            tunnelId,
            ticket,
            agentWsUrl: agentUrl,
            ttlSeconds: ttlSeconds || 900,
        },
        ui: {
            tunnelId,
            wsUrl: browserUrl,
            expiresAt: new Date(Date.now() + 5 * 60e3).toISOString(),
            mode: 'serial',
        },
        vm,
    };
}

/** Generic TCP tunnel (SSH/RDP/VNC…) */
async function planNetTunnelOpen({ refId, tenantId, agentId, target, mode, ttlSeconds, sub }) {
    if (!target?.ip || !target?.port) throw new Error('target.ip and target.port are required');

    const vm = await loadVmOrThrow({ refId, tenantId, agentId });
    assertAgent(vm, agentId);

    const vmId = String(vm._id);
    const tunnelId = genTunnelId();

    const ticket = makeAgentTicket({
        tunnelId,
        vmId,
        tenantId: vm.tenantId,
        agentId: agentId || vm.agentId,
        action: 'net.tunnel.open',
    });
    const agentUrl = agentWsUrl(tunnelId, ticket);

    const _mode = mode || 'net';
    const browserToken = makeBrowserToken({
        tunnelId,
        vmId,
        tenantId: vm.tenantId,
        sub,
        mode: _mode,
    });
    const browserUrl = browserWsUrl(_mode, browserToken);

    return {
        agentData: {
            vmId,
            tunnelId,
            ticket,
            agentWsUrl: agentUrl,
            ttlSeconds: ttlSeconds || 900,
            target,
        },
        ui: {
            tunnelId,
            wsUrl: browserUrl,
            expiresAt: new Date(Date.now() + 5 * 60e3).toISOString(),
            mode: _mode,
        },
        vm,
    };
}

module.exports = {
    planSerialOpen,
    planNetTunnelOpen,
};
