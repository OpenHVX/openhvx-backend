import dotenv from 'dotenv';
import http from 'http';
import { parse } from 'url';
import type { ParsedUrlQuery } from 'querystring';
import type { Socket } from 'net';
import type { Duplex } from 'stream';
import { WebSocketServer, type WebSocket, type RawData } from 'ws';
import jwt, { type JwtPayload } from 'jsonwebtoken';

dotenv.config();

type TunnelSide = 'agent' | 'browser';

interface AgentPayload extends JwtPayload {
    aud: 'agent';
    tunnelId: string;
    act?: string;
    vmId?: string;
    tenantId?: string;
    agentId?: string;
}

interface BrowserPayload extends JwtPayload {
    aud: 'browser';
    tunnelId: string;
    mode?: string;
    vmId?: string;
    tenantId?: string;
}

interface MessageStats {
    inMsgs: number;
    inBytes: number;
    outMsgs: number;
    outBytes: number;
}

interface TunnelStats {
    agent: MessageStats;
    browser: MessageStats;
}

interface TunnelMeta {
    act?: string;
    vmId?: string;
    tenantId?: string;
    agentId?: string;
    tunnelId?: string;
}

interface Tunnel {
    agentWS: WebSocket | null;
    browserWS: WebSocket | null;
    meta: TunnelMeta;
    expiresAt: number;
    timer: NodeJS.Timeout | null;
    hb: Record<TunnelSide, number>;
    stats: TunnelStats;
    qB2A: Buffer[];
}

type HeartbeatWebSocket = WebSocket & { isAlive?: boolean };

const LOG_PREFIX = '[ws-broker]';
const DEFAULT_PORT = 8081;
const MAX_AGENT_TTL_MS = 60 * 60 * 1000;
const MAX_BUFFERED_BROWSER_BYTES = 4 * 1024;
const HEARTBEAT_INTERVAL_MS = 25_000;
const SOCKET_KEEPALIVE_MS = 20_000;
const MAX_PAYLOAD_BYTES = 1 * 1024 * 1024;
const WS_OPEN_STATE = 1;
const AGENT_PATH_PREFIX = '/ws/tunnel/';
const BROWSER_SERIAL_PATH = '/v1/console/serial/ws';
const BROWSER_NETWORK_PATH = '/v1/console/net/ws';

/* ===================== ENV ===================== */
const PORT = Number(process.env.PORT ?? DEFAULT_PORT);
const JWT_AGENT_SECRET = must('JWT_AGENT_SECRET');
const JWT_BROWSER_SECRET = must('JWT_BROWSER_SECRET');
const WS_ORIGINS = (process.env.WS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean);
const BROWSER_WAIT_MS = Number(process.env.BROWSER_WAIT_MS ?? 2000); // grace before rejecting agent if no browser

function must(name: string): string {
    const v = process.env[name as keyof NodeJS.ProcessEnv];
    if (!v) throw new Error(`${name} is required`);
    return v;
}

/* ===================== Utils ===================== */
function now(): number { return Date.now(); }
function log(...a: unknown[]): void { console.log(LOG_PREFIX, ...a); }
function warn(...a: unknown[]): void { console.warn(LOG_PREFIX, ...a); }
function firstHeaderValue(value: string | string[] | undefined): string | undefined {
    if (Array.isArray(value)) return value[0];
    return value;
}

function peerInfo(req: http.IncomingMessage): { ip: string; ua: string } {
    const forwarded = firstHeaderValue(req.headers['x-forwarded-for']);
    const ip = req.socket?.remoteAddress || forwarded || 'unknown';
    const ua = firstHeaderValue(req.headers['user-agent']) || '';
    return { ip, ua };
}
function toQueryParams(queryObjOrString?: ParsedUrlQuery | string | null): URLSearchParams {
    if (!queryObjOrString) return new URLSearchParams();
    if (typeof queryObjOrString === 'string') return new URLSearchParams(queryObjOrString);
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(queryObjOrString)) {
        if (Array.isArray(v)) v.forEach(val => params.append(k, val));
        else if (typeof v === 'string') params.append(k, v);
        else if (typeof v === 'number' || typeof v === 'boolean') params.append(k, String(v));
    }
    return params;
}
function isWebSocketOpen(ws: WebSocket | null | undefined): ws is WebSocket {
    return Boolean(ws && ws.readyState === WS_OPEN_STATE);
}
function rejectUpgrade(socket: Duplex, statusCode: number, message?: string): void {
    const statusText = http.STATUS_CODES[statusCode] ?? 'Error';
    const body = message ? `${statusText}: ${message}` : statusText;
    try { socket.write(`HTTP/1.1 ${statusCode} ${statusText}\r\ncontent-type: text/plain\r\ncontent-length: ${Buffer.byteLength(body)}\r\n\r\n${body}`); } catch { }
    socket.destroy();
}
function sizeOf(data: RawData): number {
    if (typeof data === 'string') return Buffer.byteLength(data);
    if (Buffer.isBuffer(data)) return data.length;
    if (Array.isArray(data)) return data.reduce((acc, chunk) => acc + sizeOf(chunk), 0);
    if (data instanceof ArrayBuffer) return data.byteLength;
    return Buffer.byteLength(String(data));
}
function toBuffer(data: RawData): Buffer {
    if (Buffer.isBuffer(data)) return data;
    if (typeof data === 'string') return Buffer.from(data);
    if (data instanceof ArrayBuffer) return Buffer.from(data);
    if (Array.isArray(data)) return Buffer.concat(data.map(toBuffer));
    return Buffer.from(String(data ?? ''));
}
const vmKey = (tenantId?: string, vmId?: string) => `${tenantId || ''}:${vmId || ''}`;

/* ===================== State ===================== */
// tunnelId -> { agentWS, browserWS, meta, expiresAt, timer, hb, stats, qB2A }
const tunnels = new Map<string, Tunnel>();
// active console per VM (enforces single active)
const activeByVm = new Map<string, string>(); // key=tenantId:vmId -> tunnelId

function ensureTunnel(tunnelId: string): Tunnel {
    let t = tunnels.get(tunnelId);
    if (!t) {
        t = {
            agentWS: null,
            browserWS: null,
            meta: {}, // { act, vmId, tenantId, agentId }
            expiresAt: 0,
            timer: null,
            hb: { agent: now(), browser: now() },
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

function clearActiveIfMatching(t: Tunnel, tunnelId: string): void {
    const k = vmKey(t.meta.tenantId, t.meta.vmId);
    if (!k.includes(':')) return;
    const cur = activeByVm.get(k);
    if (cur && cur === tunnelId) {
        activeByVm.delete(k);
    }
}

function closeTunnel(tunnelId: string, reason = 'end'): void {
    const t = tunnels.get(tunnelId);
    if (!t) return;
    try { t.agentWS && t.agentWS.close(1000, reason); } catch { }
    try { t.browserWS && t.browserWS.close(1000, reason); } catch { }
    if (t.timer) clearTimeout(t.timer);
    // clear active map if this was the active tunnel for the VM
    try { clearActiveIfMatching(t, tunnelId); } catch { }
    tunnels.delete(tunnelId);
    log('tunnel closed', tunnelId, reason, { stats: t.stats });
}

function scheduleExpiry(t: Tunnel, tunnelId: string, ttlMs: number, logLabel: string): void {
    const safeTtl = Math.max(1000, ttlMs);
    if (t.timer) clearTimeout(t.timer);
    t.expiresAt = now() + safeTtl;
    t.timer = setTimeout(() => closeTunnel(tunnelId, 'ttl'), safeTtl);
    log(`tunnel TTL ${logLabel}`, tunnelId, `${safeTtl}ms`);
}

function flushBrowserQueue(t: Tunnel): void {
    if (!isWebSocketOpen(t.agentWS) || !t.qB2A.length) return;
    for (const buf of t.qB2A) {
        try {
            t.agentWS.send(buf, { binary: true });
            t.stats.agent.outMsgs++; t.stats.agent.outBytes += buf.length;
        } catch {
            break;
        }
    }
    t.qB2A.length = 0;
}

function bufferBrowserPayload(t: Tunnel, payload: RawData): void {
    const chunk = toBuffer(payload);
    const used = t.qB2A.reduce((sum, item) => sum + item.length, 0);
    const budget = Math.max(0, MAX_BUFFERED_BROWSER_BYTES - used);
    if (budget > 0) t.qB2A.push(chunk.slice(0, budget));
}

/* ===================== JWT ===================== */
function verifyAgentTicket(token: string, expectedTunnelId: string): AgentPayload {
    const payload = jwt.verify(token, JWT_AGENT_SECRET, { clockTolerance: 10 }) as AgentPayload;
    if (payload.aud !== 'agent') throw new Error('bad aud');
    if (payload.tunnelId !== expectedTunnelId) throw new Error('tunnelId mismatch');
    return payload;
}
function verifyBrowserToken(token: string): BrowserPayload {
    const payload = jwt.verify(token, JWT_BROWSER_SECRET, { clockTolerance: 10 }) as BrowserPayload;
    if (payload.aud !== 'browser') throw new Error('bad aud');
    if (!payload.tunnelId) throw new Error('missing tunnelId');
    return payload; // {mode,tunnelId,vmId,tenantId,sub,exp,...}
}

/* ===================== Heartbeat ===================== */
function wireHeartbeat(ws: WebSocket, side: TunnelSide, t: Tunnel): void {
    const hbSocket = ws as HeartbeatWebSocket;
    hbSocket.isAlive = true;
    hbSocket.on('pong', () => { hbSocket.isAlive = true; t.hb[side] = now(); });
}
// ping only browser
setInterval(() => {
    for (const [tid, t] of tunnels.entries()) {
        if (t.browserWS) {
            const browserSocket = t.browserWS as HeartbeatWebSocket;
            if (!browserSocket.isAlive) {
                try { browserSocket.terminate(); } catch { }
                closeTunnel(tid, 'browser ping timeout');
                continue;
            }
            browserSocket.isAlive = false;
            try { browserSocket.ping(); } catch { }
        }
        if (t.agentWS && !isWebSocketOpen(t.agentWS)) {
            closeTunnel(tid, 'agent not open');
            continue;
        }
    }
}, HEARTBEAT_INTERVAL_MS);

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
    maxPayload: MAX_PAYLOAD_BYTES,
});

server.on('upgrade', (req, socket, head) => {
    try {
        const netSocket = socket as Socket;
        netSocket.setNoDelay(true);
        netSocket.setKeepAlive(true, SOCKET_KEEPALIVE_MS);
    } catch { }

    const { pathname, query } = parse(req.url || '', true);
    const peer = peerInfo(req);

    if (pathname && pathname.startsWith(AGENT_PATH_PREFIX)) {
        handleAgentUpgrade(req, socket, head, pathname, query, peer);
        return;
    }

    if (pathname === BROWSER_SERIAL_PATH || pathname === BROWSER_NETWORK_PATH) {
        handleBrowserUpgrade(req, socket, head, pathname, query, peer);
        return;
    }

    warn('upgrade 404', { path: pathname, peer });
    rejectUpgrade(socket, 404, 'unknown route');
});

function handleAgentUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    pathname: string,
    query: ParsedUrlQuery | string | null,
    peer: { ip: string; ua: string },
): void {
    const tunnelId = pathname.split('/').pop() || '';
    if (!tunnelId) {
        warn('AGENT upgrade missing tunnelId', { path: pathname, peer });
        rejectUpgrade(socket, 400, 'missing tunnel id');
        return;
    }

    const params = toQueryParams(query);
    const ticket = params.get('ticket') || '';
    if (!ticket) {
        warn('AGENT upgrade missing ticket', { tunnelId, path: pathname, peer });
        rejectUpgrade(socket, 401, 'missing ticket');
        return;
    }

    let payload: AgentPayload;
    try {
        payload = verifyAgentTicket(ticket, tunnelId);
    } catch (err) {
        warn('AGENT upgrade FAIL', { tunnelId, path: pathname, err: err instanceof Error ? err.message : String(err), peer });
        rejectUpgrade(socket, 401, 'invalid ticket');
        return;
    }

    log('AGENT upgrade OK', {
        tunnelId,
        act: payload.act,
        agentId: payload.agentId,
        vmId: payload.vmId,
        peer,
        expInMs: ((payload.exp ?? 0) * 1000) - now(),
    });

    wss.handleUpgrade(req, socket, head, (ws) => {
        const tunnel = ensureTunnel(tunnelId);
        if (tunnel.agentWS) {
            warn('agent already connected, rejecting', { tunnelId });
            try { ws.close(1011, 'agent already connected'); } catch { }
            return;
        }

        const key = vmKey(payload.tenantId, payload.vmId);
        const activeTid = activeByVm.get(key);
        if (activeTid && activeTid !== tunnelId) {
            warn('agent connect rejected (superseded)', { tunnelId, activeTid, vmKey: key });
            try { ws.close(4403, 'superseded'); } catch { }
            return;
        }

        tunnel.agentWS = ws;
        tunnel.meta = { act: payload.act, vmId: payload.vmId, tenantId: payload.tenantId, agentId: payload.agentId };

        const expiresInMs = Math.max(1000, ((payload.exp ?? 0) * 1000) - now());
        scheduleExpiry(tunnel, tunnelId, Math.min(expiresInMs, MAX_AGENT_TTL_MS), '(agent ticket)');

        wireHeartbeat(ws, 'agent', tunnel);

        if (!tunnel.browserWS && BROWSER_WAIT_MS > 0) {
            setTimeout(() => {
                const cur = tunnels.get(tunnelId);
                if (cur && !cur.browserWS && cur.agentWS === ws) {
                    warn('agent no-browser, closing', { tunnelId, waitMs: BROWSER_WAIT_MS });
                    try { ws.close(4404, 'no browser'); } catch { }
                    closeTunnel(tunnelId, 'no browser');
                }
            }, BROWSER_WAIT_MS);
        }

        flushBrowserQueue(tunnel);

        ws.on('message', (data, isBinary) => {
            const len = sizeOf(data);
            tunnel.stats.agent.inMsgs++; tunnel.stats.agent.inBytes += len;
            if (isWebSocketOpen(tunnel.browserWS)) {
                tunnel.browserWS.send(data, { binary: isBinary });
                tunnel.stats.browser.outMsgs++; tunnel.stats.browser.outBytes += len;
            }
        });

        ws.on('error', (err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            warn('agent ws error', { tunnelId, err: errMsg });
        });

        ws.on('close', (code, reasonBuf) => {
            const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf || '');
            warn('agent closed', { tunnelId, code, reason, stats: tunnel.stats });
            closeTunnel(tunnelId, 'agent closed');
        });

        log('agent connected', { tunnelId, meta: tunnel.meta });
        if (isWebSocketOpen(tunnel.browserWS)) log('tunnel ready (agent+browser)', { tunnelId });
    });
}

function handleBrowserUpgrade(
    req: http.IncomingMessage,
    socket: Duplex,
    head: Buffer,
    pathname: string,
    query: ParsedUrlQuery | string | null,
    peer: { ip: string; ua: string },
): void {
    const params = toQueryParams(query);
    const token = params.get('t') || '';
    if (!token) {
        warn('BROWSER upgrade missing token', { path: pathname, peer });
        rejectUpgrade(socket, 401, 'missing token');
        return;
    }

    if (WS_ORIGINS.length) {
        const origin = req.headers.origin || '';
        if (!WS_ORIGINS.includes(origin)) {
            warn('BROWSER origin blocked', { origin, path: pathname, peer });
            rejectUpgrade(socket, 403, 'origin blocked');
            return;
        }
    }

    let payload: BrowserPayload;
    try {
        payload = verifyBrowserToken(token);
    } catch (err) {
        warn('BROWSER upgrade FAIL', { path: pathname, err: err instanceof Error ? err.message : String(err), peer });
        rejectUpgrade(socket, 401, 'invalid token');
        return;
    }

    const tunnelId = payload.tunnelId;
    log('BROWSER upgrade OK', {
        tunnelId,
        mode: payload.mode,
        vmId: payload.vmId,
        tenantId: payload.tenantId,
        peer,
        expInMs: ((payload.exp ?? 0) * 1000) - now(),
    });

    wss.handleUpgrade(req, socket, head, (ws) => {
        const tunnel = ensureTunnel(tunnelId);
        if (tunnel.browserWS) {
            try { tunnel.browserWS.close(1011, 'replaced'); } catch { }
        }
        tunnel.browserWS = ws;

        const key = vmKey(payload.tenantId, payload.vmId);
        const prevTid = activeByVm.get(key);
        if (prevTid && prevTid !== tunnelId) {
            warn('closing previous active tunnel for VM', { vmKey: key, prevTid, newTid: tunnelId });
            try { closeTunnel(prevTid, 'superseded'); } catch { }
        }
        activeByVm.set(key, tunnelId);

        const desiredExpiry = tunnel.expiresAt || ((payload.exp ?? 0) * 1000);
        const remaining = Math.max(1000, desiredExpiry - now());
        scheduleExpiry(tunnel, tunnelId, remaining, '(browser align)');

        wireHeartbeat(ws, 'browser', tunnel);

        ws.on('message', (data, isBinary) => {
            const len = sizeOf(data);
            tunnel.stats.browser.inMsgs++; tunnel.stats.browser.inBytes += len;

            if (isWebSocketOpen(tunnel.agentWS)) {
                tunnel.agentWS.send(data, { binary: isBinary });
                tunnel.stats.agent.outMsgs++; tunnel.stats.agent.outBytes += len;
            } else {
                bufferBrowserPayload(tunnel, data);
            }
        });

        ws.on('error', (err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            warn('browser ws error', { tunnelId, err: errMsg });
        });

        ws.on('close', (code, reasonBuf) => {
            const reason = Buffer.isBuffer(reasonBuf) ? reasonBuf.toString('utf8') : String(reasonBuf || '');
            warn('browser closed', { tunnelId, code, reason, stats: tunnel.stats });
            closeTunnel(tunnelId, 'browser closed');
        });

        log('browser connected', { tunnelId, mode: payload.mode });
        if (isWebSocketOpen(tunnel.agentWS)) log('tunnel ready (agent+browser)', { tunnelId });
    });
}

/* ===================== Start ===================== */
server.listen(PORT, () => {
    log(`listening on :${PORT}`);
    log('secrets:', { JWT_AGENT_SECRET_len: JWT_AGENT_SECRET.length, JWT_BROWSER_SECRET_len: JWT_BROWSER_SECRET.length });
});
