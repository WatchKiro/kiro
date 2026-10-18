import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { cancellable } from '@/services/cancellable';

/** A command that settles only when told to, recording cancellations. */
function fakeCommand() {
  const started: string[] = [];
  const cancelled: string[] = [];
  let settle: (value: string) => void = () => undefined;
  return {
    started,
    cancelled,
    start: (requestId: string) => {
      started.push(requestId);
      return new Promise<string>((resolve) => (settle = resolve));
    },
    cancel: (requestId: string) => {
      cancelled.push(requestId);
      return Promise.resolve(true);
    },
    settle: (value: string) => settle(value),
  };
}

describe('cancellable', () => {
  it('resolves with the command result and does not cancel it', async () => {
    const command = fakeCommand();
    const result = cancellable(new AbortController().signal, command.start, command.cancel);
    command.settle('done');
    assert.equal(await result, 'done');
    assert.equal(command.started.length, 1);
    assert.deepEqual(command.cancelled, []);
  });

  it('rejects on abort and cancels the command by its request id', async () => {
    const command = fakeCommand();
    const controller = new AbortController();
    const result = cancellable(controller.signal, command.start, command.cancel);
    controller.abort();
    await assert.rejects(result, { name: 'AbortError' });
    assert.deepEqual(command.cancelled, command.started);
    assert.match(command.started[0] ?? '', /^[0-9a-f-]{36}$/);
  });

  it('does not start a command when the signal is already aborted', async () => {
    const command = fakeCommand();
    await assert.rejects(cancellable(AbortSignal.abort(), command.start, command.cancel), {
      name: 'AbortError',
    });
    assert.deepEqual(command.started, []);
  });

  it('gives each request its own id', () => {
    const command = fakeCommand();
    const { signal } = new AbortController();
    void cancellable(signal, command.start, command.cancel);
    void cancellable(signal, command.start, command.cancel);
    assert.equal(new Set(command.started).size, 2);
  });
});
