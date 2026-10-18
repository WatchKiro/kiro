import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createKiroApiClient, KiroApiError } from './index';

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });
}

function clientWith(fetchImpl: typeof fetch, timeoutMs?: number) {
  return createKiroApiClient({
    baseUrl: 'http://localhost:4000/',
    fetch: fetchImpl,
    ...(timeoutMs === undefined ? {} : { timeoutMs }),
  });
}

async function rejectsWithCode(promise: Promise<unknown>, code: string) {
  await assert.rejects(promise, (error: unknown) => {
    assert.ok(error instanceof KiroApiError);
    assert.equal(error.code, code);
    return true;
  });
}

describe('createKiroApiClient', () => {
  it('requests the versioned endpoint and returns validated data', async () => {
    let requestedUrl = '';
    const client = clientWith((input) => {
      requestedUrl = input instanceof Request ? input.url : input.toString();
      return Promise.resolve(
        jsonResponse({ success: true, data: { status: 'ok', service: 'kiro-api' } }),
      );
    });

    assert.deepEqual(await client.health(), { status: 'ok', service: 'kiro-api' });
    assert.equal(requestedUrl, 'http://localhost:4000/api/v1/health');
  });

  it('surfaces API error envelopes as KiroApiError', async () => {
    const client = clientWith(() =>
      Promise.resolve(
        jsonResponse(
          { success: false, error: { code: 'NOT_FOUND', message: 'Route not found' } },
          404,
        ),
      ),
    );
    await rejectsWithCode(client.health(), 'NOT_FOUND');
  });

  it('rejects responses that do not match the contract', async () => {
    const client = clientWith(() => Promise.resolve(jsonResponse({ status: 'ok' })));
    await rejectsWithCode(client.health(), 'INVALID_RESPONSE');
  });

  it('reports network failures', async () => {
    const client = clientWith(() => Promise.reject(new TypeError('fetch failed')));
    await rejectsWithCode(client.health(), 'NETWORK_ERROR');
  });

  it('times out slow requests', async () => {
    const client = clientWith(
      (_input, init) =>
        new Promise((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => reject(new Error('aborted')));
        }),
      10,
    );
    await rejectsWithCode(client.health(), 'TIMEOUT');
  });

  it('rejects non-http base URLs', () => {
    assert.throws(() => createKiroApiClient({ baseUrl: 'file:///etc/passwd' }), TypeError);
  });
});
