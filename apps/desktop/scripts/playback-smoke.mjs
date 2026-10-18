// Playback smoke test, for CI on Windows and Linux (.github/workflows/playback.yml,
// and linux-packages.yml for the installed packages).
//
// Starts `tauri dev --features libmpv` playing an mpv test pattern (green,
// with a red band across the top), waits until the player has started and
// paused (`VITE_KIRO_SPIKE_EXERCISE=smoke`, so the controls stay on screen),
// takes a screenshot of the whole screen and checks it:
//
// - the pattern is visible: the video shows through the transparent webview;
// - the red band is above the green: the picture is the right way up;
// - light pixels (the controls' icons and text) sit inside the video: the
//   webview is drawn over the video, not under it.
//
// Usage: node scripts/playback-smoke.mjs <output-dir> [--app <executable>]
//        [--source <url>] [--expect-hwdec <name>]
//
// --app runs an installed release build instead of `tauri dev` (the .deb's
// /usr/bin/kiro-desktop, or an AppImage), with `KIRO_SMOKE_TEST_URL` set so it
// plays the source and pauses. --source plays something else than the test
// pattern: a URL, or a local file, served over http://127.0.0.1 (release
// builds only open http and https). Release builds can't play lavfi
// patterns, so --app needs it: an encoded copy of the pattern, e.g.
//   ffmpeg -f lavfi -i '<PATTERN below, without av://lavfi:>' -t 30 \
//     -c:v libx264 -pix_fmt yuv420p -movflags +faststart pattern.mp4
// --expect-hwdec fails unless mpv reports that hardware decoder (`no` for
// software decoding); the one it used is always written to result.json.
//
// The screenshot (.png and the raw capture) and the app's log are written to
// <output-dir>. Linux needs an X display (xvfb-run) and ImageMagick's
// `import`; Windows uses PowerShell.
import { spawn, spawnSync } from 'node:child_process';
import {
  createReadStream,
  createWriteStream,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createServer } from 'node:http';
import { basename, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

const { values: options, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    app: { type: 'string' },
    source: { type: 'string' },
    'expect-hwdec': { type: 'string' },
  },
});
const outDir = resolve(positionals[0] ?? 'playback-smoke');
mkdirSync(outDir, { recursive: true });
const isWindows = process.platform === 'win32';

const PATTERN =
  'av://lavfi:color=c=0x00ff00:s=1280x720:r=30,drawbox=x=0:y=0:w=iw:h=120:color=red:t=fill';
if (options.app && !options.source) throw new Error('--app needs --source (see above)');
const source =
  options.source && existsSync(options.source)
    ? await serve(options.source)
    : (options.source ?? PATTERN);

/** Serves one file over http on 127.0.0.1 (with byte ranges, for seeking); returns its URL. */
async function serve(path) {
  const { size } = statSync(path);
  const server = createServer((request, response) => {
    const range = /^bytes=(\d*)-(\d*)$/.exec(request.headers.range ?? '');
    const start = range?.[1] ? Number(range[1]) : 0;
    const end = range?.[2] ? Math.min(Number(range[2]), size - 1) : size - 1;
    if (range && start > end) {
      response.writeHead(416, { 'content-range': `bytes */${size}` }).end();
      return;
    }
    response.writeHead(range ? 206 : 200, {
      'accept-ranges': 'bytes',
      'content-length': end - start + 1,
      'content-type': 'video/mp4',
      ...(range && { 'content-range': `bytes ${start}-${end}/${size}` }),
    });
    if (request.method === 'HEAD') response.end();
    else createReadStream(path, { start, end }).pipe(response);
  });
  await new Promise((listening) => server.listen(0, '127.0.0.1', listening));
  server.unref();
  return `http://127.0.0.1:${server.address().port}/${basename(path)}`;
}
/** The first build happens before this script; this covers linking and start-up. */
const START_TIMEOUT_MS = 10 * 60_000;
/** Screenshots after the pause: soon, and once any start-up screen is surely gone. */
const SHOTS_MS = [2500, 12_000];

const log = createWriteStream(join(outDir, 'app.log'));
const [command, args] = options.app
  ? [options.app, []]
  : ['pnpm', ['exec', 'tauri', 'dev', '--features', 'libmpv', '--no-watch']];
const app = spawn(command, args, {
  env: {
    ...process.env,
    KIRO_SPIKE_LOG: '1',
    ...(options.app
      ? { KIRO_SMOKE_TEST_URL: source }
      : { VITE_KIRO_SPIKE_AUTOPLAY: source, VITE_KIRO_SPIKE_EXERCISE: 'smoke' }),
  },
  shell: isWindows,
  // Its own process group on Linux, so stopping it stops vite and the app too.
  detached: !isWindows,
  stdio: ['ignore', 'pipe', 'pipe'],
});

let output = '';
const paused = new Promise((resolvePaused, reject) => {
  const timer = setTimeout(
    () => reject(new Error('timed out waiting for playback')),
    START_TIMEOUT_MS,
  );
  const onData = (chunk) => {
    const text = chunk.toString();
    log.write(text);
    process.stdout.write(text);
    output += text;
    // The player failed to start or to open the source (an error code, not
    // a value): no use waiting.
    const failed = /\[kiro-player\] player_(attach|load)\(.*\) -> ([A-Z][A-Z_]+ .*)/.exec(output);
    if (failed) {
      clearTimeout(timer);
      reject(new Error(`player_${failed[1]} failed: ${failed[2]}`));
      return;
    }
    const playing = output.indexOf('"state":"playing"');
    if (playing >= 0 && output.indexOf('"state":"paused"', playing) >= 0) {
      clearTimeout(timer);
      resolvePaused();
    }
  };
  app.stdout.on('data', onData);
  app.stderr.on('data', onData);
  app.on('exit', (code) => {
    clearTimeout(timer);
    reject(new Error(`the app exited (${code}) before playback started`));
  });
});

async function stop() {
  if (isWindows) {
    spawnSync('taskkill', ['/PID', String(app.pid), '/T', '/F'], { stdio: 'ignore' });
    return;
  }
  for (const signal of ['SIGTERM', 'SIGKILL']) {
    try {
      process.kill(-app.pid, signal);
    } catch {
      return; // Already gone.
    }
    await new Promise((done) => setTimeout(done, 3000));
  }
}

/** Captures the screen as an uncompressed image Node can read without packages. */
function screenshot(name) {
  if (isWindows) {
    const bmp = join(outDir, `${name}.bmp`);
    const png = join(outDir, `${name}.png`);
    const script = `
      Add-Type -AssemblyName System.Windows.Forms, System.Drawing
      $b = [System.Windows.Forms.SystemInformation]::VirtualScreen
      $bmp = New-Object System.Drawing.Bitmap $b.Width, $b.Height, ([System.Drawing.Imaging.PixelFormat]::Format24bppRgb)
      $g = [System.Drawing.Graphics]::FromImage($bmp)
      $g.CopyFromScreen($b.Left, $b.Top, 0, 0, $bmp.Size)
      $bmp.Save('${bmp}', [System.Drawing.Imaging.ImageFormat]::Bmp)
      $bmp.Save('${png}', [System.Drawing.Imaging.ImageFormat]::Png)`;
    const result = spawnSync('powershell', ['-NoProfile', '-Command', script], {
      encoding: 'utf8',
    });
    if (result.status !== 0) throw new Error(`screenshot failed: ${result.stderr}`);
    return readBmp(readFileSync(bmp));
  }
  const ppm = join(outDir, `${name}.ppm`);
  for (const target of [ppm, join(outDir, `${name}.png`)]) {
    const result = spawnSync('import', ['-window', 'root', target], { encoding: 'utf8' });
    if (result.status !== 0) throw new Error(`screenshot failed: ${result.stderr}`);
  }
  return readPpm(readFileSync(ppm));
}

/** Binary PPM (P6), 8 or 16 bits per sample (ImageMagick writes 16 for a 32-bit window). */
function readPpm(data) {
  const header = [];
  let offset = 0;
  while (header.length < 4) {
    while (/\s/.test(String.fromCharCode(data[offset]))) offset += 1;
    if (data[offset] === 0x23) {
      while (data[offset] !== 0x0a) offset += 1;
      continue;
    }
    let token = '';
    while (!/\s/.test(String.fromCharCode(data[offset])))
      token += String.fromCharCode(data[offset++]);
    header.push(token);
  }
  offset += 1;
  const [magic, width, height, maxval] = header.map((token, i) => (i ? Number(token) : token));
  if (magic !== 'P6') throw new Error(`unexpected PPM ${magic}`);
  const bytes = maxval > 255 ? 2 : 1;
  const sample = (i) => (bytes === 2 ? data.readUInt16BE(i) : data[i]);
  return {
    width,
    height,
    pixel: (x, y) => {
      const i = offset + (y * width + x) * 3 * bytes;
      return [0, 1, 2].map((c) => Math.round((sample(i + c * bytes) * 255) / maxval));
    },
  };
}

/** 24-bit BMP, bottom-up. */
function readBmp(data) {
  const start = data.readUInt32LE(10);
  const width = data.readInt32LE(18);
  const height = data.readInt32LE(22);
  const stride = Math.ceil((width * 3) / 4) * 4;
  return {
    width,
    height: Math.abs(height),
    pixel: (x, y) => {
      const row = height > 0 ? height - 1 - y : y;
      const i = start + row * stride + x * 3;
      return [data[i + 2], data[i + 1], data[i]];
    },
  };
}

function analyse(image) {
  const isGreen = ([r, g, b]) => g > 150 && r < 110 && b < 110;
  const isRed = ([r, g, b]) => r > 150 && g < 110 && b < 110;
  const isLight = ([r, g, b]) => r > 200 && g > 200 && b > 200;
  // The pattern's colours, also where the controls' gradient darkens them.
  const isTinted = ([r, g, b]) =>
    (g > 30 && g > 2 * r && g > 2 * b) || (r > 30 && r > 2 * g && r > 2 * b);
  let green = 0;
  let red = 0;
  let greenY = 0;
  let redY = 0;
  let lightOverVideo = 0;
  for (let y = 0; y < image.height; y += 2) {
    for (let x = 0; x < image.width; x += 2) {
      const pixel = image.pixel(x, y);
      if (isGreen(pixel)) {
        green += 1;
        greenY += y;
      } else if (isRed(pixel)) {
        red += 1;
        redY += y;
      } else if (isLight(pixel)) {
        // Part of the controls (icons, text) with the video right beside it:
        // drawn over the video.
        for (const dx of [-8, -4, 4, 8]) {
          const nx = x + dx;
          if (nx >= 0 && nx < image.width && isTinted(image.pixel(nx, y))) {
            lightOverVideo += 1;
            break;
          }
        }
      }
    }
  }
  const sampled = Math.ceil(image.width / 2) * Math.ceil(image.height / 2);
  return {
    size: `${image.width}x${image.height}`,
    greenShare: Number((green / sampled).toFixed(3)),
    redPixels: red,
    redAboveGreen: red > 0 && green > 0 && redY / red < greenY / green,
    lightPixelsOverVideo: lightOverVideo,
  };
}

let failure = null;
try {
  await paused;
  let elapsed = 0;
  const results = {};
  for (const [index, at] of SHOTS_MS.entries()) {
    await new Promise((done) => setTimeout(done, at - elapsed));
    elapsed = at;
    results[`screen-${index + 1}`] = analyse(screenshot(`screen-${index + 1}`));
  }
  // The player's periodic stats line (KIRO_SPIKE_LOG): `hwdec: Some("vaapi")`.
  const hwdecs = [...output.matchAll(/hwdec: Some\("([^"]*)"\)/g)].map((match) => match[1]);
  results.hwdec = hwdecs.at(-1) ?? null;
  writeFileSync(join(outDir, 'result.json'), JSON.stringify(results, null, 2));
  console.log('\n[smoke] results', JSON.stringify(results));
  // Judged on the second: start-up screens may still cover the first.
  const result = results['screen-2'];
  const problems = [
    result.greenShare < 0.1 && 'the video is not visible (opaque webview, or nothing drawn)',
    !result.redAboveGreen && 'the picture is upside down, or the red band is missing',
    result.lightPixelsOverVideo < 20 &&
      'no controls over the video (video drawn over the webview?)',
    options['expect-hwdec'] !== undefined &&
      results.hwdec !== options['expect-hwdec'] &&
      `mpv decoded with hwdec ${results.hwdec}, not ${options['expect-hwdec']}`,
  ].filter(Boolean);
  if (problems.length > 0) failure = new Error(problems.join('; '));
} catch (error) {
  failure = error;
} finally {
  await stop();
  log.end();
}
if (failure) {
  console.error(`\n[smoke] FAILED: ${failure.message}`);
  process.exit(1);
}
console.log('\n[smoke] passed');
process.exit(0);
