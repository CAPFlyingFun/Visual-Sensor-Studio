import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * BOOT SURVIVAL, measured against a faithful reproduction of the failure
 * Joshua hit on his phone (2026-09-03): "I had lost all the buttons and
 * wasn't able to enable the camera as all buttons were disabled."
 *
 * The shape of app.ts is what made one error total: the capture buttons ship
 * `disabled` in the markup, byId() throws on a missing element, and boot is
 * one long unguarded run of top-level statements with the Enable Camera
 * listener near the very end of it. So a single throw anywhere in the first
 * three thousand lines left Enable Camera looking normal with nothing behind
 * it, every other button greyed exactly as shipped, and no message at all.
 *
 * These tests break boot ON PURPOSE by serving index.html with one element
 * genuinely removed, and ask the only question that matters: can you still
 * turn the camera on?
 *
 * MEASURED BEFORE THE FIX, all three cases: camera never started, HUD stuck
 * at IDLE, canvas hidden, no banner. Exactly the reported symptom.
 */

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ROOT = fileURLToPath(new URL('../public', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.map': 'application/json'
};

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* not installed */ }
const runnable = chromium !== null && existsSync(CHROME);

/** Serve the app, optionally with one element stripped out of the markup. */
async function withBrokenBoot(missingId, body) {
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    const file = join(ROOT, url === '/' ? 'index.html' : url);
    if (!existsSync(file) || !file.startsWith(ROOT)) { res.writeHead(404); res.end(); return; }
    let payload = readFileSync(file);
    if (missingId && file.endsWith('index.html')) {
      const text = payload.toString('utf8');
      const pattern = new RegExp(`<([a-z]+)[^>]*id="${missingId}"[\\s\\S]*?</\\1>`, 'i');
      const stripped = text.replace(pattern, '<!-- removed by the test -->');
      assert.notEqual(stripped, text, `the test must really remove #${missingId}`);
      payload = Buffer.from(stripped, 'utf8');
    }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(payload);
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({
    executablePath: CHROME,
    args: ['--use-fake-device-for-media-stream', '--use-fake-ui-for-media-stream']
  });
  try {
    const context = await browser.newContext({
      permissions: ['camera'], viewport: { width: 390, height: 844 }
    });
    const page = await context.newPage();
    await page.goto(`http://127.0.0.1:${port}/`, { waitUntil: 'domcontentloaded' });
    await page.waitForTimeout(700);
    return await body(page);
  } finally {
    await browser.close();
    server.close();
  }
}

/** Tap Enable and wait for a genuinely live camera, not merely a click. */
async function cameraStarts(page) {
  try {
    await page.click('#v2EnableCamera', { timeout: 3000 });
    await page.waitForFunction(
      () => document.getElementById('v2HudState')?.textContent === 'LIVE',
      null, { timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

test('the camera still starts when boot breaks further down',
  { skip: runnable ? false : 'no browser available' }, async () => {
    // Three different elements, from three different parts of the page, each
    // removed on its own. Whichever one goes, the camera is wired before the
    // failure and must still come on.
    for (const missing of ['v2AverageRow', 'v2ExposureToggle', 'v2FilterStrip']) {
      await withBrokenBoot(missing, async (page) => {
        assert.equal(await cameraStarts(page), true,
          `#${missing} missing must not stop the camera`);
        // And the picture really renders, not just a state label.
        assert.equal(
          await page.evaluate(() => document.getElementById('v2PreviewCanvas')?.hidden),
          false, 'the preview is live, not merely reported live');
      });
    }
  });

test('a broken boot says so instead of looking like a working app',
  { skip: runnable ? false : 'no browser available' }, async () => {
    // The part that used to be missing entirely. A dead app that looks fine
    // is the worst version of this failure: there is nothing to report and
    // nothing to try.
    await withBrokenBoot('v2AverageRow', async (page) => {
      const banner = await page.evaluate(() =>
        document.getElementById('v2BootFailure')?.textContent ?? null);
      assert.ok(banner, 'the failure is on screen');
      assert.match(banner, /V2 markup is missing #v2AverageRow/,
        'and it names what actually broke');
      assert.match(banner, /Enable Camera should still work/,
        'and says what still works, so there is something to do');
    });
  });

test('an intact boot shows no banner at all',
  { skip: runnable ? false : 'no browser available' }, async () => {
    // The control. A warning that appears when nothing is wrong teaches
    // people to ignore it.
    await withBrokenBoot(null, async (page) => {
      assert.equal(
        await page.evaluate(() => !!document.getElementById('v2BootFailure')),
        false, 'no banner when nothing failed');
      assert.equal(await cameraStarts(page), true);
    });
  });

test('the camera controls are wired before the rest of boot', () => {
  // The ordering IS the fix, so it is pinned rather than left to survive by
  // habit: every camera control is attached in the first tenth of the file,
  // and each exactly once — a second listener would fire the action twice.
  const app = readFileSync(new URL('../src/v2/app.ts', import.meta.url), 'utf8');
  const lines = app.split('\n');
  const at = (needle) => lines.findIndex((line) => line.includes(needle));
  for (const control of ['v2EnableCamera', 'v2PhotoButton', 'v2RecordButton', 'v2SwitchCamera']) {
    const wiring = `byId('${control}').addEventListener`;
    assert.equal(app.split(wiring).length - 1, 1, `${control} is wired exactly once`);
    const where = at(wiring);
    assert.ok(where > 0 && where < lines.length * 0.1,
      `${control} is wired early (line ${where + 1} of ${lines.length})`);
  }
  // Its own guard, so this block cannot become the new single point of failure.
  assert.match(app, /the camera controls could not all be wired/);
});
