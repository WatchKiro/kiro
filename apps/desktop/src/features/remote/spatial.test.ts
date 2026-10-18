import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  FocusMemory,
  chooseMove,
  findNearest,
  inBeam,
  isCandidate,
  type NavItem,
  type Rect,
} from '@/features/remote/spatial';

/** A box at (x, y), `w` by `h`. */
const box = (x: number, y: number, w = 100, h = 150): Rect => ({
  left: x,
  top: y,
  right: x + w,
  bottom: y + h,
});

interface Group {
  name: string;
}
type Item = NavItem<Group, string>;

const item = (target: string, rect: Rect, ...groups: Group[]): Item => ({ target, rect, groups });

/** A row of `count` posters 100 wide with 20 between them, starting at `x`. */
function row(name: string, y: number, count: number, x = 0, ...outer: Group[]) {
  const group = { name };
  const items = Array.from({ length: count }, (_, index) =>
    item(`${name}${index}`, box(x + index * 120, y), group, ...outer),
  );
  return { group, items };
}

const nearest = (from: Item, items: readonly Item[], direction: 'up' | 'down' | 'left' | 'right') =>
  findNearest(from.rect, items, direction)?.target;

describe('isCandidate', () => {
  const source = box(200, 200);

  it('takes only what lies further in the direction', () => {
    assert.equal(isCandidate(source, box(320, 200), 'right'), true);
    assert.equal(isCandidate(source, box(80, 200), 'right'), false);
    assert.equal(isCandidate(source, box(80, 200), 'left'), true);
    assert.equal(isCandidate(source, box(200, 400), 'down'), true);
    assert.equal(isCandidate(source, box(200, 400), 'up'), false);
    assert.equal(isCandidate(source, box(200, 0), 'up'), true);
  });

  it('takes an overlapping item that reaches further, but not the source itself', () => {
    assert.equal(isCandidate(source, box(250, 200), 'right'), true);
    assert.equal(isCandidate(source, source, 'right'), false);
    assert.equal(isCandidate(source, box(150, 150, 200, 200), 'right'), false);
  });
});

describe('inBeam', () => {
  it('compares across the direction of travel', () => {
    assert.equal(inBeam(box(0, 0), box(500, 100), 'right'), true);
    assert.equal(inBeam(box(0, 0), box(500, 150), 'right'), false);
    assert.equal(inBeam(box(0, 0), box(50, 500), 'down'), true);
    assert.equal(inBeam(box(0, 0), box(100, 500), 'down'), false);
  });
});

describe('findNearest', () => {
  const first = row('a', 0, 5);
  const second = row('b', 220, 5);
  const all = [...first.items, ...second.items];
  const [a0, a1, a2] = first.items as [Item, Item, Item];
  const [b0, , b2] = second.items as [Item, Item, Item];

  it('moves along a row', () => {
    assert.equal(nearest(a1, all, 'right'), 'a2');
    assert.equal(nearest(a1, all, 'left'), 'a0');
  });

  it('moves between rows to the item straight above or below', () => {
    assert.equal(nearest(a2, all, 'down'), 'b2');
    assert.equal(nearest(b2, all, 'up'), 'a2');
  });

  it('stops at the edges instead of wrapping', () => {
    assert.equal(nearest(a0, all, 'left'), undefined);
    assert.equal(nearest(a0, all, 'up'), undefined);
    assert.equal(nearest(second.items[4] as Item, all, 'right'), undefined);
    assert.equal(nearest(b0, all, 'down'), undefined);
  });

  it('finds items scrolled out of view, as far along the row as they are', () => {
    // A row scrolled sideways: its first items sit left of the window.
    const scrolled = row('s', 0, 6, -480);
    const visible = scrolled.items[4] as Item;
    assert.equal(nearest(visible, scrolled.items, 'left'), 's3');
    assert.equal(nearest(scrolled.items[1] as Item, scrolled.items, 'left'), 's0');
    // And rows below the fold.
    const below = item('far', box(0, 4000));
    assert.equal(nearest(b0, [...all, below], 'down'), 'far');
  });

  it('skips over an empty row', () => {
    // A row with nothing focusable (still loading) adds no candidates.
    const third = row('c', 660, 3);
    assert.equal(nearest(b0, [...all, ...third.items], 'down'), 'c0');
  });

  it('stays on the same line sideways, even past a nearer item off the line', () => {
    const offLine = item('off', box(130, 160, 40, 40));
    assert.equal(nearest(a0, [...first.items, offLine], 'right'), 'a1');
  });

  it('goes to the nearer line before one further down that is in the beam', () => {
    // From a button on the right, Down reaches the row below, even though
    // only something much further down lines up with it.
    const button = item('button', box(900, 0, 80, 40));
    const shortRow = row('short', 100, 2);
    const aligned = item('aligned', box(900, 900));
    assert.equal(nearest(button, [...shortRow.items, aligned], 'down'), 'short1');
  });

  it('prefers the item in line when another one is only slightly nearer', () => {
    const play = item('play', box(40, 0, 120, 48));
    const seeAll = item('see-all', box(1200, 80, 60, 20));
    const poster = item('poster', box(40, 130));
    assert.equal(nearest(play, [seeAll, poster], 'down'), 'poster');
  });

  it('weighs distance along the direction more than distance across it', () => {
    // From the sidebar, Right goes to the hero button level with it, not to
    // the search field further right and above.
    const link = item('link', box(12, 300, 200, 38));
    const search = item('search', box(600, 12, 440, 40));
    const play = item('play', box(272, 520, 120, 48));
    assert.equal(nearest(link, [search, play], 'right'), 'play');
  });

  it('returns nothing without candidates', () => {
    assert.equal(nearest(a0, [], 'right'), undefined);
  });
});

describe('FocusMemory', () => {
  it('remembers the last item per group, and forgets', () => {
    const memory = new FocusMemory<Group, string>();
    const outer = { name: 'outer' };
    const inner = { name: 'inner' };
    memory.remember([inner, outer], 'x');
    memory.remember([outer], 'y');
    assert.equal(memory.recall(inner), 'x');
    assert.equal(memory.recall(outer), 'y');
    memory.forget(inner);
    assert.equal(memory.recall(inner), undefined);
  });
});

describe('chooseMove', () => {
  const sidebar = { name: 'sidebar' };
  const links = [0, 1, 2].map((index) =>
    item(`link${index}`, box(0, 100 + index * 50, 200, 38), sidebar),
  );
  const first = row('a', 100, 6, 260);
  const second = row('b', 320, 6, 260);
  const all = [...links, ...first.items, ...second.items];
  const at = (target: string) => all.find((candidate) => candidate.target === target) as Item;

  it('moves to the nearest item when no group is entered', () => {
    const memory = new FocusMemory<Group, string>();
    const move = chooseMove({ source: at('a1'), candidates: all, direction: 'right', memory });
    assert.equal(move?.target, 'a2');
  });

  it('returns to the item last focused in a row', () => {
    const memory = new FocusMemory<Group, string>();
    memory.remember([second.group], 'b4');
    const move = chooseMove({ source: at('a1'), candidates: all, direction: 'down', memory });
    assert.equal(move?.target, 'b4');
  });

  it('ignores the memory of the row it is moving within', () => {
    const memory = new FocusMemory<Group, string>();
    memory.remember([first.group], 'a5');
    const move = chooseMove({ source: at('a1'), candidates: all, direction: 'right', memory });
    assert.equal(move?.target, 'a2');
  });

  it('falls back to the nearest item when the remembered one is gone', () => {
    const memory = new FocusMemory<Group, string>();
    memory.remember([second.group], 'b4');
    const without = all.filter((candidate) => candidate.target !== 'b4');
    const move = chooseMove({ source: at('a1'), candidates: without, direction: 'down', memory });
    assert.equal(move?.target, 'b1');
  });

  it('lands on the preferred item of a group entered for the first time', () => {
    const memory = new FocusMemory<Group, string>();
    const move = chooseMove({
      source: at('b0'),
      candidates: all,
      direction: 'left',
      memory,
      isPreferred: (candidate) => candidate.target === 'link0',
      groupRect: (group) => (group === sidebar ? box(0, 0, 200, 1000) : box(0, 0, 0, 0)),
    });
    assert.equal(move?.target, 'link0');
  });

  it('lands in line with the source when a group is entered for the first time', () => {
    // A row with "See all" above its right end: coming down from the right of
    // the row above lands on the poster below, not on the nearer link.
    const section = { name: 'section' };
    const seeAll = item('see-all', box(1200, 300, 60, 20), section);
    const posters = row('p', 340, 8, 260, section);
    const from = item('from', box(1020, 100));
    const move = chooseMove({
      source: from,
      candidates: [from, seeAll, ...posters.items],
      direction: 'down',
      memory: new FocusMemory<Group, string>(),
    });
    assert.equal(move?.target, 'p6');
    // Without the group, the nearer link wins.
    assert.equal(
      nearest(from, [item('see-all', seeAll.rect), ...row('q', 340, 8, 260).items], 'down'),
      'see-all',
    );
  });

  it('stops at the end of a row instead of dropping to the next one', () => {
    const memory = new FocusMemory<Group, string>();
    const short = row('s', 100, 2, 260);
    const below = row('t', 320, 6, 260);
    const candidates = [...links, ...short.items, ...below.items];
    const end = short.items[1] as Item;
    assert.equal(chooseMove({ source: end, candidates, direction: 'right', memory }), undefined);
    // Without groups, the nearest item that way is in the next row.
    const loose = [...short.items, ...below.items].map(({ target, rect }) => item(target, rect));
    assert.equal(nearest(item('s1', end.rect), loose, 'right'), 't2');
  });

  it('leaves a row sideways for a group level with it, such as the sidebar', () => {
    const memory = new FocusMemory<Group, string>();
    // A row below the sidebar's links: none of them is level with it, but the
    // sidebar itself runs the height of the window.
    const low = row('low', 700, 4, 260);
    const candidates = [...links, ...low.items];
    const sidebarRect = box(0, 0, 220, 1000);
    const move = chooseMove({
      source: low.items[0] as Item,
      candidates,
      direction: 'left',
      memory,
      isPreferred: (candidate) => candidate.target === 'link1',
      groupRect: (group) => (group === sidebar ? sidebarRect : box(0, 0, 0, 0)),
    });
    assert.equal(move?.target, 'link1');
    assert.equal(
      chooseMove({ source: low.items[0] as Item, candidates, direction: 'left', memory }),
      undefined,
    );
  });

  it('keeps sideways moves level from items outside any group, unless told not to', () => {
    // The last control in a settings row: Right doesn't jump to one further
    // down the page.
    const memory = new FocusMemory<Group, string>();
    const control = item('colour', box(600, 100, 40, 30));
    const below = item('below', box(800, 600, 30, 30));
    const level = item('level', box(900, 105, 30, 20));
    assert.equal(
      chooseMove({ source: control, candidates: [below], direction: 'right', memory }),
      undefined,
    );
    assert.equal(
      chooseMove({ source: control, candidates: [below, level], direction: 'right', memory })
        ?.target,
      'level',
    );
    // From the sidebar, Right reaches the page wherever it is.
    assert.equal(
      chooseMove({
        source: control,
        candidates: [below],
        direction: 'right',
        memory,
        freeSideways: true,
      })?.target,
      'below',
    );
  });

  it('uses the outermost group entered', () => {
    const shelf = { name: 'shelf' };
    const inner = row('i', 100, 3, 260, shelf);
    const lower = row('j', 320, 3, 260, shelf);
    const candidates = [...links, ...inner.items, ...lower.items];
    const memory = new FocusMemory<Group, string>();
    memory.remember([lower.group, shelf], 'j2');
    memory.remember([inner.group], 'i1');
    const move = chooseMove({
      source: links[0] as Item,
      candidates,
      direction: 'right',
      memory,
    });
    assert.equal(move?.target, 'j2');
  });

  it('returns nothing at an edge', () => {
    const memory = new FocusMemory<Group, string>();
    const move = chooseMove({ source: at('a5'), candidates: all, direction: 'right', memory });
    assert.equal(move, undefined);
  });
});
