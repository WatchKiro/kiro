import { isTauri } from '@tauri-apps/api/core';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { RouterProvider } from 'react-router/dom';

import { router } from '@/app/router';
import { SmokeTestStart } from '@/app/smoke-test';
import { hideSplash } from '@/app/splash';
import { SplashHandoff } from '@/app/splash-handoff';
import { installAndroidBack } from '@/features/remote/android-back';
import { installTvTextFields } from '@/features/remote/android-text-fields';
import { installRemoteNavigation } from '@/features/remote/remote-navigation';
import { ShortcutsHelp } from '@/features/remote/shortcuts-help';
import { IS_ANDROID } from '@/lib/platform';

import '@/styles/globals.css';

async function start() {
  // Development in a plain browser: answer native commands with the preview
  // backend. The branch, and the module, are dropped from production builds.
  if (import.meta.env.DEV && !isTauri() && import.meta.env.VITE_KIRO_PREVIEW !== '0') {
    const { installPreviewBackend } = await import('@/dev/preview-backend');
    installPreviewBackend();
  }

  if (IS_ANDROID) document.documentElement.dataset.tv = '';

  const container = document.getElementById('root');
  if (!container) throw new Error('Kiro: #root element missing from index.html');

  // Arrows, Enter and Back from a keyboard or remote, on every page.
  installRemoteNavigation(router);
  installAndroidBack();
  installTvTextFields();

  createRoot(container).render(
    <StrictMode>
      <RouterProvider router={router} />
      <ShortcutsHelp />
      <SplashHandoff router={router} />
      <SmokeTestStart router={router} />
    </StrictMode>,
  );
}

// If the app can't start, don't leave the splash over the error.
void start().catch((error: unknown) => {
  hideSplash();
  throw error;
});
