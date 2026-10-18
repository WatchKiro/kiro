import { Search } from 'lucide-react';
import { useEffect, useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import { useLocation, useNavigate } from 'react-router';

import {
  MAX_QUERY_LENGTH,
  MIN_LIVE_QUERY_LENGTH,
  SEARCH_DEBOUNCE_MS,
  normalizeQuery,
  searchPath,
} from '@/features/search/search-data';
import { usesCommandKey } from '@/lib/platform';

const SEARCH_PATH = '/search';

/**
 * The header search box. Typing searches after a short pause; Enter searches
 * immediately. ⌘K / Ctrl+K focuses it from anywhere and Escape clears it.
 *
 * The box mirrors `?q=` while the search page is open and is empty
 * elsewhere, so Back and Forward restore the query that was searched.
 */
export function SearchBox() {
  const navigate = useNavigate();
  const location = useLocation();
  const onSearchPage = location.pathname === SEARCH_PATH;
  const urlQuery = onSearchPage
    ? normalizeQuery(new URLSearchParams(location.search).get('q') ?? '')
    : '';

  const [value, setValue] = useState(urlQuery);
  const [focused, setFocused] = useState(false);
  /** A query this box navigated to, whose arrival in the URL must not reset the text. */
  const [submitted, setSubmitted] = useState<string | null>(null);
  const [seenUrlQuery, setSeenUrlQuery] = useState(urlQuery);
  if (urlQuery !== seenUrlQuery) {
    setSeenUrlQuery(urlQuery);
    // The text may have moved on while the search was debounced; keep it.
    if (urlQuery === submitted) setSubmitted(null);
    else setValue(urlQuery);
  }

  const inputRef = useRef<HTMLInputElement>(null);
  const debounce = useRef<ReturnType<typeof setTimeout>>(undefined);
  const cancelDebounce = () => clearTimeout(debounce.current);

  // Navigating elsewhere drops a pending live search.
  useEffect(() => () => clearTimeout(debounce.current), [location.key]);

  // ⌘K / Ctrl+K focuses the box from anywhere in the app.
  useEffect(() => {
    const command = usesCommandKey();
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key.toLowerCase() !== 'k' || event.altKey || event.shiftKey) return;
      if (!(command ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      event.preventDefault();
      inputRef.current?.focus();
      inputRef.current?.select();
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, []);

  const submit = (text: string) => {
    cancelDebounce();
    const query = normalizeQuery(text);
    if (onSearchPage ? query === urlQuery : !query) return;
    setSubmitted(query);
    // Refining a search replaces the entry, so Back leaves the search page.
    void navigate(searchPath(query), { replace: onSearchPage });
  };

  const onChange = (text: string) => {
    setValue(text);
    cancelDebounce();
    const query = normalizeQuery(text);
    // Clearing the box on the search page clears the results too.
    if (query.length >= MIN_LIVE_QUERY_LENGTH || (onSearchPage && !query)) {
      debounce.current = setTimeout(() => submit(text), SEARCH_DEBOUNCE_MS);
    }
  };

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    submit(value);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'Escape') return;
    event.preventDefault();
    cancelDebounce();
    if (value) {
      setValue('');
      if (onSearchPage) submit('');
    } else {
      event.currentTarget.blur();
    }
  };

  const shortcut = usesCommandKey() ? '⌘K' : 'Ctrl K';

  return (
    <form
      role="search"
      onSubmit={onSubmit}
      className="relative mx-auto flex w-full max-w-md items-center"
    >
      <label htmlFor="kiro-search" className="sr-only">
        Search movies and shows
      </label>
      <Search
        aria-hidden
        className="pointer-events-none absolute left-3.5 z-10 size-4 text-ink-400"
      />
      <input
        ref={inputRef}
        id="kiro-search"
        type="search"
        value={value}
        maxLength={MAX_QUERY_LENGTH}
        autoComplete="off"
        autoCorrect="off"
        spellCheck={false}
        placeholder="Search movies and shows"
        aria-keyshortcuts={usesCommandKey() ? 'Meta+K' : 'Control+K'}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        className="h-10 w-full rounded-full border border-white/10 bg-ink-950/40 pr-16 pl-10 text-sm text-ink-100 backdrop-blur-xl transition-colors placeholder:text-ink-400 focus:border-accent/50 focus:bg-ink-950/70 focus:outline-none [&::-webkit-search-cancel-button]:hidden"
      />
      {!focused && !value && (
        <kbd className="pointer-events-none absolute right-3.5 font-sans text-[11px] font-medium text-ink-500">
          {shortcut}
        </kbd>
      )}
    </form>
  );
}
