#!/usr/bin/env node
// Measures how smoothly Kiro runs on an Android TV device or emulator, by
// pressing remote keys with adb and reading the WebView over the DevTools
// protocol. Needs a build with WebView debugging: a debug build, or a
// release build made with `--features tauri/devtools`.
//
//   node scripts/android-perf.mjs latency [row|down] [--throttle 6]
//   node scripts/android-perf.mjs styles [row|down]
//   node scripts/android-perf.mjs layers
//   node scripts/android-perf.mjs playback [playing|paused]
//
// - latency: from each key press to the next frame (Event Timing), and the
//   time spent in key handlers. `--throttle` slows the page's CPU (6 is
//   roughly a TV box's Cortex-A53 against an Apple M1 core).
// - styles: style recalculations and elements restyled per press.
// - layers: composited layers on the page.
// - playback: the page's main-thread work while a stream plays with the
//   controls hidden (or paused, with them shown), per second. The stream is
//   KIRO_PERF_STREAM, by default a public HLS test stream.
//
// Routes start from the first poster of the first row on Discover: `row`
// goes right ten times and back four, `down` goes down four rows and up two.
// Pick a device with ANDROID_SERIAL when several are attached.
import { execFileSync } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';

const PACKAGE = 'app.kiro.tv';
const PORT = 9333;
const ROUTES = {
  row: [
    ['DPAD_RIGHT', 10],
    ['DPAD_LEFT', 4],
  ],
  down: [
    ['DPAD_DOWN', 4],
    ['DPAD_UP', 2],
  ],
};

const STREAM = process.env.KIRO_PERF_STREAM ?? 'https://test-streams.mux.dev/x36xhzz/x36xhzz.m3u8';

const [mode = 'latency', routeName, ...rest] = process.argv.slice(2);
const throttleAt = rest.indexOf('--throttle');
const throttle = throttleAt >= 0 ? Number(rest[throttleAt + 1]) : 1;
const route = ROUTES[routeName ?? 'row'];
const playbackState = routeName ?? 'playing';
const valid =
  mode === 'playback'
    ? ['playing', 'paused'].includes(playbackState)
    : ['latency', 'styles', 'layers'].includes(mode) && route;
if (!valid) {
  console.error(
    'usage: android-perf.mjs latency|styles|layers [row|down] [--throttle N] | playback [playing|paused]',
  );
  process.exit(2);
}

const adb = (...args) => execFileSync('adb', args, { encoding: 'utf8' });

/** Forwards the app's WebView DevTools socket and connects to its page. */
async function connect() {
  const pid = adb('shell', 'pidof', PACKAGE).trim();
  if (!pid) throw new Error(`${PACKAGE} isn't running`);
  adb('forward', `tcp:${PORT}`, `localabstract:webview_devtools_remote_${pid}`);
  const pages = await (await fetch(`http://localhost:${PORT}/json`)).json();
  const page = pages.find((p) => p.type === 'page');
  if (!page) throw new Error('No WebView page: is WebView debugging on in this build?');
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve) => ws.addEventListener('open', resolve));
  let id = 0;
  const pending = new Map();
  const listeners = new Set();
  ws.addEventListener('message', (message) => {
    const data = JSON.parse(message.data);
    pending.get(data.id)?.(data.result);
    for (const listener of listeners) listener(data);
  });
  const send = (method, params = {}) =>
    new Promise((resolve) => {
      pending.set(++id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = async (expression) =>
    (await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true })).result
      ?.value;
  return { send, evaluate, listeners, close: () => ws.close() };
}

/** Reloads Discover and puts key focus on the first poster of the first row. */
async function start(page) {
  await page.evaluate(`(() => { history.replaceState(null, '', '/'); location.reload(); })()`);
  await sleep(8000);
  adb('shell', 'input', 'keyevent', 'KEYCODE_DPAD_DOWN');
  await sleep(500);
  const card = await page.evaluate(`(() => {
    const card = document.querySelector('main ul a');
    if (!card) return null;
    card.setAttribute('data-nav-focus', '');
    card.focus();
    return card.textContent.trim().slice(0, 40);
  })()`);
  if (!card) throw new Error('No poster row on Discover');
  await sleep(1500);
}

async function press(pause = 120) {
  for (const [key, times] of route) {
    for (let i = 0; i < times; i++) {
      adb('shell', 'input', 'keyevent', `KEYCODE_${key}`);
      await sleep(pause);
    }
  }
  await sleep(1500);
}

const presses = route?.reduce((sum, [, times]) => sum + times, 0) ?? 0;

/** A Chrome trace of the page while `during` runs. */
async function trace(page, categories, during) {
  const events = [];
  let finish;
  const finished = new Promise((resolve) => (finish = resolve));
  page.listeners.add((data) => {
    if (data.method === 'Tracing.dataCollected') events.push(...data.params.value);
    if (data.method === 'Tracing.tracingComplete') finish();
  });
  await page.send('Tracing.start', {
    traceConfig: { includedCategories: categories },
    transferMode: 'ReportEvents',
  });
  await during();
  await page.send('Tracing.end');
  await finished;
  return events;
}
const median = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? +sorted[Math.floor(sorted.length / 2)].toFixed(1) : null;
};
const p90 = (values) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? +sorted[Math.floor(sorted.length * 0.9)].toFixed(1) : null;
};

const page = await connect();
try {
  if (mode === 'layers') {
    const layers = await new Promise((resolve) => {
      page.listeners.add((data) => {
        if (data.method === 'LayerTree.layerTreeDidChange' && data.params.layers) {
          resolve(data.params.layers);
        }
      });
      void page.send('LayerTree.enable');
      // The tree is sent with the next frame: draw one.
      setTimeout(() => adb('shell', 'input', 'keyevent', 'KEYCODE_DPAD_DOWN'), 1000);
    });
    const drawing = layers.filter((layer) => layer.drawsContent);
    console.log(JSON.stringify({ layers: layers.length, drawing: drawing.length }));
  } else if (mode === 'latency') {
    await start(page);
    await page.send('Emulation.setCPUThrottlingRate', { rate: throttle });
    await page.evaluate(`(() => {
      const perf = (window.__kiroPerf = { keys: [], handlers: [], frames: [] });
      perf.events = new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.name !== 'keydown') continue;
          perf.keys.push(entry.duration);
          perf.handlers.push(entry.processingEnd - entry.processingStart);
        }
      });
      perf.events.observe({ type: 'event', durationThreshold: 16 });
      const tick = (time) => { perf.frames.push(time); if (perf.events) requestAnimationFrame(tick); };
      requestAnimationFrame(tick);
    })()`);
    await press();
    const result = await page.evaluate(`(() => {
      const perf = window.__kiroPerf;
      perf.events.disconnect();
      perf.events = null;
      return perf;
    })()`);
    await page.send('Emulation.setCPUThrottlingRate', { rate: 1 });
    const { frames } = result;
    const seconds = (frames.at(-1) - frames[0]) / 1000;
    console.log(
      JSON.stringify({
        route: routeName,
        throttle,
        presses,
        keyToFrameMedianMs: median(result.keys),
        keyToFrameP90Ms: p90(result.keys),
        handlerMedianMs: median(result.handlers),
        handlerP90Ms: p90(result.handlers),
        fps: +((frames.length - 1) / seconds).toFixed(1),
      }),
    );
  } else if (mode === 'playback') {
    await page.evaluate(`(() => {
      history.pushState({ usr: { url: ${JSON.stringify(STREAM)}, title: 'Performance' }, key: 'perf' + Date.now(), idx: 1 }, '', '/player');
      dispatchEvent(new PopStateEvent('popstate', { state: history.state }));
    })()`);
    // Playing, then the controls hide after a few seconds without input.
    await sleep(12000);
    if (playbackState === 'paused') {
      adb('shell', 'input', 'keyevent', 'KEYCODE_MEDIA_PLAY_PAUSE');
      await sleep(3000);
    }
    const seconds = 8;
    // DOM changes: what re-rendering actually changed, whatever the CPU's load.
    await page.evaluate(`(() => {
      window.__kiroMutations = 0;
      window.__kiroObserver = new MutationObserver((records) => { window.__kiroMutations += records.length; });
      window.__kiroObserver.observe(document.body, { subtree: true, childList: true, attributes: true, characterData: true });
    })()`);
    const events = await trace(page, ['devtools.timeline', 'toplevel', 'v8'], () =>
      sleep(seconds * 1000),
    );
    const mutations = await page.evaluate(
      `(() => { window.__kiroObserver.disconnect(); return window.__kiroMutations; })()`,
    );
    const main = new Set(
      events
        .filter((e) => e.ph === 'M' && e.name === 'thread_name' && e.args.name === 'CrRendererMain')
        .map((e) => `${e.pid}:${e.tid}`),
    );
    const onMain = (name) =>
      events.filter((e) => e.ph === 'X' && e.name === name && main.has(`${e.pid}:${e.tid}`));
    const total = (list) => list.reduce((sum, e) => sum + e.dur / 1000, 0);
    const perSecond = (value) => +(value / seconds).toFixed(1);
    console.log(
      JSON.stringify({
        playback: playbackState,
        perSecond: {
          mainThreadMs: perSecond(total(onMain('ThreadControllerImpl::RunTask'))),
          scriptMs: perSecond(total(onMain('FunctionCall'))),
          messages: perSecond(onMain('EvaluateScript').length),
          domChanges: perSecond(mutations),
        },
      }),
    );
    adb('shell', 'input', 'keyevent', 'KEYCODE_BACK');
  } else {
    await start(page);
    const events = await trace(page, ['devtools.timeline', 'blink'], () => press(400));
    const styles = events.filter((e) => e.name === 'UpdateLayoutTree' && e.ph === 'X');
    const layouts = events.filter((e) => e.name === 'Layout' && e.ph === 'X');
    const sum = (list, value) => list.reduce((total, e) => total + value(e), 0);
    console.log(
      JSON.stringify({
        route: routeName,
        presses,
        perPress: {
          styleRecalcs: +(styles.length / presses).toFixed(1),
          elementsRestyled: Math.round(sum(styles, (e) => e.args?.elementCount ?? 0) / presses),
          styleMs: +(sum(styles, (e) => e.dur / 1000) / presses).toFixed(1),
          layoutMs: +(sum(layouts, (e) => e.dur / 1000) / presses).toFixed(1),
        },
      }),
    );
  }
} finally {
  page.close();
}
