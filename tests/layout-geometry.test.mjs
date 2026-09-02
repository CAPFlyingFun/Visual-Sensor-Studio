import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { readFileSync, existsSync } from 'node:fs';
import { extname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/*
 * MEASURED GEOMETRY, not a search for words in a stylesheet.
 *
 * Joshua, after v0.39.0: "Please test the actual geometry, not just whether CSS
 * contains certain words." The rejected layout passed every string test it had
 * — it said `position: sticky` and the test checked that it said it. What no
 * string could catch was that the controls then scrolled behind the camera and
 * left a small usable window.
 *
 * So this drives a real browser at real viewport sizes and asserts on
 * rectangles. It skips, loudly, where no browser is available, because a test
 * that silently passes when it cannot run is worse than no test.
 */

const CHROME = '/opt/pw-browsers/chromium-1194/chrome-linux/chrome';
const ROOT = fileURLToPath(new URL('../public', import.meta.url));
const TYPES = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'text/javascript',
  '.json': 'application/json', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png'
};

let chromium = null;
try { ({ chromium } = await import('playwright')); } catch { /* not installed */ }
const runnable = chromium !== null && existsSync(CHROME);

async function withPage(width, height, body) {
  const server = createServer((req, res) => {
    const url = req.url.split('?')[0];
    const file = join(ROOT, url === '/' ? 'legacy.html' : url);
    if (!existsSync(file) || !file.startsWith(ROOT)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${port}/legacy.html`);
    await page.waitForTimeout(500);
    await page.click('[data-tab="camera"]');
    await page.waitForTimeout(250);
    return await body(page);
  } finally {
    await browser.close();
    server.close();
  }
}

const READ = () => {
  const rect = (sel) => {
    const el = document.querySelector(sel);
    if (!el) return null;
    const b = el.getBoundingClientRect();
    return {
      top: Math.round(b.top), bottom: Math.round(b.bottom),
      left: Math.round(b.left), right: Math.round(b.right),
      width: Math.round(b.width), height: Math.round(b.height)
    };
  };
  const stage = document.querySelector('#visionStage');
  return {
    viewport: { width: innerWidth, height: innerHeight },
    camera: rect('#visionStage'),
    command: rect('.command-strip'),
    modes: rect('.mode-console'),
    drawer: rect('.tool-drawer'),
    dock: rect('.tabbar'),
    topbar: rect('.topbar'),
    stagePosition: getComputedStyle(stage).position,
    stickySelectors: [...document.styleSheets]
      .flatMap((sheet) => { try { return [...sheet.cssRules]; } catch { return []; } })
      .filter((rule) => rule.style && rule.style.position === 'sticky').length,
    pageScrolls: document.documentElement.scrollHeight > innerHeight + 1,
    documentWidth: document.documentElement.scrollWidth,
    modes14: document.querySelectorAll('#tab-camera [data-vision-mode]').length,
    duplicateIds: (() => {
      const seen = new Set(); const dupes = [];
      for (const el of document.querySelectorAll('[id]')) {
        if (seen.has(el.id)) dupes.push(el.id);
        seen.add(el.id);
      }
      return dupes;
    })()
  };
};

const overlaps = (a, b) => a && b && a.top < b.bottom - 1 && b.top < a.bottom - 1;

for (const [label, width, height, minRoom] of [
  ['430x932', 430, 932, 380],
  ['320x568', 320, 568, 240]
]) {
  test(`the picture stays put while the controls scroll at ${label}`,
    { skip: runnable ? false : 'no browser available' },
    async () => {
      const seen = await withPage(width, height, async (page) => {
        const before = await page.evaluate(READ);
        // Scroll the PAGE to its end — the picture must still be on screen.
        await page.evaluate(() => window.scrollTo(0, document.documentElement.scrollHeight));
        await page.waitForTimeout(200);
        const after = await page.evaluate(() => {
          const b = document.querySelector('#visionStage').getBoundingClientRect();
          const dock = document.querySelector('.tabbar').getBoundingClientRect();
          return {
            cameraTop: Math.round(b.top), cameraBottom: Math.round(b.bottom),
            visible: b.top < innerHeight && b.bottom > 0,
            clearsDock: b.bottom <= dock.top,
            scrolled: Math.round(window.scrollY)
          };
        });
        return { before, after };
      });
      const { camera, command, modes, dock } = seen.before;

      // The picture is pinned; nothing else is.
      assert.equal(seen.before.stagePosition, 'sticky');
      assert.equal(seen.before.stickySelectors, 1,
        'exactly one element in the stylesheet may be sticky');

      // Rows in the order the design specifies, none overlapping.
      assert.ok(!overlaps(camera, command), 'the command strip is under the picture');
      assert.ok(!overlaps(command, modes), 'the mode controls are under the command strip');
      assert.ok(camera.bottom <= command.top);
      assert.ok(command.bottom <= modes.top);

      // A preview worth looking at, and room left for the controls.
      assert.ok(camera.height >= height * 0.25, `the preview is only ${camera.height}px`);
      assert.ok(camera.height <= height * 0.5, `the preview takes ${camera.height}px of ${height}`);
      const room = height - camera.height - dock.height;
      assert.ok(room >= minRoom,
        `only ${room}px is left for controls below the picture`);

      // One scrolling surface: the page.
      assert.ok(seen.before.pageScrolls, 'the page should scroll');
      assert.equal(seen.before.documentWidth, width, 'no horizontal overflow');

      // Scrolled to the very end, the picture is still there and still clear of
      // the dock.
      assert.ok(seen.after.scrolled > 100, 'the page should have scrolled');
      assert.ok(seen.after.visible, 'the picture left the screen');
      assert.ok(seen.after.clearsDock, 'the picture overlaps the bottom dock');

      // And the app underneath is intact.
      assert.equal(seen.before.modes14, 14);
      assert.deepEqual(seen.before.duplicateIds, []);
    });
}

test('every family shows its own modes, and only those', { skip: runnable ? false : 'no browser available' },
  async () => {
    const seen = await withPage(430, 932, async (page) => {
      const result = [];
      for (const family of ['view', 'motion', 'time', 'night', 'custom']) {
        await page.click(`label[for="fam-${family}"]`);
        await page.waitForTimeout(80);
        result.push(await page.evaluate((f) => {
          const shown = [...document.querySelectorAll('.mode-row')]
            .filter((r) => getComputedStyle(r).display !== 'none')
            .map((r) => r.dataset.family);
          const visible = [...document.querySelectorAll('#tab-camera [data-vision-mode]')]
            .filter((b) => b.getBoundingClientRect().height > 0).length;
          return { family: f, shown, visible };
        }, family));
      }
      return result;
    });
    const counts = { view: 3, motion: 5, time: 4, night: 1, custom: 1 };
    for (const row of seen) {
      assert.deepEqual(row.shown, [row.family], `${row.family} should be the only row shown`);
      assert.equal(row.visible, counts[row.family],
        `${row.family} should show ${counts[row.family]} modes`);
    }
  });
