import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const mainSource = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');

test('live detail defaults to the camera resolution', () => {
  // The first version of this setting shipped capped at 540p, from a
  // benchmark run in a slow container rather than measured on a phone. A
  // device pass showed a full-resolution preview keeping up, so the cap was a
  // guess and the guess was wrong.
  assert.match(mainSource, /lensDetail: 'full',/);
  assert.doesNotMatch(mainSource, /lensDetail: '540',/);
});

test('a corrected default reaches installs that never had an opinion', () => {
  // Otherwise a bad default is frozen into stored settings forever: every
  // install that never touched the control keeps the guess.
  assert.match(mainSource, /lensDetailChosen: boolean;/);
  assert.match(mainSource, /lensDetailChosen: false,/);
  assert.match(mainSource, /parsed\.lensDetailChosen === true/);
});

test('a deliberate choice is never overridden by a default', () => {
  assert.match(mainSource, /settings\.lensDetailChosen = true;/);
  const at = mainSource.indexOf('lensDetail: parsed.lensDetailChosen === true');
  const loader = mainSource.slice(at, at + 400);
  // Chosen -> the stored value; unchosen -> the current default.
  assert.match(loader, /\? parsed\.lensDetail as LensDetail/);
  assert.match(loader, /: DEFAULT_SETTINGS\.lensDetail/);
});

test('the note points at the measured cost rather than urging caution', () => {
  assert.match(mainSource, /Full matches the camera; drop it only if the frame rate beside it says you should/);
});
