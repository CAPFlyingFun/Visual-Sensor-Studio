import test from 'node:test';
import assert from 'node:assert/strict';
import {
  describeImportability, describeMp4Shape, importBlockers
} from '../.test-build/v2/capture/mp4-shape.js';

/*
 * Why Photos silently refuses a clip that plays perfectly.
 *
 * Joshua, 2026-09-04, on a MAX recording: "It did give me the option, but
 * nothing happened." Two container properties decide this on Apple platforms
 * and MediaRecorder output can fail either — the HEVC sample entry being
 * hev1 rather than hvc1, and the file being fragmented rather than
 * progressive. Both are structure, not pixels, so both are fixable by a
 * remux. These build real box trees byte by byte and read them back.
 */

/** Build one MP4 box: 4-byte size, 4-char type, then the body. */
function box(type, body = new Uint8Array(0)) {
  const out = new Uint8Array(8 + body.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, out.length);
  for (let i = 0; i < 4; i += 1) out[4 + i] = type.charCodeAt(i);
  out.set(body, 8);
  return out;
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let at = 0;
  for (const p of parts) { out.set(p, at); at += p.length; }
  return out;
}

const fourcc = (s) => Uint8Array.from([...s].map((c) => c.charCodeAt(0)));

/** ftyp with a major brand and any number of compatible brands. */
const ftyp = (major, ...compatible) =>
  box('ftyp', concat(fourcc(major), new Uint8Array(4), ...compatible.map(fourcc)));

/** A moov carrying one video track whose sample entry is `codec`. */
const moovWith = (codec) =>
  box('moov', box('trak', box('mdia', box('minf', box('stbl',
    // stsd is a FullBox: version+flags, entry_count, then the entries.
    box('stsd', concat(new Uint8Array(4), Uint8Array.from([0, 0, 0, 1]), box(codec))))))));

test('an hev1 tag is named as the blocker, and a remux is enough', () => {
  const bytes = concat(ftyp('iso5', 'iso6', 'mp41'), moovWith('hev1'), box('mdat'));
  const shape = describeMp4Shape(bytes);
  assert.ok(shape, 'the box tree parses');
  assert.equal(shape.majorBrand, 'iso5');
  assert.deepEqual(shape.compatibleBrands, ['iso6', 'mp41']);
  assert.deepEqual(shape.videoCodecs, ['hev1']);
  assert.equal(shape.fragmented, false);
  assert.equal(shape.hasMoov, true);
  assert.equal(shape.moovBeforeMdat, true);

  const blockers = importBlockers(shape);
  assert.equal(blockers.length, 1, `exactly the tag, got ${blockers.map((b) => b.id)}`);
  assert.equal(blockers[0].id, 'hev1');
  assert.equal(blockers[0].remuxable, true, 'the same codec tagged hvc1 imports');
  assert.match(describeImportability(shape), /a remux fixes it without re-encoding/);
});

test('hvc1 is not a blocker — the tag is the whole difference', () => {
  const shape = describeMp4Shape(concat(ftyp('mp42'), moovWith('hvc1'), box('mdat')));
  assert.deepEqual(shape.videoCodecs, ['hvc1']);
  assert.deepEqual(importBlockers(shape), [],
    'the same file tagged hvc1 has nothing standing in its way');
  assert.match(describeImportability(shape), /nothing here would stop an import/);
});

test('a fragmented file is caught even when its codec tag is fine', () => {
  // MediaRecorder writes fragmented MP4 by design: it must be able to stop at
  // any moment, so the index cannot be written up front.
  const bytes = concat(ftyp('iso5', 'dash'), moovWith('hvc1'), box('moof'), box('mdat'));
  const shape = describeMp4Shape(bytes);
  assert.equal(shape.fragmented, true);
  const ids = importBlockers(shape).map((b) => b.id);
  assert.deepEqual(ids, ['fragmented'], 'the tag is fine; the layout is not');
  assert.match(describeImportability(shape), /FRAGMENTED MP4/);

  // A fragmented file must NOT also be accused of putting moov last — that
  // check is meaningless there, and two reasons for one fault reads as two.
  assert.ok(!ids.includes('moov-last'));
});

test('both faults at once are both reported, and both are remuxable', () => {
  const shape = describeMp4Shape(concat(ftyp('iso5'), moovWith('hev1'), box('moof'), box('mdat')));
  const blockers = importBlockers(shape);
  assert.deepEqual(blockers.map((b) => b.id), ['hev1', 'fragmented']);
  assert.ok(blockers.every((b) => b.remuxable), 'neither needs a re-encode');
});

test('moov after mdat is flagged, and a missing moov is NOT called remuxable', () => {
  const late = describeMp4Shape(concat(ftyp('mp42'), box('mdat'), moovWith('avc1')));
  assert.equal(late.moovBeforeMdat, false);
  assert.deepEqual(importBlockers(late).map((b) => b.id), ['moov-last']);

  const headless = describeMp4Shape(concat(ftyp('mp42'), box('mdat')));
  const blockers = importBlockers(headless);
  assert.deepEqual(blockers.map((b) => b.id), ['no-moov']);
  assert.equal(blockers[0].remuxable, false,
    'a file with no index cannot be rewritten into one — that is not a remux');
});

test('it refuses to guess about bytes it cannot read', () => {
  assert.equal(describeMp4Shape(new Uint8Array(0)), null);
  assert.equal(describeMp4Shape(Uint8Array.from([0x1a, 0x45, 0xdf, 0xa3, 1, 2, 3, 4])), null,
    'a WebM is not an MP4 with problems, it is not an MP4');
  assert.match(describeImportability(null), /nothing to diagnose/);
});

test('a malformed box tree terminates instead of spinning', () => {
  // A size field smaller than its own header would step backwards forever.
  const bad = new Uint8Array(16);
  new DataView(bad.buffer).setUint32(0, 2);
  bad.set(fourcc('ftyp'), 4);
  assert.doesNotThrow(() => describeMp4Shape(bad));
  // And a size that runs past the end must stop rather than read out of range.
  const over = concat(ftyp('mp42'), (() => {
    const b = box('moov');
    new DataView(b.buffer).setUint32(0, 9999);
    return b;
  })());
  assert.doesNotThrow(() => describeMp4Shape(over));
});
