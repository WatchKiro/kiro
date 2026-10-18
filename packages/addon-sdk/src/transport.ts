import type { AddonManifest, AddonResource } from './manifest';
import type { MetaDetail, MetaPreview, Stream, Subtitle } from './resources';

/** Extra catalog arguments such as `search`, `genre` or `skip`. */
export type ResourceExtra = Readonly<Record<string, string>>;

export interface ResourceRequest {
  resource: AddonResource;
  type: string;
  id: string;
  extra?: ResourceExtra;
}

/**
 * Builds the protocol path for a resource request, e.g.
 * `/catalog/movie/top/search=alien.json`. Every segment is percent-encoded so
 * that ids from untrusted sources cannot alter the path structure.
 */
export function buildResourcePath({ resource, type, id, extra }: ResourceRequest): string {
  const segments = [resource, type, id].map(encodeURIComponent);
  const extraEntries = Object.entries(extra ?? {});
  if (extraEntries.length > 0) {
    segments.push(
      extraEntries
        .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(value)}`)
        .join('&'),
    );
  }
  return `/${segments.join('/')}.json`;
}

/**
 * How Kiro reaches an addon. Implementations (HTTP from the Rust core, a local
 * bundled addon, a test double, ...) return **raw, unvalidated** data; callers
 * must pass it through the `parse*` functions before use.
 *
 * Kiro never executes addon code: addons are remote services spoken to over a
 * transport.
 */
export interface AddonTransport {
  getManifest(signal?: AbortSignal): Promise<unknown>;
  getResource(request: ResourceRequest, signal?: AbortSignal): Promise<unknown>;
}

/**
 * Contract an addon implements on the serving side. Useful for building
 * first-party addons and protocol test fixtures.
 */
export interface AddonHandlers {
  catalog?(args: {
    type: string;
    id: string;
    extra: ResourceExtra;
  }): Promise<{ metas: MetaPreview[] }>;
  meta?(args: { type: string; id: string }): Promise<{ meta: MetaDetail }>;
  stream?(args: { type: string; id: string }): Promise<{ streams: Stream[] }>;
  subtitles?(args: {
    type: string;
    id: string;
    extra: ResourceExtra;
  }): Promise<{ subtitles: Subtitle[] }>;
}

export interface AddonDefinition {
  manifest: AddonManifest;
  handlers: AddonHandlers;
}
