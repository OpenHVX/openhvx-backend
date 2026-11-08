import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { resolve } from "node:path";
import jwt from "jsonwebtoken";
import WebSocket from "ws";
import { MongoMemoryReplSet } from "mongodb-memory-server";
let mongo: MongoMemoryReplSet;
const processes: ChildProcess[] = [];
let portA: number, portB: number, portC: number;
const secret = "console-test-secret-32-characters-minimum";
async function port() {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const result = (server.address() as { port: number }).port;
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return result;
}
before(async () => {
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.24" },
  });
  portA = await port();
  portB = await port();
  portC = await port();
  const peers = JSON.stringify({
    a: `http://127.0.0.1:${portA}`,
    b: `http://127.0.0.1:${portB}`,
    c: `http://127.0.0.1:${portC}`,
  });
  for (const [id, p] of [
    ["a", portA],
    ["b", portB],
    ["c", portC],
  ] as const) {
    let logs = "";
    const child = spawn(
      process.execPath,
      [resolve("../service-ws-broker/dist/app.js")],
      {
        env: {
          ...process.env,
          MONGO_URL: mongo.getUri(),
          BROKER_ID: id,
          BROKER_PEERS: peers,
          PORT: String(p),
          JWT_AGENT_SECRET: secret,
          JWT_BROWSER_SECRET: secret,
          BROWSER_WAIT_MS: "30000",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    );
    processes.push(child);
    child.stdout!.on("data", (data) => {
      logs += data;
    });
    child.stderr!.on("data", (data) => {
      logs += data;
    });
    let ready = false;
    for (let attempt = 0; attempt < 100; attempt++) {
      try {
        ready = (await fetch(`http://127.0.0.1:${p}/readyz`)).ok;
      } catch {}
      if (ready) break;
      if (child.exitCode !== null) throw new Error(logs);
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    assert.ok(ready, logs);
  }
});
after(async () => {
  for (const child of processes) child.kill("SIGTERM");
  await Promise.all(
    processes.map((child) =>
      child.exitCode !== null
        ? Promise.resolve()
        : new Promise((resolve) => child.once("exit", resolve)),
    ),
  );
  await mongo?.stop();
});
function ticket(tunnelId: string, aud: string, vmId = "vm") {
  return jwt.sign({ tunnelId, tenantId: "tenant", vmId, aud }, secret, {
    expiresIn: 120,
  });
}
async function open(url: string): Promise<WebSocket> {
  const socket = new WebSocket(url);
  await new Promise<void>((resolve, reject) => {
    socket.once("open", resolve);
    socket.once("error", reject);
  });
  return socket;
}
test("agent and browser through different brokers reach the owner; ticket replay fails", async () => {
  const agent = await open(
    `ws://127.0.0.1:${portA}/ws/tunnel/shared?ticket=${ticket("shared", "agent")}`,
  );
  const browserUrl = `ws://127.0.0.1:${portB}/v1/console/serial/ws?t=${ticket("shared", "browser")}`;
  const browser = await open(browserUrl);
  try {
    const received = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("relay timeout")),
        5000,
      );
      agent.once("message", (data) => {
        clearTimeout(timeout);
        resolve(data.toString());
      });
    });
    browser.send("hello distributed console");
    assert.equal(await received, "hello distributed console");
    await assert.rejects(open(browserUrl));
    await assert.rejects(
      open(
        `ws://127.0.0.1:${portB}/ws/tunnel/other?ticket=${ticket("other", "agent")}`,
      ),
    );
  } finally {
    browser.terminate();
    agent.terminate();
  }
});
test("browser may connect before agent through another broker", async () => {
  const browser = await open(
    `ws://127.0.0.1:${portB}/v1/console/serial/ws?t=${ticket("reverse", "browser", "vm-2")}`,
  );
  const agent = await open(
    `ws://127.0.0.1:${portA}/ws/tunnel/reverse?ticket=${ticket("reverse", "agent", "vm-2")}`,
  );
  try {
    const received = new Promise<string>((resolve, reject) => {
      const timeout = setTimeout(
        () => reject(new Error("relay timeout")),
        5000,
      );
      browser.once("message", (data) => {
        clearTimeout(timeout);
        resolve(data.toString());
      });
    });
    agent.send("reverse order");
    assert.equal(await received, "reverse order");
  } finally {
    browser.terminate();
    agent.terminate();
  }
});

test("a paused old owner cannot forward after another broker acquires the expired lease", { timeout: 30000 }, async () => {
    const agent = await open(`ws://127.0.0.1:${portA}/ws/tunnel/paused?ticket=${ticket("paused", "agent", "vm-failover")}`);
    const browser = await open(`ws://127.0.0.1:${portB}/v1/console/serial/ws?t=${ticket("paused", "browser", "vm-failover")}`);
    processes[0].kill("SIGSTOP");
    let recoveredAgent: WebSocket | undefined, recoveredBrowser: WebSocket | undefined;
    try {
        await new Promise(resolve => setTimeout(resolve, 16000));
        recoveredAgent = await open(`ws://127.0.0.1:${portC}/ws/tunnel/recovered?ticket=${ticket("recovered", "agent", "vm-failover")}`);
        recoveredBrowser = await open(`ws://127.0.0.1:${portB}/v1/console/serial/ws?t=${ticket("recovered", "browser", "vm-failover")}`);
        const closed = new Promise<void>(resolve => { const timer = setTimeout(resolve, 5000); browser.once("close", () => { clearTimeout(timer); resolve(); }); });
        let forwarded = false;
        browser.on("message", () => { forwarded = true; });
        agent.send("stale owner must not forward");
        processes[0].kill("SIGCONT");
        await closed;
        assert.equal(forwarded, false);
        assert.notEqual(browser.readyState, WebSocket.OPEN);
        await assert.rejects(open(`ws://127.0.0.1:${portB}/ws/tunnel/paused?ticket=${ticket("paused", "agent", "vm-failover")}`));
    } finally {
        processes[0].kill("SIGCONT");
        browser.terminate(); agent.terminate(); recoveredAgent?.terminate(); recoveredBrowser?.terminate();
    }
});
