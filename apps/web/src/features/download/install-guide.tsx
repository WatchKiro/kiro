import { PlatformIcon } from '@/components/platform-icon';
import { PLATFORMS, type Platform } from '@/lib/platform';

const STEPS: Record<Platform, string[]> = {
  macos: [
    'Open the downloaded .dmg and drag Kiro into your Applications folder.',
    'Open Kiro from Applications or Spotlight.',
    'If macOS says the app cannot be opened because it is from an unidentified developer, Control-click (right-click) Kiro in Applications, choose Open, then Open again. You only need to do this once.',
  ],
  windows: [
    'Run the downloaded installer and follow the prompts.',
    'If Windows SmartScreen shows a warning, choose "More info" and then "Run anyway".',
    'Kiro installs the Microsoft WebView2 runtime automatically if it is missing.',
  ],
  linux: [
    'AppImage: make the file executable (chmod +x Kiro*.AppImage) and run it. No installation required.',
    'Debian / Ubuntu: sudo apt install ./Kiro*.deb',
    'Fedora / openSUSE: sudo dnf install ./Kiro*.rpm',
  ],
};

export function InstallGuide({ available }: { available: ReadonlySet<Platform> }) {
  const platforms = PLATFORMS.filter((p) => available.has(p.id));
  if (platforms.length === 0) return null;

  return (
    <section aria-labelledby="install-heading" className="mt-20">
      <h2 id="install-heading" className="text-2xl font-semibold tracking-tight text-ink-50">
        Installing
      </h2>
      <div className="mt-6 grid gap-4 lg:grid-cols-3">
        {platforms.map((platform) => (
          <div
            key={platform.id}
            className="rounded-card border border-white/[0.07] bg-white/[0.02] p-6"
          >
            <h3 className="flex items-center gap-2.5 font-medium text-ink-50">
              <PlatformIcon platform={platform.id} className="size-4 text-ink-300" />
              {platform.label}
            </h3>
            <ol className="mt-4 space-y-3 text-sm leading-relaxed text-ink-300">
              {STEPS[platform.id].map((step, index) => (
                <li key={step} className="flex gap-3">
                  <span className="mt-0.5 flex size-5 shrink-0 items-center justify-center rounded-full border border-white/10 text-[11px] font-medium text-ink-400">
                    {index + 1}
                  </span>
                  <span>{step}</span>
                </li>
              ))}
            </ol>
          </div>
        ))}
      </div>
    </section>
  );
}
