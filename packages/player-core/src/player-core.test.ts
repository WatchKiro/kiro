import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  createEmitter,
  resolvePlayerFactory,
  type MediaPlayerFactory,
  type MediaSource,
  type PlayerEventMap,
} from './index';

describe('createEmitter', () => {
  it('delivers events until unsubscribed', () => {
    const emitter = createEmitter<PlayerEventMap>();
    const received: number[] = [];
    const off = emitter.on('timeUpdate', ({ position }) => received.push(position));

    emitter.emit('timeUpdate', { position: 1, duration: 10 });
    off();
    emitter.emit('timeUpdate', { position: 2, duration: 10 });

    assert.deepEqual(received, [1]);
  });

  it('isolates throwing listeners', () => {
    const errors: unknown[] = [];
    const emitter = createEmitter<PlayerEventMap>({
      onListenerError: (error) => errors.push(error),
    });
    let delivered = false;

    emitter.on('ended', () => {
      throw new Error('listener failure');
    });
    emitter.on('ended', () => {
      delivered = true;
    });
    emitter.emit('ended', {});

    assert.equal(delivered, true);
    assert.equal(errors.length, 1);
  });
});

describe('resolvePlayerFactory', () => {
  const factory = (backend: 'native' | 'web', available: boolean, local: boolean) =>
    ({
      backend,
      isAvailable: () => Promise.resolve(available),
      canPlay: (source: MediaSource) => local || source.kind === 'network',
      create: () => Promise.reject(new Error('not implemented in test')),
    }) satisfies MediaPlayerFactory;

  const local: MediaSource = { kind: 'local', path: '/media/film.mkv' };
  const network: MediaSource = { kind: 'network', url: 'https://cdn.example/film.mp4' };

  it('prefers the first available backend that can play the source', async () => {
    const factories = [factory('native', true, true), factory('web', true, false)];
    assert.equal((await resolvePlayerFactory(factories, local))?.backend, 'native');
  });

  it('falls back when the preferred backend is unavailable', async () => {
    const factories = [factory('native', false, true), factory('web', true, false)];
    assert.equal((await resolvePlayerFactory(factories, network))?.backend, 'web');
    assert.equal(await resolvePlayerFactory(factories, local), null);
  });
});
