import Tenant from "../../models/Tenant";
import { spawn, type ChildProcess } from "node:child_process";
import { resolve } from "node:path";
import { createServer } from "node:net";
import { before, after, test } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import { request, type Server } from "node:http";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { controllerIdentity } from "../../middlewares/controllerIdentity";
import { enqueueTask } from "../../controllers/tasksController";
import Heartbeat from "../../models/Heartbeat";
import Idempotency from "../../models/Idempotency";
import Outbox from "../../models/Outbox";
import Task from "../../models/Task";
let mongo: MongoMemoryReplSet, server: Server, base: string;
let gateway: ChildProcess | undefined;
let authServer: Server | undefined;
const secret = "test-internal-secret-32-characters-minimum";
before(async () => {
  process.env.INTERNAL_API_SECRET = secret;
  mongo = await MongoMemoryReplSet.create({
    replSet: { count: 1 },
    binary: { version: "7.0.24" },
  });
  await mongoose.connect(mongo.getUri());
  for (const model of [Tenant, Heartbeat, Idempotency, Outbox, Task])
    await model.init();
  await Tenant.create({ tenantId: "http-tenant", name: "HTTP tenant" });
  await Heartbeat.create({
    agentId: "http-agent",
    capabilities: ["echo", "task.protocol.v2"],
    lastSeen: new Date(),
  });
  const app = express();
  app.use(express.json());
  app.post("/api/v1/tenant/tasks", controllerIdentity("tenant"), enqueueTask);
  server = app.listen(0);
  await new Promise<void>((resolve) => server.once("listening", resolve));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
after(async () => {
  gateway?.kill("SIGTERM");
  if (gateway && gateway.exitCode === null)
    await new Promise((resolve) => gateway!.once("exit", resolve));
  authServer?.close();
  server?.close();
  await mongoose.disconnect();
  await mongo?.stop();
});
function identity(body: unknown, tenantId = "http-tenant") {
  return jwt.sign(
    {
      mode: "tenant",
      tenantId,
      roles: ["tenant-admin"],
      method: "POST",
      path: "/api/v1/tenant/tasks",
      bodyHash: createHash("sha256").update(JSON.stringify(body)).digest("hex"),
    },
    secret,
    {
      issuer: "openhvx-gateway",
      audience: "openhvx-controller",
      subject: "actor",
      expiresIn: 30,
    },
  );
}
const body = {
  action: "echo",
  target: { kind: "vm", agentId: "http-agent" },
  data: { message: "hello" },
};
async function submit(
  value: unknown,
  token = identity(value),
  key = "same-request",
) {
  return fetch(`${base}/api/v1/tenant/tasks`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-controller-identity": token,
      "idempotency-key": key,
    },
    body: JSON.stringify(value),
  });
}
test("parallel HTTP retries persist one task and one outbox; changed body conflicts", async () => {
  const responses = await Promise.all(
    Array.from({ length: 6 }, () => submit(body)),
  );
  for (const response of responses)
    assert.equal(response.status, 202, await response.text());
  assert.equal(await Task.countDocuments(), 1);
  assert.equal(await Outbox.countDocuments(), 1);
  assert.equal(
    (await submit({ ...body, data: { message: "other" } })).status,
    409,
  );
});
test("unsigned and modified requests cannot use tenant/admin headers as identity", async () => {
  assert.equal((await submit(body, "")).status, 401);
  assert.equal(
    (await submit({ ...body, data: { message: "changed" } }, identity(body)))
      .status,
    401,
  );
});

test("the real gateway signs the rewritten request and immediately observes auth revocation", async () => {
  let active = true;
  let introspections = 0;
  const auth = express();
  auth.use(express.json());
  auth.post("/auth/tenant/introspect", (_req, res) => {
    introspections++;
    res.json({
      active,
      sub: "gateway-actor",
      roles: ["tenant-admin"],
      tenantId: "http-tenant",
      exp: Math.floor(Date.now() / 1000) + 3600,
    });
  });
  authServer = auth.listen(0);
  await new Promise<void>((resolve) => authServer!.once("listening", resolve));
  const authPort = (authServer.address() as { port: number }).port;
  const reservation = createServer();
  await new Promise<void>((resolve) =>
    reservation.listen(0, "127.0.0.1", resolve),
  );
  const port = (reservation.address() as { port: number }).port;
  await new Promise<void>((resolve) => reservation.close(() => resolve()));
  let logs = "";
  gateway = spawn(
    process.execPath,
    [resolve("../service-api-gateway/dist/app.js")],
    {
      env: {
        ...process.env,
        INTERNAL_API_SECRET: secret,
        PORT: String(port),
        CONTROLLER_URL: base,
        AUTH_URL: `http://127.0.0.1:${authPort}`,
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  gateway.stdout!.on("data", (data) => {
    logs += data;
  });
  gateway.stderr!.on("data", (data) => {
    logs += data;
  });
  let ready = false;
  for (let attempt = 0; attempt < 100; attempt++) {
    try {
      ready = (await fetch(`http://127.0.0.1:${port}/healthz`)).ok;
    } catch {}
    if (ready) break;
    if (gateway.exitCode !== null) throw new Error(logs);
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  assert.ok(ready, logs);
  const send = (key: string) =>
    new Promise<{ status: number; text: () => Promise<string> }>(
      (resolve, reject) => {
        const req = request(
          {
            hostname: "127.0.0.1",
            port,
            method: "POST",
            path: "/api/v1/tenant/tasks",
            headers: {
              host: "api.local",
              authorization: "Bearer opaque-test-token",
              "content-type": "application/json",
              "idempotency-key": key,
              "x-user-id": "spoofed",
              "x-controller-identity": "spoofed",
              "x-tenant-id": "other-tenant",
            },
          },
          (response) => {
            let text = "";
            response.setEncoding("utf8");
            response.on("data", (chunk) => {
              text += chunk;
            });
            response.on("end", () =>
              resolve({
                status: response.statusCode || 0,
                text: async () => text,
              }),
            );
          },
        );
        req.on("error", reject);
        req.end(JSON.stringify(body));
      },
    );
  const accepted = await send("via-gateway");
  assert.equal(accepted.status, 202, await accepted.text());
  active = false;
  assert.equal((await send("revoked")).status, 401);
  assert.equal(introspections, 2);
});
