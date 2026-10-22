import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseManifest, parseStreamQuality, type Stream } from '@kiro/addon-sdk';

import type { InstalledAddon } from '@/features/addons/addons-store';
import { DEFAULT_STREAM_SETTINGS } from '@/features/settings/settings-data';
import {
  describeStream,
  formatSize,
  goodEnoughToStart,
  qualityBadges,
  rankStreams,
  readyToStart,
  sensibleSize,
  rankedPlaybackRequest,
  type AddonStreams,
  type RankingOptions,
} from '@/features/title/stream-ranking';

function addon(name: string): InstalledAddon {
  const manifest = parseManifest({
    id: `org.${name.toLowerCase()}`,
    version: '1.0.0',
    name,
    types: ['movie', 'series'],
    resources: ['stream'],
  });
  assert.ok(manifest.ok);
  return {
    transportUrl: `https://${name.toLowerCase()}.example/manifest.json`,
    manifest: manifest.value,
  };
}

const ALPHA = addon('Alpha');
const BETA = addon('Beta');
const DIRECT = addon('Direct');

const OPTIONS: RankingOptions = { ...DEFAULT_STREAM_SETTINGS };

let next = 0;
function stream(name: string, title: string, extra: Partial<Stream> = {}): Stream {
  return { url: `https://cdn.example/${next++}.mkv`, name, title, ...extra };
}

/** The names of the playable streams, best first. */
function order(groups: AddonStreams[], options: Partial<RankingOptions> = {}) {
  return rankStreams(groups, { ...OPTIONS, ...options }).playable.map(
    ({ stream: ranked }) => ranked.description ?? ranked.title,
  );
}

// One addon's results for one film, in the addon's own order.
const CACHED_4K_DV = stream(
  '[XY+] Alpha\n4k DV | HDR',
  '4K DV · Sample.Film.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-GROUP\n👤 214 💾 18.4 GB',
  { behaviorHints: { bingeGroup: 'alpha|4k|DV|HDR' } },
);
const UNCACHED_4K_REMUX = stream(
  '[XY download] Alpha\n4k HDR',
  '4K remux · Sample.Film.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.HEVC.REMUX\n👤 51 💾 72.1 GB',
);
const CACHED_1080 = stream(
  '[XY+] Alpha\n1080p',
  '1080p · Sample.Film.2024.1080p.WEB-DL.DDP5.1.H.264-GROUP\n👤 402 💾 6.1 GB',
);
const CACHED_720 = stream(
  '[XY+] Alpha\n720p',
  '720p · Sample.Film.2024.720p.WEBRip.x264.AAC\n👤 90 💾 1.9 GB',
);
const CACHED_CAM = stream(
  '[XY+] Alpha\n1080p',
  'cam · Sample.Film.2024.1080p.HDCAM.x264\n💾 2.1 GB',
);
const TORRENT: Stream = {
  infoHash: 'a'.repeat(40),
  name: 'Alpha\n4k',
  title: 'torrent · Sample.Film.2160p',
};
const HTTP: Stream = { url: 'http://cdn.example/x.mkv', name: 'Plain', title: 'http · 1080p' };

const ALPHA_RESULTS: AddonStreams = {
  addon: ALPHA,
  streams: [TORRENT, CACHED_720, UNCACHED_4K_REMUX, CACHED_CAM, CACHED_1080, HTTP, CACHED_4K_DV],
};

const label = (text: string | undefined) => text?.split(' · ')[0];

describe('rankStreams', () => {
  it('puts cached streams first, then the best resolution', () => {
    assert.deepEqual(order([ALPHA_RESULTS]).map(label), [
      '4K DV',
      '1080p',
      '720p',
      'cam',
      '4K remux',
    ]);
  });

  it('keeps unplayable streams apart, with the reason, in addon order', () => {
    const { unplayable } = rankStreams([ALPHA_RESULTS], OPTIONS);
    assert.deepEqual(
      unplayable.map(({ stream: unplayed, reason }) => [label(unplayed.title), reason]),
      [
        ['torrent', 'Torrents aren’t supported'],
        ['http', 'Insecure (http) streams aren’t supported'],
      ],
    );
  });

  it('respects the maximum resolution', () => {
    assert.deepEqual(order([ALPHA_RESULTS], { maxResolution: 1080 }).map(label), [
      '1080p',
      '720p',
      '4K DV',
      'cam',
      '4K remux',
    ]);
    assert.deepEqual(order([ALPHA_RESULTS], { maxResolution: 720 }).map(label).slice(0, 3), [
      '720p',
      '1080p',
      '4K DV',
    ]);
  });

  it('ignores the cached marker when cached streams aren’t preferred', () => {
    assert.deepEqual(order([ALPHA_RESULTS], { preferCached: false }).map(label), [
      '4K DV',
      '4K remux',
      '1080p',
      '720p',
      'cam',
    ]);
  });

  it('treats streams that say nothing about caching as ready, after cached ones', () => {
    const direct = stream('Direct\n4K', 'direct · 2160p WEB-DL HDR 15 GB');
    const uncached = stream('[XY download] Alpha\n4K', 'uncached · 2160p WEB-DL HDR 15 GB');
    const cached = stream('[XY+] Alpha\n1080p', 'cached · 1080p WEB-DL 5 GB');
    assert.deepEqual(
      order([
        { addon: ALPHA, streams: [uncached, cached] },
        { addon: DIRECT, streams: [direct] },
      ]).map(label),
      ['cached', 'direct', 'uncached'],
    );
  });

  it('prefers HDR10 to Dolby Vision alone, and SDR when HDR is off', () => {
    const sdr = stream('A\n4K', 'sdr · 2160p WEB-DL 15 GB');
    const dvOnly = stream('A\n4K', 'dv · 2160p WEB-DL DV 15 GB');
    const hdr = stream('A\n4K', 'hdr · 2160p WEB-DL HDR10 15 GB');
    const groups = [{ addon: BETA, streams: [sdr, dvOnly, hdr] }];
    assert.deepEqual(order(groups).map(label), ['hdr', 'dv', 'sdr']);
    assert.deepEqual(order(groups, { preferHdr: false }).map(label), ['sdr', 'dv', 'hdr']);
  });

  it('puts implausible sizes after sensible ones at the same resolution', () => {
    // Too big and too small rank the same; the remux then wins on source.
    const fake = stream('A\n1080p', 'fake · 1080p WEB-DL 120 MB');
    const good = stream('A\n1080p', 'good · 1080p WEB-DL 4.2 GB');
    const huge = stream('A\n1080p', 'huge · 1080p BluRay REMUX 31 GB');
    assert.deepEqual(order([{ addon: BETA, streams: [fake, huge, good] }]).map(label), [
      'good',
      'huge',
      'fake',
    ]);
  });

  it('breaks ties on source, audio, codec and then size', () => {
    const web = stream('A\n1080p', 'web · 1080p WEB-DL x264 AAC 2.0 4 GB');
    const bluray = stream('A\n1080p', 'bluray · 1080p BluRay x264 AAC 2.0 4 GB');
    const atmos = stream('A\n1080p', 'atmos · 1080p WEB-DL x264 DDP5.1 Atmos 4 GB');
    const surround = stream('A\n1080p', 'surround · 1080p WEB-DL x264 DDP5.1 4 GB');
    const hevc = stream('A\n1080p', 'hevc · 1080p WEB-DL x265 AAC 2.0 4 GB');
    const bigger = stream('A\n1080p', 'bigger · 1080p WEB-DL x264 AAC 2.0 5 GB');
    assert.deepEqual(
      order([{ addon: BETA, streams: [web, bigger, hevc, surround, atmos, bluray] }]).map(label),
      ['bluray', 'atmos', 'surround', 'hevc', 'bigger', 'web'],
    );
  });

  it('puts streams in only other languages after the viewer’s', () => {
    const italian = stream('A\n4K', 'italian · 2160p 🇮🇹 HDR 15 GB');
    const multi = stream('A\n1080p', 'multi · 1080p MULTi 🇮🇹 🇬🇧 5 GB');
    const unlabelled = stream('A\n720p', 'unlabelled · 720p 2 GB');
    const groups = [{ addon: BETA, streams: [italian, multi, unlabelled] }];
    assert.deepEqual(order(groups, { languages: ['en'] }).map(label), [
      'multi',
      'unlabelled',
      'italian',
    ]);
    assert.deepEqual(order(groups, { languages: ['it'] }).map(label), [
      'italian',
      'multi',
      'unlabelled',
    ]);
    assert.deepEqual(order(groups).map(label), ['italian', 'multi', 'unlabelled']);
  });

  it('keeps addon order, then the addon’s own order, for equal streams', () => {
    const a1 = stream('X', 'a1 · 1080p');
    const a2 = stream('X', 'a2 · 1080p');
    const b1 = stream('X', 'b1 · 1080p');
    assert.deepEqual(
      order([
        { addon: ALPHA, streams: [a1, a2] },
        { addon: BETA, streams: [b1] },
      ]).map(label),
      ['a1', 'a2', 'b1'],
    );
    assert.deepEqual(
      order([
        { addon: BETA, streams: [b1] },
        { addon: ALPHA, streams: [a1, a2] },
      ]).map(label),
      ['b1', 'a1', 'a2'],
    );
  });

  it('gives the same order every time, whatever the input order of equal streams', () => {
    const groups = [ALPHA_RESULTS, { addon: BETA, streams: [CACHED_1080, CACHED_4K_DV] }];
    const first = rankStreams(groups, OPTIONS).playable.map((ranked) => ranked.url);
    for (let run = 0; run < 5; run++) {
      assert.deepEqual(
        rankStreams(groups, OPTIONS).playable.map((ranked) => ranked.url),
        first,
      );
    }
  });

  it('returns nothing playable when there is nothing to play', () => {
    const ranking = rankStreams([{ addon: ALPHA, streams: [TORRENT, HTTP] }], OPTIONS);
    assert.deepEqual(ranking.playable, []);
    assert.equal(ranking.unplayable.length, 2);
    assert.deepEqual(rankStreams([], OPTIONS), { playable: [], filtered: [], unplayable: [] });
  });
});

describe('stream filters', () => {
  /** Labels of the filtered streams, best first, with why. */
  const filtered = (options: Partial<RankingOptions>, groups = [ALPHA_RESULTS]) =>
    rankStreams(groups, { ...OPTIONS, ...options }).filtered.map(({ stream: ranked, reasons }) => [
      label(ranked.title),
      reasons.join(', '),
    ]);

  it('filters nothing by default', () => {
    assert.deepEqual(filtered({}), []);
  });

  it('moves cam releases out of the playable streams, keeping them listed', () => {
    const ranking = rankStreams([ALPHA_RESULTS], { ...OPTIONS, excludeCam: true });
    assert.deepEqual(
      ranking.playable.map((ranked) => label(ranked.stream.title)),
      ['4K DV', '1080p', '720p', '4K remux'],
    );
    assert.deepEqual(filtered({ excludeCam: true }), [['cam', 'CAM']]);
    // Unplayable streams are unaffected.
    assert.equal(ranking.unplayable.length, 2);
  });

  it('filters files over the maximum size, keeping streams of unknown size', () => {
    const unknown = stream('[XY+] Alpha\n4k', 'unknown · 2160p WEB-DL HDR');
    assert.deepEqual(
      filtered({ maxSizeGb: 10 }, [{ addon: ALPHA, streams: [...ALPHA_RESULTS.streams, unknown] }]),
      [
        ['4K DV', 'Over 10 GB'],
        ['4K remux', 'Over 10 GB'],
      ],
    );
    assert.deepEqual(filtered({ maxSizeGb: 100 }), []);
  });

  it('filters codecs to avoid', () => {
    assert.deepEqual(filtered({ avoidCodecs: ['hevc'] }), [
      ['4K DV', 'HEVC'],
      ['4K remux', 'HEVC'],
    ]);
    const av1 = stream('A\n1080p', 'av1 · 1080p WEB-DL AV1 3 GB');
    assert.deepEqual(filtered({ avoidCodecs: ['av1'] }, [{ addon: BETA, streams: [av1] }]), [
      ['av1', 'AV1'],
    ]);
  });

  it('filters keywords as whole words, ignoring case, anywhere in the stream', () => {
    const group = (title: string, hints: Stream['behaviorHints'] = {}) =>
      stream('A\n1080p', `${title} · 1080p WEB 4 GB`, { behaviorHints: hints });
    const groups = [
      {
        addon: BETA,
        streams: [
          group('tagged', { filename: 'Film.2024.1080p.WEBRip.x264-GROUP.mp4' }),
          group('hardcoded Film.2024.HC.1080p'),
          group('hcam Film.2024.HCAM'),
          group('dual Film.2024.Dual.Audio'),
        ],
      },
    ];
    assert.deepEqual(filtered({ excludedKeywords: ['group', 'HC', 'dual audio'] }, groups), [
      ['tagged', '“group”'],
      ['hardcoded Film.2024.HC.1080p', '“HC”'],
      ['dual Film.2024.Dual.Audio', '“dual audio”'],
    ]);
    // Characters with a meaning in patterns are matched literally.
    assert.deepEqual(filtered({ excludedKeywords: ['(.*)', 'x+'] }, groups), []);
  });

  it('lists every reason, and never picks a filtered stream', () => {
    const ranking = rankStreams([ALPHA_RESULTS], {
      ...OPTIONS,
      excludeCam: true,
      maxSizeGb: 1,
      avoidCodecs: ['hevc'],
      excludedKeywords: ['alpha'],
    });
    assert.deepEqual(ranking.playable, []);
    assert.deepEqual(
      ranking.filtered.map(({ stream: ranked, reasons }) => [label(ranked.title), reasons]),
      [
        ['4K DV', ['Over 1 GB', 'HEVC', '“alpha”']],
        ['1080p', ['Over 1 GB', '“alpha”']],
        ['720p', ['Over 1 GB', '“alpha”']],
        ['cam', ['CAM', 'Over 1 GB', '“alpha”']],
        ['4K remux', ['Over 1 GB', 'HEVC', '“alpha”']],
      ],
    );
    assert.equal(readyToStart(ranking, true, false, OPTIONS), true, 'settled: show the list');
  });
});

describe('the stream time budget', () => {
  const quality = (target: Stream) => ({ quality: parseStreamQuality(target) });
  const ranking = (...streams: Stream[]) => rankStreams([{ addon: BETA, streams }], OPTIONS);

  it('starts only cached streams within the maximum resolution', () => {
    assert.equal(goodEnoughToStart(quality(CACHED_4K_DV), OPTIONS), true);
    assert.equal(goodEnoughToStart(quality(CACHED_1080), OPTIONS), true);
    assert.equal(goodEnoughToStart(quality(UNCACHED_4K_REMUX), OPTIONS), false);
    assert.equal(
      goodEnoughToStart(quality(CACHED_4K_DV), { ...OPTIONS, maxResolution: 1080 }),
      false,
    );
  });

  it('never settles early for a cam, an unknown resolution or another language', () => {
    assert.equal(goodEnoughToStart(quality(CACHED_CAM), OPTIONS), false);
    const unknown = stream('[XY+] Alpha', 'unknown · Sample.Film.2024.WEB-DL 6 GB');
    assert.equal(goodEnoughToStart(quality(unknown), OPTIONS), false);
    const italian = stream('[XY+] Alpha\n1080p', 'italian · 1080p 🇮🇹 5 GB');
    assert.equal(goodEnoughToStart(quality(italian), { ...OPTIONS, languages: ['en'] }), false);
    assert.equal(goodEnoughToStart(quality(italian), { ...OPTIONS, languages: ['it'] }), true);
  });

  it('waits for every addon until the budget is spent', () => {
    assert.equal(readyToStart(ranking(CACHED_4K_DV), false, false, OPTIONS), false);
    assert.equal(readyToStart(ranking(CACHED_4K_DV), false, true, OPTIONS), true);
  });

  it('keeps waiting after the budget while nothing good has arrived', () => {
    assert.equal(readyToStart(ranking(), false, true, OPTIONS), false);
    assert.equal(readyToStart(ranking(UNCACHED_4K_REMUX, CACHED_CAM), false, true, OPTIONS), false);
  });

  it('judges the best stream so far, as Play would start it', () => {
    // The cached 1080p ranks first when 4K is over the maximum.
    const options: RankingOptions = { ...OPTIONS, maxResolution: 1080 };
    const groups = [{ addon: BETA, streams: [CACHED_4K_DV, CACHED_1080] }];
    assert.equal(readyToStart(rankStreams(groups, options), false, true, options), true);
    // Without caching preferred, the uncached remux ranks first and isn't good enough.
    const uncachedFirst = { ...OPTIONS, preferCached: false };
    const remux = rankStreams(
      [{ addon: BETA, streams: [CACHED_1080, UNCACHED_4K_REMUX] }],
      uncachedFirst,
    );
    assert.equal(readyToStart(remux, false, true, uncachedFirst), false);
  });

  it('is ready once every addon has answered, whatever arrived', () => {
    assert.equal(readyToStart(ranking(), true, false, OPTIONS), true);
    assert.equal(readyToStart(ranking(UNCACHED_4K_REMUX), true, false, OPTIONS), true);
  });
});

describe('stream labels', () => {
  it('lists badges, most important first', () => {
    assert.deepEqual(qualityBadges(parseStreamQuality(CACHED_4K_DV)), [
      '4K',
      'DV',
      'HDR',
      'Atmos',
      '18.4 GB',
    ]);
    assert.deepEqual(qualityBadges(parseStreamQuality(CACHED_CAM)), ['1080p', 'CAM', '2.1 GB']);
    assert.deepEqual(
      qualityBadges(parseStreamQuality(stream('A', 'BluRay REMUX 1080p TrueHD 7.1'))),
      ['1080p', '7.1', 'Remux'],
    );
    assert.deepEqual(qualityBadges(parseStreamQuality({ url: 'https://a.example' })), []);
  });

  it('formats sizes', () => {
    assert.equal(formatSize(18_400_000_000), '18.4 GB');
    assert.equal(formatSize(700_000_000), '700 MB');
    assert.equal(formatSize(10), '1 MB');
  });

  it('judges sizes by resolution', () => {
    assert.equal(sensibleSize(18e9, 2160), true);
    assert.equal(sensibleSize(72e9, 2160), false);
    assert.equal(sensibleSize(0.1e9, 1080), false);
    assert.equal(sensibleSize(2e9, 480), true);
    assert.equal(sensibleSize(30e9, undefined), true);
  });

  it('describes the chosen stream and builds the player request', () => {
    const [best] = rankStreams([ALPHA_RESULTS], OPTIONS).playable;
    assert.ok(best);
    assert.equal(describeStream(best), 'Alpha · 4K · DV · HDR · Atmos · 18.4 GB · Cached');
    const artwork = { background: 'https://img.example/bg.jpg' };
    assert.deepEqual(
      rankedPlaybackRequest(best, { title: 'Sample Film', subtitle: 'S1 E2', artwork }),
      {
        url: best.url,
        title: 'Sample Film',
        subtitle: 'S1 E2 — Alpha · [XY+] Alpha',
        streamLabel: 'Alpha · 4K · DV · HDR · Atmos · 18.4 GB · Cached',
        artwork,
        // Up next plays the next episode from the same addon and release.
        source: { addon: ALPHA.transportUrl, bingeGroup: 'alpha|4k|DV|HDR' },
      },
    );
  });
});
