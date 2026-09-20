import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createModalManager, handleModalKeydown } from '../src/components/modalManager.ts';
import { getMotionScrollBehavior } from '../src/utils/scrollBehavior.ts';

function fakeDocument() {
  const listeners = new Map();
  const root = { inert: false };
  const doc = {
    activeElement: null,
    body: { style: { overflow: 'scroll' } },
    getElementById: (id) => id === 'root' ? root : null,
    addEventListener: (type, listener) => listeners.set(type, listener),
    removeEventListener: (type, listener) => {
      if (listeners.get(type) === listener) listeners.delete(type);
    },
    dispatch: (type, event) => listeners.get(type)?.(event),
    listenerCount: () => listeners.size,
    root,
  };
  return doc;
}

function dialogWithControls(controls) {
  return {
    querySelectorAll: () => controls,
    contains: (element) => controls.includes(element),
    focus: () => {},
  };
}

function keyEvent(key, shiftKey = false) {
  let prevented = false;
  return {
    key,
    shiftKey,
    preventDefault: () => { prevented = true; },
    wasPrevented: () => prevented,
  };
}

test('modal manager traps Escape in the top modal and restores the original page lock after the final close', () => {
  const doc = fakeDocument();
  const manager = createModalManager(doc);
  const firstEscape = { count: 0 };
  const secondEscape = { count: 0 };
  const first = { querySelectorAll: () => [], contains: () => false, focus: () => {} };
  const second = { querySelectorAll: () => [], contains: () => false, focus: () => {} };

  const closeFirst = manager.register({ dialog: first, onEscape: () => { firstEscape.count += 1; } });
  const closeSecond = manager.register({ dialog: second, onEscape: () => { secondEscape.count += 1; } });
  assert.equal(doc.body.style.overflow, 'hidden');
  assert.equal(doc.root.inert, true);
  assert.equal(doc.listenerCount(), 1);

  const escape = keyEvent('Escape');
  doc.dispatch('keydown', escape);
  assert.equal(escape.wasPrevented(), true);
  assert.deepEqual(secondEscape, { count: 1 });
  assert.deepEqual(firstEscape, { count: 0 });

  assert.equal(closeSecond(), true);
  assert.equal(doc.body.style.overflow, 'hidden');
  assert.equal(doc.root.inert, true);
  assert.equal(manager.size(), 1);
  assert.equal(closeFirst(), true);
  assert.equal(doc.body.style.overflow, 'scroll');
  assert.equal(doc.root.inert, false);
  assert.equal(doc.listenerCount(), 0);
});

test('modal keyboard handler recaptures focus from outside and wraps both Tab directions', () => {
  const focused = [];
  const first = { hidden: false, getAttribute: () => null, focus: () => focused.push('first') };
  const last = { hidden: false, getAttribute: () => null, focus: () => focused.push('last') };
  const outside = {};
  const dialog = dialogWithControls([first, last]);

  const outsideTab = keyEvent('Tab');
  handleModalKeydown(outsideTab, dialog, outside, () => {});
  assert.equal(outsideTab.wasPrevented(), true);
  assert.deepEqual(focused, ['first']);

  const reverseOutsideTab = keyEvent('Tab', true);
  handleModalKeydown(reverseOutsideTab, dialog, outside, () => {});
  assert.equal(reverseOutsideTab.wasPrevented(), true);
  assert.deepEqual(focused, ['first', 'last']);

  const forwardWrap = keyEvent('Tab');
  handleModalKeydown(forwardWrap, dialog, last, () => {});
  assert.equal(forwardWrap.wasPrevented(), true);
  assert.deepEqual(focused, ['first', 'last', 'first']);

  const backwardWrap = keyEvent('Tab', true);
  handleModalKeydown(backwardWrap, dialog, first, () => {});
  assert.equal(backwardWrap.wasPrevented(), true);
  assert.deepEqual(focused, ['first', 'last', 'first', 'last']);
});

test('reduced-motion scroll helper switches smooth scrolling off only when the media query asks for it', () => {
  const originalWindow = globalThis.window;
  globalThis.window = { matchMedia: () => ({ matches: true }) };
  assert.equal(getMotionScrollBehavior(), 'auto');
  globalThis.window = { matchMedia: () => ({ matches: false }) };
  assert.equal(getMotionScrollBehavior(), 'smooth');
  if (originalWindow === undefined) delete globalThis.window;
  else globalThis.window = originalWindow;
});
