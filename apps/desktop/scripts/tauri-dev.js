// Starts `tauri dev`, enabling native libmpv playback (the `libmpv` Cargo
// feature) automatically when libmpv is available:
// - macOS: a system libmpv (`brew install mpv`);
// - Linux: the distribution's development package (`libmpv-dev`), found
//   with pkg-config;
// - Windows: `KIRO_LIBMPV_DIR` pointing at a folder with `libmpv-2.dll`
//   (e.g. an extracted mpv-dev package; see docs/playback.md).
// Set KIRO_MPV=0 to start without it.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const HINTS = {
  darwin: 'brew install mpv',
  linux: 'install libmpv-dev, or your distribution’s mpv development package',
  win32: 'set KIRO_LIBMPV_DIR to a folder containing libmpv-2.dll',
};

function hasPkgConfigMpv() {
  return spawnSync('pkg-config', ['--exists', 'mpv'], { stdio: 'ignore' }).status === 0;
}

function hasLibmpv() {
  if (process.env.KIRO_MPV === '0') return false;
  switch (process.platform) {
    case 'darwin':
      return (
        hasPkgConfigMpv() ||
        ['/opt/homebrew/lib/libmpv.dylib', '/usr/local/lib/libmpv.dylib'].some(existsSync)
      );
    case 'linux':
      return hasPkgConfigMpv();
    case 'win32': {
      const dir = process.env.KIRO_LIBMPV_DIR;
      return Boolean(dir) && existsSync(join(dir, 'libmpv-2.dll'));
    }
    default:
      return false;
  }
}

const mpv = hasLibmpv();
const hint = HINTS[process.platform];
console.log(
  mpv
    ? '[kiro] libmpv found: native playback enabled (KIRO_MPV=0 to disable)'
    : hint
      ? `[kiro] libmpv not found: starting without native playback (${hint} to enable)`
      : '[kiro] native playback is not available on this platform: starting without it',
);

const args = ['dev', ...(mpv ? ['--features', 'libmpv'] : []), ...process.argv.slice(2)];
const child = spawn('tauri', args, { stdio: 'inherit', shell: process.platform === 'win32' });

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => child.kill(signal));
}
child.on('exit', (code, signal) => {
  if (signal) process.kill(process.pid, signal);
  else process.exit(code ?? 0);
});
