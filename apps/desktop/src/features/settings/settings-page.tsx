import { cx } from '@kiro/utils';
import {
  ChevronRight,
  Download,
  Info,
  Play,
  Puzzle,
  Search,
  Settings2,
  Subtitles,
  Users,
  Volume2,
  Waves,
  X,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ComponentType,
  type KeyboardEvent,
} from 'react';
import { Link, Navigate, useLocation, useParams } from 'react-router';

import { Page } from '@/components/page';
import { ProfilesSection } from '@/features/profiles/profiles-section';
import { AddonsSection } from '@/features/settings/addon-settings';
import { AudioSection } from '@/features/settings/audio-settings';
import { GeneralSection, KeyboardGroup } from '@/features/settings/general-settings';
import { PlaybackSection } from '@/features/settings/playback-settings';
import { Group, Section } from '@/features/settings/settings-controls';
import {
  SETTINGS_SECTIONS,
  findSetting,
  resolveSettingsLocation,
  searchSettings,
  settingElementId,
  settingsPath,
  settingsSection,
  type SettingsSearchResult,
  type SettingsSectionId,
  type SettingsSectionInfo,
} from '@/features/settings/settings-sections';
import { useSettingsStore } from '@/features/settings/settings-store';
import { StreamsSection } from '@/features/settings/stream-settings';
import { SubtitlesSection } from '@/features/settings/subtitle-settings';
import { StremioImportSection } from '@/features/stremio-import/stremio-import-section';
import { useAppInfo } from '@/hooks/use-app-info';
import { formatOs } from '@/lib/platform';
import { isNativeRuntime } from '@/services/native';

const SECTION_ICONS: Record<SettingsSectionId, LucideIcon> = {
  general: Settings2,
  profiles: Users,
  playback: Play,
  audio: Volume2,
  subtitles: Subtitles,
  streams: Waves,
  addons: Puzzle,
  import: Download,
  about: Info,
};

const SECTION_CONTENT: Record<SettingsSectionId, ComponentType> = {
  general: GeneralSection,
  profiles: ProfilesSection,
  playback: PlaybackSection,
  audio: AudioSection,
  subtitles: SubtitlesSection,
  streams: StreamsSection,
  addons: AddonsSection,
  import: StremioImportSection,
  about: AboutSection,
};

/** Navigation state from a search result: focus the setting's control once there. */
interface SettingsNavState {
  focusSetting?: boolean;
}

/**
 * Settings, one section at a time (`/settings/playback`), with the sections
 * listed beside it and a search across every setting. `/settings` is General;
 * a link can name one setting (`/settings/streams#max-resolution`), and the
 * old single-page anchors (`/settings#stremio`) still land in the right place.
 *
 * Every section stays mounted and the others are hidden, so a half-finished
 * Stremio import or keyword survives looking at another section, as it did
 * when they were all on one page.
 */
export function SettingsPage() {
  const native = isNativeRuntime();
  const status = useSettingsStore((state) => state.status);
  const error = useSettingsStore((state) => state.error);
  const load = useSettingsStore((state) => state.load);
  const params = useParams();
  const { hash, state } = useLocation() as { hash: string; state: SettingsNavState | null };
  const [query, setQuery] = useState('');
  const location = resolveSettingsLocation(params.section, hash);
  const active = 'redirect' in location ? null : location.section;
  const setting = 'redirect' in location ? null : location.setting;
  const searching = query.trim() !== '';

  useEffect(() => {
    if (native) void load();
  }, [native, load]);

  useSettingAnchor(searching ? null : setting, state?.focusSetting === true);

  if ('redirect' in location) return <Navigate to={location.redirect} replace />;

  return (
    <Page title="Settings" className="@container">
      <div className="flex items-start gap-6 @4xl:gap-10">
        <SettingsNav active={active} query={query} onQuery={setQuery} />
        <div className="max-w-3xl min-w-0 flex-1">
          {native && (status === 'error' || error) && (
            <p
              role="alert"
              className="mb-6 rounded-card border border-red-400/20 bg-red-500/10 px-5 py-3 text-sm text-red-200"
            >
              {status === 'error'
                ? 'Settings could not be loaded. '
                : 'Couldn’t save that change. '}
              {error}
            </p>
          )}
          {searching && <SearchResults query={query} onChoose={() => setQuery('')} />}
          {SETTINGS_SECTIONS.map((section) => (
            <div
              key={section.id}
              hidden={searching || section.id !== active}
              // Right from the list lands at the top, or back where it was left.
              data-nav-entry
            >
              <SectionContent section={section} native={native} />
            </div>
          ))}
        </div>
      </div>
    </Page>
  );
}

function SectionContent({ section, native }: { section: SettingsSectionInfo; native: boolean }) {
  if (section.native && !native) {
    return (
      <Section title={section.title} description={section.description}>
        <p className="rounded-card border border-white/[0.07] bg-white/[0.025] px-5 py-4 text-sm text-ink-400">
          These settings are only available inside the desktop app.
        </p>
        {/* The keys work in a browser too. */}
        {section.id === 'general' && <KeyboardGroup />}
      </Section>
    );
  }
  const Content = SECTION_CONTENT[section.id];
  return <Content />;
}

/**
 * The search field and the list of sections, in a column beside the
 * section that stays in view as it scrolls. Choosing a section
 * replaces the address rather than adding to history, so Back leaves
 * Settings instead of stepping through every section looked at.
 */
function SettingsNav({
  active,
  query,
  onQuery,
}: {
  active: SettingsSectionId | null;
  query: string;
  onQuery: (query: string) => void;
}) {
  const searching = query.trim() !== '';
  return (
    <nav
      aria-label="Settings"
      data-settings-nav
      // A column beside the section, as the sidebar is beside the page: Up
      // and Down stay in it, and it's the height of the section, so Left from
      // any setting reaches it (and its current section).
      data-nav-side
      data-nav-group
      className="w-44 shrink-0 self-stretch @4xl:w-52"
    >
      <div className="sticky top-24">
        <SearchField query={query} onQuery={onQuery} />
        <ul className="mt-4 space-y-0.5">
          {SETTINGS_SECTIONS.map((section) => {
            const Icon = SECTION_ICONS[section.id];
            const current = !searching && section.id === active;
            return (
              <li key={section.id}>
                <Link
                  to={settingsPath(section.id)}
                  replace
                  aria-current={current ? 'page' : undefined}
                  onClick={() => onQuery('')}
                  className={cx(
                    'flex h-9 items-center gap-3 rounded-lg px-3 text-sm font-medium transition-colors focus-visible:focus-ring',
                    current
                      ? 'bg-white/[0.07] text-ink-50'
                      : 'text-ink-300 hover:bg-white/[0.04] hover:text-ink-50',
                  )}
                >
                  <Icon
                    aria-hidden
                    className={cx(
                      'size-4 shrink-0',
                      current ? 'text-accent-strong' : 'text-ink-500',
                    )}
                  />
                  {section.title}
                </Link>
              </li>
            );
          })}
        </ul>
      </div>
    </nav>
  );
}

/** Searches every setting by name and the words people use for it. */
function SearchField({ query, onQuery }: { query: string; onQuery: (query: string) => void }) {
  const input = useRef<HTMLInputElement>(null);

  // Escape clears the search, then leaves the field (as the header's search does).
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    if (query) onQuery('');
    else input.current?.blur();
  };

  return (
    <div className="relative">
      <Search
        aria-hidden
        className="pointer-events-none absolute top-1/2 left-3 size-4 -translate-y-1/2 text-ink-500"
      />
      <input
        ref={input}
        type="search"
        value={query}
        onChange={(event) => onQuery(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Search settings"
        aria-label="Search settings"
        aria-controls="settings-search-results"
        className="h-9 w-full rounded-lg border border-white/10 bg-white/[0.04] pr-8 pl-9 text-sm text-ink-100 placeholder:text-ink-500 focus-visible:focus-ring [&::-webkit-search-cancel-button]:hidden"
      />
      {query && (
        <button
          type="button"
          aria-label="Clear search"
          onClick={() => {
            onQuery('');
            input.current?.focus();
          }}
          className="absolute top-1/2 right-1.5 flex size-6 -translate-y-1/2 cursor-pointer items-center justify-center rounded-full text-ink-400 hover:bg-white/10 hover:text-ink-50 focus-visible:focus-ring"
        >
          <X aria-hidden className="size-3.5" />
        </button>
      )}
    </div>
  );
}

/** The settings matching the search, each a link to the setting in its section. */
function SearchResults({ query, onChoose }: { query: string; onChoose: () => void }) {
  const headingId = useId();
  const results = useMemo(() => searchSettings(query), [query]);

  return (
    <section id="settings-search-results" aria-labelledby={headingId}>
      <h2 id={headingId} className="text-xl font-semibold tracking-[-0.01em] text-ink-50">
        Search results
      </h2>
      <p aria-live="polite" className="mt-1 mb-6 text-[13px] text-ink-400">
        {results.length === 0
          ? `No settings match “${query.trim()}”. Try a word such as subtitles, Dolby or PIN.`
          : `${results.length} ${results.length === 1 ? 'setting matches' : 'settings match'} “${query.trim()}”.`}
      </p>
      {results.length > 0 && (
        <ul
          data-nav-group
          className="divide-y divide-white/[0.05] overflow-hidden rounded-card border border-white/[0.07] bg-white/[0.025]"
        >
          {results.map((result) => (
            <SearchResultItem
              key={`${result.section.id}-${result.setting.id}`}
              result={result}
              onChoose={onChoose}
            />
          ))}
        </ul>
      )}
    </section>
  );
}

function SearchResultItem({
  result: { section, setting },
  onChoose,
}: {
  result: SettingsSearchResult;
  onChoose: () => void;
}) {
  const Icon = SECTION_ICONS[section.id];
  const shownWith = setting.shownWith ? findSetting(setting.shownWith) : undefined;
  return (
    <li>
      <Link
        to={settingsPath(section.id, setting.id)}
        replace
        state={{ focusSetting: true } satisfies SettingsNavState}
        onClick={onChoose}
        className="group flex items-center gap-4 px-5 py-3.5 transition-colors hover:bg-white/[0.03] focus-visible:focus-ring focus-visible:-outline-offset-2"
      >
        <span className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-white/[0.05] text-ink-400">
          <Icon aria-hidden className="size-4" />
        </span>
        <span className="min-w-0 flex-1">
          <span className="block truncate text-sm font-medium text-ink-100">{setting.label}</span>
          <span className="block truncate text-xs text-ink-500">
            {section.title}
            {setting.group !== section.title && ` › ${setting.group}`}
            {shownWith && ` · Shown while “${shownWith.setting.label}” is on`}
          </span>
        </span>
        <ChevronRight
          aria-hidden
          className="size-4 shrink-0 text-ink-500 transition-transform group-hover:translate-x-0.5 group-hover:text-ink-200"
        />
      </Link>
    </li>
  );
}

/** How long a linked setting stays highlighted. */
const HIGHLIGHT_MS = 1600;

/**
 * Brings a linked setting (`#max-resolution`) into view and highlights it,
 * opening "More filters" or the like if it's folded away. Coming from a
 * search result, it also focuses the setting's control, so Enter or the
 * arrows act on it at once.
 */
function useSettingAnchor(setting: string | null, focus: boolean) {
  const { key } = useLocation();
  useEffect(() => {
    if (!setting) return;
    // A setting shown only while another is on: that one, while it's off.
    const shownWith = findSetting(setting)?.setting.shownWith;
    const row =
      document.getElementById(settingElementId(setting)) ??
      (shownWith ? document.getElementById(settingElementId(shownWith)) : null);
    if (!row) {
      // Don't leave focus nowhere once the search result that had it is gone.
      if (focus) document.querySelector<HTMLElement>('[data-settings-nav] [aria-current]')?.focus();
      return;
    }
    const details = row.closest('details');
    if (details && !details.open) details.open = true;
    row.scrollIntoView({ block: 'center' });
    row.setAttribute('data-highlight', '');
    if (focus) {
      const control =
        row.querySelector<HTMLElement>(`[data-setting-control] ${FOCUSABLE}`) ??
        row.querySelector<HTMLElement>(FOCUSABLE);
      control?.focus({ preventScroll: true });
    }
    const timer = window.setTimeout(() => row.removeAttribute('data-highlight'), HIGHLIGHT_MS);
    return () => {
      window.clearTimeout(timer);
      row.removeAttribute('data-highlight');
    };
    // `key`: following the same link again highlights it again.
  }, [setting, focus, key]);
}

const FOCUSABLE =
  ':is(button, input, select, a[href], [tabindex="0"]):not([disabled]):not([tabindex="-1"])';

function AboutSection() {
  const appInfo = useAppInfo();
  const section = settingsSection('about');

  const rows: [label: string, value: string][] =
    appInfo.status === 'ready'
      ? [
          ['Version', appInfo.info.version],
          ['Platform', `${formatOs(appInfo.info.os)} (${appInfo.info.arch})`],
          ['Tauri', appInfo.info.tauriVersion],
        ]
      : [];

  return (
    <Section title={section.title} description={section.description}>
      <Group title="About Kiro">
        {appInfo.status === 'ready' ? (
          <dl id={settingElementId('version')} className="divide-y divide-white/[0.05]">
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
      </Group>
    </Section>
  );
}
