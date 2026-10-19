#!/usr/bin/env bash
# Writes a draft release's notes (release.yml): downloads, updating,
# installing (with the warnings unsigned builds get), and the open-source
# components. "What's new" lists the pull requests merged since the last
# release; edit the draft before publishing.
#
# Usage: release-notes.sh <version> <tag> > notes.md
# MACOS_SIGNED and WINDOWS_SIGNED (true/false) say how the builds were signed.
# GITHUB_REPOSITORY names the repository; GH_TOKEN lets gh read it.
set -euo pipefail

version="$1"
tag="$2"
repo="${GITHUB_REPOSITORY:?}"
dmg="Kiro_${version}_aarch64.dmg"
exe="Kiro_${version}_x64-setup.exe"
appimage="Kiro_${version}_amd64.AppImage"
deb="Kiro_${version}_amd64.deb"

if ! changes="$(gh api "repos/$repo/releases/generate-notes" -f tag_name="$tag" -q .body 2> /dev/null)" \
  || [[ -z "$changes" ]]; then
  changes="See the [commits](https://github.com/$repo/commits/$tag)."
fi

cat << EOF
## What's new

$changes

## Download

| Platform | File |
| --- | --- |
| **macOS** (Apple Silicon, macOS 12 or later) | \`$dmg\` |
| **Windows** (10 or 11, 64-bit) | \`$exe\` |
| **Linux** (x86_64; Ubuntu 22.04, Debian 12, Fedora or newer) | \`$appimage\` or \`$deb\` |

## Updating

Kiro checks for a new version when it starts and once a day, downloads it in the background and then offers **Restart to update** in the sidebar. You can also check in **Settings → General**. This works on macOS, Windows and with the AppImage. The \`.deb\` doesn't update itself: Kiro tells you about the new version, and you install the new \`.deb\` over the old one.

Kiro 0.1.0 beta 1 doesn't update itself: if that's the version you have, download this one by hand.

## Installing

EOF

mac_signed="${MACOS_SIGNED:-false}"
windows_signed="${WINDOWS_SIGNED:-false}"
if [[ "$mac_signed" != true && "$windows_signed" != true ]]; then
  echo "These builds aren't signed with an Apple or Microsoft certificate yet, so your computer will warn you the first time you open Kiro."
elif [[ "$mac_signed" != true ]]; then
  echo "The macOS build isn't signed with an Apple certificate yet, so macOS will warn you the first time you open Kiro."
elif [[ "$windows_signed" != true ]]; then
  echo "The Windows build isn't signed yet, so Windows will warn you when you run the installer."
fi
echo

echo "**macOS**"
echo
if [[ "$mac_signed" == true ]]; then
  echo "Open the \`.dmg\` and drag **Kiro** into **Applications**."
else
  cat << 'EOF'
1. Open the `.dmg` and drag **Kiro** into **Applications**.
2. Open Kiro. macOS says it can't verify the app; click **Done**.
3. Go to **System Settings → Privacy & Security**, scroll down, and click **Open Anyway** next to Kiro. Confirm, and Kiro opens. You only need to do this once.
EOF
fi

echo
echo "**Windows**"
echo
echo "1. Run \`$exe\`. No administrator rights are needed."
if [[ "$windows_signed" == true ]]; then
  echo "2. Windows 11 already has WebView2. On Windows 10 the installer downloads it if it's missing."
else
  echo "2. If **\"Windows protected your PC\"** appears, click **More info → Run anyway**."
  echo "3. Windows 11 already has WebView2. On Windows 10 the installer downloads it if it's missing."
fi

cat << EOF

**Linux**

- **AppImage:** make it executable (\`chmod +x $appimage\`) and run it. It updates itself.
- **.deb** (Ubuntu, Debian): \`sudo apt install ./$deb\`.

## Open-source components

Kiro is MIT-licensed. It bundles **libmpv** and **FFmpeg**, built as **LGPL-2.1-or-later** and linked dynamically. Their licence texts ship inside the app, and their exact sources and build scripts are attached below (\`*-libmpv-*-sources\`). Checksums for every file are in \`SHA256SUMS\`.
EOF
