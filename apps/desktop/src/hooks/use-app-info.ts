import { useEffect, useState } from 'react';

import { getAppInfo, isNativeRuntime, type AppInfo } from '@/services/native';

export type AppInfoState =
  | { status: 'loading' }
  | { status: 'ready'; info: AppInfo }
  | { status: 'unavailable'; reason: 'browser' | 'error' };

// The values never change at runtime, so the native call is made at most once.
let cached: Promise<AppInfo> | undefined;

/** Application metadata from the Rust core. */
export function useAppInfo(): AppInfoState {
  const [state, setState] = useState<AppInfoState>(() =>
    isNativeRuntime() ? { status: 'loading' } : { status: 'unavailable', reason: 'browser' },
  );

  useEffect(() => {
    if (!isNativeRuntime()) return;
    let active = true;
    cached ??= getAppInfo();
    cached.then(
      (info) => active && setState({ status: 'ready', info }),
      () => active && setState({ status: 'unavailable', reason: 'error' }),
    );
    return () => {
      active = false;
    };
  }, []);

  return state;
}
