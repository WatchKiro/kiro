// Builds the Windows release: a per-user NSIS installer for Kiro, with native
// playback through the bundled LGPL libmpv (libmpv-2.dll beside Kiro.exe).
//
// The DLL is cross-compiled by scripts/build-libmpv-windows.sh, on Linux or
// macOS (or WSL), into apps/desktop/.libmpv-windows/dist. Build it there and
// copy the folder over, or download the `libmpv-windows` artifact from CI.
//
// Signed when signing credentials are set (scripts/sign-windows.mjs: Azure
// Artifact Signing or a .pfx certificate); otherwise unsigned, and
// SmartScreen warns on first run. See docs/releasing.md.
//
// Usage: pnpm build:windows [extra `tauri build` arguments]
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { signingMethod } from './sign-windows.mjs';

const desktop = dirname(dirname(fileURLToPath(import.meta.url)));
const dist = join(desktop, '.libmpv-windows', 'dist');

function fail(message) {
  console.error(`build-windows: ${message}`);
  process.exit(1);
}

if (process.platform !== 'win32') {
  fail(
    'run this on Windows. To build libmpv-2.dll here, run scripts/build-libmpv-windows.sh instead.',
  );
}
for (const file of [join('bin', 'libmpv-2.dll'), join('licenses', 'README.txt')]) {
  if (!existsSync(join(dist, file))) {
    fail(
      `${join(dist, file)} is missing. Build it with scripts/build-libmpv-windows.sh ` +
        '(on Linux, macOS or WSL) and copy apps/desktop/.libmpv-windows/dist here, ' +
        'or download the libmpv-windows artifact from CI into that folder.',
    );
  }
}

const configs = ['--config', join('src-tauri', 'tauri.windows-release.conf.json')];
let method;
try {
  method = signingMethod();
} catch (error) {
  fail(error.message);
}
if (method) {
  console.log(
    `build-windows: signing with ${method === 'azure' ? 'Azure Artifact Signing' : 'the .pfx certificate'}`,
  );
  const signCommand = {
    cmd: process.execPath,
    args: [join(desktop, 'scripts', 'sign-windows.mjs'), '%1'],
  };
  // Passed as a file: `shell` (needed to run pnpm.cmd) would mangle inline JSON.
  const signConfig = join('src-tauri', 'target', 'windows-signing.conf.json');
  mkdirSync(join(desktop, 'src-tauri', 'target'), { recursive: true });
  writeFileSync(
    join(desktop, signConfig),
    JSON.stringify({ bundle: { windows: { signCommand } } }, null, 2),
  );
  configs.push('--config', signConfig);
} else {
  console.log('build-windows: no signing credentials, building unsigned (SmartScreen will warn)');
}

const result = spawnSync(
  'pnpm',
  [
    'exec',
    'tauri',
    'build',
    '--features',
    'libmpv',
    ...configs,
    '--bundles',
    'nsis',
    ...process.argv.slice(2),
  ],
  {
    cwd: desktop,
    env: { ...process.env, KIRO_LIBMPV_DIR: join(dist, 'bin') },
    stdio: 'inherit',
    shell: true,
  },
);
process.exit(result.status ?? 1);
