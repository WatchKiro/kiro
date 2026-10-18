//! The addons a new profile starts with, so Discover has catalogues and the
//! player has subtitles before the user has looked for any addon URLs.
//!
//! - Cinemeta: the official catalogues and metadata for movies and series.
//! - OpenSubtitles v3: the official subtitles addon. It needs no account or
//!   configuration.
//!
//! They are ordinary installed addons, not built-ins: the user can turn them
//! off, reorder them or remove them like any other. The registry seeds them
//! only into a profile that has never had an addon list, so a removed default
//! stays removed; "Restore default addons" puts back any that are missing.
//!
//! Each manifest is a snapshot of what the addon served (in `defaults/`),
//! bundled so the first run needs no network. Installed manifests are
//! snapshots anyway: reinstalling an addon's URL updates its stored one.

use serde_json::Value;

use super::AddonUrl;
use super::registry::InstalledAddon;

/// `(manifest URL, manifest snapshot)`, in priority order.
const DEFAULTS: [(&str, &str); 2] = [
    (
        "https://v3-cinemeta.strem.io/manifest.json",
        include_str!("defaults/cinemeta.json"),
    ),
    (
        "https://opensubtitles-v3.strem.io/manifest.json",
        include_str!("defaults/opensubtitles-v3.json"),
    ),
];

/// The default addons, enabled, in priority order.
pub fn default_addons() -> Vec<InstalledAddon> {
    DEFAULTS
        .iter()
        .filter_map(|(url, manifest)| {
            Some(InstalledAddon {
                transport_url: AddonUrl::parse(url).ok()?,
                manifest: serde_json::from_str::<Value>(manifest).ok()?,
                enabled: true,
            })
        })
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_default_parses_with_its_own_manifest() {
        let addons = default_addons();
        assert_eq!(addons.len(), DEFAULTS.len());
        let ids: Vec<_> = addons
            .iter()
            .map(|addon| addon.manifest["id"].as_str().unwrap())
            .collect();
        assert_eq!(ids, ["com.linvo.cinemeta", "org.stremio.opensubtitlesv3"]);
        assert!(addons.iter().all(|addon| addon.enabled));
    }
}
