import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { apiResponseSchema, healthDataSchema } from './api';

describe('apiResponseSchema', () => {
  const schema = apiResponseSchema(healthDataSchema);

  it('accepts a success envelope', () => {
    const parsed = schema.parse({ success: true, data: { status: 'ok', service: 'kiro-api' } });
    assert.equal(parsed.success, true);
  });

  it('accepts a failure envelope', () => {
    const parsed = schema.parse({
      success: false,
      error: { code: 'NOT_FOUND', message: 'Route not found' },
    });
    assert.equal(parsed.success, false);
  });

  it('rejects a success envelope with invalid data', () => {
    assert.equal(schema.safeParse({ success: true, data: { status: 'down' } }).success, false);
  });
});
