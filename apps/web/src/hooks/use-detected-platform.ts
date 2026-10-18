'use client';

import { useEffect, useState } from 'react';

import { detectPlatform, type DetectedPlatform } from '@/lib/platform';

/**
 * The visitor's desktop platform, resolved after hydration.
 *
 * `undefined` while detecting (and during server render), `null` when the
 * visitor is on a phone/tablet or the platform cannot be determined.
 */
export function useDetectedPlatform(): DetectedPlatform | null | undefined {
  const [detected, setDetected] = useState<DetectedPlatform | null | undefined>(undefined);

  useEffect(() => {
    let cancelled = false;
    void detectPlatform().then((result) => {
      if (!cancelled) setDetected(result);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  return detected;
}
