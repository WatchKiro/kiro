import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  filterHistory,
  formatTimeLeft,
  formatWatchedAt,
  groupHistory,
  historyAction,
} from '@/features/library/history-data';
import { groupSeasons } from '@/features/title/title-data';

/** Local time, so day boundaries hold in any time zone. */
const at = (month: number, day: number, hour = 12, minute = 0, year = 2026) =>
  new Date(year, month - 1, day, hour, minute).getTime();

/** Saturday 17 October 2026, 09:30. */
const now = at(10, 17, 9, 30);

const month = (timestamp: number) =>
  new Intl.DateTimeFormat(undefined, { month: 'long' }).format(timestamp);

const labels = (timestamps: number[], when = now) =>
  groupHistory(
    timestamps.map((updatedAt) => ({ updatedAt })),
    when,
  ).map((group) => [group.label, group.items.length]);

describe('groupHistory', () => {
  it('splits by day at local midnight', () => {
    assert.deepEqual(
      labels([
        now,
        at(10, 17, 0, 0), // midnight today
        at(10, 16, 23, 59), // last minute of yesterday
        at(10, 16, 0, 0), // midnight yesterday
        at(10, 15, 23, 59),
        at(10, 11, 0, 0), // six days ago: still this week
      ]),
      [
        ['Today', 2],
        ['Yesterday', 2],
        ['This week', 2],
      ],
    );
  });

  it('groups older entries by month, naming the year when it differs', () => {
    const groups = groupHistory(
      [at(10, 10, 23, 59), at(10, 1), at(9, 30), at(12, 24, 12, 0, 2025)].map((updatedAt) => ({
        updatedAt,
      })),
      now,
    );
    assert.deepEqual(
      groups.map((group) => group.items.length),
      [2, 1, 1],
    );
    assert.equal(groups[0]?.label, month(at(10, 1)));
    assert.equal(groups[1]?.label, month(at(9, 30)));
    assert.match(groups[2]?.label ?? '', /2025/);
    assert.doesNotMatch(groups[0]?.label ?? '', /2026/);
  });

  it('keeps the same month of different years apart', () => {
    const groups = groupHistory(
      [at(9, 1), at(9, 1, 12, 0, 2025)].map((updatedAt) => ({ updatedAt })),
      now,
    );
    assert.equal(groups.length, 2);
  });

  it('counts a timestamp ahead of the clock as today', () => {
    assert.deepEqual(labels([now + 3_600_000]), [['Today', 1]]);
  });

  it('finds yesterday across a daylight saving change', () => {
    // Clocks change on the last Sunday of March in Europe; any zone works.
    assert.deepEqual(labels([at(3, 29, 0, 30)], at(3, 30, 12)), [['Yesterday', 1]]);
  });

  it('returns nothing for no entries', () => {
    assert.deepEqual(groupHistory([], now), []);
  });
});

const show = (name: string, episodeName: string | null) => ({
  title: { type: 'series', id: name, name, poster: null },
  video: { id: `${name}:1:1`, season: 1, episode: 1, name: episodeName },
});
const film = (name: string) => ({
  title: { type: 'movie', id: name, name, poster: null },
  video: { id: name, season: null, episode: null, name: null },
});

describe('filterHistory', () => {
  const items = [show('Shōgun', 'Anjin'), film('Inception'), show('The Bear', 'System')];
  const names = (filtered: typeof items) => filtered.map((item) => item.title.name);

  it('filters by kind', () => {
    assert.deepEqual(names(filterHistory(items, 'all', '')), ['Shōgun', 'Inception', 'The Bear']);
    assert.deepEqual(names(filterHistory(items, 'movie', '')), ['Inception']);
    assert.deepEqual(names(filterHistory(items, 'series', '')), ['Shōgun', 'The Bear']);
  });

  it('searches titles and episode names, ignoring case, accents and spaces around', () => {
    assert.deepEqual(names(filterHistory(items, 'all', '  SHOGUN ')), ['Shōgun']);
    assert.deepEqual(names(filterHistory(items, 'all', 'system')), ['The Bear']);
    assert.deepEqual(names(filterHistory(items, 'movie', 'bear')), []);
  });
});

describe('historyAction', () => {
  const seasons = groupSeasons([
    { id: 'tt2:1:1', season: 1, episode: 1 },
    { id: 'tt2:1:2', season: 1, episode: 2 },
  ]);
  const episode = (videoId: string, position: number, completed: boolean) => ({
    title: { type: 'series', id: 'tt2', name: 'Show', poster: null },
    video: { id: videoId, season: 1, episode: 1, name: null },
    position,
    completed,
  });

  it('resumes unfinished progress, or plays when barely started', () => {
    const resume = historyAction(episode('tt2:1:1', 300, false), undefined);
    assert.equal(resume.label, 'Resume');
    assert.equal(resume.href, '/title/series/tt2?episode=tt2%3A1%3A1');
    assert.equal(historyAction(episode('tt2:1:1', 5, false), undefined).label, 'Play');
  });

  it('offers the next episode after a finished one', () => {
    const next = historyAction(episode('tt2:1:1', 1300, true), seasons);
    assert.equal(next.kind, 'next');
    assert.equal(next.href, '/title/series/tt2?episode=tt2%3A1%3A2');
  });

  it('opens the title while the episodes load, or when they fail to', () => {
    for (const unknown of [undefined, null]) {
      const action = historyAction(episode('tt2:1:1', 1300, true), unknown);
      assert.deepEqual(action, { kind: 'next', label: 'Next episode', href: '/title/series/tt2' });
    }
  });

  it('watches again after the last episode or a finished film', () => {
    assert.equal(historyAction(episode('tt2:1:2', 1300, true), seasons).kind, 'again');
    assert.equal(
      historyAction({ ...film('tt1'), position: 6000, completed: true }, seasons).label,
      'Watch again',
    );
  });
});

describe('formatting', () => {
  it('says how long is left', () => {
    assert.equal(formatTimeLeft({ position: 0, duration: 45 * 60 }), '45 min left');
    assert.equal(formatTimeLeft({ position: 60, duration: 73 * 60 + 60 }), '1 hr 13 min left');
    assert.equal(formatTimeLeft({ position: 0, duration: 7200 }), '2 hr left');
    assert.equal(formatTimeLeft({ position: 100, duration: 110 }), '1 min left');
  });

  it('dates older entries, with the year when it differs', () => {
    assert.notEqual(formatWatchedAt(at(10, 16, 21), now), formatWatchedAt(at(10, 12, 21), now));
    assert.doesNotMatch(formatWatchedAt(at(9, 3), now), /2026/);
    assert.match(formatWatchedAt(at(9, 3, 12, 0, 2025), now), /2025/);
  });
});
