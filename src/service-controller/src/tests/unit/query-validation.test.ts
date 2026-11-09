import test from 'node:test';
import assert from 'node:assert/strict';
import express from 'express';
import { AddressInfo } from 'node:net';
import { validateListQuery } from '../../lib/schemas/resource';
import { isString, objectStrict, validate } from '../../lib/validate';

test('resource queries and path parameters accept Express 5 null-prototype objects', async () => {
  const app = express();
  app.get('/tenants/:tenantId/resources', (req, res) => {
    const query = validateListQuery(req.query);
    const params = validate(objectStrict({ tenantId: isString }), req.params);
    res.status(query.ok && params.ok ? 200 : 422).json({ query, params });
  });
  const server = app.listen(0, '127.0.0.1');
  try {
    await new Promise<void>(resolve => server.once('listening', resolve));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/tenants/lab-smoke/resources`;
    for (const suffix of ['', '?kind=vm']) {
      const response = await fetch(url + suffix);
      assert.equal(response.status, 200);
      assert.equal((await response.json() as any).params.value.tenantId, 'lab-smoke');
    }
    assert.equal((await fetch(url + '?unexpected=1')).status, 422);
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()));
  }
});

test('accepting dictionary objects does not admit arrays or class instances', () => {
  const schema = objectStrict({ name: isString });
  for (const value of [[], new Date(), new (class { name = 'value'; })()]) {
    assert.equal(validate(schema, value).ok, false);
  }
  assert.equal(validate(schema, Object.assign(Object.create(null), { name: 'value' })).ok, true);
});
