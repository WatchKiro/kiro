export type TrackKind = 'video' | 'audio' | 'subtitle';

export interface MediaTrack {
  /** Backend-assigned identifier, stable for the lifetime of the loaded source. */
  id: string;
  kind: TrackKind;
  label?: string;
  language?: string;
  codec?: string;
  /** Audio channel count, e.g. 2 or 6. */
  channels?: number;
  isDefault?: boolean;
  isForced?: boolean;
  /** Loaded from an `ExternalSubtitle` rather than embedded in the container. */
  isExternal?: boolean;
}
