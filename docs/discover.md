# Discover, Movies and TV Shows

Kiro has no catalogue of its own. Discover, Movies and TV Shows are built from the catalogues the enabled addons declare in their manifests, as rows of posters. This page covers which catalogues become rows, how rows load, and how people choose and arrange them.

## Which catalogues become rows

| Page     | Catalogues                                                                      |
| -------- | ------------------------------------------------------------------------------- |
| Discover | Every catalogue of every enabled addon, whatever its type (`movie`, `anime`, …) |
| Movies   | Catalogues of type `movie`, as rows on Overview and as tabs with a full grid    |
| TV Shows | Catalogues of type `series`, the same way                                       |

A catalogue is left out when Kiro can't list it without input from the user: it requires an extra other than a `genre` that lists options (search-only catalogues, Cinemeta's `lastVideosIds` feed), or the addon's `catalog` resource doesn't cover its type. A required genre with options is fine: the first option is used (Cinemeta's "New" opens on the latest year). See `isBrowsableCatalog` and `discoverSources` in `apps/desktop/src/features/discovery/browse-data.ts`.

Row headings read "Popular movies" or "New TV shows" for the two built-in types, and the catalogue's own name for others ("Kitsu Top Airing"), with the addon's name beside it.

## Loading

Each row fetches its catalogue's first page when it comes within a screen of the viewport, through the browse store (`browse-store.ts`), which uses the core's addon transport (https only, timeouts, size caps) and validates the response with `@kiro/addon-sdk`. Rows are independent: a slow addon shows a placeholder row while the others fill in, and a failing one shows its error with Retry. Feeds are kept across navigation, so "See all" opens with the row's items already loaded.

The hero on Discover features a title from the first three shown rows: the first that has answered, waiting up to 2.5 s for an earlier one, so a slow first addon doesn't hold up the page. Once a title is featured it stays.

Artwork follows the item's `posterShape`: `poster` (2:3) cards are 9.5 rem wide, `landscape` (16:9) 16.5 rem and `square` 11.5 rem, so they stay about as tall as each other. Grids pick their column width from the catalogue's first item.

## Customising

**Customise** on Discover (beside "Continue watching") and on Movies and TV Shows (beside the title) opens an editor:

- **On Discover**: the shown rows in order. Drag a row by its handle, or use the up and down buttons; the eye button hides it.
- **Catalogues**: every available catalogue, grouped by addon, with a switch to show or hide it. A hidden row keeps its place, so showing it again puts it back where it was.
- **Reset to default** forgets the page's layout: every catalogue, in addon order (Settings → Addons) and then manifest order.

Changes are saved as they are made. With the keys or a remote, the arrows move between the controls (the editor is a `data-nav-layer`), Enter presses them, and Escape or Back closes the editor and returns focus to Customise. Moving or hiding a row keeps focus on the same control, or on the next row's when the row leaves the list. Move up on the first row (and Move down on the last) does nothing rather than turning off, so focus never drops out of the list.

## How layouts are kept

Layouts are saved by the core in `settings.json` (format 3), section `rows`, one list per page (`discover`, `movies`, `tvShows`). `null` means the default. Each entry names a catalogue by **addon id, content type and catalogue id**, with a `hidden` flag:

```json
"rows": {
  "discover": [
    { "addon": "community.anime.kitsu", "type": "anime", "catalog": "kitsu-anime-airing", "hidden": false },
    { "addon": "com.linvo.cinemeta", "type": "movie", "catalog": "top", "hidden": true }
  ],
  "movies": null,
  "tvShows": null
}
```

These survive addon updates, reinstalls from another URL and restarts. The core validates entries when saving (`settings/rows.rs`: addon ids as manifests allow them, bounded type and catalogue ids, no duplicates, at most 500 per page) and, when reading, keeps the well-formed, distinct entries of each list and ignores fields it doesn't know. The renderer applies a layout in `features/discovery/row-layout.ts` (unit-tested in `row-layout.test.ts`):

- Entries nothing provides are ignored on the page but kept in the layout. **An addon that is turned off or uninstalled** loses its rows at once, and gets them back in the same places, shown or hidden as before, if it returns.
- **A catalogue the layout doesn't know** joins it shown: after its addon's other rows when the addon is already in the layout (a catalogue an update adds), otherwise at the end.
- Without a saved layout, rows follow the default order, so new addons simply appear last.

### New addons are added, not just offered

When a layout is saved and a newly installed addon brings catalogues, they are added to the end of Discover (and of Movies or TV Shows, by type) straight away, and Discover shows "New rows from _addon_" beside Customise until the note is dismissed or the layout is next changed, which records them.

Installing an addon with catalogues is a clear sign of wanting to see them, and its rows not appearing anywhere was the problem this feature set out to fix. Adding them at the end leaves the user's arrangement above untouched, and the note says what changed and where to undo it. Offering them only in the editor would have made a new addon look broken until someone found the editor.

## Trying it in the browser

`pnpm --filter @kiro/desktop dev:renderer` starts the renderer with the preview backend (`src/dev/preview-backend.ts`). It installs Cinemeta, Anime Kitsu (live, when reachable) and a local "Preview Channels" addon with wide and square artwork, a catalogue that takes 8 s, one that fails, and a search-only one that is skipped. Settings, layouts included, are kept in `localStorage['kiro.preview.settings']` so they survive a reload; remove the key to start over.
