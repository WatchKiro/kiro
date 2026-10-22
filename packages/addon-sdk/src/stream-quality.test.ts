import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { parseStreamQuality, type Stream } from './index';

const URL = 'https://cdn.example/play/abc';

function quality(stream: Omit<Stream, 'url'>) {
  return parseStreamQuality({ url: URL, ...stream });
}

// Stream texts in the shapes real addons send them.
describe('parseStreamQuality: real-world streams', () => {
  it('reads a cached stream with a bracketed + tag', () => {
    assert.deepEqual(
      quality({
        name: '[XY+] Example\n4k DV | HDR',
        title:
          'Sample.Film.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-GROUP\n👤 214 💾 18.4 GB ⚙️ Example',
        behaviorHints: {
          bingeGroup: 'example|4k|DV|HDR|WEB-DL|hevc|DDP|Atmos',
          filename: 'Sample.Film.2024.2160p.WEB-DL.DDP5.1.Atmos.DV.HDR.H.265-GROUP.mkv',
        },
      }),
      {
        resolution: 2160,
        hdr: true,
        dolbyVision: true,
        codec: 'hevc',
        source: 'web',
        atmos: true,
        channels: '5.1',
        size: 18_400_000_000,
        cached: true,
        languages: [],
        multiAudio: false,
      },
    );
  });

  it('reads an uncached multi-audio stream with a download tag', () => {
    assert.deepEqual(
      quality({
        name: '[XY download] Example\n1080p',
        title:
          'Sample Film 2024 1080p BluRay x264 DTS-HD MA 7.1-GROUP\n👤 88 💾 14.2 GB ⚙️ Example\nMulti Audio / 🇬🇧 / 🇫🇷 / 🇮🇹',
      }),
      {
        resolution: 1080,
        hdr: false,
        dolbyVision: false,
        codec: 'h264',
        source: 'bluray',
        atmos: false,
        channels: '7.1',
        size: 14_200_000_000,
        cached: false,
        languages: ['en', 'fr', 'it'],
        multiAudio: true,
      },
    );
  });

  it('reads a cached remux with another service tag', () => {
    const result = quality({
      name: '[AB+] Example\n4k HDR',
      title:
        'Sample.Film.2024.UHD.BluRay.2160p.TrueHD.Atmos.7.1.HEVC.REMUX-GROUP\n👤 51 💾 72.1 GB ⚙️ Example',
    });
    assert.equal(result.resolution, 2160);
    assert.equal(result.source, 'remux');
    assert.equal(result.cached, true);
    assert.equal(result.hdr, true);
    assert.equal(result.dolbyVision, false);
    assert.equal(result.channels, '7.1');
    assert.equal(result.size, 72_100_000_000);
  });

  it('reads a stream with a lightning marker', () => {
    const result = quality({
      name: '[XY⚡] Example 1080p',
      description: 'Sample Film (2024) 1080p WEBRip x265 10bit AAC 5.1\n💾 3.2 GB 🔎 Example',
    });
    assert.equal(result.cached, true);
    assert.equal(result.resolution, 1080);
    assert.equal(result.codec, 'hevc');
    assert.equal(result.source, 'web');
    assert.equal(result.channels, '5.1');
  });

  it('reads an uncached cam with an hourglass marker', () => {
    const result = quality({
      name: 'Example | XY ⏳ 720p',
      description: '📂 Sample.Film.2024.720p.HDCAM.x264\n💾 1.4 GB 👤 12\n🔗 Example',
    });
    assert.equal(result.cached, false);
    assert.equal(result.resolution, 720);
    assert.equal(result.source, 'cam');
    assert.equal(result.size, 1_400_000_000);
  });

  it('reads a stream with labelled fields', () => {
    const result = quality({
      name: 'Example ⚡\n4K',
      description:
        'Sample.Film.2024.2160p.AMZN.WEB-DL.DDP5.1.H.265\nSize: 21.5 GB | Seeders: 120\nLanguage: English | Cached: Yes',
    });
    assert.equal(result.cached, true);
    assert.equal(result.resolution, 2160);
    assert.equal(result.source, 'web');
    assert.deepEqual(result.languages, ['en']);
    assert.equal(result.size, 21_500_000_000);
  });

  it('reads a direct-link addon that only names the quality', () => {
    const result = quality({ name: 'HTTP Streams', description: 'FHD · 2.3 GiB' });
    assert.equal(result.resolution, 1080);
    assert.equal(result.size, Math.round(2.3 * 2 ** 30));
    assert.equal(result.cached, undefined);
  });
});

describe('parseStreamQuality: leniency', () => {
  it('returns no facts for a bare stream', () => {
    assert.deepEqual(parseStreamQuality({ url: URL }), {
      hdr: false,
      dolbyVision: false,
      atmos: false,
      languages: [],
      multiAudio: false,
    });
  });

  it('prefers the addon’s label to the release name for resolution', () => {
    const result = quality({ name: 'Addon\n1080p', title: 'Movie.2160p.Downscaled' });
    assert.equal(result.resolution, 1080);
  });

  it('falls back to the release name, then the filename', () => {
    assert.equal(quality({ name: 'Addon', title: 'Movie.720p.WEB' }).resolution, 720);
    assert.equal(quality({ behaviorHints: { filename: 'Movie.2019.UHD.mkv' } }).resolution, 2160);
  });

  it('does not mistake look-alike tokens', () => {
    const result = quality({ title: 'Movie.2019.HDRip.XviD.AC3-GROUP DVDRip SDR' });
    assert.equal(result.hdr, false);
    assert.equal(result.dolbyVision, false);
    assert.equal(result.codec, 'xvid');
    assert.equal(result.source, 'dvd');
  });

  it('spots HDR10+, HLG and spelled-out Dolby Vision', () => {
    assert.equal(quality({ title: 'Show.S01E01.HDR10+.2160p' }).hdr, true);
    assert.equal(quality({ title: 'Broadcast HLG' }).hdr, true);
    assert.equal(quality({ title: 'Dolby Vision' }).dolbyVision, true);
    assert.equal(quality({ title: 'DoVi P8' }).dolbyVision, true);
  });

  it('keeps sizes and channel layouts apart', () => {
    const result = quality({ title: 'AAC 2.0 · 2.0 GB' });
    assert.equal(result.channels, '2.0');
    assert.equal(result.size, 2_000_000_000);
    assert.equal(quality({ title: '💾 5.1 GB' }).channels, undefined);
    assert.equal(quality({ title: 'TrueHD Atmos 7.1.2' }).channels, '7.1');
    assert.equal(quality({ title: 'H.264 x265' }).channels, undefined);
  });

  it('reads sizes in MB, GiB and with a decimal comma', () => {
    assert.equal(quality({ title: '700MB' }).size, 700_000_000);
    assert.equal(quality({ title: '18,4 GB' }).size, 18_400_000_000);
    assert.equal(quality({ title: '1.5 TiB' }).size, Math.round(1.5 * 2 ** 40));
  });

  it('prefers the size the addon reports in behaviorHints', () => {
    const result = quality({ title: '💾 18.4 GB', behaviorHints: { videoSize: 1_234_567_890 } });
    assert.equal(result.size, 1_234_567_890);
  });

  it('reads cached and uncached markers, uncached first', () => {
    assert.equal(quality({ name: '[AB+] Example' }).cached, true);
    assert.equal(quality({ name: '[CD download] Example' }).cached, false);
    assert.equal(quality({ description: 'Instant' }).cached, true);
    assert.equal(quality({ description: 'Cached on Example' }).cached, true);
    assert.equal(quality({ description: 'Uncached' }).cached, false);
    assert.equal(quality({ description: 'Not cached' }).cached, false);
    assert.equal(quality({ description: 'Cached: No' }).cached, false);
    assert.equal(quality({ name: 'Example [XY⬇️]' }).cached, false);
    assert.equal(quality({ name: 'Plain' }).cached, undefined);
  });

  it('reads language names and flags without duplicates', () => {
    const result = quality({ title: '🇪🇸 🇲🇽 Castellano + Latino · Dual Audio · ITA ENG' });
    assert.deepEqual(result.languages, ['es', 'en', 'it']);
    assert.equal(result.multiAudio, true);
  });

  it('ignores unknown flags and keeps working on huge text', () => {
    assert.deepEqual(quality({ title: '🇿🇿 🏴‍☠️' }).languages, []);
    const result = quality({ description: `${'x'.repeat(9_000)} 1080p` });
    assert.equal(result.resolution, 1080);
  });
});
