//! Installed addons, persisted on-device.
//!
//! Stored as a small JSON file (`addons.json` in the config directory) rather
//! than SQLite: the list is tiny, read once at startup, written only when the
//! user installs or removes an addon, and never queried. A database can take
//! over when the library and watch history need one.
//!
//! The list's order is the user's priority order: addons are queried, and
//! their streams listed, in this order, and it breaks ties when ranking
//! streams. A disabled addon stays installed (with its place in the order)
//! but is not queried.
//!
//! A profile without the file (a fresh install) starts with the default
//! addons ([`super::defaults`]), written out on first read. Once the file
//! exists the defaults are never added again by themselves, so removing one
//! sticks; [`AddonRegistry::restore_defaults`] puts back any that are missing.
//!
//! Writes go to a temporary file that is then renamed over the old one, so a
//! crash mid-write never leaves a truncated list behind.
//!
//! Format history: version 1 had no `enabled` flag; its addons read as
//! enabled, in the order they were installed. Version 2 adds the flag.

use std::fs;
use std::io::{self, Write};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use serde::{Deserialize, Serialize};
use serde_json::Value;

use super::AddonUrl;
use crate::core::error::{Error, Result};

const FILE_NAME: &str = "addons.json";
const FORMAT_VERSION: u32 = 2;
pub const MAX_ADDONS: usize = 100;
pub const MAX_STORED_MANIFEST_BYTES: usize = 1024 * 1024;

/// An installed addon: where to reach it and the manifest it served when it
/// was installed. The manifest was validated by the renderer, but is treated
/// as untrusted again whenever it is read back.
///
/// Mirrored by `InstalledAddonRecord` in `apps/desktop/src/services/native.ts`.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct InstalledAddon {
    pub transport_url: AddonUrl,
    pub manifest: Value,
    /// Whether the addon is queried. Missing (version 1 files, installs):
    /// enabled.
    #[serde(default = "enabled")]
    pub enabled: bool,
}

fn enabled() -> bool {
    true
}

impl InstalledAddon {
    fn validate(&self) -> Result<()> {
        if !self.manifest.is_object() {
            return Err(Error::invalid_argument("Addon manifest must be an object"));
        }
        let size = serde_json::to_vec(&self.manifest)
            .map(|bytes| bytes.len())
            .unwrap_or(usize::MAX);
        if size > MAX_STORED_MANIFEST_BYTES {
            return Err(Error::invalid_argument("Addon manifest is too large"));
        }
        Ok(())
    }
}

#[derive(Serialize)]
struct FileRef<'a> {
    version: u32,
    addons: &'a [InstalledAddon],
}

#[derive(Deserialize)]
struct FileOwned {
    #[serde(default)]
    addons: Vec<Value>,
}

/// The installed-addon list. Serialises read-modify-write cycles, because
/// commands run concurrently.
#[derive(Debug)]
pub struct AddonRegistry {
    path: PathBuf,
    lock: Mutex<()>,
    /// Seeded into a profile that has no list yet, in this order.
    defaults: Vec<InstalledAddon>,
}

impl AddonRegistry {
    /// A registry without default addons: a new profile starts empty.
    pub fn new(config_dir: &Path) -> Self {
        Self {
            path: config_dir.join(FILE_NAME),
            lock: Mutex::new(()),
            defaults: Vec::new(),
        }
    }

    /// Seeds `defaults` into a profile that has no list yet.
    pub fn with_defaults(mut self, defaults: Vec<InstalledAddon>) -> Self {
        self.defaults = defaults;
        self
    }

    pub fn defaults(&self) -> &[InstalledAddon] {
        &self.defaults
    }

    pub fn list(&self) -> Result<Vec<InstalledAddon>> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        self.read()
    }

    /// Installs `addon` at the end of the list, enabled. An existing entry
    /// with the same URL is updated in place, keeping its position and
    /// whether it is enabled.
    pub fn install(&self, mut addon: InstalledAddon) -> Result<Vec<InstalledAddon>> {
        addon.validate()?;
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut addons = self.read()?;
        match addons
            .iter()
            .position(|existing| existing.transport_url == addon.transport_url)
        {
            Some(index) => {
                addon.enabled = addons[index].enabled;
                addons[index] = addon;
            }
            None if addons.len() >= MAX_ADDONS => {
                return Err(Error::invalid_argument("Too many addons are installed"));
            }
            None => {
                addon.enabled = true;
                addons.push(addon);
            }
        }
        self.write(&addons)?;
        Ok(addons)
    }

    /// Turns an installed addon on or off, keeping it installed.
    pub fn set_enabled(&self, url: &AddonUrl, enabled: bool) -> Result<Vec<InstalledAddon>> {
        self.modify(url, |addons, index| addons[index].enabled = enabled)
    }

    /// Moves an installed addon to `index` in the priority order (clamped to
    /// the end of the list), shifting the others.
    pub fn move_to(&self, url: &AddonUrl, index: usize) -> Result<Vec<InstalledAddon>> {
        self.modify(url, |addons, from| {
            let addon = addons.remove(from);
            let to = index.min(addons.len());
            addons.insert(to, addon);
        })
    }

    /// Changes the list around the addon at `url`, which must be installed.
    fn modify(
        &self,
        url: &AddonUrl,
        change: impl FnOnce(&mut Vec<InstalledAddon>, usize),
    ) -> Result<Vec<InstalledAddon>> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut addons = self.read()?;
        let index = addons
            .iter()
            .position(|addon| &addon.transport_url == url)
            .ok_or_else(|| Error::invalid_argument("That addon is not installed"))?;
        let before = addons.clone();
        change(&mut addons, index);
        if addons != before {
            self.write(&addons)?;
        }
        Ok(addons)
    }

    /// Installs, enabled and at the end of the list, the default addons that
    /// are not installed. Installed ones are left as they are, switch and
    /// position included.
    pub fn restore_defaults(&self) -> Result<Vec<InstalledAddon>> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut addons = self.read()?;
        let missing: Vec<_> = self
            .defaults
            .iter()
            .filter(|default| {
                !addons
                    .iter()
                    .any(|addon| addon.transport_url == default.transport_url)
            })
            .cloned()
            .collect();
        if missing.is_empty() {
            return Ok(addons);
        }
        if addons.len() + missing.len() > MAX_ADDONS {
            return Err(Error::invalid_argument("Too many addons are installed"));
        }
        addons.extend(missing.into_iter().map(|addon| InstalledAddon {
            enabled: true,
            ..addon
        }));
        self.write(&addons)?;
        Ok(addons)
    }

    pub fn uninstall(&self, url: &AddonUrl) -> Result<Vec<InstalledAddon>> {
        let _guard = self.lock.lock().unwrap_or_else(|e| e.into_inner());
        let mut addons = self.read()?;
        let before = addons.len();
        addons.retain(|addon| &addon.transport_url != url);
        if addons.len() != before {
            self.write(&addons)?;
        }
        Ok(addons)
    }

    /// Reads the list. A missing file is a new profile: it gets the defaults,
    /// which are written out at once so they are seeded only this time.
    /// Unreadable entries are skipped; an unparseable file is moved aside (not
    /// overwritten) and replaced with an empty list, not the defaults.
    fn read(&self) -> Result<Vec<InstalledAddon>> {
        let bytes = match fs::read(&self.path) {
            Ok(bytes) => bytes,
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                if !self.defaults.is_empty() {
                    self.write(&self.defaults)?;
                }
                return Ok(self.defaults.clone());
            }
            Err(error) => return Err(error.into()),
        };
        let Ok(file) = serde_json::from_slice::<FileOwned>(&bytes) else {
            fs::rename(&self.path, self.path.with_extension("json.corrupt"))?;
            self.write(&[])?;
            return Ok(Vec::new());
        };
        Ok(file
            .addons
            .into_iter()
            .filter_map(|entry| serde_json::from_value::<InstalledAddon>(entry).ok())
            .filter(|addon| addon.validate().is_ok())
            .take(MAX_ADDONS)
            .collect())
    }

    fn write(&self, addons: &[InstalledAddon]) -> Result<()> {
        if let Some(dir) = self.path.parent() {
            fs::create_dir_all(dir)?;
        }
        let json = serde_json::to_vec_pretty(&FileRef {
            version: FORMAT_VERSION,
            addons,
        })
        .map_err(io::Error::other)?;

        let temp = self.path.with_extension("json.tmp");
        let mut file = fs::File::create(&temp)?;
        file.write_all(&json)?;
        file.sync_all()?;
        drop(file);
        fs::rename(&temp, &self.path)?;
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicUsize, Ordering};

    use serde_json::json;

    use super::*;

    /// A fresh, empty directory under the system temp dir.
    fn temp_dir() -> PathBuf {
        static COUNTER: AtomicUsize = AtomicUsize::new(0);
        let dir = std::env::temp_dir().join(format!(
            "kiro-registry-test-{}-{}",
            std::process::id(),
            COUNTER.fetch_add(1, Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&dir);
        dir
    }

    fn addon(url: &str, name: &str) -> InstalledAddon {
        InstalledAddon {
            transport_url: AddonUrl::parse(url).unwrap(),
            manifest: json!({ "id": "org.example", "name": name }),
            enabled: true,
        }
    }

    fn url(name: &str) -> AddonUrl {
        AddonUrl::parse(&format!("https://{name}.example/manifest.json")).unwrap()
    }

    /// Each addon's host's first label and whether it is enabled, in order.
    fn summary(addons: &[InstalledAddon]) -> Vec<(String, bool)> {
        addons
            .iter()
            .map(|addon| {
                let host = addon.transport_url.as_url().host_str().unwrap_or_default();
                (host.split('.').next().unwrap().to_owned(), addon.enabled)
            })
            .collect()
    }

    fn with_addons(names: &[&str]) -> (PathBuf, AddonRegistry) {
        let dir = temp_dir();
        let registry = AddonRegistry::new(&dir);
        for name in names {
            registry
                .install(addon(
                    &format!("https://{name}.example/manifest.json"),
                    name,
                ))
                .unwrap();
        }
        (dir, registry)
    }

    fn with_defaults(dir: &Path) -> AddonRegistry {
        AddonRegistry::new(dir).with_defaults(vec![
            addon("https://meta.example/manifest.json", "Meta"),
            addon("https://subs.example/manifest.json", "Subs"),
        ])
    }

    #[test]
    fn a_new_profile_starts_with_the_defaults_in_order() {
        let dir = temp_dir();
        assert_eq!(
            summary(&with_defaults(&dir).list().unwrap()),
            [("meta".into(), true), ("subs".into(), true)]
        );
        // They were written out, so they are installed like any other addon.
        assert!(dir.join(FILE_NAME).exists());
        assert_eq!(AddonRegistry::new(&dir).list().unwrap().len(), 2);

        // Installing into a new profile adds to the defaults.
        let dir2 = temp_dir();
        let addons = with_defaults(&dir2)
            .install(addon("https://a.example/manifest.json", "A"))
            .unwrap();
        assert_eq!(
            summary(&addons)
                .into_iter()
                .map(|(name, _)| name)
                .collect::<Vec<_>>(),
            ["meta", "subs", "a"]
        );
        fs::remove_dir_all(dir).unwrap();
        fs::remove_dir_all(dir2).unwrap();
    }

    #[test]
    fn removed_and_disabled_defaults_stay_that_way() {
        let dir = temp_dir();
        let registry = with_defaults(&dir);
        registry.uninstall(&url("meta")).unwrap();
        registry.set_enabled(&url("subs"), false).unwrap();

        // A restart (a new registry with the same defaults) keeps the changes.
        assert_eq!(
            summary(&with_defaults(&dir).list().unwrap()),
            [("subs".into(), false)]
        );
        // Removing every addon leaves an empty list, not the defaults.
        registry.uninstall(&url("subs")).unwrap();
        assert!(with_defaults(&dir).list().unwrap().is_empty());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn existing_lists_and_corrupt_files_are_not_seeded() {
        let (dir, _) = with_addons(&["a"]);
        assert_eq!(
            summary(&with_defaults(&dir).list().unwrap()),
            [("a".into(), true)]
        );

        fs::write(dir.join(FILE_NAME), "{ not json").unwrap();
        assert!(with_defaults(&dir).list().unwrap().is_empty());
        assert!(with_defaults(&dir).list().unwrap().is_empty());
        assert!(dir.join("addons.json.corrupt").exists());
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn restoring_adds_only_the_missing_defaults_at_the_end() {
        let dir = temp_dir();
        let registry = with_defaults(&dir);
        registry.uninstall(&url("meta")).unwrap();
        registry.set_enabled(&url("subs"), false).unwrap();
        registry
            .install(addon("https://a.example/manifest.json", "A"))
            .unwrap();

        let restored = registry.restore_defaults().unwrap();
        assert_eq!(
            summary(&restored),
            [
                ("subs".into(), false),
                ("a".into(), true),
                ("meta".into(), true),
            ]
        );
        assert_eq!(
            summary(&with_defaults(&dir).list().unwrap()),
            summary(&restored)
        );
        // Nothing missing: nothing changes.
        assert_eq!(registry.restore_defaults().unwrap(), restored);
        // Without defaults there is nothing to restore.
        assert_eq!(
            AddonRegistry::new(&dir).restore_defaults().unwrap(),
            restored
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn disabling_keeps_the_addon_installed_in_place() {
        let (dir, registry) = with_addons(&["a", "b", "c"]);
        registry.set_enabled(&url("b"), false).unwrap();
        let expected = [("a".into(), true), ("b".into(), false), ("c".into(), true)];
        assert_eq!(summary(&AddonRegistry::new(&dir).list().unwrap()), expected);

        // Updating a disabled addon (reinstalling its URL) keeps it disabled
        // and in place; a new install is enabled at the end.
        let mut update = addon("https://b.example/manifest.json", "B2");
        update.enabled = true;
        registry.install(update).unwrap();
        let mut new = addon("https://d.example/manifest.json", "D");
        new.enabled = false;
        let addons = registry.install(new).unwrap();
        assert_eq!(addons[1].manifest["name"], "B2");
        assert_eq!(
            summary(&addons),
            [
                ("a".into(), true),
                ("b".into(), false),
                ("c".into(), true),
                ("d".into(), true),
            ]
        );

        registry.set_enabled(&url("b"), true).unwrap();
        assert!(registry.list().unwrap()[1].enabled);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn moves_addons_in_the_priority_order() {
        let (dir, registry) = with_addons(&["a", "b", "c", "d"]);
        let order = |addons: Vec<InstalledAddon>| {
            summary(&addons)
                .into_iter()
                .map(|(name, _)| name)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            order(registry.move_to(&url("c"), 0).unwrap()),
            ["c", "a", "b", "d"]
        );
        assert_eq!(
            order(registry.move_to(&url("c"), 2).unwrap()),
            ["a", "b", "c", "d"]
        );
        // Past the end goes last.
        assert_eq!(
            order(registry.move_to(&url("a"), 99).unwrap()),
            ["b", "c", "d", "a"]
        );
        assert_eq!(
            order(AddonRegistry::new(&dir).list().unwrap()),
            ["b", "c", "d", "a"]
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn changing_an_addon_that_is_not_installed_fails() {
        let (dir, registry) = with_addons(&["a"]);
        assert_eq!(
            registry.set_enabled(&url("x"), false).unwrap_err().code(),
            "INVALID_ARGUMENT"
        );
        assert_eq!(
            registry.move_to(&url("x"), 0).unwrap_err().code(),
            "INVALID_ARGUMENT"
        );
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn version_1_files_read_as_enabled_in_install_order() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join(FILE_NAME),
            json!({ "version": 1, "addons": [
                { "transportUrl": "https://b.example/manifest.json", "manifest": { "name": "B" } },
                { "transportUrl": "https://a.example/manifest.json", "manifest": { "name": "A" } },
            ]})
            .to_string(),
        )
        .unwrap();
        let registry = AddonRegistry::new(&dir);
        assert_eq!(
            summary(&registry.list().unwrap()),
            [("b".into(), true), ("a".into(), true)]
        );

        // The next write upgrades the file.
        registry.set_enabled(&url("a"), false).unwrap();
        let stored: Value =
            serde_json::from_slice(&fs::read(dir.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(stored["version"], 2);
        assert_eq!(stored["addons"][0]["enabled"], true);
        assert_eq!(stored["addons"][1]["enabled"], false);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn persists_installs_and_removals() {
        let dir = temp_dir();
        let registry = AddonRegistry::new(&dir);
        assert!(registry.list().unwrap().is_empty());

        registry
            .install(addon("https://a.example/manifest.json", "A"))
            .unwrap();
        registry
            .install(addon("https://b.example/manifest.json", "B"))
            .unwrap();
        // Reinstalling the same URL updates in place.
        registry
            .install(addon("https://a.example/manifest.json", "A2"))
            .unwrap();

        // A new registry (e.g. after a restart) reads the same list.
        let reopened = AddonRegistry::new(&dir);
        let names: Vec<_> = reopened
            .list()
            .unwrap()
            .into_iter()
            .map(|addon| addon.manifest["name"].clone())
            .collect();
        assert_eq!(names, [json!("A2"), json!("B")]);

        let url = AddonUrl::parse("https://a.example/manifest.json").unwrap();
        assert_eq!(reopened.uninstall(&url).unwrap().len(), 1);
        assert_eq!(AddonRegistry::new(&dir).list().unwrap().len(), 1);
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn rejects_invalid_manifests() {
        let registry = AddonRegistry::new(&temp_dir());
        let mut not_object = addon("https://a.example/manifest.json", "A");
        not_object.manifest = json!("manifest");
        assert!(registry.install(not_object).is_err());

        let mut huge = addon("https://a.example/manifest.json", "A");
        huge.manifest = json!({ "name": "x".repeat(MAX_STORED_MANIFEST_BYTES) });
        assert!(registry.install(huge).is_err());
    }

    #[test]
    fn skips_bad_entries_and_sets_corrupt_files_aside() {
        let dir = temp_dir();
        fs::create_dir_all(&dir).unwrap();
        let path = dir.join(FILE_NAME);

        fs::write(
            &path,
            json!({ "version": 1, "addons": [
                { "transportUrl": "http://insecure.example/manifest.json", "manifest": {} },
                { "transportUrl": "https://ok.example/manifest.json", "manifest": {} },
                "garbage"
            ]})
            .to_string(),
        )
        .unwrap();
        assert_eq!(AddonRegistry::new(&dir).list().unwrap().len(), 1);

        fs::write(&path, "{ not json").unwrap();
        assert!(AddonRegistry::new(&dir).list().unwrap().is_empty());
        assert!(dir.join("addons.json.corrupt").exists());
        fs::remove_dir_all(dir).unwrap();
    }
}
