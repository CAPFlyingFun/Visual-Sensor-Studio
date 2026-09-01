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
    const file = join(ROOT, url === '/' ? 'index.html' : url);
    if (!existsSync(file) || !file.startsWith(ROOT)) { res.writeHead(404); res.end(); return; }
    res.writeHead(200, { 'content-type': TYPES[extname(file)] ?? 'application/octet-stream' });
    res.end(readFileSync(file));
  });
  await new Promise((r) => server.listen(0, r));
  const port = server.address().port;
  const browser = await chromium.launch({ executablePath: CHROME });
  try {
    const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 2 });
    await page.goto(`http://127.0.0.1:${port}/index.html`);
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
  const drawer = document.querySelector('.tool-drawer');
  const drawerStyle = getComputedStyle(drawer);
  return {
    viewport: { width: innerWidth, height: innerHeight },
    camera: rect('#visionStage'),
    command: rect('.command-strip'),
    modes: rect('.mode-console'),
    drawer: rect('.tool-drawer'),
    dock: rect('.tabbar'),
    topbar: rect('.topbar'),
    headPosition: getComputedStyle(document.querySelector('.workbench-head')).position,
    drawerOverflowY: drawerStyle.overflowY,
    drawerMinHeight: drawerStyle.minHeight,
    drawerScrolls: drawer.scrollHeight > drawer.clientHeight + 1,
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

for (const [label, width, height, minDrawer] of [
  ['430x932', 430, 932, 180],
  ['320x568', 320, 568, 100]
]) {
  test(`the workspace is laid out in rows at ${label}`, { skip: runnable ? false : 'no browser available' },
    async () => {
      const seen = await withPage(width, height, async (page) => {
        const before = await page.evaluate(READ);
        // Scroll the drawer to its end; the camera must not move a pixel.
        await page.evaluate(() => {
          const d = document.querySelector('.tool-drawer');
          d.scrollTop = d.scrollHeight;
        });
        await page.waitForTimeout(150);
        const after = await page.evaluate(() => ({
          camera: Math.round(document.querySelector('#visionStage').getBoundingClientRect().top),
          scrolled: Math.round(document.querySelector('.tool-drawer').scrollTop)
        }));
        return { before, after };
      });
      const { camera, command, modes, drawer, dock } = seen.before;

      // Nothing is sticky and nothing overlays anything.
      assert.notEqual(seen.before.headPosition, 'sticky');
      const rows = { camera, command, modes, drawer, dock };
      for (const [a, b] of [['camera', 'command'], ['command', 'modes'], ['modes', 'drawer'],
        ['drawer', 'dock'], ['camera', 'drawer'], ['camera', 'dock']]) {
        assert.ok(!overlaps(rows[a], rows[b]),
          `${a} ${JSON.stringify(rows[a])} overlaps ${b} ${JSON.stringify(rows[b])}`);
      }
      // ...and they are in the order the design specifies.
      assert.ok(camera.bottom <= command.top, 'the command strip must sit below the camera');
      assert.ok(command.bottom <= modes.top, 'the mode controls must sit below the command strip');
      assert.ok(modes.bottom <= drawer.top, 'the drawer must sit below the mode controls');
      assert.ok(drawer.bottom <= dock.top, 'the drawer must end above the dock');

      // The camera owns a useful share of the screen, and the drawer is not a slot.
      assert.ok(camera.height >= height * 0.15, `the camera is only ${camera.height}px`);
      assert.ok(camera.height <= height * 0.5, `the camera takes ${camera.height}px of ${height}`);
      assert.ok(drawer.height >= minDrawer,
        `the drawer has ${drawer.height}px, which is not enough to work in`);

      // One scrolling surface: the drawer. The page does not scroll.
      assert.equal(seen.before.drawerOverflowY, 'auto');
      assert.equal(seen.before.drawerMinHeight, '0px');
      assert.ok(seen.before.drawerScrolls, 'the drawer should have more content than height');
      assert.equal(seen.before.pageScrolls, false, 'the page itself must not scroll');
      assert.equal(seen.before.documentWidth, width, 'no horizontal overflow');

      // Scrolling the controls does not move the picture.
      assert.ok(seen.after.scrolled > 50, 'the drawer should have scrolled');
      assert.equal(seen.after.camera, camera.top, 'the camera moved while the drawer scrolled');

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
