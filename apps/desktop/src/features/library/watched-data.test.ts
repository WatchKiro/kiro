import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import type { Video } from '@kiro/addon-sdk';

import {
  episodeMarks,
  episodesUpTo,
  isWatched,
  seasonEpisodes,
  showEpisodes,
  videosToMark,
  videosToUnmark,
  watchedState,
} from '@/features/library/watched-data';
import { groupSeasons } from '@/features/title/title-data';

function episode(season: number, number: number): Video {
  return { id: `tt1:${season}:${number}`, title: `Episode ${number}`, season, episode: number };
}

// Two seasons of three, and a special.
const seasons = groupSeasons([
  episode(0, 1),
  ...[1, 2, 3].map((number) => episode(1, number)),
  ...[1, 2, 3].map((number) => episode(2, number)),
]);

function progress(entries: [id: string, completed: boolean][]) {
  return entries.map(([id, completed]) => ({
    video: { id, season: null, episode: null, name: null },
    completed,
  }));
}

const ids = (videos: Video[]) => videos.map((video) => video.id);

describe('watched state', () => {
  it('tells watched videos from started and unplayed ones', () => {
    const saved = progress([
      ['tt1:1:1', true],
      ['tt1:1:2', false],
    ]);
    assert.equal(isWatched(saved, 'tt1:1:1'), true);
    assert.equal(isWatched(saved, 'tt1:1:2'), false);
    assert.equal(isWatched(saved, 'tt1:1:3'), false);

    const season1 = seasonEpisodes(seasons, 1);
    assert.equal(watchedState(saved, season1), 'some');
    assert.equal(watchedState(saved, seasonEpisodes(seasons, 2)), 'none');
    assert.equal(watchedState(progress(season1.map((video) => [video.id, true])), season1), 'all');
    // A started episode is progress, but not watched.
    assert.equal(watchedState(progress([['tt1:2:1', false]]), seasonEpisodes(seasons, 2)), 'some');
    assert.equal(watchedState(saved, []), 'none');
  });
});

describe('episodes a mark covers', () => {
  it('lists a whole show with specials first, so it ends on the last episode', () => {
    assert.deepEqual(ids(showEpisodes(seasons)), [
      'tt1:0:1',
      'tt1:1:1',
      'tt1:1:2',
      'tt1:1:3',
      'tt1:2:1',
      'tt1:2:2',
      'tt1:2:3',
    ]);
    const specialsOnly = groupSeasons([episode(0, 1), episode(0, 2)]);
    assert.deepEqual(ids(showEpisodes(specialsOnly)), ['tt1:0:1', 'tt1:0:2']);
  });

  it('marks up to an episode across seasons, and a special within its own', () => {
    assert.deepEqual(ids(episodesUpTo(seasons, 'tt1:2:2')), [
      'tt1:1:1',
      'tt1:1:2',
      'tt1:1:3',
      'tt1:2:1',
      'tt1:2:2',
    ]);
    assert.deepEqual(ids(episodesUpTo(seasons, 'tt1:0:1')), ['tt1:0:1']);
    assert.deepEqual(episodesUpTo(seasons, 'tt9'), []);
  });

  it('sends unwatched videos and the last one, and unmarks only what has progress', () => {
    const saved = progress([
      ['tt1:1:1', true],
      ['tt1:1:2', false],
      ['tt1:1:3', true],
    ]);
    const season1 = seasonEpisodes(seasons, 1);
    // Episode 1 keeps its date; 3 is sent to end the mark on it.
    assert.deepEqual(ids(videosToMark(saved, season1)), ['tt1:1:2', 'tt1:1:3']);
    assert.deepEqual(videosToUnmark(saved, [...season1, ...seasonEpisodes(seasons, 2)]), [
      'tt1:1:1',
      'tt1:1:2',
      'tt1:1:3',
    ]);
  });
});

describe('episodeMarks', () => {
  it('offers "up to here" only while an earlier episode is unwatched', () => {
    const none = episodeMarks(seasons, [], 'tt1:2:1');
    assert.equal(none.watched, false);
    assert.deepEqual(ids(none.upTo ?? []), ['tt1:1:1', 'tt1:1:2', 'tt1:1:3', 'tt1:2:1']);

    const caughtUp = progress([
      ['tt1:1:1', true],
      ['tt1:1:2', true],
      ['tt1:1:3', true],
    ]);
    assert.deepEqual(episodeMarks(seasons, caughtUp, 'tt1:2:1'), { watched: false, upTo: null });
    assert.deepEqual(episodeMarks(seasons, caughtUp, 'tt1:1:3'), { watched: true, upTo: null });
    // The first episode: nothing before it.
    assert.equal(episodeMarks(seasons, [], 'tt1:1:1').upTo, null);
    // Partly caught up: only the gaps, and the episode itself.
    const gap = progress([
      ['tt1:1:1', true],
      ['tt1:1:3', true],
    ]);
    assert.deepEqual(ids(episodeMarks(seasons, gap, 'tt1:2:1').upTo ?? []), ['tt1:1:2', 'tt1:2:1']);
  });
});
