import { startServer, lineSignature, req, type TestServer } from './_http.ts';
import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';

let srv: TestServer;
before(async () => { srv = await startServer(); });
after(async () => { await srv.close(); });

const payload = { destination: 'x', events: [{ type: 'message', webhookEventId: 'evt-1', timestamp: 1 }] };
const raw = JSON.stringify(payload);

test('valid signature is accepted and event ingested', async () => {
  const r = await req(srv.base, 'POST', '/webhook/line', {
    body: payload,
    headers: { 'x-line-signature': lineSignature(raw) },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.ingested, 1);
});

test('duplicate event is ingested only once', async () => {
  const r = await req(srv.base, 'POST', '/webhook/line', {
    body: payload,
    headers: { 'x-line-signature': lineSignature(raw) },
  });
  assert.equal(r.status, 200);
  assert.equal(r.body.received, 1);
  assert.equal(r.body.ingested, 0); // evt-1 already stored by the previous test
});

test('invalid signature is rejected (401)', async () => {
  const r = await req(srv.base, 'POST', '/webhook/line', {
    body: payload,
    headers: { 'x-line-signature': 'deadbeef' },
  });
  assert.equal(r.status, 401);
});

test('missing signature is rejected (401)', async () => {
  const r = await req(srv.base, 'POST', '/webhook/line', { body: payload });
  assert.equal(r.status, 401);
});

test('tampered body fails signature (signature was for original)', async () => {
  const tampered = { ...payload, events: [{ type: 'message', webhookEventId: 'evt-2', timestamp: 2 }] };
  const r = await req(srv.base, 'POST', '/webhook/line', {
    body: tampered,
    headers: { 'x-line-signature': lineSignature(raw) }, // signature for the ORIGINAL raw
  });
  assert.equal(r.status, 401);
});
