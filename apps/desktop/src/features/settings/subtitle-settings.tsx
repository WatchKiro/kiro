import { cx } from '@kiro/utils';
import { Check } from 'lucide-react';
import { useId } from 'react';

import { LanguageSetting } from '@/features/settings/language-setting';
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
  DEFAULT_SUBTITLE_SETTINGS,
  MAX_SUBTITLE_OFFSET,
  SUBTITLE_COLORS,
  SUBTITLE_EDGES,
  SUBTITLE_SIZE,
  SUBTITLE_TYPES,
  isHexColor,
  resetTo,
} from '@/features/settings/settings-data';
import { settingsSection } from '@/features/settings/settings-sections';
import {
  useFieldsReset,
  useSettingsEditable,
  useSettingsStore,
} from '@/features/settings/settings-store';
import { SubtitlePreview } from '@/features/settings/subtitle-preview';

const SECTION = settingsSection('subtitles');

/**
 * Which subtitles are turned on (the languages and "off by default" are
 * playback settings), and how they look, with a live preview.
 */
export function SubtitlesSection() {
  const disabled = !useSettingsEditable();
  const playback = useSettingsStore((state) => state.settings.playback);
  const subtitles = useSettingsStore((state) => state.settings.subtitles);
  const updatePlayback = useSettingsStore((state) => state.updatePlayback);
  const updateSubtitles = useSettingsStore((state) => state.updateSubtitles);
  const ids = { size: useId(), color: useId(), edge: useId(), offset: useId(), type: useId() };
  const resetPlayback = <K extends 'subtitlesOff' | 'subtitleLanguages'>(key: K) =>
    resetTo(
      playback[key],
      DEFAULT_PLAYBACK_SETTINGS[key],
      () => void updatePlayback({ [key]: DEFAULT_PLAYBACK_SETTINGS[key] }),
    );
  const resetOf = <K extends keyof typeof subtitles>(key: K) =>
    resetTo(
      subtitles[key],
      DEFAULT_SUBTITLE_SETTINGS[key],
      () => void updateSubtitles({ [key]: DEFAULT_SUBTITLE_SETTINGS[key] }),
    );

  return (
    <Section
      title={SECTION.title}
      description={SECTION.description}
      {...useFieldsReset(SECTION.fields)}
    >
      <Group title="Choosing subtitles" description="You can still switch tracks in the player.">
        <ToggleSetting
          id="subtitles-off"
          label="Subtitles off by default"
          hint="Forced subtitles, for signs and foreign dialogue, still show."
          checked={playback.subtitlesOff}
          disabled={disabled}
          onChange={(subtitlesOff) => void updatePlayback({ subtitlesOff })}
          onReset={resetPlayback('subtitlesOff')}
        />
        <LanguageSetting
          id="subtitle-languages"
          label="Subtitle languages"
          hint={
            playback.subtitlesOff
              ? 'Not used while subtitles are off by default.'
              : 'The first one a stream has is turned on. Otherwise, the stream’s default.'
          }
          languages={playback.subtitleLanguages}
          disabled={disabled || playback.subtitlesOff}
          onChange={(subtitleLanguages) => void updatePlayback({ subtitleLanguages })}
          onReset={resetPlayback('subtitleLanguages')}
        />
        <SettingRow
          id="subtitle-type"
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
      </Group>

      <Group title="Appearance">
        <SubtitlePreview subtitles={subtitles} />
        <SettingRow
          id="subtitle-size"
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
          id="subtitle-colour"
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
          id="subtitle-edge"
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
          id="subtitle-position"
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
      </Group>
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
