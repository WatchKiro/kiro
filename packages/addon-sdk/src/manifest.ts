import { z } from 'zod';

import {
  contentTypeSchema,
  httpUrlSchema,
  lenient,
  longTextSchema,
  shortTextSchema,
} from './common';

/** Resources Kiro knows how to request. Unknown resource names are tolerated but ignored. */
export const ADDON_RESOURCES = ['catalog', 'meta', 'stream', 'subtitles'] as const;
export type AddonResource = (typeof ADDON_RESOURCES)[number];

export function isKnownResource(name: string): name is AddonResource {
  return (ADDON_RESOURCES as readonly string[]).includes(name);
}

const idPrefixesSchema = z.array(z.string().min(1).max(64)).max(64);

export const manifestResourceSchema = z.union([
  z.string().min(1).max(64),
  z.object({
    name: z.string().min(1).max(64),
    types: z.array(contentTypeSchema).max(32).optional(),
    idPrefixes: idPrefixesSchema.optional(),
  }),
]);
export type ManifestResource = z.infer<typeof manifestResourceSchema>;

export const catalogExtraSchema = z.object({
  name: z.string().min(1).max(64),
  isRequired: z.boolean().optional(),
  options: lenient(z.array(shortTextSchema).max(500)),
  optionsLimit: lenient(z.number().int().positive().max(100)),
});
export type CatalogExtra = z.infer<typeof catalogExtraSchema>;

export const manifestCatalogSchema = z.object({
  type: contentTypeSchema,
  id: z.string().min(1).max(128),
  name: lenient(shortTextSchema),
  extra: z.array(catalogExtraSchema).max(32).optional(),
});
export type ManifestCatalog = z.infer<typeof manifestCatalogSchema>;

/**
 * Addon manifest. Compatible with the Stremio addon manifest format so that
 * existing community addons can be consumed.
 *
 * Unknown fields are stripped rather than rejected, which keeps older Kiro
 * releases compatible with manifests written for newer protocol revisions.
 */
export const addonManifestSchema = z.object({
  id: z
    .string()
    .regex(
      /^[A-Za-z0-9._-]{1,128}$/,
      'Addon ids may only contain letters, digits, ".", "_" and "-"',
    ),
  version: z
    .string()
    .regex(/^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)*$/, 'Expected a semantic version')
    .max(64),
  name: z.string().min(1).max(128),
  description: lenient(longTextSchema),
  logo: lenient(httpUrlSchema),
  background: lenient(httpUrlSchema),
  types: z.array(contentTypeSchema).max(32),
  resources: z.array(manifestResourceSchema).min(1).max(32),
  catalogs: z.array(manifestCatalogSchema).max(100).default([]),
  idPrefixes: idPrefixesSchema.optional(),
  behaviorHints: lenient(
    z.object({
      adult: z.boolean().optional(),
      p2p: z.boolean().optional(),
      configurable: z.boolean().optional(),
      configurationRequired: z.boolean().optional(),
    }),
  ),
});
export type AddonManifest = z.infer<typeof addonManifestSchema>;

/**
 * Whether an addon declares support for a resource request. Resource-level
 * `types`/`idPrefixes` override the manifest-level values, as in Stremio.
 */
export function supportsResource(
  manifest: AddonManifest,
  resource: AddonResource,
  type: string,
  id?: string,
): boolean {
  for (const entry of manifest.resources) {
    const name = typeof entry === 'string' ? entry : entry.name;
    if (name !== resource) continue;

    const types = (typeof entry === 'string' ? undefined : entry.types) ?? manifest.types;
    const prefixes =
      (typeof entry === 'string' ? undefined : entry.idPrefixes) ?? manifest.idPrefixes;

    if (!types.includes(type)) continue;
    if (id !== undefined && prefixes && !prefixes.some((prefix) => id.startsWith(prefix))) continue;
    return true;
  }
  return false;
}

/**
 * Whether a catalogue can be queried with only a `search` extra: it declares
 * `search`, and every other extra it requires is optional.
 */
export function isSearchableCatalog(catalog: ManifestCatalog): boolean {
  const extras = catalog.extra ?? [];
  return (
    extras.some((extra) => extra.name === 'search') &&
    extras.every((extra) => extra.name === 'search' || !extra.isRequired)
  );
}

/**
 * The catalogues of an addon that can be searched (see
 * {@link isSearchableCatalog}), in manifest order. A catalogue whose type the
 * addon's `catalog` resource does not cover is left out.
 */
export function searchableCatalogs(manifest: AddonManifest): ManifestCatalog[] {
  return manifest.catalogs.filter(
    (catalog) =>
      isSearchableCatalog(catalog) && supportsResource(manifest, 'catalog', catalog.type),
  );
}
