require('dotenv').config();
const http = require('http');
const url = require('url');
const { WebSocketServer } = require('ws');
const jwt = require('jsonwebtoken');

/* ===================== ENV ===================== */
const PORT = Number(process.env.PORT || 8081);
const JWT_AGENT_SECRET = must('JWT_AGENT_SECRET');
const JWT_BROWSER_SECRET = must('JWT_BROWSER_SECRET');
const WS_ORIGINS = (process.env.WS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const BROWSER_WAIT_MS = Number(process.env.BROWSER_WAIT_MS || 2000); // grace before rejecting agent if no browser

function must(name) {
    const v = process.env[name];
    if (!v) throw new Error(`${name} is required`);
    return v;
}

/* ===================== Utils ===================== */
function now() { return Date.now(); }
function log(...a) { console.log('[ws-broker]', ...a); }
function warn(...a) { console.warn('[ws-broker]', ...a); }
function peerInfo(req) {
    const ip = req.socket?.remoteAddress || req.headers['x-forwarded-for'] || 'unknown';
    const ua = req.headers['user-agent'] || '';
    return { ip, ua };
}
function qp(queryObjOrString) {
    if (typeof queryObjOrString === 'string') return new URLSearchParams(queryObjOrString);
    try { return new URLSearchParams(Object.entries(queryObjOrString || {})); }
    catch { return new URLSearchParams(); }
}
function sizeOf(data, isBinary) {
    if (Buffer.isBuffer(data)) return data.length;
    if (typeof data === 'string') return Buffer.byteLength(data);
    try { return Buffer.from(data).length; } catch { return 0; }
}
const vmKey = (tenantId, vmId) => `${tenantId || ''}:${vmId || ''}`;

/* ===================== State ===================== */
// tunnelId -> { agentWS, browserWS, meta, expiresAt, timer, hb, stats, qB2A }
const tunnels = new Map();
// active console per VM (enforces single active)
const activeByVm = new Map(); // key=tenantId:vmId -> tunnelId

function ensureTunnel(tunnelId) {
    let t = tunnels.get(tunnelId);
    if (!t) {
        t = {
            agentWS: null,
            browserWS: null,
            meta: {}, // { act, vmId, tenantId, agentId }
            expiresAt: 0,
            timer: null,
            hb: { a: now(), b: now() },
            stats: {
                agent: { inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0 },
                browser: { inMsgs: 0, inBytes: 0, outMsgs: 0, outBytes: 0 },
            },
            qB2A: [], // queued browser->agent when agent not connected
        };
        tunnels.set(tunnelId, t);
    }
    return t;
}

function clearActiveIfMatching(t) {
    const k = vmKey(t.meta.tenantId, t.meta.vmId);
    if (!k.includes(':')) return;
    const cur = activeByVm.get(k);
    if (cur && cur === t.meta.tunnelId) {
        activeByVm.delete(k);
    }
}

function closeTunnel(tunnelId, reason = 'end') {
    const t = tunnels.get(tunnelId);
    if (!t) return;
    try { t.agentWS && t.agentWS.close(1000, reason); } catch { }
    try { t.browserWS && t.browserWS.close(1000, reason); } catch { }
    if (t.timer) clearTimeout(t.timer);
    // clear active map if this was the active tunnel for the VM
    try { clearActiveIfMatching({ meta: { ...t.meta, tunnelId } }); } catch { }
    tunnels.delete(tunnelId);
    log('tunnel closed', tunnelId, reason, { stats: t.stats });
}

/* ===================== JWT ===================== */
function verifyAgentTicket(token, expectedTunnelId) {
    const payload = jwt.verify(token, JWT_AGENT_SECRET, { clockTolerance: 10 });
    if (payload.aud !== 'agent') throw new Error('bad aud');
    if (payload.tunnelId !== expectedTunnelId) throw new Error('tunnelId mismatch');
    return payload;
}
function verifyBrowserToken(token) {
    const payload = jwt.verify(token, JWT_BROWSER_SECRET, { clockTolerance: 10 });
    if (payload.aud !== 'browser') throw new Error('bad aud');
    if (!payload.tunnelId) throw new Error('missing tunnelId');
    return payload; // {mode,tunnelId,vmId,tenantId,sub,exp,...}
}

/* ===================== Heartbeat ===================== */
function wireHeartbeat(ws, side, t, tunnelId) {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; t.hb[side] = now(); });
}
// ping only browser
setInterval(() => {
    for (const [tid, t] of tunnels.entries()) {
        if (t.browserWS) {
            if (!t.browserWS.isAlive) {
                try { t.browserWS.terminate(); } catch { }
                closeTunnel(tid, 'browser ping timeout');
                continue;
            }
            t.browserWS.isAlive = false;
            try { t.browserWS.ping(); } catch { }
        }
        if (t.agentWS && t.agentWS.readyState !== 1) {
            closeTunnel(tid, 'agent not open');
            continue;
        }
    }
}, 25000);

/* ===================== HTTP & WS ===================== */
const server = http.createServer((req, res) => {
    if (req.url === '/healthz') {
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ ok: true, service: 'ws-broker' }));
        return;
    }
    res.writeHead(404).end();
});

const wss = new WebSocketServer({
    noServer: true,
    perMessageDeflate: false,
    maxPayload: 1 * 1024 * 1024,
});

server.on('upgrade', (req, socket, head) => {
    try {
        socket.setNoDelay(true);
        socket.setKeepAlive(true, 20_000);
    } catch { }

    const { pathname, query } = url.parse(req.url, true);
    const peer = peerInfo(req);

    // ---------- Agent -> /ws/tunnel/:tunnelId?ticket=... ----------
    if (pathname && pathname.startsWith('/ws/tunnel/')) {
        const tunnelId = pathname.split('/').pop();
        const params = qp(query);
        const ticket = params.get('ticket') || '';
        if (!ticket) {
            warn('AGENT upgrade missing ticket', { tunnelId, path: pathname, peer });
            try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch { }
            return socket.destroy();
        }

        try {
            const payload = verifyAgentTicket(ticket, tunnelId);
            log('AGENT upgrade OK', {
                tunnelId,
                act: payload.act,
                agentId: payload.agentId,
                vmId: payload.vmId,
                peer,
                expInMs: (payload.exp * 1000) - now(),
            });

            return wss.handleUpgrade(req, socket, head, (ws) => {
                const t = ensureTunnel(tunnelId);
                if (t.agentWS) {
                    warn('agent already connected, rejecting', { tunnelId });
                    try { ws.close(1011, 'agent already connected'); } catch { }
                    return;
                }

                // --- Single active tunnel per VM: reject stale tunnel immediately
                const k = vmKey(payload.tenantId, payload.vmId);
                const activeTid = activeByVm.get(k);
                if (activeTid && activeTid !== tunnelId) {
                    warn('agent connect rejected (superseded)', { tunnelId, activeTid, vmKey: k });
                    try { ws.close(4403, 'superseded'); } catch { }
                    return;
                }

                t.agentWS = ws;
                t.meta = { act: payload.act, vmId: payload.vmId, tenantId: payload.tenantId, agentId: payload.agentId };

                // TTL aligned with agent ticket (max 1h)
                const expMs = Math.max(1000, (payload.exp * 1000) - now());
                const ttlMs = Math.min(expMs, 60 * 60 * 1000);
                t.expiresAt = now() + ttlMs;
                if (t.timer) clearTimeout(t.timer);
                t.timer = setTimeout(() => closeTunnel(tunnelId, 'ttl'), ttlMs);
                log('tunnel TTL set', tunnelId, `${ttlMs}ms`);

                wireHeartbeat(ws, 'a', t, tunnelId);

                // If no browser yet, allow a tiny grace then reject fast (avoids “hanging” old tasks)
                if (!t.browserWS && BROWSER_WAIT_MS > 0) {
                    setTimeout(() => {
                        const cur = tunnels.get(tunnelId);
                        if (cur && !cur.browserWS && cur.agentWS === ws) {
                            warn('agent no-browser, closing', { tunnelId, waitMs: BROWSER_WAIT_MS });
                            try { ws.close(4404, 'no browser'); } catch { }
                            closeTunnel(tunnelId, 'no browser');
                        }
                    }, BROWSER_WAIT_MS);
                }

                // flush queued browser->agent if any
                if (t.qB2A && t.qB2A.length) {
                    for (const buf of t.qB2A) {
                        try {
                            t.agentWS.send(buf, { binary: true });
                            t.stats.agent.outMsgs++; t.stats.agent.outBytes += buf.length;
                        } catch { break }
                    }
                    t.qB2A.length = 0;
                }

                ws.on('message', (data, isBinary) => {
                    const len = sizeOf(data, isBinary);
                    t.stats.agent.inMsgs++; t.stats.agent.inBytes += len;
                    if (t.browserWS && t.browserWS.readyState === 1) {
                        t.browserWS.send(data, { binary: isBinary });
                        t.stats.browser.outMsgs++; t.stats.browser.outBytes += len;
                    }
                });

                ws.on('error', (e) => warn('agent ws error', { tunnelId, err: e?.message }));

                ws.on('close', (code, reasonBuf) => {
                    const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf || '');
                    warn('agent closed', { tunnelId, code, reason, stats: t.stats });
                    closeTunnel(tunnelId, 'agent closed');
                });

                log('agent connected', { tunnelId, meta: t.meta });
                if (t.agentWS && t.browserWS) log('tunnel ready (agent+browser)', { tunnelId });
            });
        } catch (e) {
            warn('AGENT upgrade FAIL', { tunnelId, path: pathname, err: e.message, peer });
            try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch { }
            return socket.destroy();
        }
    }

    // ---------- Browser -> /v1/console/(serial|net)/ws?t=... ----------
    if (pathname === '/v1/console/serial/ws' || pathname === '/v1/console/net/ws') {
        const params = qp(query);
        const token = params.get('t') || '';
        if (!token) {
            warn('BROWSER upgrade missing token', { path: pathname, peer });
            try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch { }
            return socket.destroy();
        }

        if (WS_ORIGINS.length) {
            const origin = req.headers.origin || '';
            if (!WS_ORIGINS.includes(origin)) {
                warn('BROWSER origin blocked', { origin, path: pathname, peer });
                try { socket.write('HTTP/1.1 403 Forbidden\r\n\r\n'); } catch { }
                return socket.destroy();
            }
        }

        try {
            const payload = verifyBrowserToken(token);
            const tunnelId = payload.tunnelId;
            log('BROWSER upgrade OK', {
                tunnelId,
                mode: payload.mode,
                vmId: payload.vmId,
                tenantId: payload.tenantId,
                peer,
                expInMs: (payload.exp * 1000) - now(),
            });

            return wss.handleUpgrade(req, socket, head, (ws) => {
                const t = ensureTunnel(tunnelId);
                if (t.browserWS) { try { t.browserWS.close(1011, 'replaced'); } catch { } }
                t.browserWS = ws;

                // 1 tunnel per VM
                const k = vmKey(payload.tenantId, payload.vmId);
                const prevTid = activeByVm.get(k);
                if (prevTid && prevTid !== tunnelId) {
                    warn('closing previous active tunnel for VM', { vmKey: k, prevTid, newTid: tunnelId });
                    try { closeTunnel(prevTid, 'superseded'); } catch { }
                }
                activeByVm.set(k, tunnelId);

                // TTL
                const remaining = Math.max(1000, (t.expiresAt || (payload.exp * 1000)) - now());
                if (t.timer) clearTimeout(t.timer);
                t.expiresAt = now() + remaining;
                t.timer = setTimeout(() => closeTunnel(tunnelId, 'ttl'), remaining);
                log('tunnel TTL (browser align)', tunnelId, `${remaining}ms`);

                wireHeartbeat(ws, 'b', t, tunnelId);

                ws.on('message', (data, isBinary) => {
                    const len = sizeOf(data, isBinary);
                    t.stats.browser.inMsgs++; t.stats.browser.inBytes += len;

                    if (t.agentWS && t.agentWS.readyState === 1) {
                        t.agentWS.send(data, { binary: isBinary });
                        t.stats.agent.outMsgs++; t.stats.agent.outBytes += len;
                    } else {
                        // buffer
                        const chunk = Buffer.isBuffer(data) ? data : Buffer.from(data);
                        const used = t.qB2A.reduce((a, b) => a + b.length, 0);
                        const budget = Math.max(0, 4096 - used);
                        if (budget > 0) t.qB2A.push(chunk.slice(0, budget));
                    }
                });

                ws.on('error', (e) => warn('browser ws error', { tunnelId, err: e?.message }));

                ws.on('close', (code, reasonBuf) => {
                    const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf || '');
                    warn('browser closed', { tunnelId, code, reason, stats: t.stats });
                    closeTunnel(tunnelId, 'browser closed');
                });

                log('browser connected', { tunnelId, mode: payload.mode });
                if (t.agentWS && t.browserWS) log('tunnel ready (agent+browser)', { tunnelId });
            });
        } catch (e) {
            warn('BROWSER upgrade FAIL', { path: pathname, err: e.message, peer });
            try { socket.write('HTTP/1.1 401 Unauthorized\r\n\r\n'); } catch { }
            return socket.destroy();
        }
    }

    // Defaults
    warn('upgrade 404', { path: pathname, peer });
    try { socket.write('HTTP/1.1 404 Not Found\r\n\r\n'); } catch { }
    socket.destroy();
});

/* ===================== Start ===================== */
server.listen(PORT, () => {
    log(`listening on :${PORT}`);
    log('secrets:', { JWT_AGENT_SECRET_len: JWT_AGENT_SECRET.length, JWT_BROWSER_SECRET_len: JWT_BROWSER_SECRET.length });
});
