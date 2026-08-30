import test from 'node:test';
import assert from 'node:assert/strict';
import {
  decideAutoStart,
  describeAutoStart,
  onFirstGesture,
  readPermission
} from '../.test-build/sensors/autostart.js';

test('an already-granted sensor starts without a prompt or a tap', () => {
  assert.equal(decideAutoStart({ enabled: true, permission: 'granted' }), 'start');
});

test('auto-start off means off, whatever the permission says', () => {
  assert.equal(decideAutoStart({ enabled: false, permission: 'granted' }), 'off');
  assert.equal(decideAutoStart({ enabled: false, permission: 'denied' }), 'off');
});

test('an unknown permission is never treated as a yes', () => {
  // Safari does not answer permissions.query for the camera, so 'unknown' is
  // the NORMAL iOS answer. Calling getUserMedia to find out IS the prompt, so
  // reading unknown as permission to proceed would fire a permission dialog at
  // someone who just opened the app and asked for nothing.
  assert.equal(decideAutoStart({ enabled: true, permission: 'unknown' }), 'needs-gesture');
  assert.equal(decideAutoStart({ enabled: true, permission: 'prompt' }), 'needs-gesture');
});

test('a denied sensor is reported as blocked rather than retried', () => {
  assert.equal(decideAutoStart({ enabled: true, permission: 'denied' }), 'blocked');
  // And blocked beats every other consideration.
  assert.equal(decideAutoStart({
    enabled: true, permission: 'denied', requiresGesture: true
  }), 'blocked');
});

test('a gesture-only sensor waits for a gesture even when granted', () => {
  // iOS DeviceMotion.requestPermission() throws outside a user gesture no
  // matter what was granted before, so a stored grant changes nothing here.
  assert.equal(decideAutoStart({
    enabled: true, permission: 'granted', requiresGesture: true
  }), 'needs-gesture');
});

test('an unsupported sensor is blocked, not merely off', () => {
  assert.equal(decideAutoStart({ enabled: true, permission: 'granted', supported: false }), 'blocked');
});

test('every decision has something the user can act on', () => {
  for (const decision of ['start', 'needs-gesture', 'blocked', 'off']) {
    const text = describeAutoStart(decision, 'Camera');
    assert.ok(text.length > 10, `${decision} needs a real description`);
    assert.match(text, /Camera/);
  }
  // The gesture case has to say a tap is needed, or it looks broken.
  assert.match(describeAutoStart('needs-gesture', 'Camera'), /[Tt]ap/);
  // The blocked case has to point at Settings, which is the only fix.
  assert.match(describeAutoStart('blocked', 'Camera'), /Settings/);
});

test('a permissions query that throws reads as unknown, not as granted', () => {
  // Safari rejects on the camera name and older engines throw synchronously.
  const rejecting = { query: () => Promise.reject(new Error('TypeError')) };
  const throwing = { query: () => { throw new Error('unsupported name'); } };
  return Promise.all([
    readPermission('camera', rejecting).then((s) => assert.equal(s, 'unknown')),
    readPermission('camera', throwing).then((s) => assert.equal(s, 'unknown')),
    readPermission('camera', undefined).then((s) => assert.equal(s, 'unknown')),
    readPermission('camera', { query: () => Promise.resolve({ state: 'weird' }) })
      .then((s) => assert.equal(s, 'unknown')),
    readPermission('geolocation', { query: () => Promise.resolve({ state: 'granted' }) })
      .then((s) => assert.equal(s, 'granted'))
  ]);
});

/** Minimal EventTarget stand-in that records listener bookkeeping. */
function fakeTarget() {
  const listeners = new Map();
  return {
    listeners,
    addEventListener(type, fn) {
      listeners.set(type, (listeners.get(type) ?? new Set()).add(fn));
    },
    removeEventListener(type, fn) {
      listeners.get(type)?.delete(fn);
    },
    fire(type) {
      for (const fn of [...(listeners.get(type) ?? [])]) fn();
    },
    count() {
      let total = 0;
      for (const set of listeners.values()) total += set.size;
      return total;
    }
  };
}

test('a gesture-armed start fires once and then detaches every listener', () => {
  // A listener left behind on every input event is a leak on the hottest path
  // in a touch app.
  const target = fakeTarget();
  let fired = 0;
  onFirstGesture(() => fired++, target);
  assert.ok(target.count() > 1, 'several gesture types should be watched');

  target.fire('pointerdown');
  assert.equal(fired, 1);
  assert.equal(target.count(), 0, 'all listeners must be released');

  target.fire('click');
  target.fire('touchend');
  assert.equal(fired, 1, 'it must not fire again');
});

test('an armed start can be cancelled before any gesture', () => {
  const target = fakeTarget();
  let fired = 0;
  const cancel = onFirstGesture(() => fired++, target);
  cancel();
  assert.equal(target.count(), 0);
  target.fire('pointerdown');
  assert.equal(fired, 0);
});
