/**
 * Development-only scripted run of the native player, for checking it end to
 * end without clicking: with `VITE_KIRO_SPIKE_EXERCISE=1` (plus
 * `VITE_KIRO_SPIKE_AUTOPLAY=<url>`, and `KIRO_SPIKE_LOG=1` so Rust logs every
 * command and event), the player page drives track selection, an external
 * subtitle, seeking, volume and mute, then leaves and re-enters the player to
 * exercise detach / re-attach, and finally leaves for good.
 *
 * Results are read from the Rust log; the steps assume a file with at least
 * two audio and two subtitle tracks (e.g. Matroska's `test5.mkv`).
 *
 * `VITE_KIRO_SPIKE_EXERCISE=progress` plays for 25 s, pauses and leaves (for
 * checking library progress saving with `VITE_KIRO_SPIKE_MEDIA`).
 *
 * `VITE_KIRO_SPIKE_EXERCISE=fullscreen` enters fullscreen, then leaves it
 * (with `KIRO_SPIKE_LOG=1` the video layer logs each resize).
 *
 * `VITE_KIRO_SPIKE_EXERCISE=chapters` clicks Skip intro as soon as it shows,
 * then seeks near the closing credits and clicks Skip credits (for a file whose
 * chapters mark both; the Rust log shows the chapters and both seeks).
 *
 * `VITE_KIRO_SPIKE_EXERCISE=smoke` pauses once playback starts, leaving the
 * controls over the video (the CI playback check screenshots this).
 *
 * `VITE_KIRO_SPIKE_EXERCISE=awake` plays, pauses, plays, turns Settings →
 * Playback → "Keep the screen on while playing" off and on again, then leaves
 * (detach), a few seconds apart, for watching `pmset -g assertions` (the Rust
 * log shows each `keep awake` change).
 *
 * `VITE_KIRO_SPIKE_EXERCISE=timing` presses the player's keys: plays a
 * stretch at normal speed and one at 1.5× (`]`), logging the position after
 * each as a seek to where playback paused; pauses at 13.5 s, just after a
 * line of `test5.mkv`'s English subtitles ends, and shows them 2 s later
 * (`X`), which brings the line back, then earlier again (`Z`), a few seconds
 * apart for screenshots; delays the audio (`K`); slows to 0.75× (`[`) and
 * leaves. The Rust log shows each command and mpv's `timingChange` back.
 *
 * `VITE_KIRO_SPIKE_EXERCISE=discord` (with `VITE_KIRO_SPIKE_MEDIA` for a
 * title, and a build with `KIRO_DISCORD_APPLICATION_ID`) turns on Settings →
 * General → Discord, then plays, seeks, pauses, plays, hides the episode,
 * the title, turns Discord off and on again, leaves and comes back, and
 * stays playing, a few seconds apart, for checking what reaches Discord's
 * socket (the Rust log shows each change). Quitting then clears it.
 *
 * `VITE_KIRO_SPIKE_EXERCISE=streams` (with `VITE_KIRO_SPIKE_AUTOPLAY` set to a
 * dead link and `VITE_KIRO_SPIKE_MEDIA` to a title an installed addon has
 * streams for) waits while the player falls back to a stream that plays,
 * then picks another one in the Streams panel, which opens at the same
 * position, and leaves. The Rust log shows each load and its start position.
 *
 * `VITE_KIRO_SPIKE_EXERCISE=sources` instead loads a broken URL, the HLS test
 * stream, then `test5.mkv` near its end (start position, `ended`).
 */
import type { PlaybackState } from '@kiro/player-core';

import type { NativePlayer } from '@/features/playback/native-player';
import { settingsStore } from '@/features/settings/settings-store';
import type { GeneralSettings } from '@/services/native';

const MODE = import.meta.env.DEV
  ? (import.meta.env.VITE_KIRO_SPIKE_EXERCISE as string | undefined)
  : undefined;
export const DEV_EXERCISE = Boolean(MODE);

const TEST5_MKV =
  'https://github.com/ietf-wg-cellar/matroska-test-files/raw/master/test_files/test5.mkv';

const SUBTITLE_URL =
  (import.meta.env.VITE_KIRO_SPIKE_SUBTITLE as string | undefined) ??
  'https://raw.githubusercontent.com/brenopolanski/html5-video-webvtt-example/master/MIB2-subtitles-pt-BR.vtt';

/** Survives the player page unmounting, so the second visit runs a shorter round. */
let round = 0;

const sleep = (ms: number) => new Promise((resolve) => window.setTimeout(resolve, ms));

function waitForState(
  player: NativePlayer,
  wanted: PlaybackState,
  timeoutMs = 30_000,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (player.getState() === wanted) return resolve();
    const timer = window.setTimeout(
      () => reject(new Error('timed out waiting to play')),
      timeoutMs,
    );
    const off = player.on('stateChange', ({ state }) => {
      if (state !== wanted) return;
      window.clearTimeout(timer);
      off();
      resolve();
    });
  });
}

/** Each step's failure is logged by Rust; keep going so one run shows everything. */
async function step(action: () => Promise<unknown>) {
  await action().catch(() => undefined);
  await sleep(1500);
}

/**
 * CI's playback check (`scripts/playback-smoke.mjs`): once the video plays,
 * pause, so the controls stay on screen over it for a screenshot. Also run in
 * release builds started with `KIRO_SMOKE_TEST_URL`.
 */
export async function pauseOncePlaying(player: NativePlayer): Promise<void> {
  await waitForState(player, 'playing');
  await sleep(1500);
  await step(() => player.pause());
}

export async function runDevExercise(
  player: NativePlayer,
  navigate: (to: string) => unknown,
  toggleFullscreen: () => void,
): Promise<void> {
  if (MODE === 'sources') return exerciseSources(player, navigate);
  if (MODE === 'fullscreen') {
    await waitForState(player, 'playing');
    await sleep(2000);
    toggleFullscreen();
    await sleep(5000);
    toggleFullscreen();
    await sleep(4000);
    void navigate('/');
    return;
  }
  if (MODE === 'chapters') return exerciseChapters(player, navigate);
  if (MODE === 'smoke') return pauseOncePlaying(player);
  if (MODE === 'streams') return exerciseStreams(player, navigate);
  if (MODE === 'timing') return exerciseTiming(player, navigate);
  if (MODE === 'awake') {
    const keepScreenOn = (on: boolean) =>
      settingsStore.getState().updatePlayback({ keepScreenOn: on });
    await waitForState(player, 'playing');
    await sleep(8000);
    await player.pause();
    await sleep(8000);
    await player.play();
    await sleep(8000);
    await keepScreenOn(false);
    await sleep(8000);
    await keepScreenOn(true);
    await sleep(8000);
    void navigate('/');
    return;
  }
  if (MODE === 'discord') {
    const general = (patch: Partial<GeneralSettings>) =>
      settingsStore.getState().updateGeneral(patch);
    const all = { discordPresence: true, discordShowTitle: true, discordShowEpisode: true };
    round += 1;
    if (round === 1) await general(all);
    await waitForState(player, 'playing');
    await sleep(5000);
    if (round > 1) return;
    await step(() => player.seek(300));
    await sleep(5000);
    await step(() => player.pause());
    await sleep(5000);
    await step(() => player.play());
    await sleep(5000);
    await general({ discordShowEpisode: false });
    await sleep(5000);
    await general({ discordShowTitle: false });
    await sleep(5000);
    await general({ discordPresence: false });
    await sleep(5000);
    await general(all);
    await sleep(5000);
    void navigate('/');
    await sleep(5000);
    void navigate('/player');
    return;
  }
  if (MODE === 'progress') {
    await waitForState(player, 'playing');
    await sleep(25_000);
    await step(() => player.pause());
    void navigate('/');
    return;
  }
  round += 1;
  await waitForState(player, 'playing');
  await sleep(2000);

  if (round === 1) {
    await step(() => player.selectAudioTrack('2'));
    await step(() => player.selectAudioTrack('9')); // expect TRACK_NOT_FOUND
    await step(() => player.selectSubtitleTrack('2'));
    await step(() => player.selectSubtitleTrack(null));
    await step(() =>
      player.addExternalSubtitle({ url: SUBTITLE_URL, label: 'External', language: 'pt-BR' }),
    );
    await step(() => player.addExternalSubtitle({ url: 'http://insecure.example/a.srt' })); // expect INVALID_ARGUMENT
    await step(() => player.seek(20));
    await step(() => player.pause());
    await step(() => player.play());
    await step(() => player.setVolume(0.5));
    await step(() => player.setMuted(true));
    await step(() => player.setMuted(false));
    // Leave (detach) and come back (fresh attach).
    void navigate('/');
    await sleep(2000);
    void navigate('/player');
  } else {
    await step(() => player.selectAudioTrack('2'));
    void navigate('/');
  }
}

/** Clicks the skip button whose text starts with `label` once it shows. */
async function clickSkip(label: string, timeoutMs = 15_000) {
  const until = Date.now() + timeoutMs;
  while (Date.now() < until) {
    const button = [...document.querySelectorAll('button')].find((candidate) =>
      candidate.textContent.startsWith(label),
    );
    if (button) {
      button.click();
      return;
    }
    await sleep(250);
  }
  console.warn(`[dev-exercise] no "${label}" button`);
}

async function exerciseStreams(player: NativePlayer, navigate: (to: string) => unknown) {
  // The first stream fails; the player moves on by itself.
  await waitForState(player, 'playing', 60_000);
  await sleep(10_000);
  document.querySelector<HTMLButtonElement>('button[aria-label="Streams"]')?.click();
  await sleep(1000);
  const options = document.querySelectorAll<HTMLButtonElement>(
    '[role="dialog"][aria-label="Streams"] [role="radio"][aria-checked="false"]',
  );
  [...options].find((option) => !option.textContent?.includes('Didn’t play'))?.click();
  await sleep(3000);
  await waitForState(player, 'playing');
  await sleep(10_000);
  void navigate('/');
}

async function exerciseChapters(player: NativePlayer, navigate: (to: string) => unknown) {
  await waitForState(player, 'playing');
  await sleep(3000);
  await clickSkip('Skip intro');
  await sleep(3000);
  const { chapters, duration } = player.getView();
  const credits = chapters.at(-1)?.start ?? (duration ?? 10) - 10;
  await step(() => player.seek(Math.max(credits - 2, 0)));
  // Playing, so the credits are reached even if something paused playback.
  await step(() => player.play());
  await clickSkip('Skip credits');
  await sleep(4000);
  void navigate('/');
}

async function exerciseTiming(player: NativePlayer, navigate: (to: string) => unknown) {
  /** Presses `key` on the player page, as the keyboard would. */
  const press = async (key: string, times = 1) => {
    for (let i = 0; i < times; i += 1) {
      window.dispatchEvent(new KeyboardEvent('keydown', { key, bubbles: true }));
      await sleep(150);
    }
    await sleep(1500);
  };
  /** A seek to where playback is, so the Rust log shows the position. */
  const logPosition = () => step(() => player.seek(player.getView().position));
  /** Plays for a while (the step's 1.5 s and then 6 s), pauses and logs where. */
  const playStretch = async () => {
    await step(() => player.play());
    await sleep(6000);
    await step(() => player.pause());
    await logPosition();
  };

  await waitForState(player, 'playing');
  await sleep(2000);
  await step(() => player.selectSubtitleTrack('1'));
  await step(() => player.pause());
  await logPosition();
  await playStretch();
  await press(']', 2);
  await playStretch();
  await step(() => player.seek(13.5));
  await sleep(4000);
  await press('x', 20);
  await sleep(4000);
  await press('z', 20);
  await press('k', 2);
  await press('[', 3);
  await step(() => player.play());
  await sleep(3000);
  void navigate('/');
}

async function exerciseSources(player: NativePlayer, navigate: (to: string) => unknown) {
  const wait = (state: PlaybackState, timeoutMs?: number) =>
    waitForState(player, state, timeoutMs).catch(() => undefined);
  await step(() => player.load({ kind: 'network', url: 'https://repo.jellyfin.org/missing.mkv' }));
  await wait('error');
  await step(() =>
    player.load({ kind: 'network', url: 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8' }),
  );
  await wait('playing');
  await sleep(8000);
  await step(() => player.load({ kind: 'network', url: TEST5_MKV, startPosition: 40 }));
  await wait('ended', 60_000);
  await step(() => player.seek(30));
  await sleep(2000);
  void navigate('/');
}
