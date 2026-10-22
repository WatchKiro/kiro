import { ArrowUp, Plus, X } from 'lucide-react';
import { useId } from 'react';

import { ChipButton, SettingRow } from '@/features/settings/settings-controls';
import { LANGUAGE_CHOICES, MAX_LANGUAGES, languageLabel } from '@/features/settings/settings-data';

/** An ordered list of languages: the first is the most preferred. */
export function LanguageSetting({
  id,
  label,
  hint,
  languages,
  disabled,
  onChange,
  onReset,
}: {
  id: string;
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
    <SettingRow
      id={id}
      label={label}
      hint={hint}
      labelId={labelId}
      disabled={disabled}
      stacked
      onReset={onReset}
    >
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
