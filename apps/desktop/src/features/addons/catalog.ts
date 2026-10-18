import type { ManifestCatalog } from '@kiro/addon-sdk';

/** Cache key for a catalogue of an installed addon. */
export function catalogKey(transportUrl: string, catalog: Pick<ManifestCatalog, 'type' | 'id'>) {
  return JSON.stringify([transportUrl, catalog.type, catalog.id]);
}

/** Only https artwork can load under the app's CSP (`img-src … https:`). */
export function displayableImage(url: string | undefined): string | undefined {
  return url?.startsWith('https://') ? url : undefined;
}
