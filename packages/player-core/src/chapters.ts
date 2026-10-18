/** A chapter of the loaded media, as the file marks it. */
export interface Chapter {
  /** Seconds from the start. A chapter ends where the next one starts, or at the end. */
  start: number;
  /** The file's own name for the chapter: untrusted, possibly in any language. */
  title?: string;
}
