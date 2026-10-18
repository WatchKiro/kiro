import {
  Clapperboard,
  Compass,
  Film,
  LayoutGrid,
  Library,
  Puzzle,
  Settings,
  Sparkles,
  Tv,
  type LucideIcon,
} from 'lucide-react';

/** Static metadata attached to routes via `handle`. */
export interface RouteHandle {
  /** The page's name, used for the window title. */
  title: string;
  /** Show a Back button in the header (pages reached from another page). */
  back?: boolean;
}

export interface NavItem {
  to: string;
  label: string;
  icon: LucideIcon;
}

export interface NavSection {
  label: string;
  items: NavItem[];
}

/** Primary navigation. Route paths are defined once here and reused by the router. */
export const NAV_SECTIONS: NavSection[] = [
  {
    label: 'Browse',
    items: [
      { to: '/', label: 'Discover', icon: Compass },
      { to: '/movies', label: 'Movies', icon: Film },
      { to: '/tv', label: 'TV Shows', icon: Tv },
    ],
  },
  {
    label: 'Your Kiro',
    items: [
      { to: '/library', label: 'Library', icon: Library },
      { to: '/addons', label: 'Addons', icon: Puzzle },
    ],
  },
];

/**
 * The icon for a content type's browse page. Addons can list types beyond
 * movies and series (Anime Kitsu's `anime`); each gets a page and a sidebar
 * entry under Browse.
 */
export function contentTypeIcon(type: string): LucideIcon {
  if (type === 'movie') return Film;
  if (type === 'series' || type === 'tv') return Tv;
  if (type === 'anime') return Sparkles;
  return LayoutGrid;
}

export const SETTINGS_NAV_ITEM: NavItem = { to: '/settings', label: 'Settings', icon: Settings };

/** The player's source picker (test streams), shown in development builds only. */
export const DEV_NAV_ITEMS: NavItem[] = import.meta.env.DEV
  ? [{ to: '/player', label: 'Player (debug)', icon: Clapperboard }]
  : [];
