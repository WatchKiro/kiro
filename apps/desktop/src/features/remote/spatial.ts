/**
 * Spatial navigation: which item an arrow key moves focus to, by on-screen
 * position, and focus groups that remember where they were left.
 *
 * Pure: items are anything with a rectangle and a chain of groups, so the
 * rules are tested without a DOM. `remote-navigation.ts` feeds it elements.
 *
 * Candidate selection follows Android's FocusFinder, which TV apps have used
 * for years: only items wholly further in the direction count; one that
 * overlaps the source across the direction of travel ("in the beam", such as
 * the next poster in a row) beats one that doesn't, unless it lies further
 * away than the other one's far edge; otherwise the closest by a distance that
 * weighs the direction of travel 13 times more than the sideways offset.
 */

export type Direction = 'up' | 'down' | 'left' | 'right';

export interface Rect {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

/**
 * Something focus can move to: what it is (an element, in the app), its box,
 * and the groups it is in, innermost first.
 */
export interface NavItem<G, E> {
  target: E;
  rect: Rect;
  groups: readonly G[];
}

const horizontal = (direction: Direction) => direction === 'left' || direction === 'right';

/** Whether `dest` lies further than `source` in `direction`. */
export function isCandidate(source: Rect, dest: Rect, direction: Direction): boolean {
  switch (direction) {
    case 'left':
      return (source.right > dest.right || source.left >= dest.right) && source.left > dest.left;
    case 'right':
      return (source.left < dest.left || source.right <= dest.left) && source.right < dest.right;
    case 'up':
      return (source.bottom > dest.bottom || source.top >= dest.bottom) && source.top > dest.top;
    case 'down':
      return (source.top < dest.top || source.bottom <= dest.top) && source.bottom < dest.bottom;
  }
}

/** Whether `dest` lies wholly beyond `source`'s leading edge in `direction`. */
function isWhollyBeyond(source: Rect, dest: Rect, direction: Direction): boolean {
  switch (direction) {
    case 'left':
      return source.left >= dest.right;
    case 'right':
      return source.right <= dest.left;
    case 'up':
      return source.top >= dest.bottom;
    case 'down':
      return source.bottom <= dest.top;
  }
}

/** Whether `rect` overlaps `source` across the direction of travel. */
export function inBeam(source: Rect, rect: Rect, direction: Direction): boolean {
  return horizontal(direction)
    ? rect.bottom > source.top && rect.top < source.bottom
    : rect.right > source.left && rect.left < source.right;
}

/** Gap from `source`'s leading edge to `dest`'s near edge, in `direction`. */
function majorDistance(source: Rect, dest: Rect, direction: Direction): number {
  const gap = {
    left: source.left - dest.right,
    right: dest.left - source.right,
    up: source.top - dest.bottom,
    down: dest.top - source.bottom,
  }[direction];
  return Math.max(0, gap);
}

/** Distance from `source`'s leading edge to `dest`'s far edge, in `direction`. */
function majorDistanceToFarEdge(source: Rect, dest: Rect, direction: Direction): number {
  const gap = {
    left: source.left - dest.left,
    right: dest.right - source.right,
    up: source.top - dest.top,
    down: dest.bottom - source.bottom,
  }[direction];
  return Math.max(1, gap);
}

/** Offset between the centres, across the direction of travel. */
function minorDistance(source: Rect, dest: Rect, direction: Direction): number {
  return horizontal(direction)
    ? Math.abs((source.top + source.bottom) / 2 - (dest.top + dest.bottom) / 2)
    : Math.abs((source.left + source.right) / 2 - (dest.left + dest.right) / 2);
}

function weightedDistance(source: Rect, dest: Rect, direction: Direction): number {
  const major = majorDistance(source, dest, direction);
  const minor = minorDistance(source, dest, direction);
  return 13 * major * major + minor * minor;
}

/** Whether `a`, being in the beam, wins over `b`, which isn't. */
function beamBeats(source: Rect, a: Rect, b: Rect, direction: Direction): boolean {
  const aInBeam = inBeam(source, a, direction);
  if (!aInBeam || inBeam(source, b, direction)) return false;
  // `b` overlaps the source along the way; sideways, staying on the line wins.
  if (!isWhollyBeyond(source, b, direction) || horizontal(direction)) return true;
  // Up and down, unless `b` is on a nearer line than `a`.
  return majorDistance(source, a, direction) < majorDistanceToFarEdge(source, b, direction);
}

/** Whether `a` is a better destination than `b` from `source`. */
function isBetter(source: Rect, a: Rect, b: Rect, direction: Direction): boolean {
  if (beamBeats(source, a, b, direction)) return true;
  if (beamBeats(source, b, a, direction)) return false;
  return weightedDistance(source, a, direction) < weightedDistance(source, b, direction);
}

/** The nearest of `candidates` from `source` in `direction`, if any lies that way. */
export function findNearest<T extends { rect: Rect }>(
  source: Rect,
  candidates: readonly T[],
  direction: Direction,
): T | undefined {
  let best: T | undefined;
  for (const candidate of candidates) {
    if (!isCandidate(source, candidate.rect, direction)) continue;
    if (!best || isBetter(source, candidate.rect, best.rect, direction)) best = candidate;
  }
  return best;
}

/**
 * The last-focused item of each group, so returning to a row lands where it
 * was left. Groups are held weakly: a group that leaves the page is forgotten.
 */
export class FocusMemory<G extends object, E> {
  private readonly items = new WeakMap<G, E>();

  /** Records `target` as the last focused in each of its groups. */
  remember(groups: readonly G[], target: E): void {
    for (const group of groups) this.items.set(group, target);
  }

  recall(group: G): E | undefined {
    return this.items.get(group);
  }

  forget(group: G): void {
    this.items.delete(group);
  }
}

interface MoveOptions<G extends object, E, T extends NavItem<G, E>> {
  /** Where focus is now. */
  source: Omit<NavItem<G, E>, 'target'>;
  /** Everything focus could move to (the source may be among them). */
  candidates: readonly T[];
  direction: Direction;
  memory: FocusMemory<G, E>;
  /** Items a group prefers when entered for the first time, such as the selected tab. */
  isPreferred?: (item: T) => boolean;
  /** A group's box, so the sidebar counts as level with every row beside it. */
  groupRect?: (group: G) => Rect;
  /** Sideways to the nearest item anywhere, as from the sidebar into the page. */
  freeSideways?: boolean;
}

/**
 * Sideways, focus moves along the source's group (a row); past its end, or
 * from outside any group, it only leaves for something level with the
 * source, or inside a group that is (the sidebar beside every row), never for
 * the next row down or a control further down the page.
 */
function sidewaysCandidates<G, E, T extends NavItem<G, E>>(
  source: Omit<NavItem<G, E>, 'target'>,
  candidates: readonly T[],
  direction: Direction,
  groupRect: ((group: G) => Rect) | undefined,
): readonly T[] {
  if (!horizontal(direction)) return candidates;
  const own = source.groups[0];
  if (own !== undefined) {
    const inOwn = candidates.filter((candidate) => candidate.groups.includes(own));
    if (findNearest(source.rect, inOwn, direction)) return inOwn;
  }
  return candidates.filter(
    (candidate) =>
      (own === undefined || !candidate.groups.includes(own)) &&
      (inBeam(source.rect, candidate.rect, direction) ||
        candidate.groups.some(
          (group) => groupRect !== undefined && inBeam(source.rect, groupRect(group), direction),
        )),
  );
}

/**
 * Where an arrow key moves focus: the nearest item that way, except that
 * entering a group (a row, the sidebar) lands on the item last focused there,
 * or else the group's preferred item, or else its nearest item in line with
 * the source (a poster below, rather than a link off to the side).
 */
export function chooseMove<G extends object, E, T extends NavItem<G, E>>({
  source,
  candidates,
  direction,
  memory,
  isPreferred,
  groupRect,
  freeSideways = false,
}: MoveOptions<G, E, T>): T | undefined {
  const reachable = freeSideways
    ? candidates
    : sidewaysCandidates(source, candidates, direction, groupRect);
  const nearest = findNearest(source.rect, reachable, direction);
  if (!nearest) return undefined;
  // The outermost group being entered decides: from the sidebar into a row
  // inside a list of rows, the list's memory is the one that counts.
  const entered = nearest.groups.filter((group) => !source.groups.includes(group)).at(-1);
  if (entered === undefined) return nearest;
  const inGroup = candidates.filter((candidate) => candidate.groups.includes(entered));
  const remembered = memory.recall(entered);
  const recalled = inGroup.find((candidate) => candidate.target === remembered);
  if (recalled) return recalled;
  const preferred = isPreferred && inGroup.find(isPreferred);
  if (preferred) return preferred;
  const inLine = inGroup.filter((candidate) => inBeam(source.rect, candidate.rect, direction));
  return findNearest(source.rect, inLine, direction) ?? nearest;
}
