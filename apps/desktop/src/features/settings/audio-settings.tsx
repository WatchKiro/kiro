import { cx } from '@kiro/utils';
import { Check } from 'lucide-react';
import { useId } from 'react';

import { LanguageSetting } from '@/features/settings/language-setting';
import { Group, Section, SettingRow, ToggleSetting } from '@/features/settings/settings-controls';
import {
  DEFAULT_PLAYBACK_SETTINGS,
  PASSTHROUGH_FORMATS,
  isPassthroughAvailable,
  resetTo,
  withPassthroughFormat,
} from '@/features/settings/settings-data';
import { settingsSection } from '@/features/settings/settings-sections';
import {
  useFieldsReset,
  useSettingsEditable,
  useSettingsStore,
} from '@/features/settings/settings-store';
import { useAppInfo } from '@/hooks/use-app-info';
import { formatOs } from '@/lib/platform';

const SECTION = settingsSection('audio');

/** What each platform's audio output can send to a receiver, for the formats' hint. */
const PASSTHROUGH_PLATFORM_NOTES: Record<string, string> = {
  windows:
    'Windows can send all of them: Kiro takes the audio device for itself (WASAPI exclusive mode) while one plays. Dolby Digital Plus, DTS-HD and TrueHD need HDMI; optical carries only Dolby Digital and DTS.',
  macos:
    'A Mac can only send Dolby Digital and DTS (a DTS-HD soundtrack sends its DTS core): macOS doesn’t let apps send Dolby Digital Plus, DTS-HD or TrueHD over HDMI, so those are decoded. Kiro takes the audio device for itself (Core Audio exclusive mode) while one plays.',
  linux:
    'Depends on the sound setup. With PipeWire or PulseAudio, also allow these formats for the HDMI or optical output, in pavucontrol’s Configuration or Output Devices settings. Without a sound server, Kiro opens the HDMI or optical device directly.',
};

/**
 * Which soundtrack plays, and "Audio passthrough (AV receiver)": formats sent
 * to a receiver untouched, greyed out where this platform can't send them.
 * These are playback settings, stored with the rest of Settings → Playback.
 */
export function AudioSection() {
  const disabled = !useSettingsEditable();
  const playback = useSettingsStore((state) => state.settings.playback);
  const updatePlayback = useSettingsStore((state) => state.updatePlayback);
  const appInfo = useAppInfo();
  const os = appInfo.status === 'ready' ? appInfo.info.os : null;
  const formatsId = useId();
  const formats = playback.passthroughFormats;
  const platformNote = os ? PASSTHROUGH_PLATFORM_NOTES[os] : undefined;
  const defaults = DEFAULT_PLAYBACK_SETTINGS;
  const resetOf = <K extends keyof typeof playback>(key: K) =>
    resetTo(playback[key], defaults[key], () => void updatePlayback({ [key]: defaults[key] }));

  return (
    <Section
      title={SECTION.title}
      description={SECTION.description}
      {...useFieldsReset(SECTION.fields)}
    >
      <Group title="Languages" description="You can still switch tracks in the player.">
        <LanguageSetting
          id="audio-languages"
          label="Audio languages"
          hint="The first one a stream has is used. Otherwise, the stream’s default. Play also prefers streams in these languages."
          languages={playback.audioLanguages}
          disabled={disabled}
          onChange={(audioLanguages) => void updatePlayback({ audioLanguages })}
          onReset={resetOf('audioLanguages')}
        />
      </Group>

      <Group title="AV receiver">
        <ToggleSetting
          id="passthrough"
          label="Audio passthrough (AV receiver)"
          hint={
            playback.audioPassthrough
              ? 'Surround soundtracks in the formats below go to your receiver or soundbar untouched, for it to decode, Dolby Atmos and DTS:X included. Set the volume on the receiver: Kiro’s volume doesn’t change them. Anything the computer’s audio output won’t take is decoded as usual.'
              : 'Kiro decodes all audio itself: lossless, but Dolby Atmos and DTS:X are mixed down to plain channels. Turn on if Kiro plays through an AV receiver or soundbar over HDMI or optical.'
          }
          checked={playback.audioPassthrough}
          disabled={disabled}
          onChange={(audioPassthrough) => void updatePlayback({ audioPassthrough })}
          onReset={resetOf('audioPassthrough')}
        />
        {playback.audioPassthrough && (
          <SettingRow
            id="passthrough-formats"
            label="Passthrough formats"
            hint={
              <>
                Only choose formats your receiver decodes: Kiro can tell when this computer won’t
                send one, and decodes it instead, but not what the receiver does with it.
                {platformNote && ` ${platformNote}`}
                {formats.length === 0 && ' With none chosen, everything is decoded.'}
              </>
            }
            labelId={formatsId}
            disabled={disabled}
            stacked
            onReset={resetOf('passthroughFormats')}
          >
            <div role="group" aria-labelledby={formatsId} className="flex flex-wrap gap-2">
              {PASSTHROUGH_FORMATS.map((format) => {
                const available = isPassthroughAvailable(format.value, os);
                const on = available && formats.includes(format.value);
                return (
                  <button
                    key={format.value}
                    type="button"
                    aria-pressed={on}
                    disabled={disabled || !available}
                    title={available ? undefined : `Not available on ${formatOs(os ?? '')}`}
                    onClick={() =>
                      void updatePlayback({
                        passthroughFormats: withPassthroughFormat(formats, format.value, !on),
                      })
                    }
                    className={cx(
                      'flex h-8 cursor-pointer items-center gap-1.5 rounded-full border px-3 text-[13px] transition-colors focus-visible:focus-ring disabled:cursor-not-allowed',
                      !available && 'opacity-40',
                      on
                        ? 'border-accent/60 bg-accent/15 text-ink-50'
                        : 'border-white/10 text-ink-300 enabled:hover:text-ink-50',
                    )}
                  >
                    {on && <Check aria-hidden className="size-3.5" />}
                    {format.label}
                  </button>
                );
              })}
            </div>
          </SettingRow>
        )}
      </Group>
    </Section>
  );
}
