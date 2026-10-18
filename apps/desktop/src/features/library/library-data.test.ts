import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  continueTarget,
  entryPath,
  formatRelativeTime,
  progressFraction,
  resumePosition,
  videoLabel,
} from '@/features/library/library-data';
import { groupSeasons } from '@/features/title/title-data';
import type { HistoryEntry } from '@/services/native';

const entry: HistoryEntry = {
  title: { type: 'series', id: 'tt2', name: 'Show', poster: null },
  video: { id: 'tt2:1:3', season: 1, episode: 3, name: 'Third' },
  position: 300,
  duration: 1200,
  completed: false,
  updatedAt: 0,
};

describe('library data', () => {
  it('offers to resume only unfinished progress past the first seconds', () => {
    assert.equal(resumePosition(entry), 300);
    assert.equal(resumePosition({ ...entry, position: 10 }), null);
    assert.equal(resumePosition({ ...entry, completed: true }), null);
    assert.equal(resumePosition(undefined), null);
  });

  it('labels videos and links back to the episode', () => {
    assert.equal(videoLabel(entry.video), 'S1 E3 · Third');
    assert.equal(videoLabel({ ...entry.video, season: 0, name: null }), 'Special 3');
    assert.equal(videoLabel({ id: 'tt1', season: null, episode: null, name: null }), null);

    assert.equal(entryPath(entry), '/title/series/tt2?episode=tt2%3A1%3A3');
    const movie = {
      title: { ...entry.title, type: 'movie', id: 'tt1' },
      video: { ...entry.video, id: 'tt1' },
    };
    assert.equal(entryPath(movie), '/title/movie/tt1');
  });

  it('formats progress and relative times', () => {
    assert.equal(progressFraction(entry), 0.25);
    assert.equal(progressFraction({ position: 5, duration: 0 }), 0);
    assert.equal(progressFraction({ position: 50, duration: 10 }), 1);

    const now = Date.UTC(2026, 9, 16, 12);
    assert.equal(formatRelativeTime(now - 20_000, now), 'just now');
    assert.match(formatRelativeTime(now - 5 * 60_000, now), /5 min/);
    assert.match(formatRelativeTime(now - 26 * 3600_000, now), /yesterday/i);
  });
});

describe('continueTarget', () => {
  const seasons = groupSeasons([
    { id: 'tt2:1:1', season: 1, episode: 1 },
    { id: 'tt2:1:2', season: 1, episode: 2 },
    { id: 'tt2:1:3', season: 1, episode: 3 },
    { id: 'tt2:2:1', season: 2, episode: 1 },
  ]);
  const finished = (videoId: string): HistoryEntry => ({
    ...entry,
    video: { ...entry.video, id: videoId },
    completed: true,
  });

  it('resumes unfinished progress', () => {
    assert.deepEqual(continueTarget(entry, undefined), { kind: 'resume' });
  });

  it('offers the next episode after a finished one, across seasons', () => {
    const next = continueTarget(finished('tt2:1:2'), seasons);
    assert.equal(next.kind === 'next' && next.video.id, 'tt2:1:3');
    const nextSeason = continueTarget(finished('tt2:1:3'), seasons);
    assert.equal(nextSeason.kind === 'next' && nextSeason.video.id, 'tt2:2:1');
  });

  it('waits for the episodes, and falls back to the title if they fail to load', () => {
    assert.deepEqual(continueTarget(finished('tt2:1:2'), undefined), { kind: 'pending' });
    assert.deepEqual(continueTarget(finished('tt2:1:2'), null), { kind: 'title' });
  });

  it('has nothing to offer after the last episode or a finished film', () => {
    assert.deepEqual(continueTarget(finished('tt2:2:1'), seasons), { kind: 'done' });
    const film: HistoryEntry = {
      ...entry,
      title: { type: 'movie', id: 'tt1', name: 'Film', poster: null },
      video: { id: 'tt1', season: null, episode: null, name: null },
      completed: true,
    };
    assert.deepEqual(continueTarget(film, seasons), { kind: 'done' });
  });
});
