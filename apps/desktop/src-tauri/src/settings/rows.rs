//! Which catalogue rows Discover, Movies and TV Shows show, and in what
//! order.
//!
//! A page without a saved layout shows every catalogue of the enabled
//! addons, in addon order then manifest order. Once the user arranges a page,
//! its layout lists rows by addon id, content type and catalogue id: stable
//! across addon updates and reinstalls, unlike transport URLs or positions.
//! Rows of addons that are uninstalled or turned off stay listed, so their
//! place comes back with them. The renderer decides how rows it doesn't know
//! yet join a layout; the core only keeps the list well formed.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::core::error::{Error, Result};

/// Most rows a page's layout keeps, including remembered rows of addons
/// that are not installed now.
pub const MAX_LAYOUT_ROWS: usize = 500;
/// Longest catalogue id kept, as the addon SDK accepts them.
const MAX_CATALOG_ID: usize = 128;
/// Longest content type kept, as the addon SDK accepts them.
const MAX_TYPE: usize = 64;

/// A layout for each page that shows catalogue rows. `None`: the default.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields, default)]
pub struct RowSettings {
    pub discover: Option<Vec<CatalogRow>>,
    pub movies: Option<Vec<CatalogRow>>,
    pub tv_shows: Option<Vec<CatalogRow>>,
}

/// One catalogue's place in a layout.
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogRow {
    /// The addon's manifest id.
    pub addon: String,
    /// The catalogue's content type (`movie`, `series`, `anime`, …).
    #[serde(rename = "type")]
    pub kind: String,
    /// The catalogue's id within the addon.
    pub catalog: String,
    /// Left off the page (still listed in its editor).
    #[serde(default)]
    pub hidden: bool,
}

impl CatalogRow {
    fn is_valid(&self) -> bool {
        is_addon_id(&self.addon)
            && is_text(&self.kind, MAX_TYPE)
            && is_text(&self.catalog, MAX_CATALOG_ID)
    }

    /// A stored row, ignoring fields a newer version may have added.
    fn from_stored(value: &Value) -> Option<Self> {
        let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
        Some(Self {
            addon: text("addon")?,
            kind: text("type")?,
            catalog: text("catalog")?,
            hidden: value
                .get("hidden")
                .and_then(Value::as_bool)
                .unwrap_or(false),
        })
    }

    fn same_catalog(&self, other: &Self) -> bool {
        self.addon == other.addon && self.kind == other.kind && self.catalog == other.catalog
    }
}

impl RowSettings {
    fn layouts(&self) -> [&Option<Vec<CatalogRow>>; 3] {
        [&self.discover, &self.movies, &self.tv_shows]
    }

    pub(super) fn validate(&self) -> Result<()> {
        for rows in self.layouts().into_iter().flatten() {
            if rows.len() > MAX_LAYOUT_ROWS {
                return Err(Error::invalid_argument(format!(
                    "A page can list at most {MAX_LAYOUT_ROWS} rows"
                )));
            }
            for (index, row) in rows.iter().enumerate() {
                if !row.is_valid() {
                    return Err(Error::invalid_argument("Invalid catalogue row"));
                }
                if rows[..index]
                    .iter()
                    .any(|earlier| earlier.same_catalog(row))
                {
                    return Err(Error::invalid_argument("Duplicate catalogue row"));
                }
            }
        }
        Ok(())
    }

    /// Reads stored layouts page by page. A page whose value isn't a list
    /// has the default layout; a list keeps its valid, distinct rows.
    pub(super) fn from_stored(value: &Value) -> Self {
        let layout = |key: &str| {
            let rows = value.get(key)?.as_array()?;
            let mut kept: Vec<CatalogRow> = Vec::new();
            for row in rows.iter().filter_map(CatalogRow::from_stored) {
                if row.is_valid() && !kept.iter().any(|earlier| earlier.same_catalog(&row)) {
                    kept.push(row);
                }
            }
            kept.truncate(MAX_LAYOUT_ROWS);
            Some(kept)
        };
        Self {
            discover: layout("discover"),
            movies: layout("movies"),
            tv_shows: layout("tvShows"),
        }
    }
}

/// An addon id as manifests allow them: 1 to 128 letters, digits, `.`, `_`
/// and `-`.
fn is_addon_id(id: &str) -> bool {
    (1..=128).contains(&id.len())
        && id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'.' | b'_' | b'-'))
}

/// 1 to `max` characters, none of them control characters.
fn is_text(text: &str, max: usize) -> bool {
    (1..=max).contains(&text.chars().count()) && !text.chars().any(char::is_control)
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    fn row(addon: &str, kind: &str, catalog: &str, hidden: bool) -> CatalogRow {
        CatalogRow {
            addon: addon.into(),
            kind: kind.into(),
            catalog: catalog.into(),
            hidden,
        }
    }

    #[test]
    fn accepts_a_layout() {
        let rows = RowSettings {
            discover: Some(vec![
                row(
                    "community.anime.kitsu",
                    "anime",
                    "kitsu-anime-airing",
                    false,
                ),
                row("com.linvo.cinemeta", "movie", "top", true),
                // The same catalogue id with another type is another row.
                row("com.linvo.cinemeta", "series", "top", false),
            ]),
            movies: Some(Vec::new()),
            tv_shows: None,
        };
        rows.validate().unwrap();
    }

    #[test]
    fn rejects_malformed_layouts() {
        let long = "x".repeat(MAX_CATALOG_ID + 1);
        for rows in [
            vec![row("bad id", "movie", "top", false)],
            vec![row("", "movie", "top", false)],
            vec![row("a.b", "", "top", false)],
            vec![row("a.b", "movie", "", false)],
            vec![row("a.b", "movie", &long, false)],
            vec![row("a.b", "movie", "to\np", false)],
            vec![
                row("a.b", "movie", "top", false),
                row("a.b", "movie", "top", true),
            ],
            (0..=MAX_LAYOUT_ROWS)
                .map(|index| row("a.b", "movie", &index.to_string(), false))
                .collect(),
        ] {
            let settings = RowSettings {
                tv_shows: Some(rows),
                ..RowSettings::default()
            };
            let error = settings.validate().unwrap_err();
            assert_eq!(error.code(), "INVALID_ARGUMENT");
        }
    }

    #[test]
    fn stored_layouts_keep_their_valid_rows() {
        let stored = RowSettings::from_stored(&json!({
            "discover": [
                { "addon": "a.b", "type": "movie", "catalog": "top", "hidden": true },
                { "addon": "a.b", "type": "movie", "catalog": "top" },
                { "addon": "bad id", "type": "movie", "catalog": "top" },
                { "addon": "a.b", "type": "series", "catalog": "top", "later": 1 },
                { "addon": "a.b", "type": "series", "catalog": "new", "hidden": "no" },
                { "addon": "a.b", "type": "series" },
                "a.b/movie/top",
            ],
            "movies": "all",
            "tvShows": null,
        }));
        assert_eq!(
            stored,
            RowSettings {
                discover: Some(vec![
                    row("a.b", "movie", "top", true),
                    row("a.b", "series", "top", false),
                    row("a.b", "series", "new", false),
                ]),
                movies: None,
                tv_shows: None,
            }
        );
    }

    #[test]
    fn stored_layouts_are_capped() {
        let rows: Vec<Value> = (0..MAX_LAYOUT_ROWS + 10)
            .map(|index| json!({ "addon": "a.b", "type": "movie", "catalog": index.to_string() }))
            .collect();
        let stored = RowSettings::from_stored(&json!({ "movies": rows }));
        assert_eq!(stored.movies.map(|rows| rows.len()), Some(MAX_LAYOUT_ROWS));
    }
}
