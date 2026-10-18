import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import { after, before, describe, it } from 'node:test';

import { createApp } from './app';
import { loadConfig } from './config/env';
import { createLogger } from './utils/logger';

describe('kiro-api', () => {
  const config = loadConfig({ NODE_ENV: 'test', CORS_ORIGINS: 'http://localhost:3000' });
  const app = createApp({ config, logger: createLogger({ level: 'silent', json: false }) });
  let server: ReturnType<typeof app.listen>;
  let baseUrl = '';

  before(async () => {
    server = app.listen(0, '127.0.0.1');
    await new Promise<void>((resolve) => server.once('listening', resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  after(() => {
    server.close();
  });

  it('GET /api/v1/health returns the health envelope', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`);

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      success: true,
      data: { status: 'ok', service: 'kiro-api' },
    });
    assert.ok(response.headers.get('x-request-id'));
    assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(response.headers.get('x-powered-by'), null);
  });

  it('returns the error envelope for unknown routes', async () => {
    const response = await fetch(`${baseUrl}/api/v1/missing`);
    const body = (await response.json()) as {
      success: boolean;
      error: { code: string; requestId: string };
    };

    assert.equal(response.status, 404);
    assert.equal(body.success, false);
    assert.equal(body.error.code, 'NOT_FOUND');
    assert.equal(body.error.requestId, response.headers.get('x-request-id'));
  });

  it('rejects malformed JSON without leaking parser details', async () => {
    const response = await fetch(`${baseUrl}/api/v1/health`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: '{"broken":',
    });
    const body = (await response.json()) as { error: { code: string; message: string } };

    assert.equal(response.status, 400);
    assert.equal(body.error.code, 'INVALID_JSON');
    assert.equal(body.error.message, 'Malformed JSON body');
  });

  it('only allows configured CORS origins', async () => {
    const allowed = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { Origin: 'http://localhost:3000' },
    });
    const denied = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { Origin: 'https://evil.example' },
    });

    assert.equal(allowed.headers.get('access-control-allow-origin'), 'http://localhost:3000');
    assert.equal(denied.headers.get('access-control-allow-origin'), null);
  });

  it('honours safe upstream request ids and replaces unsafe ones', async () => {
    const safe = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { 'X-Request-Id': 'proxy-1234abcd' },
    });
    const unsafe = await fetch(`${baseUrl}/api/v1/health`, {
      headers: { 'X-Request-Id': 'bad id\twith spaces' },
    });

    assert.equal(safe.headers.get('x-request-id'), 'proxy-1234abcd');
    assert.notEqual(unsafe.headers.get('x-request-id'), 'bad id\twith spaces');
  });
});

describe('loadConfig', () => {
  it('applies defaults', () => {
    const config = loadConfig({});
    assert.equal(config.port, 4000);
    assert.equal(config.env, 'development');
  });

  it('rejects invalid values', () => {
    assert.throws(() => loadConfig({ PORT: 'not-a-port' }), /PORT/);
    assert.throws(() => loadConfig({ CORS_ORIGINS: 'http://localhost:3000/path' }), /CORS_ORIGINS/);
  });
});
