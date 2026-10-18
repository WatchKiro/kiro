import type { JSX, SVGProps } from 'react';

import type { Platform } from '@/lib/platform';

type IconProps = SVGProps<SVGSVGElement>;

function AppleIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M16.37 12.7c-.02-2.3 1.88-3.4 1.96-3.45-1.07-1.56-2.73-1.78-3.32-1.8-1.41-.14-2.76.83-3.48.83-.72 0-1.83-.81-3-.79-1.55.02-2.97.9-3.77 2.28-1.6 2.78-.41 6.9 1.15 9.16.77 1.1 1.68 2.35 2.87 2.3 1.16-.04 1.59-.75 2.99-.75s1.79.75 3.01.73c1.24-.02 2.03-1.13 2.79-2.24.88-1.28 1.24-2.53 1.26-2.6-.03-.01-2.42-.93-2.46-3.67ZM14.09 5.96c.64-.77 1.07-1.85.95-2.92-.92.04-2.03.61-2.69 1.38-.59.68-1.11 1.78-.97 2.83 1.03.08 2.07-.52 2.71-1.29Z" />
    </svg>
  );
}

function WindowsIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M3 5.5 10.9 4.4v7.2H3V5.5Zm0 13 7.9 1.1v-7.1H3v6Zm8.8 1.2L21 21v-8.4h-9.2v7.1Zm0-15.4v7.3H21V3L11.8 4.3Z" />
    </svg>
  );
}

function LinuxIcon(props: IconProps) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden {...props}>
      <path d="M12 2c-2.3 0-3.6 1.9-3.6 4.5 0 1.1.2 1.8-.3 2.8-.9 1.6-2.6 3.4-2.9 5.7-.1.6-.1 1.1 0 1.6-.6.4-1.3 1-1.2 1.7.1.9 1.2 1 2 1.3.8.3 1.4 1 2.1 1.2.8.2 1.5-.2 1.9-.6.6.1 1.3.2 2 .2s1.4-.1 2-.2c.4.4 1.1.8 1.9.6.7-.2 1.3-.9 2.1-1.2.8-.3 1.9-.4 2-1.3.1-.7-.6-1.3-1.2-1.7.1-.5.1-1 0-1.6-.3-2.3-2-4.1-2.9-5.7-.5-1-.3-1.7-.3-2.8C15.6 3.9 14.3 2 12 2Zm-1.5 4.3c.5 0 .8.6.8 1.3s-.3 1.3-.8 1.3-.8-.6-.8-1.3.3-1.3.8-1.3Zm3 0c.5 0 .8.6.8 1.3s-.3 1.3-.8 1.3-.8-.6-.8-1.3.3-1.3.8-1.3ZM12 9c.9 0 2.2.5 2.2 1.1 0 .5-1.3 1.6-2.2 1.6s-2.2-1.1-2.2-1.6C9.8 9.5 11.1 9 12 9Zm0 3.6c1.6 0 3 1.5 3.4 3.5.3 1.4-.1 3.2-1 3.9-.6.5-1.5.7-2.4.7s-1.8-.2-2.4-.7c-.9-.7-1.3-2.5-1-3.9.4-2 1.8-3.5 3.4-3.5Z" />
    </svg>
  );
}

const ICONS: Record<Platform, (props: IconProps) => JSX.Element> = {
  macos: AppleIcon,
  windows: WindowsIcon,
  linux: LinuxIcon,
};

export function PlatformIcon({ platform, ...props }: IconProps & { platform: Platform }) {
  const Icon = ICONS[platform];
  return <Icon {...props} />;
}
