import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';

/**
 * Every script this app ships has to PARSE.
 *
 * This exists because a syntax error shipped with a green suite. A rename in
 * camera-bootstrap.js declared a `const` whose name the enclosing function
 * already used as a parameter, and the whole file then failed to load — so
 * the camera engine never registered, the boot threw, and the app rendered
 * its tabs over five hidden panels with nothing wired to anything.
 *
 * Every other test in this repo reads source as TEXT and matches patterns in
 * it, which cannot see a syntax error at all: the string is still there, the
 * regex still matches, and the file is still broken. Compiling is the cheapest
 * possible check that the file is a program rather than a document, and it
 * needs no browser and no dependencies.
 */

const publicDir = fileURLToPath(new URL('../public/', import.meta.url));

function scripts(dir, prefix = '') {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    // The compiled output under app/ is emitted by tsc, which has already
    // rejected anything that does not parse.
    if (entry.isDirectory()) {
      if (entry.name === 'app') continue;
      found.push(...scripts(`${dir}${entry.name}/`, `${prefix}${entry.name}/`));
    } else if (entry.name.endsWith('.js')) {
      found.push(`${prefix}${entry.name}`);
    }
  }
  return found;
}

const files = scripts(publicDir);

test('there are hand-written scripts to check', () => {
  assert.ok(files.length >= 2, `expected the shipped scripts, found ${files.join(', ')}`);
  assert.ok(files.includes('camera-bootstrap.js'));
  assert.ok(files.includes('sw.js'));
});

for (const file of files) {
  test(`${file} parses`, () => {
    const source = readFileSync(`${publicDir}${file}`, 'utf8');
    // Compiles without running: a SyntaxError throws here, and nothing in the
    // file executes, so a service worker or a camera engine can be checked
    // without a browser to host it.
    assert.doesNotThrow(
      () => new vm.Script(source, { filename: file }),
      `${file} does not parse, so the browser will not load it at all`
    );
  });
}

test('no shipped script redeclares a name its own scope already binds', () => {
  // The specific shape of the failure: `const requested` inside
  // buildProfiles(requested). Compiling catches it, and this names it so the
  // next person reading the suite knows what went wrong once.
  const bootstrap = readFileSync(`${publicDir}camera-bootstrap.js`, 'utf8');
  const builder = bootstrap.slice(
    bootstrap.indexOf('function buildProfiles('),
    bootstrap.indexOf('async function start(')
  );
  assert.doesNotMatch(builder, /const requested\s*=/);
  assert.match(builder, /const wantedShortSide = Number\(requestedHeight\)/);
});
