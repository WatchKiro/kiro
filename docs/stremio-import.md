# Import from Stremio

Settings → Import from Stremio brings a Stremio account's addons, library and watch progress into Kiro in one go. A link on the Discover welcome screen leads there. Kiro has no first-run setup yet; when it gets one, it should offer this too.

## The flow

1. **Sign in.** Paste an auth key (recommended) or enter an email and password.
2. **Preview.** The core reads the account and shows what it holds, for example "12 addons, 140 library items, 38 in progress". There is a checkbox for each part: addons, library (watchlist) and watch progress.
3. **Import**, with a progress bar. The library is merged first (one step), then each new addon is installed in turn.
4. **Summary.** What was added, skipped and failed, with a reason for each addon.

Every step works with the keys alone. Each step moves focus to its main control, and the button rows are nav groups, so Down from the choices lands on Import.

## Stremio's API

The account API isn't formally documented. Its shapes come from Stremio's own open-source clients ([stremio-core](https://github.com/Stremio/stremio-core) `types/api`, [stremio-api-client](https://github.com/Stremio/stremio-api-client)), which community tools use too. Every call is a JSON `POST` to `https://api.strem.io/api/<method>` and is answered with `{ "result": … }` or `{ "error": { "code", "message" } }`.

| Method               | Body                                                                 | Result                                                                    |
| -------------------- | -------------------------------------------------------------------- | ------------------------------------------------------------------------- |
| `login`              | `{ "type": "Login", "email", "password", "facebook": false }`        | `{ "authKey", "user" }`                                                   |
| `logout`             | `{ "type": "Logout", "authKey" }`                                    | `{ "success": true }`                                                     |
| `addonCollectionGet` | `{ "type": "AddonCollectionGet", "authKey", "update": true }`        | `{ "addons": [{ "transportUrl", "manifest", "flags" }], "lastModified" }` |
| `datastoreGet`       | `{ "authKey", "collection": "libraryItem", "ids": [], "all": true }` | `[LibraryItem]`                                                           |

A bad or expired key gets `{"error":{"code":1,"message":"Session does not exist"}}` (`logout` answers with code 40).

A library item (`stremio-core`'s `LibraryItem`), abridged:

```json
{
  "_id": "tt0903747",
  "type": "series",
  "name": "…",
  "poster": "https://…",
  "removed": false,
  "temp": false,
  "_ctime": "2023-01-14T19:20:31.441Z",
  "_mtime": "2024-02-10T21:03:12.004Z",
  "state": {
    "lastWatched": "2024-02-10T21:03:11.998Z",
    "timeOffset": 1320456,
    "duration": 2820000,
    "video_id": "tt0903747:5:16",
    "timesWatched": 0,
    "flaggedWatched": 0,
    "watched": "tt0903747:5:15:<bitfield>"
  }
}
```

Times are milliseconds. `removed` items were taken out of the library. `temp` items were watched without being added to it (Stremio shows them in Continue watching only). Stremio keeps one progress entry per title, for the latest video.

`link.stremio.com` also offers a "log in with a code" flow: `GET /api/v2/create?type=Create` returns `{ code, link, qrcode }`, and the user approves the code at the link. That would avoid handling any credential, but how its `read` call reports a code that is still pending couldn't be checked without an account. Its four-character codes also look guessable while a code is waiting to be approved. It's a candidate for later, once it has been tried with a real account.

## Terms

Stremio's [terms](https://www.stremio.com/tos) don't mention third-party clients or the API. §5.4.1 forbids "monitoring, copying or extracting any information from Stremio", including its Database, "by automated means". The terms define the Database as the Provider's compilation of content metadata. §3.4 asks users not to disclose their username and password to third parties. The [privacy policy](https://www.stremio.com/privacy) gives users the right to their personal data "in a portable format".

How Kiro reads that:

- The import reads only the user's own data (their library, progress and addon list), once, when they ask for it. It never reads Stremio's catalogue or metadata.
- The auth key path is the default, so Kiro never handles a password. The email and password path sends the credentials only to Stremio's own API, from the user's own device.
- The API is the one Stremio's open-source (GPL) clients use, and community addon managers use the same calls.

Nothing in the terms clearly forbids this, so the import was built. If Stremio objects, the import is one Settings section and one Rust module, and is easy to remove.

## Credentials

- They go from the form straight to the core (`stremio_import_fetch`), which sends them to `https://api.strem.io` over TLS. The Stremio client refuses redirects, so a request carrying credentials only ever reaches the endpoint it was written for.
- They are used for that one call. With email and password, Kiro signs in, reads the account, then signs that new session out, even when reading fails. A pasted key is the user's own browser session, so Kiro leaves it alone.
- They are never stored or logged. `stremio::api::Secret` has a redacted `Debug` and no `Serialize` or `Clone`. Errors are Kiro's own messages, never Stremio's text. The form clears the fields once it has sent them. A test signs in both ways against a fake Stremio, imports, and then checks that no file in the profile contains the key, the password or the email.
- What stays in memory between preview and import is the account's data, mapped to Kiro's types. It is never the credentials. It is dropped after the import, on Cancel, or when Settings is left.

## Mapping

**Addons.** They are installed in Stremio's order, after whatever Kiro already has, so Kiro's defaults stay first. Each goes through the usual install path (`addonsStore.install`): Kiro fetches the manifest again from its URL and validates it with `@kiro/addon-sdk`. Stremio's stored copy is not trusted. Skipped:

- addons already installed (the same manifest URL);
- URLs that aren't https, or that point at Stremio's own local server (for example Local Files, `http://127.0.0.1:11470/…`).

Addons that need configuring first, or whose manifest doesn't validate, are reported as failed.

**Library** (Kiro's watchlist). These are items that are neither `removed` nor `temp`. An item keeps the date it was added to Stremio (`_ctime`, else `_mtime`). Titles already on the watchlist are left as they are. Items of type `other` (pasted links) and items without a name are skipped.

**Watch progress** (Kiro's history). Each item with a duration gets one entry, for `state.video_id` (or the film itself):

- `position` is `timeOffset`. Stremio rewinds a finished video to 0 and counts it in `timesWatched` or `flaggedWatched`; Kiro then keeps it at the end.
- `completed` uses Kiro's own rule: position ≥ duration × the "Mark as watched at" setting.
- Season and episode come from ids like `tt0903747:5:16`.
- `updated_at` is `lastWatched` (else `_mtime`), so Continue watching orders imported titles by when they were really watched.
- Items removed from the library (and not `temp`) are skipped, as Stremio hides them too. Per-episode watched flags (the `watched` bitfield) aren't imported.

**Merging.** Imports never overwrite newer Kiro data. For each video, imported progress replaces Kiro's only if it was watched later. Otherwise it is skipped, so importing twice changes nothing. Each part is imported in one transaction.

All Stremio data is treated as untrusted. Fields are read one at a time, so an odd field costs only that field, or that item when it's essential. Display names, posters (https only), types and ids pass the same validation as the player's own saves. Responses are capped at 8 MB and 20,000 items, with the addon transport's timeouts.

## Code

| Where                                        | What                                                                       |
| -------------------------------------------- | -------------------------------------------------------------------------- |
| `src-tauri/src/stremio/api.rs`               | The API calls, `SignIn` and `Secret`, error messages                       |
| `src-tauri/src/stremio/data.rs`              | Reading and mapping the addon collection and library items                 |
| `src-tauri/src/stremio/mod.rs`               | Fetch, then apply or discard (`StremioImport`)                             |
| `src-tauri/src/library/mod.rs`               | `import_watchlist`, `import_history` (the merge rules)                     |
| `src-tauri/src/commands/stremio.rs`          | `stremio_import_fetch`, `stremio_import_library`, `stremio_import_discard` |
| `src-tauri/capabilities/stremio-import.json` | Grants exactly those three commands                                        |
| `src/features/stremio-import/`               | The import flow (`runImport`, tested) and the Settings section             |
| `src-tauri/src/stremio/fixtures/`            | Anonymised responses in Stremio's shapes, used by the tests                |

The fixtures follow `stremio-core`'s types and the live API's error replies. They weren't recorded from a real account. The import has been tested against those fixtures and a fake Stremio server, but not against a real account yet.
