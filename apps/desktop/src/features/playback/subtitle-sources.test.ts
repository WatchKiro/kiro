import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createEmitter, type MediaTrack, type PlayerEventMap } from '@kiro/player-core';

import type { AddonSubtitle } from '@/features/playback/addon-subtitles';
import { SubtitleSources, type TracksPlayer } from '@/features/playback/subtitle-sources';
import type { TrackSettings } from '@/features/playback/track-preferences';

const STREAM_TRACKS: MediaTrack[] = [
  { id: '1', kind: 'audio', language: 'eng', isDefault: true },
  { id: '1', kind: 'subtitle', language: 'spa' },
];

const sub = (language: string, n = 1): AddonSubtitle => ({
  url: `https://subs.example/${language}/${n}.srt`,
  language,
  origin: 'OpenSubtitles v3',
});

/** Imitates `NativePlayer`: adding a subtitle file selects it, as mpv's `sub-add select` does. */
function fakePlayer({ failing = [] as string[] } = {}) {
  const emitter = createEmitter<PlayerEventMap>();
  const calls: string[] = [];
  const view = {
    tracks: [] as MediaTrack[],
    audioTrackId: null as string | null,
    subtitleTrackId: null as string | null,
  };
  let pendingAdds: (() => void)[] = [];
  const player: TracksPlayer = {
    getView: () => view,
    on: (event, listener) => emitter.on(event, listener),
    selectAudioTrack: (id) => {
      calls.push(`audio ${id}`);
      view.audioTrackId = id;
      return Promise.resolve();
    },
    selectSubtitleTrack: (id) => {
      calls.push(`subtitle ${id}`);
      view.subtitleTrackId = id;
      return Promise.resolve();
    },
    addExternalSubtitle: ({ url, label, language }) => {
      calls.push(`add ${url} ${label} ${language}`);
      return new Promise((resolve, reject) => {
        pendingAdds.push(() => {
          if (failing.includes(url)) return reject(new Error('Could not load'));
          const track: MediaTrack = {
            id: String(view.tracks.length + 1),
            kind: 'subtitle',
            language,
            label,
            isExternal: true,
          };
          view.tracks = [...view.tracks, track];
          view.subtitleTrackId = track.id;
          resolve(track);
        });
      });
    },
  };
  return {
    player,
    calls,
    view,
    load(tracks = STREAM_TRACKS) {
      emitter.emit('stateChange', { state: 'loading' });
      view.tracks = tracks;
      view.audioTrackId = '1';
      emitter.emit('tracksChange', { tracks });
      emitter.emit('stateChange', { state: 'playing' });
    },
    /** Finishes the file downloads asked for so far. */
    async finishAdds() {
      const adds = pendingAdds;
      pendingAdds = [];
      for (const finish of adds) finish();
      await settle();
    },
  };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

function sources(
  fake: ReturnType<typeof fakePlayer>,
  playback: Partial<TrackSettings>,
  streamSubtitles: AddonSubtitle[] = [],
) {
  const settings: TrackSettings = {
    audioLanguages: [],
    subtitleLanguages: [],
    subtitlesOff: false,
    ...playback,
  };
  const instance = new SubtitleSources(
    fake.player,
    () => Promise.resolve(settings),
    streamSubtitles,
  );
  instance.connect();
  return instance;
}

describe('SubtitleSources', () => {
  it('adds nothing before the stream has loaded', async () => {
    const fake = fakePlayer();
    const subtitles = sources(fake, { subtitleLanguages: ['de'] });
    subtitles.add([sub('ger')]);
    await settle();
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(subtitles.getState().subtitles, [sub('ger')]);

    fake.load();
    await settle();
    assert.deepEqual(fake.calls, [
      'add https://subs.example/ger/1.srt German · OpenSubtitles v3 ger',
    ]);
    await fake.finishAdds();
    assert.deepEqual(subtitles.getState().loaded, { 'https://subs.example/ger/1.srt': '3' });
    assert.equal(fake.view.subtitleTrackId, '3');
  });

  it('picks a preferred addon subtitle that arrives after loading', async () => {
    const fake = fakePlayer();
    const subtitles = sources(fake, { subtitleLanguages: ['de', 'es'] });
    fake.load();
    await settle();
    assert.deepEqual(fake.calls, ['subtitle 1'], 'Spanish from the stream to start with');

    subtitles.add([sub('fre'), sub('ger')]);
    await settle();
    await fake.finishAdds();
    assert.equal(
      fake.calls.at(-1),
      'add https://subs.example/ger/1.srt German · OpenSubtitles v3 ger',
    );
    assert.equal(fake.view.subtitleTrackId, '3');

    // Nothing better can arrive now.
    subtitles.add([sub('ger', 2), sub('spa')]);
    await settle();
    assert.equal(fake.calls.length, 2);
  });

  it('includes the stream’s own subtitles', async () => {
    const fake = fakePlayer();
    sources(fake, { subtitleLanguages: ['de'] }, [{ ...sub('ger'), origin: 'TorBox' }]);
    fake.load();
    await settle();
    assert.deepEqual(fake.calls, ['add https://subs.example/ger/1.srt German · TorBox ger']);
  });

  it('respects subtitles off by default', async () => {
    const fake = fakePlayer();
    const subtitles = sources(fake, { subtitlesOff: true, subtitleLanguages: ['de'] });
    fake.load();
    subtitles.add([sub('ger')]);
    await settle();
    assert.deepEqual(fake.calls, []);
  });

  it('tries the next file after one fails to load', async () => {
    const fake = fakePlayer({ failing: ['https://subs.example/ger/1.srt'] });
    const subtitles = sources(fake, { subtitleLanguages: ['de'] });
    fake.load();
    subtitles.add([sub('ger', 1), sub('ger', 2)]);
    await settle();
    await fake.finishAdds();
    await fake.finishAdds();
    assert.deepEqual(subtitles.getState().failed, ['https://subs.example/ger/1.srt']);
    assert.deepEqual(subtitles.getState().loaded, { 'https://subs.example/ger/2.srt': '3' });
  });

  it('stops choosing once the user picks, and keeps their pick', async () => {
    const fake = fakePlayer();
    const subtitles = sources(fake, { subtitleLanguages: ['de'] });
    fake.load();
    subtitles.add([sub('ger')]);
    await settle();
    // The automatic download is still running when the user turns subtitles off.
    await subtitles.pickTrack(null);
    await fake.finishAdds();
    assert.equal(fake.view.subtitleTrackId, null, 'Off is put back');

    subtitles.add([sub('ger', 2)]);
    await settle();
    assert.equal(fake.calls.filter((call) => call.startsWith('add')).length, 1);
  });

  it('loads a picked file once, then switches to it', async () => {
    const fake = fakePlayer();
    const subtitles = sources(fake, {});
    fake.load();
    subtitles.add([sub('fre')]);
    const picked = subtitles.pick(sub('fre'));
    await settle();
    assert.deepEqual(subtitles.getState().loading, ['https://subs.example/fre/1.srt']);
    await fake.finishAdds();
    await picked;
    assert.deepEqual(subtitles.getState().loading, []);

    await subtitles.pickTrack(null);
    await subtitles.pick(sub('fre'));
    assert.deepEqual(fake.calls.slice(-2), ['subtitle null', 'subtitle 3']);
  });

  it('cancels its addon requests', async () => {
    const fake = fakePlayer();
    const subtitles = sources(fake, {});
    let aborted = false;
    const cancel = subtitles.search(
      [
        {
          transportUrl: 'https://subs.example/manifest.json',
          manifest: {
            id: 'subs',
            version: '1.0.0',
            name: 'Subs',
            types: ['movie'],
            resources: ['subtitles'],
            catalogs: [],
          },
        },
      ],
      { resource: 'subtitles', type: 'movie', id: 'tt1' },
      (_url, _request, { signal }) =>
        new Promise((_resolve, reject) =>
          signal.addEventListener('abort', () => {
            aborted = true;
            reject(new Error('cancelled'));
          }),
        ),
    );
    assert.equal(subtitles.getState().searching, true);
    cancel();
    await settle();
    assert.equal(aborted, true);
    assert.equal(subtitles.getState().searching, false);
  });
});
