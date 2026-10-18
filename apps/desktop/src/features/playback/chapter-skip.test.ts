import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Chapter } from '@kiro/player-core';

import {
  classifyChapterTitle,
  creditsStart,
  describeChapters,
  externalSkipSegments,
  isPlausible,
  segmentAt,
  skipSegments,
  type SkipSegment,
} from '@/features/playback/chapter-skip';

/** Chapters from `[start, title]` pairs. */
function chapters(...list: [number, string?][]): Chapter[] {
  return list.map(([start, title]) => (title === undefined ? { start } : { start, title }));
}

describe('classifyChapterTitle', () => {
  it('recognises intros and recaps', () => {
    for (const title of [
      'Intro',
      'Opening',
      'OP',
      'OP1',
      'OP 2',
      'Opening Credits',
      'Opening Theme',
      'Main Titles',
      '[Opening]',
      'Opening: Kaikai Kitan',
      'OP - Shinzou wo Sasageyo!',
      '02. Opening',
      'Chapter 2 - Intro',
      'Vorspann',
      'Générique de début',
      'Abertura',
      'Czołówka',
      'Опенинг',
      'オープニング',
      '片头',
      '오프닝',
    ]) {
      assert.equal(classifyChapterTitle(title), 'intro', title);
    }
    for (const title of [
      'Recap',
      'Previously',
      'Previously On',
      'Previously on Breaking Bad',
      'Previously on: The Expanse',
      'Last time on Dragon Ball Z',
      'The Story So Far',
      'Was bisher geschah',
      'Précédemment',
      'Anteriormente en La Casa de Papel',
      'Nelle puntate precedenti',
      'Ранее в сериале',
      '前回のあらすじ',
    ]) {
      assert.equal(classifyChapterTitle(title), 'recap', title);
    }
  });

  it('recognises credits and previews', () => {
    for (const title of [
      'Credits',
      'End Credits',
      'Ending Credits',
      'Closing Credits',
      'Ending',
      'ED',
      'ED2',
      'Ending - Song name',
      'Outro',
      'Abspann',
      'Générique de fin',
      'Créditos finales',
      'Titoli di coda',
      'Aftiteling',
      'Napisy końcowe',
      'Титры',
      'エンディング',
      '片尾',
      '엔딩',
    ]) {
      assert.equal(classifyChapterTitle(title), 'credits', title);
    }
    for (const title of ['Preview', 'Next Episode Preview', 'Next Time', 'Vorschau', '次回予告']) {
      assert.equal(classifyChapterTitle(title), 'preview', title);
    }
    assert.equal(classifyChapterTitle('Générique'), 'either');
  });

  it('leaves everything else alone', () => {
    for (const title of [
      undefined,
      '',
      'Chapter 1',
      'Chapter 01',
      '00:00:00.000',
      'Part A',
      'Avant',
      'Prologue',
      'Cold Open',
      'Introduction',
      'Opening Night',
      'The Opening of the Box',
      'Post-credits scene',
      'Mid-credits scene',
      'Pre-credits',
      'Happy Ending',
      'Endgame',
      'Ed and Lorraine',
      'Episode',
      'Eyecatch',
      'The End',
      'Recapture',
    ]) {
      assert.equal(classifyChapterTitle(title), undefined, String(title));
    }
  });
});

describe('skipSegments', () => {
  it('finds an anime episode’s opening, ending and preview', () => {
    const segments = skipSegments(
      chapters(
        [0, 'Avant'],
        [95, 'Opening'],
        [185, 'Part A'],
        [720, 'Part B'],
        [1290, 'Ending'],
        [1380, 'Preview'],
      ),
      1420,
    );
    assert.deepEqual(segments, [
      { kind: 'intro', start: 95, end: 185 },
      { kind: 'credits', start: 1290, end: 1420 },
    ]);
    assert.equal(creditsStart(segments, 1420), 1290);
  });

  it('skips a recap and the intro after it together', () => {
    assert.deepEqual(
      skipSegments(
        chapters([0, 'Previously on'], [62, 'Intro'], [120, 'Episode'], [2700, 'Credits']),
        2760,
      ),
      [
        { kind: 'intro', start: 0, end: 120 },
        { kind: 'credits', start: 2700, end: 2760 },
      ],
    );
    assert.deepEqual(skipSegments(chapters([0, 'Recap'], [80, 'Episode']), 2760), [
      { kind: 'recap', start: 0, end: 80 },
    ]);
  });

  it('places the theme by where it plays', () => {
    assert.deepEqual(
      skipSegments(chapters([0, 'Générique'], [60, 'Épisode'], [1500, 'Générique']), 1560),
      [
        { kind: 'intro', start: 0, end: 60 },
        { kind: 'credits', start: 1500, end: 1560 },
      ],
    );
  });

  it('keeps a post-credits scene: the credits do not run to the end', () => {
    const segments = skipSegments(
      chapters([0, 'Movie'], [7200, 'End Credits'], [7700, 'Post-credits scene']),
      7800,
    );
    assert.deepEqual(segments, [{ kind: 'credits', start: 7200, end: 7700 }]);
    assert.equal(creditsStart(segments, 7800), null);
  });

  it('is conservative', () => {
    // No duration, a single chapter, nothing named.
    assert.deepEqual(skipSegments(chapters([0, 'Intro'], [60, 'Episode']), null), []);
    assert.deepEqual(skipSegments(chapters([0, 'Intro']), 1400), []);
    assert.deepEqual(skipSegments(chapters([0, 'Chapter 1'], [300, 'Chapter 2']), 1400), []);
    // Too short, too long, or in the wrong half.
    assert.deepEqual(skipSegments(chapters([0, 'Intro'], [2, 'Episode']), 1400), []);
    assert.deepEqual(skipSegments(chapters([0, 'Intro'], [600, 'Episode']), 2400), []);
    assert.deepEqual(skipSegments(chapters([0, 'Episode'], [1000, 'Opening'], [1100]), 1400), []);
    assert.deepEqual(skipSegments(chapters([0, 'Credits'], [60, 'Episode']), 1400), []);
    assert.deepEqual(skipSegments(chapters([0, 'Episode'], [700, 'Credits']), 1400), []);
    // Chapters past the end are ignored.
    assert.deepEqual(skipSegments(chapters([0, 'Episode'], [1500, 'Credits']), 1400), []);
  });
});

describe('segmentAt', () => {
  const segments: SkipSegment[] = [
    { kind: 'intro', start: 95, end: 185 },
    { kind: 'credits', start: 1290, end: 1420 },
  ];

  it('finds the part playback is in', () => {
    assert.equal(segmentAt(segments, 0), undefined);
    assert.equal(segmentAt(segments, 94.9), undefined);
    assert.equal(segmentAt(segments, 95), segments[0]);
    assert.equal(segmentAt(segments, 150), segments[0]);
    assert.equal(segmentAt(segments, 600), undefined);
    assert.equal(segmentAt(segments, 1300), segments[1]);
  });

  it('lets go just before the end, where a skip lands', () => {
    assert.equal(segmentAt(segments, 184.5), undefined);
    assert.equal(segmentAt(segments, 185), undefined);
    assert.equal(segmentAt(segments, 1419.5), undefined);
  });

  it('has nothing to offer without parts', () => {
    assert.equal(segmentAt([], 10), undefined);
    assert.equal(creditsStart([], 1400), null);
    assert.equal(creditsStart([{ kind: 'intro', start: 0, end: 60 }], 1400), null);
  });
});

describe('describeChapters', () => {
  it('says when a file has no chapters, or none naming an intro or credits', () => {
    assert.equal(describeChapters(0, []), 'none in this file');
    assert.equal(describeChapters(1, []), '1 chapter · no intro or credits named');
    assert.equal(describeChapters(12, []), '12 chapters · no intro or credits named');
  });

  it('lists the parts that can be skipped', () => {
    const segments = skipSegments(
      chapters([0, 'Previously on'], [20, 'Opening'], [50, 'Episode'], [200, 'End Credits']),
      240,
    );
    assert.equal(describeChapters(4, segments), '4 chapters · intro 0:00–0:50, credits 3:20–4:00');
  });

  it('names the online source and what it found', () => {
    const intro: SkipSegment[] = [{ kind: 'intro', start: 73.5, end: 90 }];
    const source = 'SkipDB';
    assert.equal(
      describeChapters(0, intro, { state: 'found', source }),
      'no chapters · intro 1:13–1:30 (SkipDB)',
    );
    assert.equal(
      describeChapters(12, intro, { state: 'found', source }),
      '12 chapters · intro 1:13–1:30 (SkipDB)',
    );
    assert.equal(
      describeChapters(6, intro, { state: 'found', source, offset: 10.4 }),
      '6 chapters · intro 1:13–1:30 (SkipDB, 10 s longer cut)',
    );
    assert.equal(
      describeChapters(0, intro, { state: 'found', source, offset: -8 }),
      'no chapters · intro 1:13–1:30 (SkipDB, 8 s shorter cut)',
    );
    assert.equal(
      describeChapters(0, intro, { state: 'found', source, offset: 0.3 }),
      'no chapters · intro 1:13–1:30 (SkipDB)',
    );
    assert.equal(
      describeChapters(0, [], { state: 'looking', source }),
      'no chapters · looking up on SkipDB',
    );
    assert.equal(
      describeChapters(0, [], { state: 'none', source, otherReleases: false }),
      'no chapters · nothing on SkipDB',
    );
    assert.equal(
      describeChapters(3, [], { state: 'none', source, otherReleases: true }),
      '3 chapters · SkipDB has other releases only',
    );
    assert.equal(
      describeChapters(6, [], {
        state: 'none',
        source,
        otherReleases: true,
        otherLengths: [1368],
        fileLength: 1333.4,
      }),
      '6 chapters · SkipDB has a 22:48 cut (this file 22:13)',
    );
    assert.equal(
      describeChapters(0, [], {
        state: 'none',
        source,
        otherReleases: true,
        otherLengths: [1330, 1368],
        fileLength: 1400,
      }),
      'no chapters · SkipDB has 22:10, 22:48 cuts (this file 23:20)',
    );
    assert.equal(
      describeChapters(0, [], { state: 'failed', source }),
      'no chapters · SkipDB unavailable',
    );
  });
});

describe('isPlausible', () => {
  it('holds every part to the chapter rules', () => {
    for (const [segment, expected] of [
      [{ kind: 'intro', start: 73.5, end: 90 }, true],
      [{ kind: 'recap', start: 0, end: 59 }, true],
      [{ kind: 'credits', start: 2800, end: 2853 }, true],
      // Too short, too long, or in the wrong half.
      [{ kind: 'intro', start: 10, end: 14 }, false],
      [{ kind: 'intro', start: 0, end: 301 }, false],
      [{ kind: 'intro', start: 1500, end: 1560 }, false],
      [{ kind: 'credits', start: 600, end: 700 }, false],
      // Outside the file.
      [{ kind: 'recap', start: -5, end: 50 }, false],
      [{ kind: 'credits', start: 2800, end: 2900 }, false],
      [{ kind: 'intro', start: Number.NaN, end: 90 }, false],
    ] as [SkipSegment, boolean][]) {
      assert.equal(isPlausible(segment, 2853), expected, JSON.stringify(segment));
    }
  });
});

describe('externalSkipSegments', () => {
  it('orders parts and joins those that touch on the same side', () => {
    assert.deepEqual(
      externalSkipSegments(
        [
          { kind: 'credits', start: 2800, end: 2840 },
          { kind: 'intro', start: 55, end: 90 },
          { kind: 'recap', start: 0, end: 55 },
          { kind: 'preview', start: 2840, end: 2853 },
        ],
        2853,
      ),
      [
        { kind: 'intro', start: 0, end: 90 },
        { kind: 'credits', start: 2800, end: 2853 },
      ],
    );
  });

  it('keeps parts apart when there is a gap, and drops implausible ones', () => {
    assert.deepEqual(
      externalSkipSegments(
        [
          { kind: 'recap', start: 0, end: 50 },
          { kind: 'intro', start: 447.8, end: 461.4 },
          // In the second half.
          { kind: 'intro', start: 2000, end: 2060 },
        ],
        3700,
      ),
      [
        { kind: 'recap', start: 0, end: 50 },
        { kind: 'intro', start: 447.8, end: 461.4 },
      ],
    );
  });

  it('needs a duration', () => {
    assert.deepEqual(externalSkipSegments([{ kind: 'intro', start: 0, end: 60 }], null), []);
  });

  it('leaves its input alone', () => {
    const parts: SkipSegment[] = [
      { kind: 'recap', start: 0, end: 50 },
      { kind: 'intro', start: 50, end: 90 },
    ];
    externalSkipSegments(parts, 2853);
    assert.deepEqual(parts[0], { kind: 'recap', start: 0, end: 50 });
  });
});
