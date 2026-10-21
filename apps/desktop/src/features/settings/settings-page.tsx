import { Button } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { ArrowUp, Check, Keyboard, Plus, X } from 'lucide-react';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { useLocation } from 'react-router';

import { Page } from '@/components/page';
import { ProfilesSection } from '@/features/profiles/profiles-section';
import { useShortcutsHelpStore } from '@/features/remote/shortcuts-store';
import { AddonsSection } from '@/features/settings/addon-settings';
import {
  ChipButton,
  Section,
  Segmented,
  SettingRow,
  Slider,
  ToggleSetting,
} from '@/features/settings/settings-controls';
import {
  AVOIDABLE_CODECS,
  DEFAULT_GENERAL_SETTINGS,
  DEFAULT_PLAYBACK_SETTINGS,
  DEFAULT_STREAM_SETTINGS,
  DEFAULT_SUBTITLE_SETTINGS,
  LANGUAGE_CHOICES,
  MAX_KEYWORDS,
  MAX_KEYWORD_CHARS,
  MAX_LANGUAGES,
  MAX_RESOLUTIONS,
  MAX_SIZE_CHOICES,
  MAX_SUBTITLE_OFFSET,
  RESUME_MODES,
  SEEK_SECONDS,
  SUBTITLE_COLORS,
  SUBTITLE_EDGES,
  SUBTITLE_SIZE,
  SUBTITLE_TYPES,
  UP_NEXT_SECONDS,
  WATCHED_PERCENT,
  isChanged,
  isHexColor,
  languageLabel,
  normalizeKeyword,
  resetTo,
} from '@/features/settings/settings-data';
import { useSettingsStore } from '@/features/settings/settings-store';
import { StremioImportSection } from '@/features/stremio-import/stremio-import-section';
import { SubtitlePreview } from '@/features/settings/subtitle-preview';
import { describeUpdate, offeredVersion, useUpdateStore } from '@/features/updates/update-store';
import { useAppInfo } from '@/hooks/use-app-info';
import { formatOs } from '@/lib/platform';
import { isNativeRuntime } from '@/services/native';

export function SettingsPage() {
  const native = isNativeRuntime();
  const status = useSettingsStore((state) => state.status);
  const error = useSettingsStore((state) => state.error);
  const load = useSettingsStore((state) => state.load);
  const { hash } = useLocation();

  useEffect(() => {
    if (native) void load();
  }, [native, load]);

  // Links such as `/settings#streams` land on their section.
  useEffect(() => {
    if (hash) document.getElementById(hash.slice(1))?.scrollIntoView({ block: 'start' });
  }, [hash]);

  return (
    <Page title="Settings" className="max-w-3xl space-y-6">
      {native ? (
        <>
          {(status === 'error' || error) && (
            <p
              role="alert"
              className="rounded-card border border-red-400/20 bg-red-500/10 px-5 py-3 text-sm text-red-200"
            >
              {status === 'error'
                ? 'Settings could not be loaded. '
                : 'Couldn’t save that change. '}
              {error}
            </p>
          )}
          <ProfilesSection />
          <GeneralSection />
          <PlaybackSection />
          <SubtitlesSection />
          <StreamsSection />
          <AddonsSection />
          <StremioImportSection />
        </>
      ) : (
        <p className="rounded-card border border-white/[0.07] bg-white/[0.025] px-5 py-4 text-sm text-ink-400">
          Settings are only available inside the desktop app.
        </p>
      )}
      <KeyboardSection />
      <AboutSection />
    </Page>
  );
}

/** Settings can be changed once they've loaded. */
function useEditable() {
  return useSettingsStore((state) => state.status === 'ready');
}

/** Kiro as a whole: its version and updates, and what it shares outside the app (Discord). */
function GeneralSection() {
  const editable = useEditable();
  const settings = useSettingsStore((state) => state.settings);
  const updateGeneral = useSettingsStore((state) => state.updateGeneral);
  const reset = useSettingsStore((state) => state.reset);
  const appInfo = useAppInfo();
  const general = settings.general;
  const defaults = DEFAULT_GENERAL_SETTINGS;
  /** Builds without a Discord application ID can't show anything. */
  const unavailable = appInfo.status === 'ready' && !appInfo.info.discordPresence;
  const resetOf = <K extends keyof typeof general>(key: K) =>
    resetTo(general[key], defaults[key], () => void updateGeneral({ [key]: defaults[key] }));

  return (
    <Section
      id="general"
      title="General"
      description="Updates, and what Kiro shares outside the app."
      onReset={() => void reset('general')}
      resetDisabled={!editable || !isChanged(settings, 'general')}
    >
      <div className="divide-y divide-white/[0.05]">
        <UpdatesSetting version={appInfo.status === 'ready' ? appInfo.info.version : null} />
        <ToggleSetting
          label="Show what I’m watching on Discord"
          hint={
            unavailable
              ? 'Not available in this build: it has no Discord application set up.'
              : general.discordPresence
                ? 'While a video plays, your Discord profile shows it and how long you’ve been watching, or that it’s paused. Only what’s chosen below is sent, never the stream or where it came from. Needs the Discord app on this computer.'
                : 'While a video plays, your Discord profile can show its title, episode and poster. Nothing is sent to Discord while this is off.'
          }
          checked={general.discordPresence}
          // Something already on can still be turned off.
          disabled={!editable || (unavailable && !general.discordPresence)}
          onChange={(discordPresence) => void updateGeneral({ discordPresence })}
          onReset={resetOf('discordPresence')}
        />
        {general.discordPresence && (
          <>
            <ToggleSetting
              label="Show the title"
              hint={
                general.discordShowTitle
                  ? 'The title and its poster.'
                  : 'Discord shows “Watching something on Kiro”, with the Kiro logo, and nothing about the video.'
              }
              checked={general.discordShowTitle}
              disabled={!editable}
              onChange={(discordShowTitle) => void updateGeneral({ discordShowTitle })}
              onReset={resetOf('discordShowTitle')}
            />
            <ToggleSetting
              label="Show the episode"
              hint={
                general.discordShowTitle
                  ? 'The season and episode after the title, such as S2 E4.'
                  : 'Only shown with the title.'
              }
              checked={general.discordShowTitle && general.discordShowEpisode}
              disabled={!editable || !general.discordShowTitle}
              onChange={(discordShowEpisode) => void updateGeneral({ discordShowEpisode })}
              onReset={resetOf('discordShowEpisode')}
            />
          </>
        )}
      </div>
    </Section>
  );
}

/**
 * The running version and Check for updates. Once a new version is
 * downloaded, the button restarts into it (or, for installs that can't update
 * themselves, opens its download page), as the sidebar's prompt does.
 */
function UpdatesSetting({ version }: { version: string | null }) {
  const labelId = useId();
  const status = useUpdateStore((state) => state.status);
  const error = useUpdateStore((state) => state.error);
  const check = useUpdateStore((state) => state.check);
  const install = useUpdateStore((state) => state.install);
  const openDownload = useUpdateStore((state) => state.openDownload);
  const offered = offeredVersion(status);
  const busy = status?.state === 'checking' || status?.state === 'downloading';

  return (
    <SettingRow
      label="Updates"
      hint="Kiro looks for a new version when it starts and once a day, and downloads it in the background. Restart when it’s ready."
      labelId={labelId}
    >
      <div className="flex flex-1 flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <div aria-live="polite" className="min-w-0">
          <p className="text-sm font-medium text-ink-100 tabular-nums">
            {version ? `Kiro ${version}` : 'Kiro'}
          </p>
          <p className="text-xs leading-relaxed text-ink-400">{error ?? describeUpdate(status)}</p>
        </div>
        {status?.state === 'ready' ? (
          <Button size="sm" onClick={() => void install()}>
            Restart to update
          </Button>
        ) : status?.state === 'available' && offered ? (
          <Button size="sm" variant="secondary" onClick={() => void openDownload()}>
            Download Kiro {offered}
          </Button>
        ) : (
          <Button
            size="sm"
            variant="secondary"
            disabled={!status || status.state === 'disabled' || busy}
            onClick={() => void check()}
          >
            {status?.state === 'downloading'
              ? 'Downloading…'
              : busy
                ? 'Checking…'
                : 'Check for updates'}
          </Button>
        )}
      </div>
    </SettingRow>
  );
}

/** What the player does: tracks, resuming, Up next, skipping and volume. */
function PlaybackSection() {
  const disabled = !useEditable();
  const settings = useSettingsStore((state) => state.settings);
  const updatePlayback = useSettingsStore((state) => state.updatePlayback);
  const reset = useSettingsStore((state) => state.reset);
  const playback = settings.playback;
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
      id="playback"
      title="Playback"
      description="Applied whenever a stream plays. You can still switch tracks in the player."
      onReset={() => void reset('playback')}
      resetDisabled={disabled || !isChanged(settings, 'playback')}
    >
      <div className="divide-y divide-white/[0.05]">
        <LanguageSetting
          label="Audio languages"
          hint="The first one a stream has is used. Otherwise, the stream’s default. Play also prefers streams in these languages."
          languages={playback.audioLanguages}
          disabled={disabled}
          onChange={(audioLanguages) => void updatePlayback({ audioLanguages })}
          onReset={resetOf('audioLanguages')}
        />
        <ToggleSetting
          label="Subtitles off by default"
          hint="Forced subtitles, for signs and foreign dialogue, still show."
          checked={playback.subtitlesOff}
          disabled={disabled}
          onChange={(subtitlesOff) => void updatePlayback({ subtitlesOff })}
          onReset={resetOf('subtitlesOff')}
        />
        <LanguageSetting
          label="Subtitle languages"
          hint={
            playback.subtitlesOff
              ? 'Not used while subtitles are off by default.'
              : 'The first one a stream has is turned on. Otherwise, the stream’s default.'
          }
          languages={playback.subtitleLanguages}
          disabled={disabled || playback.subtitlesOff}
          onChange={(subtitleLanguages) => void updatePlayback({ subtitleLanguages })}
          onReset={resetOf('subtitleLanguages')}
        />
        <ToggleSetting
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
          label="Look up intro times online"
          hint="For episodes whose chapters don’t mark the intro or credits, Kiro asks SkipDB (skipdb.tv), sending the show’s IMDb id, the season and episode number and the video’s length. Contains information from SkipDB, made available under the ODbL."
          checked={playback.onlineSkipTimes}
          disabled={disabled}
          onChange={(onlineSkipTimes) => void updatePlayback({ onlineSkipTimes })}
          onReset={resetOf('onlineSkipTimes')}
        />
        <SettingRow
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
        <ToggleSetting
          label="Autoplay next episode"
          hint="When an episode ends, Up next counts down and plays the next one. Off: it waits for you to press Play now."
          checked={playback.autoplayNext}
          disabled={disabled}
          onChange={(autoplayNext) => void updatePlayback({ autoplayNext })}
          onReset={resetOf('autoplayNext')}
        />
        <SettingRow
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
        <SettingRow
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
        <SettingRow
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
        <ToggleSetting
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
      </div>
    </Section>
  );
}

/** How subtitles look, with a live preview, and which kind is picked. */
function SubtitlesSection() {
  const disabled = !useEditable();
  const settings = useSettingsStore((state) => state.settings);
  const updateSubtitles = useSettingsStore((state) => state.updateSubtitles);
  const reset = useSettingsStore((state) => state.reset);
  const subtitles = settings.subtitles;
  const defaults = DEFAULT_SUBTITLE_SETTINGS;
  const ids = { size: useId(), color: useId(), edge: useId(), offset: useId(), type: useId() };
  const resetOf = <K extends keyof typeof subtitles>(key: K) =>
    resetTo(subtitles[key], defaults[key], () => void updateSubtitles({ [key]: defaults[key] }));

  return (
    <Section
      id="subtitles"
      title="Subtitles"
      description="How subtitles look in the player, and which ones are picked."
      onReset={() => void reset('subtitles')}
      resetDisabled={disabled || !isChanged(settings, 'subtitles')}
    >
      <SubtitlePreview subtitles={subtitles} />
      <div className="divide-y divide-white/[0.05]">
        <SettingRow
          label="Size"
          hint="Relative to the player’s usual size. Subtitles also grow with the window."
          labelId={ids.size}
          disabled={disabled}
          onReset={resetOf('size')}
        >
          <Slider
            labelledBy={ids.size}
            min={SUBTITLE_SIZE.min}
            max={SUBTITLE_SIZE.max}
            step={SUBTITLE_SIZE.step}
            value={subtitles.size}
            disabled={disabled}
            format={(size) => `${size}%`}
            onChange={(size) => void updateSubtitles({ size })}
          />
        </SettingRow>
        <SettingRow
          label="Text colour"
          hint="White reads best on most pictures; yellow stands out on bright ones."
          labelId={ids.color}
          disabled={disabled}
          onReset={resetOf('color')}
        >
          <ColorChoice
            labelledBy={ids.color}
            value={subtitles.color}
            disabled={disabled}
            onChange={(color) => void updateSubtitles({ color })}
          />
        </SettingRow>
        <SettingRow
          label="Edge"
          hint="What sets the text apart from the picture: an outline, a drop shadow or a dark box behind it."
          labelId={ids.edge}
          disabled={disabled}
          onReset={resetOf('edge')}
        >
          <Segmented
            labelledBy={ids.edge}
            options={SUBTITLE_EDGES}
            value={subtitles.edge}
            disabled={disabled}
            onChange={(edge) => void updateSubtitles({ edge })}
          />
        </SettingRow>
        <SettingRow
          label="Raise subtitles"
          hint="Move them up from the bottom, e.g. clear of a TV’s overscan or burned-in text."
          labelId={ids.offset}
          disabled={disabled}
          onReset={resetOf('offset')}
        >
          <Slider
            labelledBy={ids.offset}
            min={0}
            max={MAX_SUBTITLE_OFFSET}
            step={5}
            value={subtitles.offset}
            disabled={disabled}
            format={(offset) => (offset === 0 ? 'Off' : `${offset}%`)}
            onChange={(offset) => void updateSubtitles({ offset })}
          />
        </SettingRow>
        <SettingRow
          label="Preferred type"
          hint="When a stream has several in your language. SDH adds sound descriptions for the deaf and hard of hearing; forced only covers signs and foreign dialogue."
          labelId={ids.type}
          disabled={disabled}
          onReset={resetOf('preferredType')}
        >
          <Segmented
            labelledBy={ids.type}
            options={SUBTITLE_TYPES}
            value={subtitles.preferredType}
            disabled={disabled}
            onChange={(preferredType) => void updateSubtitles({ preferredType })}
          />
        </SettingRow>
      </div>
    </Section>
  );
}

/** Preset colours as swatches, plus a picker for any other. */
function ColorChoice({
  labelledBy,
  value,
  disabled,
  onChange,
}: {
  labelledBy: string;
  value: string;
  disabled: boolean;
  onChange: (color: string) => void;
}) {
  const preset = SUBTITLE_COLORS.some((color) => color.value === value);
  return (
    <div role="radiogroup" aria-labelledby={labelledBy} className="flex items-center gap-2">
      {SUBTITLE_COLORS.map((color) => (
        <button
          key={color.value}
          type="button"
          role="radio"
          aria-checked={color.value === value}
          aria-label={color.label}
          title={color.label}
          disabled={disabled}
          onClick={() => onChange(color.value)}
          style={{ backgroundColor: color.value }}
          className={cx(
            'flex size-7 cursor-pointer items-center justify-center rounded-full ring-offset-2 ring-offset-ink-950 transition focus-visible:focus-ring disabled:cursor-not-allowed',
            color.value === value ? 'ring-2 ring-accent' : 'ring-1 ring-white/20',
          )}
        >
          {color.value === value && <Check aria-hidden className="size-4 text-ink-950" />}
        </button>
      ))}
      <label
        className={cx(
          'relative flex h-7 cursor-pointer items-center gap-1.5 rounded-full border border-dashed px-3 text-xs text-ink-300 transition-colors focus-within:outline-2 focus-within:outline-accent hover:text-ink-50',
          preset ? 'border-white/15' : 'border-accent text-ink-50',
          disabled && 'cursor-not-allowed',
        )}
      >
        <span
          aria-hidden
          style={{ backgroundColor: preset ? undefined : value }}
          className={cx(
            'size-3 rounded-full',
            preset && 'bg-conic from-rose-400 via-lime-300 to-sky-400',
          )}
        />
        Custom
        <input
          type="color"
          value={value}
          disabled={disabled}
          aria-label="Custom colour"
          onChange={(event) => {
            const color = event.target.value.toLowerCase();
            if (isHexColor(color)) onChange(color);
          }}
          className="absolute inset-0 cursor-pointer opacity-0 disabled:cursor-not-allowed"
        />
      </label>
    </div>
  );
}

/** How Play chooses a stream, and which streams it leaves out. */
function StreamsSection() {
  const disabled = !useEditable();
  const settings = useSettingsStore((state) => state.settings);
  const updateStreams = useSettingsStore((state) => state.updateStreams);
  const reset = useSettingsStore((state) => state.reset);
  const streams = settings.streams;
  const defaults = DEFAULT_STREAM_SETTINGS;
  const ids = { resolution: useId(), size: useId(), codecs: useId(), keywords: useId() };
  const resetOf = <K extends keyof typeof streams>(key: K) =>
    resetTo(streams[key], defaults[key], () => void updateStreams({ [key]: defaults[key] }));

  return (
    <Section
      id="streams"
      title="Streams"
      description="How Play picks a stream. Streams your filters leave out are still listed, marked as filtered, so you can play one yourself."
      onReset={() => void reset('streams')}
      resetDisabled={disabled || !isChanged(settings, 'streams')}
    >
      <div className="divide-y divide-white/[0.05]">
        <SettingRow
          label="Maximum resolution"
          hint="Higher resolutions are only picked when nothing within this is available."
          labelId={ids.resolution}
          disabled={disabled}
          onReset={resetOf('maxResolution')}
        >
          <Segmented
            labelledBy={ids.resolution}
            options={MAX_RESOLUTIONS}
            value={streams.maxResolution}
            disabled={disabled}
            onChange={(maxResolution) => void updateStreams({ maxResolution })}
          />
        </SettingRow>
        <ToggleSetting
          label="Prefer HDR"
          hint="Pick HDR and Dolby Vision versions first. Turn off for a display without HDR."
          checked={streams.preferHdr}
          disabled={disabled}
          onChange={(preferHdr) => void updateStreams({ preferHdr })}
          onReset={resetOf('preferHdr')}
        />
        <ToggleSetting
          label="Prefer cached streams"
          hint="Pick streams your debrid service already has, so they start instantly."
          checked={streams.preferCached}
          disabled={disabled}
          onChange={(preferCached) => void updateStreams({ preferCached })}
          onReset={resetOf('preferCached')}
        />
        <ToggleSetting
          label="Filter out cam releases"
          hint="Recordings made in a cinema: cam, telesync and screener copies."
          checked={streams.excludeCam}
          disabled={disabled}
          onChange={(excludeCam) => void updateStreams({ excludeCam })}
          onReset={resetOf('excludeCam')}
        />
        <SettingRow
          label="Maximum file size"
          hint="Larger files are filtered out. Streams that don’t say their size are kept."
          labelId={ids.size}
          disabled={disabled}
          onReset={resetOf('maxSizeGb')}
        >
          <select
            aria-labelledby={ids.size}
            value={streams.maxSizeGb ?? ''}
            disabled={disabled}
            onChange={(event) =>
              void updateStreams({
                maxSizeGb: event.target.value === '' ? null : Number(event.target.value),
              })
            }
            className="h-8 cursor-pointer rounded-full border border-white/10 bg-white/[0.05] px-3 text-[13px] text-ink-100 transition-colors hover:border-white/20 focus-visible:focus-ring disabled:cursor-not-allowed"
          >
            {/* A size saved elsewhere that isn't offered here stays selectable. */}
            {[
              ...MAX_SIZE_CHOICES,
              ...(MAX_SIZE_CHOICES.includes(streams.maxSizeGb) ? [] : [streams.maxSizeGb]),
            ].map((size) => (
              <option key={size ?? 'none'} value={size ?? ''}>
                {size === null ? 'No limit' : `${size} GB`}
              </option>
            ))}
          </select>
        </SettingRow>
        <SettingRow
          label="Codecs to avoid"
          hint="Filter out video your device can’t play smoothly. Older Macs and TVs often lack AV1, and some lack HEVC."
          labelId={ids.codecs}
          disabled={disabled}
          onReset={resetOf('avoidCodecs')}
        >
          <div role="group" aria-labelledby={ids.codecs} className="flex flex-wrap gap-2">
            {AVOIDABLE_CODECS.map((codec) => {
              const avoided = streams.avoidCodecs.includes(codec.value);
              return (
                <button
                  key={codec.value}
                  type="button"
                  aria-pressed={avoided}
                  disabled={disabled}
                  onClick={() =>
                    void updateStreams({
                      avoidCodecs: avoided
                        ? streams.avoidCodecs.filter((value) => value !== codec.value)
                        : [...streams.avoidCodecs, codec.value],
                    })
                  }
                  className={cx(
                    'flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors focus-visible:focus-ring disabled:cursor-not-allowed',
                    avoided
                      ? 'border-accent/60 bg-accent/15 text-ink-50'
                      : 'border-white/10 text-ink-300 hover:text-ink-50',
                  )}
                >
                  {avoided && <X aria-hidden className="size-3.5" />}
                  {codec.label}
                </button>
              );
            })}
          </div>
        </SettingRow>
        <KeywordSetting
          labelId={ids.keywords}
          keywords={streams.excludedKeywords}
          disabled={disabled}
          onChange={(excludedKeywords) => void updateStreams({ excludedKeywords })}
          onReset={resetOf('excludedKeywords')}
        />
      </div>
    </Section>
  );
}

/** Words that filter a stream out, added one at a time. */
function KeywordSetting({
  labelId,
  keywords,
  disabled,
  onChange,
  onReset,
}: {
  labelId: string;
  keywords: string[];
  disabled: boolean;
  onChange: (keywords: string[]) => void;
  onReset: (() => void) | undefined;
}) {
  const [draft, setDraft] = useState('');
  const [problem, setProblem] = useState<string | null>(null);
  const problemId = useId();
  const full = keywords.length >= MAX_KEYWORDS;

  const add = (event: FormEvent) => {
    event.preventDefault();
    const keyword = normalizeKeyword(draft);
    if (!keyword) {
      setProblem(`Enter 1 to ${MAX_KEYWORD_CHARS} characters.`);
    } else if (keywords.some((other) => other.toLowerCase() === keyword.toLowerCase())) {
      setProblem(`“${keyword}” is already excluded.`);
    } else {
      onChange([...keywords, keyword]);
      setDraft('');
      setProblem(null);
    }
  };

  return (
    <SettingRow
      label="Excluded keywords"
      hint="Streams that mention one of these as a whole word, in any case, are filtered out. For example, a release group or 3D."
      labelId={labelId}
      disabled={disabled}
      onReset={onReset}
    >
      <div className="w-full space-y-2">
        {keywords.length > 0 && (
          <ul aria-labelledby={labelId} className="flex flex-wrap gap-2">
            {keywords.map((keyword) => (
              <li
                key={keyword}
                className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] py-1 pr-1 pl-3 text-[13px] text-ink-100"
              >
                {keyword}
                <ChipButton
                  label={`Stop excluding ${keyword}`}
                  disabled={disabled}
                  onClick={() => onChange(keywords.filter((other) => other !== keyword))}
                >
                  <X aria-hidden className="size-3.5" />
                </ChipButton>
              </li>
            ))}
          </ul>
        )}
        <form onSubmit={add} className="flex gap-2">
          <input
            value={draft}
            onChange={(event) => {
              setDraft(event.target.value);
              setProblem(null);
            }}
            disabled={disabled || full}
            maxLength={MAX_KEYWORD_CHARS + 10}
            placeholder={full ? 'Limit reached' : 'Add a keyword'}
            aria-label="Keyword to exclude"
            aria-invalid={problem !== null}
            aria-describedby={problem ? problemId : undefined}
            className="h-8 min-w-0 flex-1 rounded-full border border-white/10 bg-white/[0.04] px-3 text-[13px] text-ink-100 placeholder:text-ink-500 focus-visible:focus-ring disabled:cursor-not-allowed"
          />
          <button
            type="submit"
            disabled={disabled || full || draft.trim() === ''}
            className="flex h-8 cursor-pointer items-center gap-1 rounded-full bg-white/[0.08] px-3 text-[13px] font-medium text-ink-100 transition-colors hover:bg-white/[0.14] focus-visible:focus-ring disabled:cursor-not-allowed disabled:opacity-50"
          >
            <Plus aria-hidden className="size-3.5" />
            Add
          </button>
        </form>
        {problem && (
          <p id={problemId} role="alert" className="text-xs text-red-300">
            {problem}
          </p>
        )}
      </div>
    </SettingRow>
  );
}

/** The keyboard and remote control, and the shortcuts overlay (`?`). */
function KeyboardSection() {
  const showShortcuts = useShortcutsHelpStore((state) => state.setOpen);
  return (
    <Section
      id="keyboard"
      title="Keyboard and remote"
      description="Arrows move around, Enter opens and Escape goes back, from a keyboard or a remote control."
    >
      <div className="px-5 py-4">
        <Button variant="secondary" size="sm" onClick={() => showShortcuts(true)}>
          <Keyboard aria-hidden className="size-4" />
          Keyboard shortcuts
          <kbd className="ml-1 font-sans text-xs text-ink-400">?</kbd>
        </Button>
      </div>
    </Section>
  );
}

function AboutSection() {
  const appInfo = useAppInfo();

  const rows: [label: string, value: string][] =
    appInfo.status === 'ready'
      ? [
          ['Version', appInfo.info.version],
          ['Platform', `${formatOs(appInfo.info.os)} (${appInfo.info.arch})`],
          ['Tauri', appInfo.info.tauriVersion],
        ]
      : [];

  return (
    <Section id="about" title="About Kiro">
      {appInfo.status === 'ready' ? (
        <dl className="divide-y divide-white/[0.05]">
          {rows.map(([label, value]) => (
            <div key={label} className="flex items-center justify-between px-5 py-3 text-sm">
              <dt className="text-ink-400">{label}</dt>
              <dd className="font-medium text-ink-100 tabular-nums">{value}</dd>
            </div>
          ))}
        </dl>
      ) : (
        <p className="px-5 py-4 text-sm text-ink-400">
          {appInfo.status === 'loading'
            ? 'Loading…'
            : appInfo.reason === 'browser'
              ? 'Native details are only available inside the desktop app.'
              : 'Native details could not be loaded.'}
        </p>
      )}
    </Section>
  );
}

/** An ordered list of languages: the first is the most preferred. */
function LanguageSetting({
  label,
  hint,
  languages,
  disabled,
  onChange,
  onReset,
}: {
  label: string;
  hint: string;
  languages: string[];
  disabled: boolean;
  onChange: (languages: string[]) => void;
  onReset?: (() => void) | undefined;
}) {
  const labelId = useId();
  const available = LANGUAGE_CHOICES.filter((code) => !languages.includes(code)).toSorted((a, b) =>
    languageLabel(a).localeCompare(languageLabel(b)),
  );
  const full = languages.length >= MAX_LANGUAGES;

  return (
    <SettingRow label={label} hint={hint} labelId={labelId} disabled={disabled} onReset={onReset}>
      <ol aria-labelledby={labelId} className="flex flex-wrap items-center gap-2">
        {languages.length === 0 && <li className="text-sm text-ink-400">Stream default</li>}
        {languages.map((code, index) => (
          <li
            key={code}
            className="flex items-center gap-1 rounded-full border border-white/10 bg-white/[0.04] py-1 pr-1 pl-3 text-[13px] text-ink-100"
          >
            <span className="mr-1 text-ink-500 tabular-nums">{index + 1}</span>
            {languageLabel(code)}
            {index > 0 && (
              <ChipButton
                label={`Prefer ${languageLabel(code)} over ${languageLabel(languages[index - 1] ?? '')}`}
                disabled={disabled}
                onClick={() => {
                  const next = [...languages];
                  next.splice(index - 1, 2, code, languages[index - 1] ?? code);
                  onChange(next);
                }}
              >
                <ArrowUp aria-hidden className="size-3.5" />
              </ChipButton>
            )}
            <ChipButton
              label={`Remove ${languageLabel(code)}`}
              disabled={disabled}
              onClick={() => onChange(languages.filter((language) => language !== code))}
            >
              <X aria-hidden className="size-3.5" />
            </ChipButton>
          </li>
        ))}
        <li className="relative">
          <Plus
            aria-hidden
            className="pointer-events-none absolute top-1/2 left-3 size-3.5 -translate-y-1/2 text-ink-300"
          />
          <select
            aria-label={`Add ${label.toLowerCase().replace(/s$/, '')}`}
            value=""
            disabled={disabled || full}
            onChange={(event) => {
              if (event.target.value) onChange([...languages, event.target.value]);
            }}
            className="h-8 cursor-pointer appearance-none rounded-full border border-dashed border-white/15 bg-transparent pr-3 pl-8 text-[13px] text-ink-300 transition-colors hover:border-white/30 hover:text-ink-100 focus-visible:focus-ring disabled:cursor-not-allowed"
          >
            <option value="">{full ? 'Limit reached' : 'Add language'}</option>
            {available.map((code) => (
              <option key={code} value={code}>
                {languageLabel(code)}
              </option>
            ))}
          </select>
        </li>
      </ol>
    </SettingRow>
  );
}
