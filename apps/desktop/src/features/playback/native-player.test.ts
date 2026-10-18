import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { MediaTrack, PlaybackState, PlayerError } from '@kiro/player-core';

import { NativePlayer, toPlayerError } from '@/features/playback/native-player';
import { describeTrack, languageName } from '@/features/playback/track-labels';
import type { NativePlayerEvent, PlayerBridge, PlayerSnapshot } from '@/services/player';

const SNAPSHOT: PlayerSnapshot = {
  state: 'idle',
  position: 0,
  duration: null,
  buffering: false,
  tracks: [],
  chapters: [],
  audioTrackId: null,
  subtitleTrackId: null,
  volume: 1,
  muted: false,
  maxVolume: 1.3,
  subtitleDelay: 0,
  audioDelay: 0,
  speed: 1,
};

const AUDIO: MediaTrack = {
  id: '2',
  kind: 'audio',
  label: 'Commentary',
  language: 'eng',
  codec: 'aac',
  channels: 1,
};

/** A command rejection shaped like Rust's `{ code, message }`. */
function rejectWith(code: string, message: string): Promise<never> {
  return Promise.reject(Object.assign(new Error(message), { code }));
}

/** In-memory stand-in for the Rust player commands. */
function fakeBridge(snapshot: PlayerSnapshot = SNAPSHOT) {
  const calls: string[] = [];
  const done = Promise.resolve();
  const record = (call: string) => {
    calls.push(call);
    return done;
  };
  let emit: (event: NativePlayerEvent) => void = () => undefined;
  const bridge: PlayerBridge = {
    attach: async (onEvent) => {
      calls.push('attach');
      emit = onEvent;
      await Promise.resolve();
      return snapshot;
    },
    detach: async () => {
      calls.push('detach');
      await Promise.resolve();
    },
    load: (url, start) => {
      calls.push(`load ${url} ${start ?? '-'}`);
      return url.includes('bad') ? rejectWith('INVALID_ARGUMENT', 'Not a valid URL') : done;
    },
    setNowPlaying: (nowPlaying) => record(`now-playing ${nowPlaying?.title ?? null}`),
    setPaused: (paused) => record(`paused ${paused}`),
    seek: (seconds) => record(`seek ${seconds}`),
    setVolume: (volume) => record(`volume ${volume}`),
    setMuted: (muted) => record(`muted ${muted}`),
    stop: () => record('stop'),
    selectAudioTrack: (id) => {
      calls.push(`audio ${id}`);
      return id === '9' ? rejectWith('TRACK_NOT_FOUND', 'That track is not available') : done;
    },
    selectSubtitleTrack: (id) => record(`subtitle ${id}`),
    addSubtitle: ({ url, label }) => {
      calls.push(`add-subtitle ${url}`);
      return Promise.resolve({
        id: '5',
        kind: 'subtitle',
        label: label ?? 'External',
        isExternal: true,
      });
    },
    setSubtitleStyle: (style) => record(`subtitle-style ${JSON.stringify(style)}`),
    setSubtitleDelay: (seconds) => record(`subtitle-delay ${seconds}`),
    setAudioDelay: (seconds) => record(`audio-delay ${seconds}`),
    setSpeed: (speed) => record(`speed ${speed}`),
    stats: () => Promise.reject(new Error('not used')),
  };
  return { bridge, calls, emit: (event: NativePlayerEvent) => emit(event) };
}

describe('NativePlayer', () => {
  it('serialises attach and detach across StrictMode-style remounts', async () => {
    const { bridge, calls } = fakeBridge();
    // mount → unmount → mount, without awaiting in between.
    const first = NativePlayer.attach(bridge);
    const destroyed = first.destroy();
    const second = NativePlayer.attach(bridge);
    await Promise.all([destroyed, second.ready]);
    assert.deepEqual(calls, ['attach', 'detach', 'attach']);
  });

  it('starts from the snapshot and mirrors events', async () => {
    const { bridge, emit } = fakeBridge({ ...SNAPSHOT, volume: 0.8 });
    const attach = bridge.attach.bind(bridge);
    bridge.attach = (onEvent) => {
      // Delivered before the snapshot: applied after it.
      onEvent({ event: 'volumeChange', payload: { volume: 0.5, muted: true } });
      return attach(onEvent);
    };
    const player = await NativePlayer.create(bridge);
    assert.equal(player.capabilities.maxVolume, 1.3);
    assert.deepEqual([player.getView().volume, player.getView().muted], [0.5, true]);

    const states: PlaybackState[] = [];
    player.on('stateChange', ({ state }) => states.push(state));
    let renders = 0;
    player.subscribe(() => renders++);

    emit({ event: 'stateChange', payload: { state: 'playing' } });
    emit({ event: 'timeUpdate', payload: { position: 12.5, duration: 60 } });
    emit({ event: 'tracksChange', payload: { tracks: [AUDIO] } });
    emit({ event: 'trackSelect', payload: { kind: 'audio', trackId: '2' } });
    emit({ event: 'trackSelect', payload: { kind: 'subtitle', trackId: null } });
    const chapters = [{ start: 0, title: 'Opening' }, { start: 90 }];
    const reported: unknown[] = [];
    player.on('chaptersChange', (payload) => reported.push(payload.chapters));
    emit({ event: 'chaptersChange', payload: { chapters } });

    assert.deepEqual(states, ['playing']);
    assert.deepEqual(player.getView().chapters, chapters);
    assert.deepEqual(reported, [chapters]);
    assert.equal(player.getState(), 'playing');
    assert.equal(await player.getPosition(), 12.5);
    assert.equal(await player.getDuration(), 60);
    assert.deepEqual(await player.getTracks(), [AUDIO]);
    assert.equal(player.getView().audioTrackId, '2');
    assert.equal(player.getView().subtitleTrackId, null);
    assert.equal(renders, 6);
  });

  it('sends the subtitle style to the player', async () => {
    const { bridge, calls } = fakeBridge();
    const player = await NativePlayer.create(bridge);
    await player.setSubtitleStyle({ size: 120, color: '#ffe45c', edge: 'shadow', offset: 10 });
    assert.equal(
      calls.at(-1),
      'subtitle-style {"size":120,"color":"#ffe45c","edge":"shadow","offset":10}',
    );
  });

  it('sets delays and speed within range, and mirrors what the player reports', async () => {
    const { bridge, calls, emit } = fakeBridge({ ...SNAPSHOT, subtitleDelay: 0.5, speed: 1.5 });
    const player = await NativePlayer.create(bridge);
    assert.deepEqual(
      [player.getView().subtitleDelay, player.getView().audioDelay, player.getView().speed],
      [0.5, 0, 1.5],
    );

    await player.setSubtitleDelay(0.3);
    await player.setSubtitleDelay(-90);
    await player.setAudioDelay(12);
    await player.setSpeed(1.25);
    await player.setSpeed(0);
    assert.deepEqual(calls.slice(1), [
      'subtitle-delay 0.3',
      'subtitle-delay -60',
      'audio-delay 10',
      'speed 1.25',
      'speed 0.25',
    ]);

    emit({ event: 'timingChange', payload: { subtitleDelay: 0.3, audioDelay: -0.2, speed: 2 } });
    assert.deepEqual(
      [player.getView().subtitleDelay, player.getView().audioDelay, player.getView().speed],
      [0.3, -0.2, 2],
    );
  });

  it('turns failures into PlayerErrors', async () => {
    const { bridge, emit } = fakeBridge();
    const player = await NativePlayer.create(bridge);
    const errors: PlayerError[] = [];
    player.on('error', ({ error }) => errors.push(error));

    emit({
      event: 'error',
      payload: {
        error: { code: 'NETWORK', message: 'The media could not be opened', recoverable: true },
      },
    });
    assert.equal(errors[0]?.code, 'NETWORK');
    assert.equal(errors[0]?.recoverable, true);

    await assert.rejects(player.selectAudioTrack('9'), { code: 'TRACK_NOT_FOUND' });
    await assert.rejects(player.load({ kind: 'network', url: 'https://cdn.example/bad' }), {
      code: 'UNSUPPORTED_SOURCE',
      message: 'Not a valid URL',
    });
    await assert.rejects(player.load({ kind: 'local', path: '/tmp/a.mkv' }), {
      code: 'UNSUPPORTED_SOURCE',
    });
  });

  it('loads with a start position and adds external subtitles once loaded', async () => {
    const { bridge, calls, emit } = fakeBridge();
    const player = await NativePlayer.create(bridge);
    await player.load({
      kind: 'network',
      url: 'https://cdn.example/film.mkv',
      startPosition: 90,
      externalSubtitles: [{ url: 'https://subs.example/film.srt', label: 'English' }],
    });
    assert.deepEqual(calls.slice(1), ['load https://cdn.example/film.mkv 90']);

    emit({ event: 'stateChange', payload: { state: 'loading' } });
    emit({ event: 'stateChange', payload: { state: 'playing' } });
    await Promise.resolve();
    assert.deepEqual(calls.slice(2), ['add-subtitle https://subs.example/film.srt']);
  });

  it('restarts from the beginning when played after the end', async () => {
    const { bridge, calls, emit } = fakeBridge();
    const player = await NativePlayer.create(bridge);
    emit({ event: 'stateChange', payload: { state: 'ended' } });
    await player.play();
    assert.deepEqual(calls.slice(1), ['seek 0', 'paused false']);
  });

  it('clamps volume and rejects calls after destroy', async () => {
    const { bridge, calls } = fakeBridge();
    const player = await NativePlayer.create(bridge);
    await player.setVolume(5);
    await player.setVolume(-1);
    assert.deepEqual(calls.slice(1), ['volume 1.3', 'volume 0']);

    await player.destroy();
    await player.destroy();
    assert.equal(calls.filter((call) => call === 'detach').length, 1);
    await assert.rejects(player.play(), { code: 'DESTROYED' });
  });

  it('reports a missing backend as unavailable', async () => {
    const { bridge } = fakeBridge();
    bridge.attach = () => Promise.reject(new Error('Command player_attach not found'));
    await assert.rejects(NativePlayer.create(bridge), { code: 'BACKEND_UNAVAILABLE' });
    assert.equal(
      toPlayerError({ code: 'PLAYER_NOT_ATTACHED', message: 'x' }).code,
      'BACKEND_UNAVAILABLE',
    );
  });
});

describe('describeTrack', () => {
  it('names tracks by label or language, with details', () => {
    assert.deepEqual(describeTrack(AUDIO), { title: 'Commentary', detail: 'English · AAC · Mono' });
    assert.deepEqual(
      describeTrack({
        id: '3',
        kind: 'subtitle',
        language: 'ger',
        codec: 'subrip',
        isForced: true,
      }),
      { title: 'German', detail: 'SRT · Forced' },
    );
    assert.deepEqual(describeTrack({ id: '4', kind: 'subtitle' }), {
      title: 'Track 4',
      detail: '',
    });
  });

  it('falls back to the code for unknown languages', () => {
    assert.equal(languageName('pt-BR'), 'Brazilian Portuguese');
    assert.equal(languageName('qaa'), undefined);
    assert.equal(languageName('not a tag'), undefined);
    assert.equal(describeTrack({ id: '1', kind: 'audio', language: 'qaa' }).title, 'QAA');
  });
});
