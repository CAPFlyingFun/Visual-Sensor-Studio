import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * V2 Milestones A–B, measured in a real browser: routing, the single sticky
 * viewfinder, and — with Chromium's fake camera — the actual camera lifecycle,
 * negotiated source size and measured delivered FPS flowing through the V2
 * state into the HUD; then the GPU pipeline itself, on SwiftShader: shaders
 * compile and draw, the canvas carries exactly the PREVIEW geometry, filters
 * change the pixels in the way each shader promises, and a photo comes out at
 * exactly the SOURCE size. Skips loudly where no browser is available.
 *
 * Real-iPhone acceptance still applies on top of this; Chromium's fake device
 * cannot verify WebKit behaviour, PWA lifecycle or MP4 output.
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

async function withBrowser(body, extraArgs = []) {
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    const file = join(ROOT, url === '/' ? 'index.html' : url);
    if (!existsSync(file) || !file.startsWith(ROOT)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: CHROME, args: ["--use-fake-device-for-media-stream", "--use-fake-ui-for-media-stream", ...extraArgs] });
  try {
    return await body(browser, `http://127.0.0.1:${port}`);
  } finally {
    await browser.close();
    server.close();
  }
}

test('?scene=v2 routes to V2 and its absence leaves legacy untouched',
  { skip: runnable ? false : 'no browser available' }, async () => {
    await withBrowser(async (browser, base) => {
      const page = await browser.newPage({ viewport: { width: 430, height: 932 } });

      await page.goto(`${base}/index.html?scene=v2`);
      await page.waitForTimeout(400);
      assert.ok(page.url().includes('/v2.html'), `should land on v2.html, got ${page.url()}`);
      assert.ok(page.url().includes('scene=v2'), 'the query survives the redirect');
      assert.equal(await page.textContent('#v2Badge'), 'V2 · Experimental');

      await page.goto(`${base}/index.html`);
      await page.waitForTimeout(400);
      assert.ok(!page.url().includes('v2.html'), 'without the parameter the legacy app stays');
      assert.ok(await page.$('.tabbar'), 'the legacy tab bar is present');
      assert.equal(await page.$('#v2Badge'), null, 'no V2 chrome leaks into legacy');
      await page.close();
    });
  });

for (const [label, width, height] of [['430x932', 430, 932], ['320x568', 320, 568]]) {
  test(`V2 keeps the viewfinder pinned and the page honest at ${label}`,
    { skip: runnable ? false : 'no browser available' }, async () => {
      await withBrowser(async (browser, base) => {
        const page = await browser.newPage({ viewport: { width, height } });
        await page.goto(`${base}/v2.html?scene=v2`);
        await page.waitForTimeout(400);

        const seen = await page.evaluate(() => {
          const sticky = [...document.querySelectorAll('*')]
            .filter((el) => getComputedStyle(el).position === 'sticky')
            .map((el) => el.className || el.tagName);
          const ids = [...document.querySelectorAll('[id]')].map((el) => el.id);
          return {
            sticky,
            docWidth: document.documentElement.scrollWidth,
            duplicateIds: ids.filter((id, i) => ids.indexOf(id) !== i),
            dockButtons: [...document.querySelectorAll('#v2Dock [data-route]')]
              .map((b) => b.dataset.route)
          };
        });
        assert.deepEqual(seen.sticky, ['viewfinder-wrap'],
          `only the viewfinder may be sticky, found: ${seen.sticky.join(', ')}`);
        assert.equal(seen.docWidth, width, 'no horizontal overflow');
        assert.deepEqual(seen.duplicateIds, []);
        assert.deepEqual(seen.dockButtons, ['camera', 'sensors', 'world', 'data', 'more'],
          'the dock is generated from NAV_ROUTES, in order');

        const before = await page.evaluate(() => ({
          top: Math.round(document.getElementById('v2Viewfinder').getBoundingClientRect().top),
          scrollable: document.documentElement.scrollHeight - innerHeight
        }));
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(150);
        const after = await page.evaluate(() => {
          const vf = document.getElementById('v2Viewfinder').getBoundingClientRect();
          const dock = document.getElementById('v2Dock').getBoundingClientRect();
          return { top: Math.round(vf.top), visible: vf.bottom > 0 && vf.top < innerHeight,
            dockTop: Math.round(dock.top), overlap: vf.bottom > dock.top + 1 };
        });
        assert.ok(after.visible, 'the viewfinder left the screen');
        // The main screen is deliberately lean now, so the page may not scroll
        // far: the viewfinder must ride up by whatever scroll exists and then
        // PIN — never leave, never drift below where the scroll would put it.
        const expectedTop = Math.max(0, before.top - Math.max(0, before.scrollable));
        assert.ok(after.top <= expectedTop + 1,
          `the viewfinder should be pinned: top ${after.top}, expected ≤ ${expectedTop} (scrollable ${before.scrollable})`);

        // The unimplemented routes are honest placeholders, not fake features.
        await page.click('[data-route="world"]');
        await page.waitForTimeout(100);
        assert.equal(await page.isHidden('#v2CameraRoute'), true);
        assert.match(await page.textContent('#v2PlaceholderPlan'), /legacy app/);
        // More is where the instruments live: the truth table and the probe
        // are off the main screen, never gone.
        await page.click('[data-route="more"]');
        await page.waitForTimeout(100);
        assert.equal(await page.isHidden('#v2CameraRoute'), true);
        assert.equal(await page.isHidden('#v2RoutePlaceholder'), true, 'More is real, not a placeholder');
        assert.equal(await page.isVisible('#v2DiagSource'), true, 'the truth table lives under More');
        assert.equal(await page.isVisible('#v2EncoderProbe'), true, 'the probe lives under More');
        await page.click('[data-route="camera"]');
        await page.waitForTimeout(100);
        assert.equal(await page.isHidden('#v2MoreRoute'), true);
        assert.equal(await page.isVisible('#v2StreamTiers'), true);
        const mainScreen = await page.evaluate(() =>
          document.getElementById('v2CameraRoute').contains(document.getElementById('v2DiagSource')));
        assert.equal(mainScreen, false, 'no truth table on the main screen');
        await page.close();
      });
    });
}

test('the hidden attribute really hides — no author display rule may defeat it',
  { skip: runnable ? false : 'no browser available' }, async () => {
    // The bug this exists for: #v2Reticle carried `display: grid`, which
    // outranks the UA stylesheet's [hidden] rule, so the box stayed on screen
    // with the attribute faithfully set. Every hideable element is checked
    // here rather than one at a time.
    await withBrowser(async (browser, base) => {
      const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(300);
      const showing = await page.evaluate(() =>
        [...document.querySelectorAll('[hidden]')]
          .filter((el) => getComputedStyle(el).display !== 'none')
          .map((el) => el.id || el.className || el.tagName));
      assert.deepEqual(showing, [], `these are hidden in name only: ${showing.join(', ')}`);
      await page.close();
    });
  });

test('the camera goes live and the HUD carries measured truth (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);

      await page.click('#v2EnableCamera');
      // The fake device negotiates quickly; a real one can take seconds.
      await page.waitForFunction(() =>
        document.getElementById('v2HudState')?.textContent === 'LIVE', null, { timeout: 8000 });

      // Let the frame-rate meter accumulate presented frames.
      await page.waitForTimeout(2500);
      const hud = await page.evaluate(() => ({
        state: document.getElementById('v2HudState').textContent,
        source: document.getElementById('v2HudSource').textContent,
        fps: document.getElementById('v2HudFps').textContent,
        diag: document.getElementById('v2DiagSource').textContent,
        capability: document.getElementById('v2DiagCapability').textContent,
        enableHidden: document.getElementById('v2EnableCamera').hidden,
        switchEnabled: !document.getElementById('v2SwitchCamera').disabled
      }));
      assert.equal(hud.state, 'LIVE');
      assert.match(hud.source, /^\d+×\d+$/, `the negotiated size should be numbers, got "${hud.source}"`);
      assert.match(hud.fps, /^\d+(\.\d+)? fps$/, `delivered fps should be measured, got "${hud.fps}"`);
      assert.match(hud.diag, /^\d+×\d+ · \d+(\.\d+)? delivered fps/,
        'the SOURCE row carries size and measured rate together');
      assert.match(hud.diag, /responsive live stream/,
        'the live-source policy names itself — a SOURCE below CAPABILITY is healthy, not flagged');
      // CAPABILITY is a fact of its own: numbers where the browser exposes
      // them, an honest "not exposed" where it does not — never a dash once
      // the camera is live.
      assert.match(hud.capability, /advertised maximum|measured maximum|measuring|not exposed/,
        `the CAPABILITY row must commit, got "${hud.capability}"`);
      assert.equal(hud.enableHidden, true, 'the enable overlay hides once live');
      assert.equal(hud.switchEnabled, true);
      await page.close();
      await context.close();
    });
  }, );

test('Milestone B: the GPU pipeline renders truthfully (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    const { ironbowColor } = await import('../.test-build/vision/motion-ironbow.js');
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      page.on('download', () => { /* the photo triggers a real download; discard it */ });
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);

      // The strip exists before the camera does — it is built from FILTERS at
      // boot, and the photo control is honestly disabled until frames exist.
      const boot = await page.evaluate(() => ({
        filters: [...document.querySelectorAll('#v2FilterStrip [data-filter]')]
          .map((b) => b.dataset.filter),
        active: [...document.querySelectorAll('#v2FilterStrip .active')]
          .map((b) => b.dataset.filter),
        photoDisabled: document.getElementById('v2PhotoButton').disabled,
        canvasHidden: document.getElementById('v2PreviewCanvas').hidden,
        stage: document.getElementById('v2Stage').textContent
      }));
      // Built-ins first, then the starter lens a fresh device seeds, then Custom +.
      assert.deepEqual(boot.filters.slice(0, 6), ['rgb', 'ironbow', 'difference', 'speed', 'trails', 'edges'],
        'the strip mirrors the FILTERS registry, in order');
      assert.deepEqual(boot.active, ['rgb'], 'RGB is the default filter');
      assert.equal(boot.photoDisabled, true, 'no photo before the camera is live');
      assert.equal(boot.canvasHidden, true, 'no canvas over the video until a real render');
      assert.ok(!/WebGL is unavailable/.test(boot.stage),
        `WebGL must initialise in this browser, stage says: "${boot.stage}"`);

      await page.click('#v2EnableCamera');
      await page.waitForFunction(() =>
        document.getElementById('v2HudState')?.textContent === 'LIVE', null, { timeout: 8000 });
      // A rendered-fps number in the PREVIEW row is the proof frames are drawing.
      await page.waitForFunction(() =>
        /\d+(\.\d+)? rendered fps/.test(document.getElementById('v2DiagPreview')?.textContent ?? ''),
        null, { timeout: 8000 });

      const sampleCanvas = () => page.evaluate(() => {
        const canvas = document.getElementById('v2PreviewCanvas');
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const pixels = [];
        let maxChroma = 0;
        for (let y = 0; y < 8; y++) {
          for (let x = 0; x < 8; x++) {
            const d = ctx.getImageData(
              Math.floor((x + 0.5) * copy.width / 8),
              Math.floor((y + 0.5) * copy.height / 8), 1, 1).data;
            pixels.push([d[0], d[1], d[2]]);
            maxChroma = Math.max(maxChroma,
              Math.abs(d[0] - d[1]), Math.abs(d[1] - d[2]), Math.abs(d[0] - d[2]));
          }
        }
        return { pixels, maxChroma, hidden: canvas.hidden, width: canvas.width, height: canvas.height };
      });

      // RGB: the canvas is visible and carries the fake device's colours.
      const rgb = await sampleCanvas();
      assert.equal(rgb.hidden, false, 'the canvas unhides once frames render');
      assert.ok(rgb.maxChroma > 20,
        `RGB preserves colour — the fake pattern is not grey (chroma ${rgb.maxChroma})`);

      // One owner, observable end to end: the canvas draws at EXACTLY the
      // PREVIEW row's size, PREVIEW never exceeds SOURCE, PHOTO equals SOURCE.
      const rows = await page.evaluate(() => ({
        source: document.getElementById('v2DiagSource').textContent,
        preview: document.getElementById('v2DiagPreview').textContent,
        policy: document.getElementById('v2DiagPhotoPolicy').textContent,
        viewfinder: document.getElementById('v2DiagViewfinder').textContent
      }));
      const dims = (text) => text.match(/^(\d+)×(\d+)/).slice(1, 3).map(Number);
      const [sw, sh] = dims(rows.source);
      const [pw, ph] = dims(rows.preview);
      assert.equal(rgb.width, pw, 'the canvas width is the PREVIEW geometry, no private size');
      assert.equal(rgb.height, ph);
      assert.ok(pw <= sw && ph <= sh, `preview ${pw}×${ph} never exceeds the stream ${sw}×${sh}`);
      assert.equal(rows.policy, 'maximum available stream on shutter',
        'PHOTO POLICY is a policy, not a size — the live SOURCE owes it nothing');
      assert.match(rows.viewfinder, /^\d+×\d+ device px/,
        'the VIEWFINDER row is display geometry, stated as such');

      // Edges: the Sobel shader writes vec3(g) — every pixel exactly grey.
      await page.click('[data-filter="edges"]');
      await page.waitForTimeout(600);
      const edges = await sampleCanvas();
      assert.ok(edges.maxChroma <= 2,
        `Sobel output is grey by construction, worst chroma ${edges.maxChroma}`);

      // Ironbow: every pixel must lie ON the legacy ramp — the LUT uploaded to
      // the GPU is ironbowColor itself, and no arbitrary colour (the fake
      // device's green, say) is anywhere near that ramp.
      await page.click('[data-filter="ironbow"]');
      await page.waitForTimeout(600);
      const ironbow = await sampleCanvas();
      assert.ok(ironbow.maxChroma > 20, 'the ramp is colour, not grey');
      const ramp = [];
      for (let i = 0; i < 256; i++) ramp.push(ironbowColor(i / 255));
      const offRamp = ironbow.pixels.filter(([r, g, b]) => {
        let best = Infinity;
        for (const [rr, rg, rb] of ramp) {
          best = Math.min(best, Math.hypot(r - rr, g - rg, b - rb));
        }
        return best > 20;
      });
      assert.equal(offRamp.length, 0,
        `every ironbow pixel sits on the legacy ramp, off-ramp: ${JSON.stringify(offRamp.slice(0, 3))}`);

      // Photo: the shutter's temporary maximum-stream window. The saved size
      // is whatever the camera actually granted — never less than the live
      // stream had, never a request taken on faith — and the whole timeline
      // is measured.
      await page.click('#v2PhotoButton');
      await page.waitForFunction(() =>
        (document.getElementById('v2PhotoResult')?.textContent ?? '').startsWith('Saved'),
        null, { timeout: 20000 });
      const line = await page.textContent('#v2PhotoResult');
      const [savedW, savedH] = dims(line.replace(/^Saved /, ''));
      assert.ok(
        Math.min(savedW, savedH) >= Math.min(sw, sh) && Math.max(savedW, savedH) >= Math.max(sw, sh),
        `the shutter never saves less than the live stream had, got "${line}" against ${sw}×${sh}`);
      assert.match(line,
        /the (largest stream the camera granted for this shot|camera kept its current mode|camera declined a larger mode)/,
        `the escalation outcome is reported honestly, got "${line}"`);
      const timing = await page.textContent('#v2PhotoTiming');
      assert.match(timing, /Max frame ready \+\d+ ms/, 'the shutter timeline is instrumented');
      assert.match(timing, /Total \d+ ms/);
      // The truth table renders on a throttle, so give the row its beat.
      await page.waitForFunction(([w, h]) =>
        (document.getElementById('v2DiagLastPhoto')?.textContent ?? '').startsWith(`${w}×${h}`),
        [savedW, savedH], { timeout: 3000 });

      // The live stream comes back RESPONSIVE: the engine restores the
      // remembered SHORT SIDE (the exact mode is the browser's choice — the
      // fake device comes back 1280×720 for a 960×720 start, measured), and
      // the stream must have left the capture mode when one was entered.
      const escalated = savedW !== sw || savedH !== sh;
      await page.waitForFunction(([shortSide, wasEscalated, capW, capH]) => {
        const text = document.getElementById('v2DiagSource')?.textContent ?? '';
        const m = text.match(/^(\d+)×(\d+)/);
        if (!m) return false;
        const w = Number(m[1]);
        const h = Number(m[2]);
        if (Math.min(w, h) !== shortSide) return false;
        if (wasEscalated && w === capW && h === capH) return false;
        return /responsive live stream/.test(text);
      }, [Math.min(sw, sh), escalated, savedW, savedH], { timeout: 10000 });

      // And the preview follows the RESTORED stream through the one owner:
      // the canvas matches the PREVIEW row exactly, at the same short side.
      await page.waitForTimeout(600);
      const after = await sampleCanvas();
      const [rpw, rph] = dims(await page.textContent('#v2DiagPreview'));
      assert.equal(after.width, rpw, 'the canvas tracks the PREVIEW geometry after a photo');
      assert.equal(after.height, rph);
      assert.equal(Math.min(after.width, after.height), Math.min(pw, ph),
        'the preview short side comes back with the responsive stream');

      await page.close();
      await context.close();
    });
  });

test('Milestone D: Motion renders honest frame change on the GPU (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    const { ironbowColor } = await import('../.test-build/vision/motion-ironbow.js');
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);
      await page.click('#v2EnableCamera');
      await page.waitForFunction(() =>
        /\d+(\.\d+)? rendered fps/.test(document.getElementById('v2DiagPreview')?.textContent ?? ''),
        null, { timeout: 8000 });

      await page.click('[data-filter="difference"]');
      // Let history warm up past the first-frame artefact and settle.
      await page.waitForTimeout(900);
      const seen = await page.evaluate(() => {
        const canvas = document.getElementById('v2PreviewCanvas');
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const pixels = [];
        for (let y = 0; y < 6; y++) {
          for (let x = 0; x < 6; x++) {
            const d = ctx.getImageData(
              Math.floor((x + 0.5) * copy.width / 6),
              Math.floor((y + 0.5) * copy.height / 6), 1, 1).data;
            pixels.push([d[0], d[1], d[2]]);
          }
        }
        return {
          pixels,
          photoDisabled: document.getElementById('v2PhotoButton').disabled,
          analysisRow: document.getElementById('v2DiagAnalysis').textContent
        };
      });
      // Every Motion pixel is a point on the ramp: still regions at its dark
      // foot, the fake device's moving pattern lighting up — no colour that
      // is not a measured change.
      const ramp = [];
      for (let i = 0; i < 256; i++) ramp.push(ironbowColor(i / 255));
      const offRamp = seen.pixels.filter(([r, g, b]) => {
        let best = Infinity;
        for (const [rr, rg, rb] of ramp) {
          best = Math.min(best, Math.hypot(r - rr, g - rg, b - rb));
        }
        return best > 22;
      });
      assert.equal(offRamp.length, 0,
        `Motion pixels sit on the ramp, off: ${JSON.stringify(offRamp.slice(0, 3))}`);
      assert.ok(seen.photoDisabled,
        'stills are declined by metadata — history cannot honestly fill a photo');
      assert.match(seen.analysisRow, /holding frame history/,
        'the ANALYSIS row says its buffer is in use');

      // Back to RGB: the photo returns with the capability.
      await page.click('[data-filter="rgb"]');
      await page.waitForFunction(() =>
        document.getElementById('v2PhotoButton').disabled === false, null, { timeout: 3000 });

      await page.close();
      await context.close();
    });
  });

test('the stream tier renegotiates the LIVE stream and the row measures it (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);
      await page.click('#v2EnableCamera');
      await page.waitForFunction(() =>
        /\d+(\.\d+)? rendered fps/.test(document.getElementById('v2DiagPreview')?.textContent ?? ''),
        null, { timeout: 8000 });

      const tiers = await page.evaluate(() =>
        [...document.querySelectorAll('#v2StreamTiers [data-stream-tier]')]
          .map((b) => b.dataset.streamTier));
      assert.deepEqual(tiers, ['720', '1080', '2k', '4k', 'maximum'],
        'the tier strip mirrors STREAM_TIERS, in order');
      await page.waitForFunction(() =>
        /responsive live stream/.test(document.getElementById('v2DiagSource')?.textContent ?? ''),
        null, { timeout: 3000 });

      // A class the camera cannot fill shows RED and answers a tap with a
      // 5 s toast instead of applying; no standing text under the strip.
      // Read the CAPABILITY row the app itself reads, so the check holds
      // whether or not this browser exposes capability.
      const availability = await page.evaluate(() => {
        const cap = document.getElementById('v2DiagCapability')?.textContent ?? '';
        const m = cap.match(/^(\d+)×(\d+)/);
        const button = (id) => document.querySelector(`[data-stream-tier="${id}"]`);
        return {
          capShort: m ? Math.min(Number(m[1]), Number(m[2])) : null,
          fourKRed: button('4k')?.classList.contains('unavailable') ?? null,
          fourKDisabled: button('4k')?.disabled ?? null,
          maxRed: button('maximum')?.classList.contains('unavailable') ?? null,
          toastHidden: document.getElementById('v2Toast')?.hidden ?? null
        };
      });
      assert.equal(availability.maxRed, false, 'MAX is always this camera\'s own largest');
      assert.equal(availability.fourKDisabled, false,
        'unavailable tiers stay tappable — the tap explains via toast');
      assert.equal(availability.toastHidden, true, 'no toast until someone taps');
      if (availability.capShort !== null) {
        const expectRed = availability.capShort < 3240;
        assert.equal(availability.fourKRed, expectRed,
          `capability short side ${availability.capShort} vs the 4K class (3240)`);
        if (expectRed) {
          await page.click('[data-stream-tier="4k"]');
          const toast = await page.evaluate(() => ({
            hidden: document.getElementById('v2Toast')?.hidden ?? null,
            text: document.getElementById('v2Toast')?.textContent ?? '',
            active: document.querySelector('#v2StreamTiers .active')?.dataset.streamTier ?? null
          }));
          assert.equal(toast.hidden, false, 'a tap on a red tier answers with the toast');
          assert.match(toast.text, /not available/, 'the toast names the reason');
          assert.equal(toast.active, '720', 'a refused tier is never applied');
        }
      } else {
        assert.equal(availability.fourKRed, false,
          'unknown capability flags nothing — that would state an unmeasured fact');
      }

      // Up to 1080: a deliberate choice, applied to the RUNNING track, and
      // the SOURCE row reports the measured stream — never the request.
      await page.click('[data-stream-tier="1080"]');
      await page.waitForFunction(() => {
        const text = document.getElementById('v2DiagSource')?.textContent ?? '';
        const m = text.match(/^(\d+)×(\d+)/);
        return m !== null
          && Math.min(Number(m[1]), Number(m[2])) === 1080
          && /1080-class live stream/.test(text);
      }, null, { timeout: 8000 });

      // And back down — responsive is one tap away, and the preview follows
      // the stream through both changes via the one geometry owner.
      await page.click('[data-stream-tier="720"]');
      await page.waitForFunction(() => {
        const text = document.getElementById('v2DiagSource')?.textContent ?? '';
        const m = text.match(/^(\d+)×(\d+)/);
        return m !== null
          && Math.min(Number(m[1]), Number(m[2])) === 720
          && /responsive live stream/.test(text);
      }, null, { timeout: 8000 });
      await page.waitForTimeout(600);
      const canvas = await page.evaluate(() => document.getElementById('v2PreviewCanvas').width);
      const preview = Number((await page.textContent('#v2DiagPreview')).match(/^(\d+)×/)[1]);
      assert.equal(canvas, preview, 'the preview tracks the geometry through tier changes');

      await page.close();
      await context.close();
    });
  });

test('Milestone D: Speed and Trails carry their memory in a state pass at ANALYSIS size (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    const { ironbowColor } = await import('../.test-build/vision/motion-ironbow.js');
    const ramp = [];
    for (let i = 0; i < 256; i++) ramp.push(ironbowColor(i / 255));
    const onRamp = ([r, g, b]) => ramp.some(([rr, gg, bb]) =>
      Math.abs(rr - r) <= 10 && Math.abs(gg - g) <= 10 && Math.abs(bb - b) <= 10);
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);
      await page.click('#v2EnableCamera');
      await page.waitForFunction(() =>
        /\d+(\.\d+)? rendered fps/.test(document.getElementById('v2DiagPreview')?.textContent ?? ''),
        null, { timeout: 8000 });

      const sample = () => page.evaluate(() => {
        const canvas = document.getElementById('v2PreviewCanvas');
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const pixels = [];
        for (let y = 0; y < 6; y++) {
          for (let x = 0; x < 6; x++) {
            const d = ctx.getImageData(
              Math.floor((x + 0.5) * copy.width / 6),
              Math.floor((y + 0.5) * copy.height / 6), 1, 1).data;
            pixels.push([d[0], d[1], d[2]]);
          }
        }
        return {
          pixels,
          drawn: pixels.some(([r, g, b]) => r + g + b > 0),
          photoDisabled: document.getElementById('v2PhotoButton').disabled,
          analysisRow: document.getElementById('v2DiagAnalysis').textContent,
          note: document.getElementById('v2FilterNote').textContent,
          stage: document.getElementById('v2Stage').textContent
        };
      });

      for (const id of ['speed', 'trails']) {
        await page.click(`[data-filter="${id}"]`);
        // Let the state pass run for a while: the fake device's moving
        // pattern feeds real change into the accumulation.
        await page.waitForTimeout(1200);
        const seen = await sample();
        assert.ok(!/shader failed/.test(seen.stage), `${id}: shaders compile and link, got "${seen.stage}"`);
        assert.ok(seen.drawn, `${id}: the state-fed display pass draws pixels`);
        const offRamp = seen.pixels.filter((p) => !onRamp(p));
        assert.equal(offRamp.length, 0,
          `${id}: every pixel is a point on the ramp — nothing but measured state, off-ramp: ${JSON.stringify(offRamp.slice(0, 3))}`);
        assert.equal(seen.photoDisabled, true, `${id} declines stills by metadata`);
        assert.match(seen.analysisRow, /holding frame history/, `${id} states where its history lives`);
        assert.match(seen.note, /ANALYSIS resolution/, `${id}'s note names its resolution`);
      }

      // (Accumulation itself is proven under controlled frames in the
      // renderer-contract test below; the fake camera's animation timing is
      // not a fair judge of it.)

      // RGB has no state and re-enables the shutter.
      await page.click('[data-filter="rgb"]');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.getElementById('v2PhotoButton').disabled), false);
      await page.close();
      await context.close();
    });
  });

test('temporal filters compare a frame against the SAME frame, not its mirror (renderer contract)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    // A vertical gradient is the sharpest possible mirror detector: compared
    // against itself it is all zero; compared against its flip it is bright
    // at both ends. Measured on device before this test existed: Motion,
    // Speed and Trails all rendered a kaleidoscope — the frame against its
    // own upside-down history.
    await withBrowser(async (browser, base) => {
      const page = await browser.newPage({ viewport: { width: 430, height: 932 } });
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(300);
      const result = await page.evaluate(async () => {
        const { GlRenderer } = await import('/app/v2/render/gl-renderer.js');
        const target = document.createElement('canvas');
        const renderer = new GlRenderer(target);
        if (renderer.unavailableReason) return { unavailable: renderer.unavailableReason };
        const source = document.createElement('canvas');
        source.width = 128;
        source.height = 96;
        const ctx = source.getContext('2d');
        const paint = (shift) => {
          const g = ctx.createLinearGradient(0, 0, 0, 96);
          g.addColorStop(0, '#000');
          g.addColorStop(1, '#fff');
          ctx.fillStyle = g;
          ctx.fillRect(0, 0, 128, 96);
          // A bright bar whose position we can move to create REAL change.
          ctx.fillStyle = '#fff';
          ctx.fillRect(0, 10 + shift, 128, 6);
        };
        const size = { width: 128, height: 96 };
        const readMean = () => {
          const copy = document.createElement('canvas');
          copy.width = target.width;
          copy.height = target.height;
          const c = copy.getContext('2d');
          c.drawImage(target, 0, 0);
          const d = c.getImageData(0, 0, copy.width, copy.height).data;
          let sum = 0;
          for (let i = 0; i < d.length; i += 4) sum += d[i] + d[i + 1] + d[i + 2];
          return sum / (d.length / 4) / 3;
        };
        const out = {};
        for (const id of ['difference', 'speed', 'trails']) {
          // Warm up: identical frames, so history and state hold THIS frame.
          paint(0);
          for (let i = 0; i < 6; i++) {
            renderer.uploadFrame(source);
            renderer.render(id, size, size);
            renderer.snapshotHistory(size);
          }
          const still = readMean();
          // Now real motion: the bar moves 20 px.
          paint(20);
          renderer.uploadFrame(source);
          renderer.render(id, size, size);
          renderer.snapshotHistory(size);
          const moved = readMean();
          // Then the scene holds still again: Motion forgets at once, a
          // trail lingers (decays by 0.94 a frame), Speed's average fades.
          paint(20);
          renderer.uploadFrame(source);
          renderer.render(id, size, size);
          renderer.snapshotHistory(size);
          out[id] = { still, moved, after: readMean() };
        }
        return out;
      });
      assert.equal(result.unavailable, undefined, `renderer must be available, got "${result.unavailable}"`);
      for (const id of ['difference', 'speed', 'trails']) {
        const { still, moved } = result[id];
        // The Ironbow ramp's foot is near-black; a frame against itself must sit there.
        assert.ok(still < 30,
          `${id}: a static frame must read dark, got mean ${still.toFixed(1)} — a mirror comparison lights the gradient's ends`);
        assert.ok(moved > still + 5,
          `${id}: real motion must register, still ${still.toFixed(1)} vs moved ${moved.toFixed(1)}`);
      }
      // Memory is the difference between the three: one still frame after
      // the motion, Motion has forgotten it while Trails still shows it.
      assert.ok(result.difference.after < result.difference.moved,
        'Motion compares two frames only — a still frame after motion reads dark again');
      assert.ok(result.trails.after > result.difference.after + 5,
        `Trails keep the motion the frame pair has forgotten: trails ${result.trails.after.toFixed(1)} vs motion ${result.difference.after.toFixed(1)}`);
      assert.ok(result.trails.after <= result.trails.moved + 1,
        'a trail only ever decays once the motion stops');
      await page.close();
    });
  });

test('Milestone E: the lens workbench edits a live custom lens with exact numbers, saves, imports (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);

      // A fresh device carries the starter lens and the Custom + entry.
      const STARTERS = ['Coloring Book Style', 'Colour Splash', 'Colour Hide',
        'Paper → Pink', 'Hue Map', 'Colour Strength', 'Rare Colour',
        'Background Subtract', 'Rarity Map', 'Red Channel'];
      const strip = await page.evaluate(() => ({
        lenses: [...document.querySelectorAll('#v2FilterStrip [data-filter^="lens:"]')].map((b) => b.textContent),
        custom: Boolean(document.querySelector('#v2FilterStrip [data-lens-new]')),
        stored: JSON.parse(localStorage.getItem('vss.lenses.v1') ?? '[]').map((l) => l.name)
      }));
      assert.deepEqual(strip.lenses, STARTERS, 'the whole starter pack is offered');
      assert.equal(strip.custom, true, 'Custom + is a first-class entry');
      assert.deepEqual(strip.stored, STARTERS, 'stored under the key the legacy app reads');

      await page.click('#v2EnableCamera');
      await page.waitForFunction(() =>
        /\d+(\.\d+)? rendered fps/.test(document.getElementById('v2DiagPreview')?.textContent ?? ''),
        null, { timeout: 8000 });

      // The starter lens renders: pixels on ITS ramp (cream to ink), and a
      // photo is allowed because edges recompute at full size.
      await page.click('[data-filter="lens:lens-mtjarl1w-pcpts4"]');
      await page.waitForTimeout(700);
      const book = await page.evaluate(() => {
        const canvas = document.getElementById('v2PreviewCanvas');
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const d = ctx.getImageData(0, 0, copy.width, copy.height).data;
        let cream = 0;
        for (let i = 0; i < d.length; i += 4) if (d[i] > 200 && d[i + 1] > 190 && d[i + 2] > 170) cream++;
        return {
          creamShare: cream / (d.length / 4),
          photoEnabled: !document.getElementById('v2PhotoButton').disabled,
          note: document.getElementById('v2FilterNote').textContent,
          editVisible: !document.getElementById('v2LensEdit').hidden
        };
      });
      assert.ok(book.creamShare > 0.2, `flat regions paint the cream foot of the ramp, got ${book.creamShare.toFixed(2)}`);
      assert.equal(book.photoEnabled, true, 'an edges lens takes stills');
      assert.match(book.note, /edge strength, 0–254, curve 1\.6/, 'the note is the lens described');
      assert.equal(book.editVisible, true);

      // Custom +: a new draft becomes the active filter at once; the number
      // field sets an EXACT value the slider cannot reach.
      await page.click('[data-lens-new]');
      await page.waitForTimeout(200);
      const opened = await page.evaluate(() => ({
        shown: true,
        active: document.querySelector('#v2FilterStrip .active')?.dataset.filter ?? '',
        pairs: document.querySelectorAll('#v2LensWorkbench input[type="range"]').length,
        numbers: document.querySelectorAll('#v2LensWorkbench input[type="number"]').length
      }));
      assert.equal(await page.isVisible('#v2LensWorkbench'), true);
      assert.match(opened.active, /^lens:/, 'the draft previews live as the active filter');
      assert.ok(opened.numbers >= opened.pairs, 'every slider has a paired number field');
      await page.fill('#v2LensName', 'Probe lens');
      await page.fill('#v2LensHighNumber', '255');
      await page.dispatchEvent('#v2LensHighNumber', 'change');
      await page.waitForTimeout(150);
      const exact = await page.evaluate(() => ({
        slider: document.getElementById('v2LensHighRange').value,
        describe: document.getElementById('v2LensDescribe').textContent
      }));
      assert.equal(exact.slider, '255', 'the slider follows the exact number');
      assert.match(exact.describe, /0–255/, 'the lens now reads 255, not 254 or 256');

      await page.click('#v2LensSave');
      await page.waitForTimeout(200);
      const saved = await page.evaluate(() => ({
        names: JSON.parse(localStorage.getItem('vss.lenses.v1') ?? '[]').map((l) => l.name),
        strip: [...document.querySelectorAll('#v2FilterStrip [data-filter^="lens:"]')].map((b) => b.textContent)
      }));
      assert.deepEqual(saved.names, [...STARTERS, 'Probe lens']);
      assert.deepEqual(saved.strip, [...STARTERS, 'Probe lens']);

      // 🔄 Reverse: the same colours, read the other way.
      const before = await page.evaluate(() =>
        [...document.querySelectorAll('#v2LensStops input[type="color"]')].map((i) => i.value));
      await page.click('#v2LensReverse');
      await page.waitForTimeout(150);
      const after = await page.evaluate(() => ({
        colors: [...document.querySelectorAll('#v2LensStops input[type="color"]')].map((i) => i.value),
        positions: [...document.querySelectorAll('#v2LensStops input[type="number"]')].map((i) => Number(i.value))
      }));
      assert.deepEqual(after.colors, [...before].reverse(), 'reverse flips the ramp order');
      assert.deepEqual(after.positions, [0, 1], 'the ends stay the ends');

      // Guides: composition overlays, chosen from the registry row.
      const guideIds = await page.evaluate(() =>
        [...document.querySelectorAll('#v2GuideRow [data-guide]')].map((b) => b.dataset.guide));
      assert.deepEqual(guideIds, ['off', 'center', 'thirds', 'phi', 'diagonals', 'grid4', 'square']);
      assert.equal(await page.evaluate(() =>
        document.querySelectorAll('#v2Guides line').length), 0, 'Off draws nothing at all');
      await page.click('[data-guide="thirds"]');
      await page.waitForTimeout(300);
      const thirds = await page.evaluate(() => ({
        lines: [...document.querySelectorAll('#v2Guides line')].map((l) => l.getAttribute('x1')),
        note: document.getElementById('v2GuideNote').textContent
      }));
      assert.equal(await page.isVisible('#v2Guides'), true);
      assert.equal(thirds.lines.length, 4, 'four lines make the thirds');
      // Back to Off and the lines really leave the picture.
      await page.click('[data-guide="off"]');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() =>
        document.querySelectorAll('#v2Guides line').length), 0, 'Off clears what a guide drew');
      await page.click('[data-guide="thirds"]');
      await page.waitForTimeout(300);
      assert.match(thirds.note, /Rule of thirds/);

      // A guide alone never puts a marker in the middle of the picture.
      await page.click('[data-guide="center"]');
      await page.waitForTimeout(300);
      // Rendered visibility, never the attribute: the attribute was set and
      // ignored once already, and a test that reads it back learns nothing.
      assert.equal(await page.isVisible('#v2Reticle'), false,
        'choosing a guide must not summon the reticle');

      // The reticle is its own toggle, and its ring is the sample patch.
      await page.click('#v2ReticleToggle');
      await page.waitForTimeout(300);
      const centre = await page.evaluate(() => {
        const ring = document.getElementById('v2PatchRing');
        const box = document.getElementById('v2Viewfinder');
        return {
          pressed: document.getElementById('v2ReticleToggle').getAttribute('aria-pressed'),
          ringWidth: ring.getBoundingClientRect().width,
          ringHeight: ring.getBoundingClientRect().height,
          boxW: box.clientWidth,
          boxH: box.clientHeight
        };
      });
      assert.equal(await page.isVisible('#v2Reticle'), true, 'the toggle shows the reticle');
      assert.equal(await page.isVisible('#v2PatchRing'), true, 'ring and all');
      assert.equal(centre.pressed, 'true', 'and says so to a screen reader');
      assert.ok(Math.abs(centre.ringWidth - centre.ringHeight) < 1.5,
        `the ring is square on screen: ${centre.ringWidth} × ${centre.ringHeight}`);
      assert.ok(centre.ringWidth > 0 && centre.ringWidth < centre.boxW / 4,
        'the ring is the small patch it claims to be');

      // Toggled back off it leaves — but an ARMED PICKER still gets its target.
      await page.click('#v2ReticleToggle');
      await page.waitForTimeout(250);
      assert.equal(await page.isVisible('#v2Reticle'), false, 'off means off — on the screen, not just in an attribute');

      // The colour picker reads the CAMERA FRAME through the cover crop.
      await page.click('#v2PickColor');
      await page.waitForTimeout(150);
      const armed = await page.evaluate(() => ({
        picking: document.getElementById('v2Viewfinder').classList.contains('picking'),
        hex: document.getElementById('v2PickerHex').textContent
      }));
      assert.equal(await page.isVisible('#v2PickerCard'), true);
      assert.equal(await page.isVisible('#v2Reticle'), true,
        'arming the picker shows its target, toggle or not');
      assert.equal(armed.picking, true, 'the viewfinder becomes a target');
      assert.equal(armed.hex, '—', 'nothing is claimed before a tap');

      const boxCentre = await page.evaluate(() => {
        const vf = document.getElementById('v2Viewfinder');
        return { w: vf.clientWidth, h: vf.clientHeight };
      });
      await page.mouse.click(boxCentre.w / 2, 300);
      await page.waitForTimeout(200);
      const picked = await page.evaluate(() => ({
        hex: document.getElementById('v2PickerHex').textContent,
        swatch: document.getElementById('v2PickerSwatch').style.background,
        detail: document.getElementById('v2PickerDetail').textContent,
        addEnabled: !document.getElementById('v2PickerAddStop').disabled
      }));
      assert.match(picked.hex, /^#[0-9A-F]{6}$/, `a real reading, got "${picked.hex}"`);
      assert.ok(picked.swatch.length > 0, 'the swatch shows the sampled colour');
      assert.match(picked.detail, /9×9 patch of camera pixels/, 'the reading says what it averaged');
      assert.match(picked.detail, /luma \d+/);
      assert.equal(picked.addEnabled, true, 'a sampled colour can become a ramp stop');

      const stopsBefore = await page.evaluate(() =>
        document.querySelectorAll('#v2LensStops .lens-stop').length);
      await page.click('#v2PickerAddStop');
      await page.waitForTimeout(150);
      const added = await page.evaluate(() => ({
        stops: document.querySelectorAll('#v2LensStops .lens-stop').length,
        colors: [...document.querySelectorAll('#v2LensStops input[type="color"]')].map((i) => i.value)
      }));
      assert.equal(added.stops, stopsBefore + 1, 'the sample joins the ramp');
      assert.ok(added.colors.includes(picked.hex.toLowerCase()), 'with the colour that was read');
      // "Sample centre" reads the middle of the frame — the reticle's spot.
      await page.evaluate(() => {
        document.getElementById('v2PickerHex').textContent = '—';
      });
      await page.click('#v2PickerCentre');
      await page.waitForTimeout(200);
      assert.match(await page.textContent('#v2PickerHex'), /^#[0-9A-F]{6}$/,
        'the centre button samples without a tap');

      await page.click('#v2PickerClose');
      await page.waitForTimeout(100);
      assert.equal(await page.evaluate(() =>
        document.getElementById('v2Viewfinder').classList.contains('picking')), false);
      await page.click('#v2LensSave');
      await page.waitForTimeout(150);

      // Import Joshua's file through the real file input.
      await page.setInputFiles('#v2LensImport',
        fileURLToPath(new URL('../docs/lenses/coloring-book-style.lens.json', import.meta.url)));
      await page.waitForTimeout(300);
      const imported = await page.evaluate(() => ({
        count: JSON.parse(localStorage.getItem('vss.lenses.v1') ?? '[]').length,
        active: document.querySelector('#v2FilterStrip .active')?.dataset.filter ?? ''
      }));
      assert.equal(imported.count, STARTERS.length + 1, 'the same lens id replaces rather than duplicates');
      assert.equal(imported.active, 'lens:lens-mtjarl1w-pcpts4', 'the import becomes the active filter');

      // Lenses survive a reload — the strip is built from storage.
      await page.reload();
      await page.waitForTimeout(400);
      const again = await page.evaluate(() => ({
        lenses: [...document.querySelectorAll('#v2FilterStrip [data-filter^="lens:"]')].map((b) => b.textContent),
        guide: document.querySelector('#v2GuideRow .active')?.dataset.guide ?? '',
        reticle: document.getElementById('v2ReticleToggle').classList.contains('active')
      }));
      assert.deepEqual(again.lenses, [...STARTERS, 'Probe lens']);
      assert.equal(again.guide, 'center', 'the chosen guide is remembered');
      assert.equal(again.reticle, false, 'and so is leaving the reticle off');
      await page.close();
      await context.close();
    });
  });

test('colour lenses: mask keeps the camera\'s colour, swap recolours, both take stills (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);
      await page.click('#v2EnableCamera');
      await page.waitForFunction(() =>
        /\d+(\.\d+)? rendered fps/.test(document.getElementById('v2DiagPreview')?.textContent ?? ''),
        null, { timeout: 8000 });

      const look = () => page.evaluate(() => {
        const canvas = document.getElementById('v2PreviewCanvas');
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        copy.getContext('2d').drawImage(canvas, 0, 0);
        const d = copy.getContext('2d').getImageData(0, 0, copy.width, copy.height).data;
        let drawn = 0;
        let coloured = 0;
        for (let i = 0; i < d.length; i += 4) {
          if (d[i] + d[i + 1] + d[i + 2] > 0) drawn++;
          // A pixel whose channels differ is carrying colour, not grey.
          if (Math.max(d[i], d[i + 1], d[i + 2]) - Math.min(d[i], d[i + 1], d[i + 2]) > 12) coloured++;
        }
        return {
          drawn: drawn / (d.length / 4),
          coloured: coloured / (d.length / 4),
          photo: !document.getElementById('v2PhotoButton').disabled,
          note: document.getElementById('v2FilterNote').textContent,
          stage: document.getElementById('v2Stage').textContent
        };
      });

      for (const [id, expect] of [
        ['lens:lens-v2-colour-splash', /keeping the camera’s colour where it matches/],
        ['lens:lens-v2-paper-pink', /recolouring matches toward/],
        ['lens:lens-v2-hue-map', /Colour from hue/i],
        ['lens:lens-v2-rare-colour', /whole frame’s colours/],
        ['lens:lens-v2-background-subtract', /whole frame’s colours/]
      ]) {
        await page.click(`[data-filter="${id}"]`);
        await page.waitForTimeout(700);
        const seen = await look();
        assert.ok(!/shader failed/i.test(seen.stage), `${id}: compiles, got "${seen.stage}"`);
        assert.ok(seen.drawn > 0.5, `${id}: draws a picture`);
        assert.equal(seen.photo, true, `${id}: a colour field is per-pixel, so stills are honest`);
        assert.match(seen.note, expect, `${id}: the note describes what the lens does`);
      }

      // Colour Splash is the mask mode: mostly grey, with matched colour kept.
      await page.click('[data-filter="lens:lens-v2-colour-splash"]');
      await page.waitForTimeout(700);
      const splash = await look();
      await page.click('[data-filter="rgb"]');
      await page.waitForTimeout(500);
      const raw = await look();
      assert.ok(splash.coloured < raw.coloured,
        `mask mutes what does not match: ${splash.coloured.toFixed(3)} vs raw ${raw.coloured.toFixed(3)}`);

      // The workbench shows the rows the lens actually uses, and the picker's
      // sample can become the reference it measures against.
      await page.click('[data-filter="lens:lens-v2-colour-splash"]');
      await page.waitForTimeout(300);
      await page.click('#v2LensEdit');
      await page.waitForTimeout(300);
      const rows = await page.evaluate(() => ({
        output: document.getElementById('v2LensOutput').value,
        reference: !document.getElementById('v2LensReferenceRow').hidden,
        target: !document.getElementById('v2LensTargetRow').hidden,
        refValue: document.getElementById('v2LensReference').value
      }));
      assert.equal(rows.output, 'mask');
      assert.equal(rows.reference, true, 'a distance lens shows what it measures from');
      assert.equal(rows.target, false, 'and no swap target it does not use');
      assert.equal(rows.refValue, '#c81e28');

      await page.click('#v2PickColor');
      await page.waitForTimeout(150);
      await page.mouse.click(215, 300);
      await page.waitForTimeout(250);
      const hex = (await page.textContent('#v2PickerHex')).toLowerCase();
      await page.click('#v2LensUseSample');
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() =>
        document.getElementById('v2LensReference').value), hex,
        'the sampled colour becomes the reference');
      assert.match(await page.textContent('#v2LensDescribe'), /measured from/);
      await page.close();
      await context.close();
    });
  });

test('the encoder probe records a synthetic canvas through the real recorder and decodes it',
  { skip: runnable ? false : 'no browser available' }, async () => {
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({ viewport: { width: 430, height: 932 } });
      const page = await context.newPage();
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(300);
      // Tiny trials: the instrument's mechanics, not the device's envelope —
      // the 12 MP ladder is for the phone.
      const rows = await page.evaluate(async () => {
        const probe = await import('/app/v2/capture/encoder-probe.js');
        const texts = [];
        const rows = await probe.runEncoderProbe(
          [{ width: 320, height: 240, fps: 10, seconds: 1.2, note: 'tiny' },
            { width: 640, height: 480, fps: 10, seconds: 1.2, note: 'small' }],
          (_row, text) => texts.push(text));
        return rows.map((row, i) => ({ ...row, text: texts[i] }));
      });
      assert.equal(rows.length, 2);
      for (const row of rows) {
        assert.equal(row.error, null, `trial ran, got "${row.text}"`);
        assert.equal(row.decoded, true, `the file decodes, got "${row.text}"`);
        assert.equal(row.encodedWidth, row.trial.width, 'measured from the file at the trial size');
        assert.equal(row.encodedHeight, row.trial.height);
        assert.equal(row.aboveLevel52, false);
        assert.match(row.text, /DECODED \d+×\d+ · [\d.]+ MB · [\d.]+ Mb\/s · \d+ chunks? · finalised/);
      }
      // Nothing was saved: the probe measures and discards.
      const button = await page.evaluate(() => ({
        exists: Boolean(document.getElementById('v2EncoderProbe')),
        outHidden: document.getElementById('v2EncoderProbeOut')?.hidden ?? null
      }));
      assert.equal(button.exists, true, 'the instrument is reachable from the Recording card');
      assert.equal(button.outHidden, true, 'no output until the button is pressed');
      await page.close();
      await context.close();
    });
  });

test('a stream above the encoder envelope records through the render, held under it, and says why',
  { skip: runnable ? false : 'no browser available' }, async () => {
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      // A remembered probe verdict from "this device": a wall far below the
      // fake camera's stream, so the RGB clip must go through the render.
      await context.addInitScript(() => {
        localStorage.setItem('vss.v2.encoderEnvelope.v1',
          JSON.stringify({ largestDecoded: 1000, smallestFailed: 1200 }));
      });
      const page = await context.newPage();
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);
      await page.click('#v2EnableCamera');
      await page.waitForFunction(() =>
        /\d+(\.\d+)? rendered fps/.test(document.getElementById('v2DiagPreview')?.textContent ?? ''),
        null, { timeout: 8000 });
      await page.waitForTimeout(600);

      const before = await page.evaluate(() => ({
        encoder: document.getElementById('v2DiagEncoder')?.textContent ?? '',
        recordIn: document.getElementById('v2DiagRecordIn')?.textContent ?? '',
        source: document.getElementById('v2DiagSource')?.textContent ?? ''
      }));
      assert.match(before.encoder, /^1,000 macroblocks max frame · MEASURED/,
        `the ENCODER row carries the stored measurement, got "${before.encoder}"`);
      assert.match(before.recordIn, /macroblock frame limit/, 'RECORD IN names the envelope before recording');
      assert.match(before.recordIn, /RGB render — the stream exceeds the encoder envelope/);
      const dims = (t) => t.match(/^(\d+)×(\d+)/).slice(1, 3).map(Number);
      const [sw, sh] = dims(before.source);
      const [rw, rh] = dims(before.recordIn);
      assert.ok(rw < sw && rh < sh, `RECORD IN ${rw}×${rh} held under SOURCE ${sw}×${sh}`);
      assert.ok(Math.ceil(rw / 16) * Math.ceil(rh / 16) <= 1000, 'inside the envelope');
      assert.match(await page.textContent('#v2FilterNote'), /record at \d+×\d+ — held under the encoder's frame limit/,
        'the note names the ceiling for RGB too — no "RGB keeps the full stream" fiction');
      assert.equal(await page.evaluate(() => document.getElementById('v2RecHud').hidden), true,
        'no recording strip before a clip');

      await page.click('#v2RecordButton');
      await page.waitForTimeout(900);
      const strip = await page.evaluate(() => ({
        hidden: document.getElementById('v2RecHud').hidden,
        text: document.getElementById('v2RecHud').textContent
      }));
      assert.equal(strip.hidden, false, 'the strip shows while the clip runs');
      assert.match(strip.text, new RegExp(`^🔴 Recording in ${rw}×${rh}`),
        `the strip names the size the file receives, got "${strip.text}"`);
      await page.waitForTimeout(900);
      await page.click('#v2RecordButton');
      await page.waitForFunction(() =>
        (document.getElementById('v2RecordResult')?.textContent ?? '').startsWith('Saved'),
        null, { timeout: 10000 });
      const line = await page.textContent('#v2RecordResult');
      const [fw, fh] = dims(line.replace(/^Saved [\d.]+s · /, ''));
      assert.equal(fw, rw, `the file carries RECORD IN, not the stream, got "${line}"`);
      assert.equal(fh, rh);
      await page.waitForTimeout(300);
      assert.equal(await page.evaluate(() => document.getElementById('v2RecHud').hidden), true,
        'the strip leaves with the clip');
      await page.close();
      await context.close();
    });
  });

test('recording truth: native and filtered clips measured from their files (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      page.on('download', () => { /* clips download like photos; discard */ });
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);
      await page.click('#v2EnableCamera');
      await page.waitForFunction(() =>
        /\d+(\.\d+)? rendered fps/.test(document.getElementById('v2DiagPreview')?.textContent ?? ''),
        null, { timeout: 8000 });
      const dims = (text) => text.match(/(\d+)×(\d+)/).slice(1, 3).map(Number);

      // With RGB active the idle row promises the native path.
      await page.waitForFunction(() =>
        /camera stream direct on record/.test(document.getElementById('v2DiagRecordIn')?.textContent ?? ''),
        null, { timeout: 3000 });
      const [sw, sh] = dims(await page.textContent('#v2DiagSource'));

      // NATIVE clip: the camera stream borrowed directly.
      await page.click('#v2RecordButton');
      await page.waitForFunction(() =>
        /RECORDING · camera stream direct/.test(document.getElementById('v2DiagRecordIn')?.textContent ?? ''),
        null, { timeout: 3000 });
      const during = await page.evaluate(() => ({
        photoDisabled: document.getElementById('v2PhotoButton').disabled,
        switchDisabled: document.getElementById('v2SwitchCamera').disabled,
        filterDisabled: document.querySelector('#v2FilterStrip [data-filter="ironbow"]').disabled,
        recClass: document.getElementById('v2RecordButton').classList.contains('recording')
      }));
      assert.ok(during.photoDisabled && during.switchDisabled && during.filterDisabled,
        'shutter, switch and filters wait for the clip — a mode change would resize the encoder');
      assert.ok(during.recClass, 'the record button shows its state');
      await page.waitForTimeout(1800);
      await page.click('#v2RecordButton');
      await page.waitForFunction(() =>
        (document.getElementById('v2RecordResult')?.textContent ?? '').startsWith('Saved'),
        null, { timeout: 10000 });
      const native = await page.textContent('#v2RecordResult');
      assert.match(native, /^Saved \d+\.\ds · \d+×\d+ measured in the file/,
        `the clip reports measured truth, got "${native}"`);
      assert.match(native, / · \d+ chunks?/,
        `the delivery pattern is measured, not assumed, got "${native}"`);
      assert.match(native, / · finalised in \d+\.\ds · fed [\d.]+ fps → file /,
        `the fed rate and the file's own rate are both reported, got "${native}"`);
      const summary = await page.textContent('#v2RecordSummary');
      assert.match(summary, /^Saved \d+\.\ds · \d+×\d+( · \d+ fps)? · [\d.]+ MB$/,
        `the main screen gets the result, not the instruments, got "${summary}"`);
      if (/video\/mp4/.test(native)) {
        assert.match(native, /file [\d.]+ fps \(\d+ frames\)/,
          `an MP4's frames are counted from its tables, got "${native}"`);
      }
      const [nw, nh] = dims(native.replace(/^Saved [\d.]+s · /, ''));
      assert.equal(nw, sw, 'the native path records the SOURCE, measured in the file');
      assert.equal(nh, sh);
      await page.waitForFunction(([w, h]) =>
        (document.getElementById('v2DiagEncoded')?.textContent ?? '').startsWith(`${w}×${h}`),
        [nw, nh], { timeout: 3000 });

      // FILTERED clip: the same GPU render, frozen at RECORD IN.
      await page.click('[data-filter="ironbow"]');
      await page.waitForTimeout(300);
      await page.click('#v2RecordButton');
      await page.waitForFunction(() =>
        /RECORDING · filtered render/.test(document.getElementById('v2DiagRecordIn')?.textContent ?? ''),
        null, { timeout: 3000 });
      const frozen = await page.evaluate(() => ({
        w: document.getElementById('v2PreviewCanvas').width,
        h: document.getElementById('v2PreviewCanvas').height
      }));
      assert.equal(frozen.w, sw, 'the canvas is frozen at RECORD IN while recording');
      assert.equal(frozen.h, sh);
      await page.waitForTimeout(1800);
      await page.click('#v2RecordButton');
      await page.waitForFunction(() =>
        (document.getElementById('v2RecordResult')?.textContent ?? '').startsWith('Saved'),
        null, { timeout: 10000 });
      const filtered = await page.textContent('#v2RecordResult');
      const [fw, fh] = dims(filtered.replace(/^Saved [\d.]+s · /, ''));
      assert.equal(fw, sw, 'the filtered clip measures at RECORD IN in the file');
      assert.equal(fh, sh);

      // After stop, the preview reclaims its own geometry through the owner.
      await page.waitForTimeout(700);
      const after = await page.evaluate(() => document.getElementById('v2PreviewCanvas').width);
      const [pw] = dims(await page.textContent('#v2DiagPreview'));
      assert.equal(after, pw, 'the preview returns to PREVIEW geometry after the clip');

      await page.close();
      await context.close();
    });
  });

test('a maximum-tier filtered clip records the CHOSEN stream, risk stated up front (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    // Joshua's ladder: a tier records what it streams, MAX included — the
    // measured crash risk is announced beside the filter strip before the
    // button, and the file records at the stream the user deliberately chose.
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      page.on('download', () => {});
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);
      await page.click('#v2EnableCamera');
      await page.waitForFunction(() =>
        /\d+(\.\d+)? rendered fps/.test(document.getElementById('v2DiagPreview')?.textContent ?? ''),
        null, { timeout: 8000 });

      await page.click('[data-stream-tier="maximum"]');
      await page.waitForFunction(() => {
        const m = (document.getElementById('v2DiagSource')?.textContent ?? '').match(/^(\d+)×(\d+)/);
        return m !== null && Math.min(Number(m[1]), Number(m[2])) > 1080;
      }, null, { timeout: 8000 });
      await page.click('[data-filter="ironbow"]');
      await page.waitForTimeout(300);

      // The encoder ceiling announces itself BEFORE the button, beside the
      // filter choice — and where the stream fits the envelope (the fake
      // camera's 3840×2160 = 32,400 macroblocks, inside Level 5.2), RECORD IN
      // holds the full stream with no cap pretending to exist.
      await page.waitForFunction(() =>
        /largest frame this device's H\.264 encoder can write/.test(
          document.getElementById('v2FilterNote')?.textContent ?? ''),
        null, { timeout: 20000 });
      assert.match(await page.textContent('#v2FilterNote'), /Photos always stay at MAX/,
        'the note says stills are exempt');
      assert.ok(!/macroblock|capped/.test(await page.textContent('#v2DiagRecordIn')),
        'inside the envelope, no cap pretends to exist');

      await page.click('#v2RecordButton');
      await page.waitForFunction(() =>
        /RECORDING · filtered render/.test(document.getElementById('v2DiagRecordIn')?.textContent ?? ''),
        null, { timeout: 3000 });
      const during = await page.evaluate(() => ({
        row: document.getElementById('v2DiagRecordIn').textContent,
        canvasW: document.getElementById('v2PreviewCanvas').width,
        canvasH: document.getElementById('v2PreviewCanvas').height
      }));
      assert.match(during.row, /^3840×2160 ·/,
        `RECORD IN is the chosen stream itself, got "${during.row}"`);
      assert.equal(Math.min(during.canvasW, during.canvasH), 2160,
        'the render target is frozen at the chosen stream — what you see is what records');
      await page.waitForTimeout(1500);
      await page.click('#v2RecordButton');
      await page.waitForFunction(() =>
        (document.getElementById('v2RecordResult')?.textContent ?? '').startsWith('Saved'),
        null, { timeout: 15000 });
      const line = await page.textContent('#v2RecordResult');
      assert.match(line, /3840×2160 measured in the file/,
        `the file carries the chosen size, got "${line}"`);

      await page.close();
      await context.close();
    });
  });

test('a lost GPU context is reported and recovered — never a silent black camera (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    // The device measurement this guards: a 12 MP filtered recording put
    // enough memory pressure on WebKit to kill the WebGL context, and the
    // viewfinder went permanently black while the camera kept delivering.
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);
      await page.click('#v2EnableCamera');
      await page.waitForFunction(() =>
        /\d+(\.\d+)? rendered fps/.test(document.getElementById('v2DiagPreview')?.textContent ?? ''),
        null, { timeout: 8000 });

      await page.evaluate(() => {
        const gl = document.getElementById('v2PreviewCanvas').getContext('webgl');
        window.__lose = gl.getExtension('WEBGL_lose_context');
        window.__lose.loseContext();
      });
      await page.waitForFunction(() =>
        /GPU context was lost/.test(document.getElementById('v2Stage')?.textContent ?? ''),
        null, { timeout: 5000 });

      await page.evaluate(() => window.__lose.restoreContext());
      await page.waitForFunction(() =>
        (document.getElementById('v2Stage')?.textContent ?? '') === '',
        null, { timeout: 8000 });
      await page.waitForTimeout(800);
      const pixel = await page.evaluate(() => {
        const canvas = document.getElementById('v2PreviewCanvas');
        const copy = document.createElement('canvas');
        copy.width = canvas.width;
        copy.height = canvas.height;
        const ctx = copy.getContext('2d');
        ctx.drawImage(canvas, 0, 0);
        const d = ctx.getImageData(Math.floor(copy.width / 2), Math.floor(copy.height / 2), 1, 1).data;
        return d[0] + d[1] + d[2];
      });
      assert.ok(pixel > 30, `the restored context draws real frames again (centre sum ${pixel})`);

      // And where no share sheet exists, no dead Share button pretends.
      const share = await page.evaluate(() => ({
        hasShare: typeof navigator.share === 'function',
        photoHidden: document.getElementById('v2SharePhoto').hidden,
        clipHidden: document.getElementById('v2ShareClip').hidden
      }));
      if (!share.hasShare) {
        assert.ok(share.photoHidden && share.clipHidden,
          'an unavailable action must never look functional');
      }

      await page.close();
      await context.close();
    });
  });

test('controls stay alive under the live frame loop (fake device)',
  { skip: runnable ? false : 'no browser available' }, async () => {
    // The measured iOS failure this guards against: every state broadcast —
    // twice per camera frame — rebuilt the zoom buttons and rewrote the text
    // panels, so the button under a finger was deleted between touchstart and
    // click and every control went dead once LIVE. The contract now: no
    // interactive element is recreated while the stream runs, and the
    // human-readable panels rewrite a few times a second, not 120.
    await withBrowser(async (browser, base) => {
      const context = await browser.newContext({
        viewport: { width: 430, height: 932 },
        permissions: ['camera']
      });
      const page = await context.newPage();
      await page.goto(`${base}/v2.html?scene=v2`);
      await page.waitForTimeout(400);
      await page.click('#v2EnableCamera');
      await page.waitForFunction(() =>
        /\d+(\.\d+)? rendered fps/.test(document.getElementById('v2DiagPreview')?.textContent ?? ''),
        null, { timeout: 8000 });

      // Pin down the exact elements a finger would rest on, and count how
      // often the diagnostics text actually mutates, across 1.5 s of frames.
      await page.evaluate(() => {
        window.__v2refs = {
          zoom: document.querySelector('#v2ZoomStops [data-zoom-stop]'),
          photo: document.getElementById('v2PhotoButton'),
          filter: document.querySelector('#v2FilterStrip [data-filter="ironbow"]'),
          switcher: document.getElementById('v2SwitchCamera')
        };
        window.__v2mutations = 0;
        const observer = new MutationObserver((records) => {
          window.__v2mutations += records.length;
        });
        observer.observe(document.getElementById('v2DiagSource'),
          { childList: true, characterData: true, subtree: true });
      });
      await page.waitForTimeout(1500);
      const churn = await page.evaluate(() => ({
        zoomAlive: document.contains(window.__v2refs.zoom),
        photoAlive: document.contains(window.__v2refs.photo),
        filterAlive: document.contains(window.__v2refs.filter),
        switcherAlive: document.contains(window.__v2refs.switcher),
        hadZoom: window.__v2refs.zoom !== null,
        mutations: window.__v2mutations
      }));
      assert.ok(churn.hadZoom, 'the fake device offers digital zoom stops to pin');
      assert.ok(churn.zoomAlive, 'a zoom button must never be recreated under a live stream');
      assert.ok(churn.photoAlive && churn.filterAlive && churn.switcherAlive,
        'no interactive element is replaced by the frame loop');
      assert.ok(churn.mutations <= 12,
        `text panels are throttled — ${churn.mutations} mutations in 1.5s is a rewrite storm`);
      assert.ok(churn.mutations >= 2, 'throttled is not frozen — the readouts still update');

      // And a tap mid-stream actually lands: the listener on those stable
      // buttons is the original one, and it still works.
      await page.click('#v2ZoomStops [data-zoom-stop="2"]');
      await page.waitForFunction(() =>
        (document.getElementById('v2HudZoom')?.textContent ?? '').startsWith('2.0×'),
        null, { timeout: 4000 });
      const active = await page.evaluate(() =>
        document.querySelector('#v2ZoomStops [data-zoom-stop="2"]').classList.contains('active'));
      assert.ok(active, 'the tapped stop takes the highlight, in place');

      await page.close();
      await context.close();
    });
  });
