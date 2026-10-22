import { cx } from '@kiro/utils';
import { Plus, X } from 'lucide-react';
import { useId, useState, type FormEvent } from 'react';

import {
  ChipButton,
  Disclosure,
  Group,
  Section,
  Segmented,
  SettingRow,
  ToggleSetting,
} from '@/features/settings/settings-controls';
import {
  AVOIDABLE_CODECS,
  DEFAULT_STREAM_SETTINGS,
  MAX_KEYWORDS,
  MAX_KEYWORD_CHARS,
  MAX_RESOLUTIONS,
  MAX_SIZE_CHOICES,
  areFieldsChanged,
  normalizeKeyword,
  resetTo,
} from '@/features/settings/settings-data';
import { settingsSection } from '@/features/settings/settings-sections';
import {
  useFieldsReset,
  useSettingsEditable,
  useSettingsStore,
} from '@/features/settings/settings-store';

const SECTION = settingsSection('streams');

/** The filters folded under "More filters". */
const MORE_FILTERS = { streams: ['maxSizeGb', 'avoidCodecs', 'excludedKeywords'] } as const;

/** How Play chooses a stream, and which streams it leaves out. */
export function StreamsSection() {
  const disabled = !useSettingsEditable();
  const settings = useSettingsStore((state) => state.settings);
  const updateStreams = useSettingsStore((state) => state.updateStreams);
  const streams = settings.streams;
  const defaults = DEFAULT_STREAM_SETTINGS;
  const ids = { resolution: useId(), size: useId(), codecs: useId(), keywords: useId() };
  const resetOf = <K extends keyof typeof streams>(key: K) =>
    resetTo(streams[key], defaults[key], () => void updateStreams({ [key]: defaults[key] }));

  return (
    <Section
      title={SECTION.title}
      description={SECTION.description}
      {...useFieldsReset(SECTION.fields)}
    >
      <Group title="Quality">
        <SettingRow
          id="max-resolution"
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
          id="prefer-hdr"
          label="Prefer HDR"
          hint="Pick HDR and Dolby Vision versions first. Turn off for a display without HDR."
          checked={streams.preferHdr}
          disabled={disabled}
          onChange={(preferHdr) => void updateStreams({ preferHdr })}
          onReset={resetOf('preferHdr')}
        />
        <ToggleSetting
          id="prefer-cached"
          label="Prefer cached streams"
          hint="Pick streams the addon marks as ready to start at once (cached)."
          checked={streams.preferCached}
          disabled={disabled}
          onChange={(preferCached) => void updateStreams({ preferCached })}
          onReset={resetOf('preferCached')}
        />
      </Group>

      <Group title="Filters">
        <ToggleSetting
          id="exclude-cam"
          label="Filter out cam releases"
          hint="Recordings made in a cinema: cam, telesync and screener copies."
          checked={streams.excludeCam}
          disabled={disabled}
          onChange={(excludeCam) => void updateStreams({ excludeCam })}
          onReset={resetOf('excludeCam')}
        />
        <Disclosure
          // Opens itself once the stored settings have loaded, if one is set.
          key={disabled ? 'loading' : 'ready'}
          label="More filters"
          summary="File size, codecs and keywords"
          defaultOpen={areFieldsChanged(settings, MORE_FILTERS)}
        >
          <SettingRow
            id="max-size"
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
            id="avoid-codecs"
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
        </Disclosure>
      </Group>
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
      id="excluded-keywords"
      label="Excluded keywords"
      hint="Streams that mention one of these as a whole word, in any case, are filtered out. For example, a release group or 3D."
      labelId={labelId}
      disabled={disabled}
      stacked
      onReset={onReset}
    >
      <div className="w-full max-w-md space-y-2">
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
