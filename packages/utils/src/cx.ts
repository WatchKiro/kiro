export type ClassValue = string | false | null | undefined;

/** Joins truthy class names. A dependency-free alternative to `clsx`. */
export function cx(...classes: ClassValue[]): string {
  return classes.filter(Boolean).join(' ');
}
