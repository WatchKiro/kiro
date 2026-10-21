//! Audio passthrough (bitstreaming): compressed surround formats sent to an
//! AV receiver untouched instead of decoded to PCM.
//!
//! mpv does the work: `audio-spdif` names the codecs to pass through, its
//! `ad_spdif` decoder wraps their packets in IEC 61937 frames with FFmpeg's
//! `spdif` muxer, and the audio output opens the device exclusively for them
//! (WASAPI exclusive on Windows, Core Audio's `coreaudio_exclusive` on macOS,
//! an IEC 958/HDMI device or a PulseAudio/PipeWire sink accepting the format
//! on Linux). Everything else stays decoded and shared. When no output
//! accepts the format, mpv decodes the track instead, so passthrough never
//! costs the sound. mpv 0.41 then stalls, though (no audio output, playback
//! stuck); [`Spdif`] stops passing that codec through, which re-creates the
//! decoder and gets playback going again. See `docs/playback.md`.

use serde::{Deserialize, Serialize};

/// A format that can be passed through, in the order Settings lists them.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum PassthroughFormat {
    /// Dolby Digital (AC-3).
    Ac3,
    /// Dolby Digital Plus (E-AC-3), including Atmos in DD+.
    Eac3,
    /// DTS (the core of any DTS track).
    Dts,
    /// DTS-HD High Resolution and Master Audio, including DTS:X. Needs
    /// [`Self::Dts`]: mpv's `dts-hd` also passes DTS cores through.
    DtsHd,
    /// Dolby TrueHD, including Atmos in TrueHD.
    #[serde(rename = "truehd")]
    TrueHd,
}

impl PassthroughFormat {
    pub const ALL: [Self; 5] = [Self::Ac3, Self::Eac3, Self::Dts, Self::DtsHd, Self::TrueHd];

    /// What Settings starts with once passthrough is turned on: the formats
    /// every receiver takes, optical (S/PDIF) ones included.
    pub const DEFAULTS: [Self; 2] = [Self::Ac3, Self::Dts];

    /// The name in mpv's `audio-spdif` list.
    pub fn mpv_name(self) -> &'static str {
        match self {
            Self::Ac3 => "ac3",
            Self::Eac3 => "eac3",
            Self::Dts => "dts",
            Self::DtsHd => "dts-hd",
            Self::TrueHd => "truehd",
        }
    }

    pub fn label(self) -> &'static str {
        match self {
            Self::Ac3 => "Dolby Digital",
            Self::Eac3 => "Dolby Digital Plus",
            Self::Dts => "DTS",
            Self::DtsHd => "DTS-HD",
            Self::TrueHd => "TrueHD",
        }
    }

    /// Whether this platform's audio output can carry the format.
    ///
    /// macOS: `coreaudio_exclusive` only finds the S/PDIF-rate formats Core
    /// Audio offers on HDMI and optical outputs, AC-3 and DTS. The high
    /// bit-rate ones (E-AC-3 at 4× rate, TrueHD and DTS-HD MA at 8×) need
    /// HDMI's HBR mode, which macOS doesn't expose to apps. Windows and
    /// Linux can carry all of them; whether they do depends on the device
    /// and driver (and on Linux, the sound server's settings).
    pub fn is_supported(self) -> bool {
        if cfg!(target_os = "macos") {
            matches!(self, Self::Ac3 | Self::Dts)
        } else {
            true
        }
    }
}

/// The value for mpv's `audio-spdif`: the chosen formats, or empty to decode
/// everything.
pub fn spdif_codecs(enabled: bool, formats: &[PassthroughFormat]) -> String {
    if !enabled {
        return String::new();
    }
    PassthroughFormat::ALL
        .into_iter()
        .filter(|format| formats.contains(format) && format.is_supported())
        .map(PassthroughFormat::mpv_name)
        .collect::<Vec<_>>()
        .join(",")
}

/// The log line mpv writes (`cplayer`, verbose) when no audio output took a
/// passthrough format and it decodes the track instead.
pub const FALLBACK_MESSAGE: &str = "Falling back to PCM output";

/// What mpv's `audio-spdif` should be for the stream playing: the codecs the
/// settings chose, less those the audio output refused during this stream.
/// mpv's own fallback to decoding stalls playback (above); changing
/// `audio-spdif` re-creates the decoder, so dropping the refused codec both
/// stops retrying it and restarts the audio.
#[derive(Debug, Default)]
pub struct Spdif {
    chosen: Vec<&'static str>,
    refused: Vec<&'static str>,
}

impl Spdif {
    /// The settings' `audio-spdif` ([`spdif_codecs`]). A change forgets
    /// refusals; the same choice again (settings are saved for other reasons
    /// mid-playback) keeps them. Whether it changed.
    pub fn choose(&mut self, codecs: &str) -> bool {
        let chosen: Vec<_> = ALL_MPV_NAMES
            .into_iter()
            .filter(|name| codecs.split(',').any(|codec| codec == *name))
            .collect();
        if chosen == self.chosen {
            return false;
        }
        self.chosen = chosen;
        self.refused.clear();
        true
    }

    /// Whether anything is passed through at all.
    pub fn is_on(&self) -> bool {
        !self.chosen.is_empty()
    }

    /// A new stream: the output (or the receiver behind it) may take what
    /// it refused before, so try again.
    pub fn new_stream(&mut self) {
        self.refused.clear();
    }

    /// The output refused the track playing, whose codec is `codec` (mpv's
    /// `audio-codec-name`). A DTS track loses DTS-HD first, so its DTS core
    /// can still pass (optical, or HDMI without HBR); anything else stops
    /// passing through. Whether that changed anything.
    pub fn refuse(&mut self, codec: &str) -> bool {
        let current = self.codecs_list();
        let dropped = match codec {
            "dts" if current.contains(&"dts-hd") => "dts-hd",
            codec => match current.iter().find(|name| **name == codec) {
                Some(name) => *name,
                None => return false,
            },
        };
        self.refused.push(dropped);
        true
    }

    /// The value for `audio-spdif` now.
    pub fn codecs(&self) -> String {
        self.codecs_list().join(",")
    }

    fn codecs_list(&self) -> Vec<&'static str> {
        self.chosen
            .iter()
            .copied()
            .filter(|name| !self.refused.contains(name))
            .collect()
    }
}

const ALL_MPV_NAMES: [&str; 5] = ["ac3", "eac3", "dts", "dts-hd", "truehd"];

/// How the audio playing reaches the output, from mpv's
/// `audio-out-params/format`: `passthrough eac3` for an IEC 61937 format
/// (`spdif-eac3`), otherwise `decoded`. `None` without audio.
pub fn audio_mode(output_format: Option<&str>) -> Option<String> {
    let format = output_format.filter(|format| !format.is_empty())?;
    Some(match format.strip_prefix("spdif-") {
        Some("dtshd") => "passthrough dts-hd".to_owned(),
        Some(codec) => format!("passthrough {codec}"),
        None => "decoded".to_owned(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use PassthroughFormat::*;

    #[test]
    fn off_decodes_everything() {
        assert_eq!(spdif_codecs(false, &PassthroughFormat::ALL), "");
        assert_eq!(spdif_codecs(true, &[]), "");
    }

    #[test]
    fn formats_map_to_mpv_names_in_a_fixed_order() {
        assert_eq!(spdif_codecs(true, &[Dts, Ac3]), "ac3,dts");
        if cfg!(target_os = "macos") {
            // E-AC-3, DTS-HD and TrueHD can't leave a Mac untouched.
            assert_eq!(
                spdif_codecs(true, &[TrueHd, DtsHd, Dts, Eac3, Ac3]),
                "ac3,dts"
            );
        } else {
            assert_eq!(
                spdif_codecs(true, &[TrueHd, DtsHd, Dts, Eac3, Ac3]),
                "ac3,eac3,dts,dts-hd,truehd"
            );
        }
    }

    #[test]
    fn platform_support() {
        assert!(Ac3.is_supported());
        assert!(Dts.is_supported());
        let hbr = [Eac3, DtsHd, TrueHd].map(PassthroughFormat::is_supported);
        assert_eq!(hbr, [!cfg!(target_os = "macos"); 3]);
        assert!(
            PassthroughFormat::DEFAULTS
                .iter()
                .all(|format| format.is_supported())
        );
    }

    #[test]
    fn names_match_what_the_renderer_sends() {
        let names: Vec<String> = PassthroughFormat::ALL
            .iter()
            .map(|format| {
                serde_json::to_value(format)
                    .unwrap()
                    .as_str()
                    .unwrap()
                    .to_owned()
            })
            .collect();
        assert_eq!(names, ["ac3", "eac3", "dts", "dtsHd", "truehd"]);
        assert_eq!(DtsHd.label(), "DTS-HD");
    }

    #[test]
    fn every_format_has_a_known_mpv_name() {
        let names = PassthroughFormat::ALL.map(PassthroughFormat::mpv_name);
        assert_eq!(names, ALL_MPV_NAMES);
    }

    #[test]
    fn a_refused_codec_stops_passing_through_for_the_stream() {
        let mut spdif = Spdif::default();
        spdif.choose("ac3,eac3,dts,dts-hd,truehd");
        assert!(spdif.refuse("truehd"));
        assert_eq!(spdif.codecs(), "ac3,eac3,dts,dts-hd");
        // Already decoded: nothing to change.
        assert!(!spdif.refuse("truehd"));
        assert!(!spdif.refuse("aac"));
        // A DTS track keeps its core, then that goes too.
        assert!(spdif.refuse("dts"));
        assert_eq!(spdif.codecs(), "ac3,eac3,dts");
        assert!(spdif.refuse("dts"));
        assert_eq!(spdif.codecs(), "ac3,eac3");
        // The next stream tries everything again.
        spdif.new_stream();
        assert_eq!(spdif.codecs(), "ac3,eac3,dts,dts-hd,truehd");
        // Saving the same choice keeps what was refused; a new one forgets it.
        spdif.refuse("ac3");
        assert!(!spdif.choose("ac3,eac3,dts,dts-hd,truehd"));
        assert_eq!(spdif.codecs(), "eac3,dts,dts-hd,truehd");
        assert!(spdif.choose("ac3,dts"));
        assert_eq!(spdif.codecs(), "ac3,dts");
    }

    #[test]
    fn nothing_chosen_passes_nothing() {
        let mut spdif = Spdif::default();
        assert_eq!(spdif.codecs(), "");
        assert!(!spdif.is_on());
        assert!(!spdif.choose(""));
        assert!(!spdif.refuse("ac3"));
        assert_eq!(spdif.codecs(), "");
        spdif.choose("ac3,unknown");
        assert_eq!(spdif.codecs(), "ac3");
        assert!(spdif.is_on());
    }

    #[test]
    fn audio_mode_from_the_output_format() {
        assert_eq!(
            audio_mode(Some("spdif-eac3")).as_deref(),
            Some("passthrough eac3")
        );
        assert_eq!(
            audio_mode(Some("spdif-ac3")).as_deref(),
            Some("passthrough ac3")
        );
        assert_eq!(
            audio_mode(Some("spdif-dtshd")).as_deref(),
            Some("passthrough dts-hd")
        );
        assert_eq!(
            audio_mode(Some("spdif-truehd")).as_deref(),
            Some("passthrough truehd")
        );
        assert_eq!(audio_mode(Some("floatp")).as_deref(), Some("decoded"));
        assert_eq!(audio_mode(Some("s16")).as_deref(), Some("decoded"));
        assert_eq!(audio_mode(Some("")), None);
        assert_eq!(audio_mode(None), None);
    }
}
