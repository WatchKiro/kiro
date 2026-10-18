/** Subtitle file loaded alongside the media rather than embedded in it. */
export interface ExternalSubtitle {
  url: string;
  /** ISO 639 code or BCP 47 tag. */
  language?: string;
  label?: string;
  /** Hint for backends that cannot sniff the format, e.g. `srt`, `vtt`, `ass`. */
  format?: string;
}

interface MediaSourceBase {
  title?: string;
  /** Position, in seconds, to resume from once loaded. */
  startPosition?: number;
  mimeType?: string;
  externalSubtitles?: readonly ExternalSubtitle[];
}

/** HTTP(S) or other network stream. */
export interface NetworkMediaSource extends MediaSourceBase {
  kind: 'network';
  url: string;
  /** Request headers required by the stream host. */
  headers?: Readonly<Record<string, string>>;
}

/** File on the local machine, resolved by the native layer. */
export interface LocalMediaSource extends MediaSourceBase {
  kind: 'local';
  path: string;
}

/** Something a `MediaPlayer` can load. */
export type MediaSource = NetworkMediaSource | LocalMediaSource;
