import { KiroMark } from '@kiro/ui';
import { cx } from '@kiro/utils';
import { PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { useEffect, useMemo } from 'react';
import { NavLink } from 'react-router';

import {
  contentTypeIcon,
  DEV_NAV_ITEMS,
  NAV_SECTIONS,
  SETTINGS_NAV_ITEM,
  type NavItem,
  type NavSection,
} from '@/app/navigation';
import { useAddonsStore } from '@/features/addons/addons-store';
import { otherTypes, sectionFor } from '@/features/discovery/browse-data';
import { ProfileMenu } from '@/features/profiles/profile-menu';
import { UpdatePrompt } from '@/features/updates/update-prompt';
import { isNativeRuntime } from '@/services/native';
import { useUiStore } from '@/stores/ui-store';

export function Sidebar() {
  const collapsed = useUiStore((state) => state.sidebarCollapsed);
  const toggleSidebar = useUiStore((state) => state.toggleSidebar);
  const ToggleIcon = collapsed ? PanelLeftOpen : PanelLeftClose;
  const sections = useNavSections();

  return (
    <aside
      aria-label="Sidebar"
      // Left from the page reaches it, at the current page's link.
      data-nav-group
      data-nav-side
      className={cx(
        'relative z-40 flex shrink-0 flex-col border-r border-white/[0.06] bg-ink-950 transition-[width] duration-300 ease-out-soft select-none',
        collapsed ? 'w-[4.25rem]' : 'w-58',
      )}
    >
      <div
        className={cx(
          'flex h-16 shrink-0 items-center gap-2.5',
          collapsed ? 'justify-center' : 'px-5',
        )}
      >
        <KiroMark className="size-7 shadow-[0_6px_20px_-6px_rgb(132_60_251/0.8)]" />
        {!collapsed && (
          <span className="text-base font-semibold tracking-[-0.01em] text-ink-50">Kiro</span>
        )}
      </div>

      <nav aria-label="Main" className="flex-1 overflow-y-auto px-3 pt-2">
        {sections.map((section) => (
          <div key={section.label} className="mb-6">
            {collapsed ? (
              <div aria-hidden className="mx-2 mb-3 h-px bg-white/[0.06]" />
            ) : (
              <p className="mb-2 px-2.5 text-[11px] font-semibold tracking-[0.08em] text-ink-500 uppercase">
                {section.label}
              </p>
            )}
            <ul className="space-y-0.5">
              {section.items.map((item) => (
                <li key={item.to}>
                  <SidebarLink item={item} collapsed={collapsed} />
                </li>
              ))}
            </ul>
          </div>
        ))}
      </nav>

      <UpdatePrompt collapsed={collapsed} />

      <div className="space-y-0.5 border-t border-white/[0.06] p-3">
        <ProfileMenu collapsed={collapsed} />
        {DEV_NAV_ITEMS.map((item) => (
          <SidebarLink key={item.to} item={item} collapsed={collapsed} />
        ))}
        <SidebarLink item={SETTINGS_NAV_ITEM} collapsed={collapsed} />
        <button
          type="button"
          onClick={toggleSidebar}
          aria-label={collapsed ? 'Expand sidebar' : 'Collapse sidebar'}
          aria-expanded={!collapsed}
          className={cx(
            'flex h-9.5 w-full cursor-pointer items-center gap-3 rounded-[10px] px-2.5 text-sm text-ink-500 transition-colors hover:bg-white/[0.04] hover:text-ink-200',
            'focus-visible:focus-ring',
            collapsed && 'justify-center',
          )}
        >
          <ToggleIcon aria-hidden className="size-[18px] shrink-0" />
          {!collapsed && 'Collapse'}
        </button>
      </div>
    </aside>
  );
}

/**
 * The main navigation, with a Browse entry for each content type beyond
 * movies and series that an installed addon lists (Anime Kitsu's Anime).
 */
function useNavSections(): NavSection[] {
  const addons = useAddonsStore((state) => state.addons);
  const loadAddons = useAddonsStore((state) => state.load);
  useEffect(() => {
    if (isNativeRuntime()) void loadAddons();
  }, [loadAddons]);

  return useMemo(() => {
    const extra: NavItem[] = otherTypes(addons).map((type) => {
      const { path, title } = sectionFor(type);
      return { to: path, label: title, icon: contentTypeIcon(type) };
    });
    if (extra.length === 0) return NAV_SECTIONS;
    return NAV_SECTIONS.map((section, index) =>
      index === 0 ? { ...section, items: [...section.items, ...extra] } : section,
    );
  }, [addons]);
}

function SidebarLink({
  item: { to, label, icon: Icon },
  collapsed,
}: {
  item: NavItem;
  collapsed: boolean;
}) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      title={collapsed ? label : undefined}
      aria-label={collapsed ? label : undefined}
      className={({ isActive }) =>
        cx(
          'relative flex h-9.5 items-center gap-3 rounded-[10px] px-2.5 text-sm transition-colors duration-150',
          'focus-visible:focus-ring',
          isActive
            ? 'bg-linear-to-r from-accent/20 to-accent/[0.04] font-medium text-ink-50 before:absolute before:inset-y-2 before:-left-3 before:w-[3px] before:rounded-r-full before:bg-accent'
            : 'text-ink-400 hover:bg-white/[0.04] hover:text-ink-100',
          collapsed && 'justify-center',
        )
      }
    >
      {({ isActive }) => (
        <>
          <Icon
            aria-hidden
            className={cx('size-[18px] shrink-0', isActive && 'text-accent-strong')}
          />
          {!collapsed && <span className="truncate">{label}</span>}
        </>
      )}
    </NavLink>
  );
}
