/** When the first-run setup (docs/first-run.md) shows. Pure, so it can be tested. */
import type { AddonsState } from '@/features/addons/addons-store';
import { providesStreams } from '@/features/title/title-data';
import type { Profile } from '@/services/native';

/**
 * Whether the setup opens by itself for `profile`: `wait` until the
 * installed addons are known, then `show` while its setup is pending and no
 * enabled addon provides streams, else `hide`.
 *
 * Addons are shared by every profile, so a profile added on a computer that
 * is already set up (or one upgraded from before the setup existed, with its
 * stream addons) has nothing to set up and isn't asked. It still can be,
 * from Settings. Addons that can't be read leave it for the next launch.
 */
export function firstRunAtLaunch(
  profile: Pick<Profile, 'firstRun'> | undefined,
  addons: Pick<AddonsState, 'status' | 'addons'>,
): 'wait' | 'show' | 'hide' {
  if (profile?.firstRun !== 'pending') return 'hide';
  if (addons.status === 'idle' || addons.status === 'loading') return 'wait';
  if (addons.status === 'error') return 'hide';
  return addons.addons.some(providesStreams) ? 'hide' : 'show';
}
