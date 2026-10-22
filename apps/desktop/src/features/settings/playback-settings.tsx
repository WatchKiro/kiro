import { useId } from 'react';

import {
  Group,
  Section,
  Segmented,
  SettingRow,
  Slider,
  ToggleSetting,
} from '@/features/settings/settings-controls';
import {
  DEFAULT_PLAYBACK_SETTINGS,
  RESUME_MODES,
  SEEK_SECONDS,
  UP_NEXT_SECONDS,
  WATCHED_PERCENT,
  resetTo,
} from '@/features/settings/settings-data';
import { settingsSection } from '@/features/settings/settings-sections';
import {
  useFieldsReset,
  useSettingsEditable,
  useSettingsStore,
} from '@/features/settings/settings-store';

const SECTION = settingsSection('playback');

/** What the player does: resuming, Up next, skipping intros, and while a video plays. */
export function PlaybackSection() {
  const disabled = !useSettingsEditable();
  const playback = useSettingsStore((state) => state.settings.playback);
  const updatePlayback = useSettingsStore((state) => state.updatePlayback);
  const defaults = DEFAULT_PLAYBACK_SETTINGS;
  const ids = {
    resume: useId(),
    upNext: useId(),
    seek: useId(),
    watched: useId(),
  };
  /** A row's reset: shown while `key` differs from its default. */
  const resetOf = <K extends keyof typeof playback>(key: K) =>
    resetTo(playback[key], defaults[key], () => void updatePlayback({ [key]: defaults[key] }));

  return (
    <Section
      title={SECTION.title}
      description={SECTION.description}
      {...useFieldsReset(SECTION.fields)}
    >
      <Group title="Resuming">
        <SettingRow
          id="resume"
          label="Resume playback"
          hint="For something you’ve started: carry on where you stopped (with a Start over option), ask each time, or always start from the beginning."
          labelId={ids.resume}
          disabled={disabled}
          onReset={resetOf('resume')}
        >
          <Segmented
            labelledBy={ids.resume}
            options={RESUME_MODES}
            value={playback.resume}
            disabled={disabled}
            onChange={(resume) => void updatePlayback({ resume })}
          />
        </SettingRow>
        <SettingRow
          id="mark-watched"
          label="Mark as watched at"
          hint="Watching this much of a video marks it watched and takes it off Continue watching. Applies to what you watch from now on; your history stays as it is."
          labelId={ids.watched}
          disabled={disabled}
          onReset={resetOf('markWatchedPercent')}
        >
          <Slider
            labelledBy={ids.watched}
            min={WATCHED_PERCENT.min}
            max={WATCHED_PERCENT.max}
            step={1}
            value={playback.markWatchedPercent}
            disabled={disabled}
            format={(percent) => `${percent}%`}
            onChange={(markWatchedPercent) => void updatePlayback({ markWatchedPercent })}
          />
        </SettingRow>
      </Group>

      <Group title="Up next">
        <ToggleSetting
          id="autoplay"
          label="Autoplay next episode"
          hint="When an episode ends, Up next counts down and plays the next one. Off: it waits for you to press Play now."
          checked={playback.autoplayNext}
          disabled={disabled}
          onChange={(autoplayNext) => void updatePlayback({ autoplayNext })}
          onReset={resetOf('autoplayNext')}
        />
        <SettingRow
          id="up-next-countdown"
          label="Up next countdown"
          hint={
            playback.autoplayNext
              ? 'How long Up next waits before playing the next episode.'
              : 'Not used while autoplay is off.'
          }
          labelId={ids.upNext}
          disabled={disabled || !playback.autoplayNext}
          onReset={resetOf('upNextSeconds')}
        >
          <Segmented
            labelledBy={ids.upNext}
            options={UP_NEXT_SECONDS.map((seconds) => ({ value: seconds, label: `${seconds} s` }))}
            value={playback.upNextSeconds}
            disabled={disabled || !playback.autoplayNext}
            onChange={(upNextSeconds) => void updatePlayback({ upNextSeconds })}
          />
        </SettingRow>
      </Group>

      <Group title="Intros and credits">
        <ToggleSetting
          id="skip-intros"
          label="Skip intros automatically"
          hint={
            playback.onlineSkipTimes
              ? 'Intros and recaps a video’s chapters mark, or SkipDB has times for. A notice lets you go back and watch.'
              : 'Intros and recaps a video’s chapters mark. A notice lets you go back and watch.'
          }
          checked={playback.skipIntros}
          disabled={disabled}
          onChange={(skipIntros) => void updatePlayback({ skipIntros })}
          onReset={resetOf('skipIntros')}
        />
        <ToggleSetting
          id="online-skip-times"
          label="Look up intro times online"
          hint="For episodes whose chapters don’t mark the intro or credits, Kiro asks SkipDB (skipdb.tv), sending the show’s IMDb id, the season and episode number and the video’s length. Contains information from SkipDB, made available under the ODbL."
          checked={playback.onlineSkipTimes}
          disabled={disabled}
          onChange={(onlineSkipTimes) => void updatePlayback({ onlineSkipTimes })}
          onReset={resetOf('onlineSkipTimes')}
        />
      </Group>

      <Group title="Player">
        <SettingRow
          id="seek"
          label="Skip interval"
          hint="How far the ← and → keys and the skip buttons jump."
          labelId={ids.seek}
          disabled={disabled}
          onReset={resetOf('seekSeconds')}
        >
          <Segmented
            labelledBy={ids.seek}
            options={SEEK_SECONDS.map((seconds) => ({ value: seconds, label: `${seconds} s` }))}
            value={playback.seekSeconds}
            disabled={disabled}
            onChange={(seekSeconds) => void updatePlayback({ seekSeconds })}
          />
        </SettingRow>
        <ToggleSetting
          id="remember-volume"
          label="Remember volume"
          hint={
            playback.rememberVolume
              ? `Each video starts at the volume you last set (${playback.volume}%).`
              : 'Each video starts at full volume.'
          }
          checked={playback.rememberVolume}
          disabled={disabled}
          onChange={(rememberVolume) => void updatePlayback({ rememberVolume })}
          onReset={resetOf('rememberVolume')}
        />
        <ToggleSetting
          id="keep-screen-on"
          label="Keep the screen on while playing"
          hint={
            playback.keepScreenOn
              ? 'The display doesn’t sleep and the screensaver doesn’t start while a video plays. Paused, they work as usual.'
              : 'The display sleeps and the screensaver starts on their usual schedule, even during a video.'
          }
          checked={playback.keepScreenOn}
          disabled={disabled}
          onChange={(keepScreenOn) => void updatePlayback({ keepScreenOn })}
          onReset={resetOf('keepScreenOn')}
        />
      </Group>
    </Section>
  );
}
