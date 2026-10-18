import { CopyButton } from '@/components/copy-button';
import type { Release } from '@/lib/downloads';

const VERIFY_COMMANDS = [
  { platform: 'macOS / Linux', command: 'shasum -a 256 <file>' },
  { platform: 'Windows (PowerShell)', command: 'Get-FileHash <file> -Algorithm SHA256' },
];

export function Checksums({ release }: { release: Release }) {
  const assets = release.assets.filter((asset) => asset.sha256);
  if (assets.length === 0) return null;

  return (
    <section aria-labelledby="checksums-heading" className="mt-20">
      <h2 id="checksums-heading" className="text-2xl font-semibold tracking-tight text-ink-50">
        Verify your download
      </h2>
      <p className="mt-3 max-w-2xl text-sm leading-relaxed text-ink-300">
        Compare the SHA-256 hash of the file you downloaded with the value published here. They
        should match exactly.
      </p>

      <div className="mt-6 overflow-hidden rounded-card border border-white/[0.07]">
        <table className="w-full text-left text-sm">
          <thead className="bg-white/[0.03] text-xs tracking-wide text-ink-400 uppercase">
            <tr>
              <th scope="col" className="px-4 py-3 font-medium">
                File
              </th>
              <th scope="col" className="px-4 py-3 font-medium">
                SHA-256
              </th>
            </tr>
          </thead>
          <tbody className="divide-y divide-white/[0.06]">
            {assets.map((asset) => (
              <tr key={asset.name} className="align-top">
                <td className="px-4 py-3 font-medium whitespace-nowrap text-ink-100">
                  {asset.name}
                </td>
                <td className="px-4 py-3">
                  <div className="flex items-start gap-2">
                    <code className="font-mono text-xs leading-relaxed wrap-anywhere text-ink-300">
                      {asset.sha256}
                    </code>
                    <CopyButton value={asset.sha256 ?? ''} label={`Copy hash for ${asset.name}`} />
                  </div>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <dl className="mt-4 grid gap-2 text-sm sm:grid-cols-2">
        {VERIFY_COMMANDS.map(({ platform, command }) => (
          <div
            key={platform}
            className="flex items-center justify-between gap-3 rounded-xl border border-white/[0.07] bg-white/[0.02] px-4 py-2.5"
          >
            <div className="min-w-0">
              <dt className="text-xs text-ink-400">{platform}</dt>
              <dd>
                <code className="font-mono text-xs text-ink-200">{command}</code>
              </dd>
            </div>
            <CopyButton value={command} label={`Copy ${platform} command`} />
          </div>
        ))}
      </dl>
    </section>
  );
}
