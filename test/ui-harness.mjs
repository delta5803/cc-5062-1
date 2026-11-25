// 无浏览器依赖的 UI 接线桩：node test/ui-harness.mjs
class FakeContext {
  clearRect() {}
  beginPath() {}
  moveTo() {}
  lineTo() {}
  stroke() {}
  arc() {}
  fill() {}
  putImageData() {}
}

class FakeElement {
  constructor(id = '') {
    this.id = id;
    this.style = {};
    this.listeners = {};
    this.children = [];
    this.checked = true;
    this.disabled = false;
    this.selectedOptions = [{ textContent: id }];
    const values = {
      maxSize: '28', spacingRatio: '0.35', flow: '0.35', hardness: '0.65',
      eccentricity: '0.6', rotationMode: 'tilt', gapTimeMs: '120',
      mousePressure: '0.5', replayRate: '120', caseSelect: 'hold',
    };
    this.value = values[id] ?? (id.includes('Rate') ? '120' : '');
    this.textContent = '';
    this.className = '';
    this.width = 960;
    this.height = 640;
  }
  addEventListener(type, fn) { this.listeners[type] = fn; }
  dispatch(type, event = {}) {
    if (!this.listeners[type]) throw new Error(`missing ${type} listener on #${this.id}`);
    return this.listeners[type](event);
  }
  appendChild(child) { this.children.push(child); return child; }
  remove() {}
  setPointerCapture() {}
  getBoundingClientRect() { return { left: 0, top: 0, width: 960, height: 640 }; }
  getContext() { return new FakeContext(); }
  click() { if (this.listeners.click) this.dispatch('click'); }
}

const elements = new Map();
globalThis.document = {
  getElementById(id) {
    if (!elements.has(id)) elements.set(id, new FakeElement(id));
    return elements.get(id);
  },
  createElement(tag) { return new FakeElement(tag); },
  body: new FakeElement('body'),
};
globalThis.window = {
  listeners: {},
  addEventListener(type, fn) { this.listeners[type] = fn; },
};
globalThis.ImageData = class ImageData {
  constructor(data, width, height) { this.data = data; this.width = width; this.height = height; }
};
const rafQueue = [];
let virtualNow = 0;
globalThis.requestAnimationFrame = cb => { rafQueue.push(cb); return rafQueue.length; };
globalThis.performance = { now: () => virtualNow };
globalThis.Blob = class Blob { constructor(parts) { this.parts = parts; } };
globalThis.URL = { createObjectURL: () => 'blob:fake', revokeObjectURL() {} };

await import('../ui/ui.js');

const $ = id => elements.get(id);
function assertNoUiError(action) {
  const err = $('err');
  if (err.style.display === 'block') throw new Error(`${action} triggered UI error: ${err.textContent}`);
}

for (const id of ['hold', 'pressure-jump', 'handwritten-good', 'handwritten-defects', 'demo']) {
  $('caseSelect').value = id;
  $('openCase').dispatch('click');
  assertNoUiError(`open ${id}`);
  const report = $('acceptance').textContent;
  if (!report.includes('[通过]') && !report.includes('[定位]')) {
    throw new Error(`case ${id} did not report acceptance: ${report}`);
  }
  console.log(`UI case ${id}: ${report.split('\n')[0]}`);
}

$('caseSelect').value = 'hold';
$('openCase').dispatch('click');
assertNoUiError('reopen hold');
if ($('undo').disabled) throw new Error('undo should be enabled after opening case');
$('undo').dispatch('click');
assertNoUiError('undo case');

function pointerEvent(x, y) {
  const event = {
    pointerId: 1,
    pointerType: 'mouse',
    clientX: x,
    clientY: y,
    pressure: 0.5,
    timeStamp: 100,
  };
  event.getCoalescedEvents = () => [event];
  return event;
}

$('ink').dispatch('pointerdown', pointerEvent(200, 200));
assertNoUiError('pointerdown');
for (let x = 210; x <= 300; x += 10) {
  $('ink').dispatch('pointermove', pointerEvent(x, 210));
  assertNoUiError('pointermove');
}
$('ink').dispatch('pointerup', pointerEvent(310, 210));
assertNoUiError('pointerup');
if (!$('stats').textContent.includes('盖印')) throw new Error('stats did not render after manual stroke');
window.listeners.keydown({ key: ']', ctrlKey: false, metaKey: false, preventDefault() {} });
$('undo').dispatch('click');
assertNoUiError('undo manual stroke');
$('export').dispatch('click');
assertNoUiError('export');

$('replay').dispatch('click');
assertNoUiError('start replay');
for (let tick = 0; tick < 120 && rafQueue.length; tick++) {
  virtualNow += 50;
  const frame = rafQueue.shift();
  frame(virtualNow);
  assertNoUiError(`replay tick ${tick}`);
}
if (rafQueue.length) throw new Error('replay did not finish');
if (!$('stats').textContent.includes('压力峰')) throw new Error('replay final evidence missing');
assertNoUiError('finish replay');

console.log('UI harness: cases, manual stroke, pressure key, undo, export, and legacy replay all completed');
