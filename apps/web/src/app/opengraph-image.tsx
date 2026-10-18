import { readFile } from 'node:fs/promises';

import { ImageResponse } from 'next/og';

import { siteConfig } from '@/lib/site';

export const alt = `${siteConfig.name} — ${siteConfig.tagline}`;
export const size = { width: 1200, height: 630 };
export const contentType = 'image/png';

export default async function OpenGraphImage() {
  const icon = await readFile(new URL('./icon.png', import.meta.url));
  const iconSrc = `data:image/png;base64,${icon.toString('base64')}`;

  return new ImageResponse(
    <div
      style={{
        width: '100%',
        height: '100%',
        display: 'flex',
        flexDirection: 'column',
        justifyContent: 'center',
        alignItems: 'center',
        background:
          'radial-gradient(ellipse 70% 60% at 50% -10%, rgba(132,60,251,0.45), transparent), #08070d',
        color: '#f5f4fa',
        fontFamily: 'sans-serif',
      }}
    >
      <img src={iconSrc} alt="" width={160} height={160} style={{ borderRadius: 40 }} />
      <div style={{ marginTop: 44, fontSize: 72, fontWeight: 600, letterSpacing: -3 }}>
        {siteConfig.tagline}
      </div>
      <div style={{ marginTop: 18, fontSize: 30, color: '#a6a2ba' }}>
        {`${siteConfig.name} · Free and open-source media player for macOS, Windows and Linux`}
      </div>
    </div>,
    size,
  );
}
