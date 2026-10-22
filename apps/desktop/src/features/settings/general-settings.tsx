import { Button } from '@kiro/ui';
import { Keyboard } from 'lucide-react';
import { useId } from 'react';

import { useShortcutsHelpStore } from '@/features/remote/shortcuts-store';
import { Group, Section, SettingRow, ToggleSetting } from '@/features/settings/settings-controls';
import { DEFAULT_GENERAL_SETTINGS, resetTo } from '@/features/settings/settings-data';
import { settingsSection } from '@/features/settings/settings-sections';
import {
  useFieldsReset,
  useSettingsEditable,
  useSettingsStore,
} from '@/features/settings/settings-store';
import { describeUpdate, offeredVersion, useUpdateStore } from '@/features/updates/update-store';
import { useAppInfo } from '@/hooks/use-app-info';

const SECTION = settingsSection('general');

/**
 * Kiro as a whole: its version and updates, what it shares outside the app
 * (Discord), and the keyboard and remote.
 */
export function GeneralSection() {
  const editable = useSettingsEditable();
  const general = useSettingsStore((state) => state.settings.general);
  const updateGeneral = useSettingsStore((state) => state.updateGeneral);
  const appInfo = useAppInfo();
  const defaults = DEFAULT_GENERAL_SETTINGS;
  /** Builds without a Discord application ID can't show anything. */
  const unavailable = appInfo.status === 'ready' && !appInfo.info.discordPresence;
  const resetOf = <K extends keyof typeof general>(key: K) =>
    resetTo(general[key], defaults[key], () => void updateGeneral({ [key]: defaults[key] }));

  return (
    <Section
      title={SECTION.title}
      description={SECTION.description}
      {...useFieldsReset(SECTION.fields)}
    >
      <Group title="Updates">
        <UpdatesSetting version={appInfo.status === 'ready' ? appInfo.info.version : null} />
      </Group>
      <Group title="Discord">
        <ToggleSetting
          id="discord"
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
              id="discord-title"
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
              id="discord-episode"
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
      </Group>
      <KeyboardGroup />
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
      id="updates"
      label={version ? `Kiro ${version}` : 'Kiro'}
      hint={
        <>
          <span aria-live="polite" className="mb-0.5 block text-ink-200">
            {error ?? describeUpdate(status)}
          </span>
          Kiro looks for a new version when it starts and once a day, and downloads it in the
          background. Restart when it’s ready.
        </>
      }
      labelId={labelId}
    >
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
    </SettingRow>
  );
}

/** The keyboard and remote control, and the shortcuts overlay (`?`). */
export function KeyboardGroup() {
  const labelId = useId();
  const showShortcuts = useShortcutsHelpStore((state) => state.setOpen);
  return (
    <Group title="Keyboard and remote">
      <SettingRow
        id="keyboard"
        label="Keyboard shortcuts"
        hint="Arrows move around, Enter opens and Escape goes back, from a keyboard or a remote control. Press ? anywhere for the full list."
        labelId={labelId}
      >
        <Button variant="secondary" size="sm" onClick={() => showShortcuts(true)}>
          <Keyboard aria-hidden className="size-4" />
          Show shortcuts
          <kbd className="ml-1 font-sans text-xs text-ink-400">?</kbd>
        </Button>
      </SettingRow>
    </Group>
  );
}
