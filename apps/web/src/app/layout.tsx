import type { Metadata, Viewport } from 'next';
import { Geist } from 'next/font/google';
import type { ReactNode } from 'react';

import { siteConfig } from '@/lib/site';
import '@/styles/globals.css';

const geist = Geist({ subsets: ['latin'], variable: '--font-geist-sans', display: 'swap' });

export const metadata: Metadata = {
  metadataBase: new URL(siteConfig.url),
  title: {
    default: `${siteConfig.name} — ${siteConfig.tagline}`,
    template: `%s · ${siteConfig.name}`,
  },
  description: siteConfig.description,
  applicationName: siteConfig.name,
  openGraph: {
    type: 'website',
    siteName: siteConfig.name,
    title: `${siteConfig.name} — ${siteConfig.tagline}`,
    description: siteConfig.description,
  },
  twitter: { card: 'summary_large_image' },
};

export const viewport: Viewport = {
  themeColor: '#08080c',
  colorScheme: 'dark',
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en" className={geist.variable}>
      <body className="min-h-dvh font-sans">{children}</body>
    </html>
  );
}
