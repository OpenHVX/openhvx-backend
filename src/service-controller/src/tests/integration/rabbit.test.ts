import { test } from "node:test";
import assert from "node:assert/strict";
import { randomUUID } from "node:crypto";
import mongoose from "mongoose";
import { MongoMemoryReplSet } from "mongodb-memory-server";
import { connect } from "amqplib";
import Task from "../../models/Task";
import Inbox from "../../models/Inbox";
import QuotaHold from "../../models/quota/hold";
import Tenant from "../../models/Tenant";
import { holdQuota } from "../../services/quota";

test("real RabbitMQ confirms command delivery, applies duplicate results once and dead-letters invalid events", {
    skip: !process.env.AMQP_INTEGRATION_URL,
    timeout: 45000,
}, async () => {
    process.env.RMQ_URL = process.env.AMQP_INTEGRATION_URL;
    const mongo = await MongoMemoryReplSet.create({ replSet: { count: 1 }, binary: { version: "7.0.24" } });
    await mongoose.connect(mongo.getUri());
    const amqp = await import("../../services/amqp");
    const connection = await connect(process.env.RMQ_URL!);
    const channel = await connection.createConfirmChannel();
    const id = randomUUID();
    const queue = `results.integration.${id}`;
    const agentId = `integration-${id}`;
    const agentQueue = `agent.${agentId}.tasks`;
    try {
        for (const model of [Task, Inbox, QuotaHold, Tenant]) await model.init();
        await amqp.startResultsToMongo(Task, { queueName: queue });
        const tenant = await Tenant.create({ tenantId: id, name: id, quotas: { storageMB: { limit: 10000, used: 1000 } } });
        await holdQuota(tenant._id, { storageMB: 100 }, id);
        await Task.create({ taskId: id, agentId, action: "echo", tenantId: id, hasQuotaHold: true });
        await amqp.publishTask({ taskId: id, eventId: `command-${id}`, agentId, action: "echo", tenantId: id, data: {} });
        const command = await channel.get(agentQueue, { noAck: false });
        assert.ok(command);
        assert.equal(command.properties.messageId, `command-${id}`);
        channel.ack(command);
        const result = { taskId: id, eventId: `result-${id}`, agentId, action: "echo", tenantId: id, contractVersion: 1, outcome: "not_applied", ok: false };
        for (let i = 0; i < 2; i++) channel.publish("results", `task.${agentId}`, Buffer.from(JSON.stringify(result)), { persistent: true });
        channel.publish("results", `task.${agentId}`, Buffer.from('{"ok":"invalid"}'), { persistent: true });
        await channel.waitForConfirms();
        let completed = false;
        for (let attempt = 0; attempt < 100; attempt++) {
            completed = (await Task.findOne({ taskId: id }))?.status === "error" && (await channel.checkQueue(`${queue}.invalid`)).messageCount === 1;
            if (completed) break;
            await new Promise(resolve => setTimeout(resolve, 100));
        }
        assert.ok(completed);
        assert.equal(await Inbox.countDocuments({ taskId: id }), 1);
        assert.equal((await Tenant.findById(tenant._id))?.quotas.storageMB?.used, 1000);
    } finally {
        await amqp.closeAmqp();
        await channel.deleteQueue(queue);
        await channel.deleteQueue(`${queue}.invalid`);
        await channel.deleteQueue(agentQueue);
        await connection.close();
        await mongoose.disconnect();
        await mongo.stop();
    }
});
