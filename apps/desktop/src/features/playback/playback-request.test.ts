import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  nowPlayingFor,
  parsePlaybackRequest,
  streamPlaybackRequest,
} from '@/features/playback/playback-request';

describe('parsePlaybackRequest', () => {
  it('accepts https requests and rejects anything else', () => {
    const request = { url: 'https://cdn.example/a.mp4', title: 'Movie', subtitle: 'Addon' };
    assert.deepEqual(parsePlaybackRequest(request), request);
    assert.deepEqual(parsePlaybackRequest({ url: request.url, title: 'Movie' }), {
      url: request.url,
      title: 'Movie',
    });
    for (const state of [
      null,
      'https://cdn.example/a.mp4',
      { url: 'http://cdn.example/a.mp4', title: 'Movie' },
      { url: 'file:///etc/passwd', title: 'Movie' },
      { url: 'not a url', title: 'Movie' },
      { url: request.url },
      { url: request.url, title: 'Movie', subtitle: 1 },
    ]) {
      assert.equal(parsePlaybackRequest(state), null);
    }
  });

  it('keeps the chosen stream’s label and drops a malformed one', () => {
    const base = { url: 'https://cdn.example/a.mp4', title: 'Movie' };
    const streamLabel = 'Torrentio · 4K · HDR · 18.4 GB · Cached';
    assert.deepEqual(parsePlaybackRequest({ ...base, streamLabel }), { ...base, streamLabel });
    assert.deepEqual(parsePlaybackRequest({ ...base, streamLabel: 4 }), base);
    assert.deepEqual(parsePlaybackRequest({ ...base, streamLabel: 'x'.repeat(301) }), base);
  });

  it('keeps well-formed library media and drops malformed media', () => {
    const media = {
      title: { type: 'series', id: 'tt2', name: 'Show', poster: null },
      video: { id: 'tt2:1:3', season: 1, episode: 3, name: 'Third' },
    };
    const base = { url: 'https://cdn.example/a.mp4', title: 'Show' };
    assert.deepEqual(parsePlaybackRequest({ ...base, media }), { ...base, media });
    assert.deepEqual(
      parsePlaybackRequest({
        ...base,
        media: { ...media, video: { ...media.video, season: '1' } },
      }),
      base,
    );
    assert.deepEqual(parsePlaybackRequest({ ...base, media: 'tt2' }), base);
  });

  it('keeps only https artwork', () => {
    const base = { url: 'https://cdn.example/a.mp4', title: 'Movie' };
    const artwork = { background: 'https://img.example/b.jpg', logo: 'https://img.example/l.png' };
    assert.deepEqual(parsePlaybackRequest({ ...base, artwork }), { ...base, artwork });
    assert.deepEqual(
      parsePlaybackRequest({
        ...base,
        artwork: { background: 'javascript:alert(1)', logo: 'https://img.example/l.png' },
      }),
      { ...base, artwork: { logo: 'https://img.example/l.png' } },
    );
    assert.deepEqual(
      parsePlaybackRequest({ ...base, artwork: { background: 'http://img.example/b.jpg' } }),
      base,
    );
    assert.deepEqual(parsePlaybackRequest({ ...base, artwork: 'b.jpg' }), base);
  });

  it('keeps the stream source for Up next', () => {
    const base = { url: 'https://cdn.example/a.mp4', title: 'Show' };
    const source = { addon: 'https://addon.example/manifest.json', bingeGroup: 'torbox|1080p' };
    assert.deepEqual(parsePlaybackRequest({ ...base, source }), { ...base, source });
    assert.deepEqual(
      parsePlaybackRequest({ ...base, source: { addon: source.addon, bingeGroup: 7 } }),
      { ...base, source: { addon: source.addon } },
    );
    assert.deepEqual(parsePlaybackRequest({ ...base, source: { bingeGroup: 'x' } }), base);
  });
});

describe('streamPlaybackRequest', () => {
  const addon = {
    transportUrl: 'https://addon.example/manifest.json',
    manifest: { name: 'TorBox' },
  };

  it('names the episode, the addon and the stream, and records the binge group', () => {
    const request = streamPlaybackRequest({
      url: 'https://cdn.example/e4.mkv',
      stream: { name: 'TorBox\n1080p', behaviorHints: { bingeGroup: 'torbox|1080p' } },
      addon,
      title: 'Show',
      subtitle: 'S1 E4 · Title',
    });
    assert.deepEqual(request, {
      url: 'https://cdn.example/e4.mkv',
      title: 'Show',
      subtitle: 'S1 E4 · Title — TorBox · TorBox',
      source: { addon: addon.transportUrl, bingeGroup: 'torbox|1080p' },
    });
    assert.deepEqual(parsePlaybackRequest(request), request, 'survives router state');
  });

  it('keeps the stream’s https subtitles and file details', () => {
    const request = streamPlaybackRequest({
      url: 'https://cdn.example/m.mkv',
      stream: {
        subtitles: [
          { id: '1', url: 'https://subs.example/en.srt', lang: 'eng' },
          { id: '2', url: 'https://subs.example/x.srt', lang: 'und', label: 'Commentary' },
        ],
        behaviorHints: { filename: 'Movie.2024.1080p.mkv', videoSize: 1_234_567 },
      },
      addon,
      title: 'Movie',
    });
    assert.deepEqual(request.subtitles, [
      { url: 'https://subs.example/en.srt', language: 'eng', origin: 'TorBox' },
      { url: 'https://subs.example/x.srt', label: 'Commentary', origin: 'TorBox' },
    ]);
    assert.deepEqual(request.file, { filename: 'Movie.2024.1080p.mkv', videoSize: 1_234_567 });
    assert.deepEqual(parsePlaybackRequest(request), request, 'survives router state');
  });

  it('drops subtitles and file details that do not check out from router state', () => {
    const base = { url: 'https://cdn.example/m.mkv', title: 'Movie' };
    assert.deepEqual(
      parsePlaybackRequest({
        ...base,
        subtitles: [
          { url: 'http://subs.example/en.srt', origin: 'Addon' },
          { url: 'https://subs.example/en.srt' },
          { url: 'https://subs.example/de.srt', origin: 'Addon', language: 'ger; rm -rf' },
          'garbage',
        ],
        file: { filename: 7, videoSize: -1 },
      }),
      { ...base, subtitles: [{ url: 'https://subs.example/de.srt', origin: 'Addon' }] },
    );
  });

  it('leaves out what the stream does not have', () => {
    const request = streamPlaybackRequest({
      url: 'https://cdn.example/m.mp4',
      stream: {},
      addon,
      title: 'Movie',
    });
    assert.equal(request.subtitle, 'TorBox');
    assert.deepEqual(request.source, { addon: addon.transportUrl });
  });
});

describe('nowPlayingFor', () => {
  const addon = {
    transportUrl: 'https://torrentio.example/manifest.json',
    manifest: { name: 'Torrentio' },
  };
  const episode = streamPlaybackRequest({
    url: 'https://debrid.example/dl/abc123/Breaking.Bad.S02E04.mkv',
    stream: { name: 'Torrentio\n4K', behaviorHints: { filename: 'Breaking.Bad.S02E04.mkv' } },
    addon,
    title: 'Breaking Bad',
    subtitle: 'S2 E4 · Down',
    media: {
      title: {
        type: 'series',
        id: 'tt0903747',
        name: 'Breaking Bad',
        poster: 'https://images.example/bb.jpg',
      },
      video: { id: 'tt0903747:2:4', season: 2, episode: 4, name: 'Down' },
    },
  });

  it('passes on the title, episode and poster', () => {
    assert.deepEqual(nowPlayingFor(episode), {
      title: 'Breaking Bad',
      season: 2,
      episode: 4,
      poster: 'https://images.example/bb.jpg',
    });
  });

  it('never passes on the stream, its addon or its file', () => {
    const sent = JSON.stringify(nowPlayingFor(episode));
    for (const secret of ['debrid', 'abc123', 'Torrentio', 'torrentio', '.mkv', 'S02E04']) {
      assert.ok(!sent.includes(secret), `${secret} in ${sent}`);
    }
  });

  it('keeps only https posters and sensible episode numbers', () => {
    const title = { type: 'movie', id: 'tt1', name: 'Heat', poster: 'http://images.example/h.jpg' };
    const request = {
      url: 'https://cdn.example/h.mp4',
      title: 'Heat',
      media: { title, video: { id: 'tt1', season: -1, episode: 1.5, name: null } },
    };
    assert.deepEqual(nowPlayingFor(request), {
      title: 'Heat',
      season: null,
      episode: null,
      poster: null,
    });
  });

  it('uses the request title without library details, and nothing without a request', () => {
    assert.deepEqual(nowPlayingFor({ url: 'https://cdn.example/a.mp4', title: ' Clip ' }), {
      title: 'Clip',
      season: null,
      episode: null,
      poster: null,
    });
    assert.equal(nowPlayingFor({ url: 'https://cdn.example/a.mp4', title: '  ' }), null);
    assert.equal(nowPlayingFor(null), null);
  });
});
