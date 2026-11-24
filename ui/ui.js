import { BrushEngine, createCanvas, DEFAULT_PARAMS } from '../brush/engine.mjs';
import { findPressurePeaks, analyzeLatency, canvasStats } from '../brush/analysis.mjs';
import { sampleTrajectory, DEMO_PEAKS, DEMO_DURATION } from '../brush/trajectory.mjs';

const W = 960, H = 640;
const PAPER = [0.96, 0.95, 0.92];

const inkCanvas = document.getElementById('ink');
const inkCtx = inkCanvas.getContext('2d');
const overlay = document.getElementById('overlay');
const ovCtx = overlay.getContext('2d');
const statsEl = document.getElementById('stats');
const errEl = document.getElementById('err');

const ui = {};
for (const id of ['maxSize', 'spacingRatio', 'flow', 'hardness', 'eccentricity', 'rotationMode',
  'gapTimeMs', 'mousePressure', 'showSamples', 'showDabs', 'showPath', 'replayRate']) {
  ui[id] = document.getElementById(id);
}

let canvas = createCanvas(W, H);
let engine = new BrushEngine(canvas, readParams());
let samples = [];      // 原始采样点(未平滑), 用于轨迹对照
let drawing = false;
let replaying = false;

function readParams() {
  return {
    maxSize: Number(ui.maxSize.value),
    spacingRatio: Number(ui.spacingRatio.value),
    flow: Number(ui.flow.value),
    hardness: Number(ui.hardness.value),
    eccentricity: Number(ui.eccentricity.value),
    rotationMode: ui.rotationMode.value,
    gapTimeMs: Number(ui.gapTimeMs.value),
  };
}

function applyParams() {
  try {
    const p = { ...DEFAULT_PARAMS, ...readParams() };
    const test = new BrushEngine(createCanvas(1, 1), p); // 校验失败会抛错
    engine.params = test.params;
    errEl.style.display = 'none';
  } catch (err) {
    errEl.textContent = '参数被拒绝: ' + err.message; // 失败反馈回界面, 笔迹保持上一组合法参数
    errEl.style.display = 'block';
  }
}

function initControls() {
  ui.maxSize.value = DEFAULT_PARAMS.maxSize;
  ui.spacingRatio.value = DEFAULT_PARAMS.spacingRatio;
  ui.flow.value = DEFAULT_PARAMS.flow;
  ui.hardness.value = DEFAULT_PARAMS.hardness;
  ui.eccentricity.value = DEFAULT_PARAMS.eccentricity;
  ui.gapTimeMs.value = DEFAULT_PARAMS.gapTimeMs;
  ui.mousePressure.value = 0.5;
  for (const id of ['maxSize', 'spacingRatio', 'flow', 'hardness', 'eccentricity', 'gapTimeMs', 'mousePressure']) {
    const span = document.getElementById('v-' + id);
    const show = () => { span.textContent = ` (${ui[id].value})`; };
    ui[id].addEventListener('input', () => { show(); applyParams(); });
    show();
  }
  ui.rotationMode.addEventListener('change', applyParams);
}

function blit() {
  const img = inkCtx.createImageData(W, H);
  const d = canvas.data, o = img.data;
  for (let i = 0; i < W * H; i++) {
    const a = d[i * 4 + 3];
    o[i * 4] = (d[i * 4] * a + PAPER[0] * (1 - a)) * 255;
    o[i * 4 + 1] = (d[i * 4 + 1] * a + PAPER[1] * (1 - a)) * 255;
    o[i * 4 + 2] = (d[i * 4 + 2] * a + PAPER[2] * (1 - a)) * 255;
    o[i * 4 + 3] = 255;
  }
  inkCtx.putImageData(img, 0, 0);
}

function drawOverlay() {
  ovCtx.clearRect(0, 0, W, H);
  if (ui.showPath.checked && samples.length > 1) {
    ovCtx.strokeStyle = '#2a9d3f88';
    ovCtx.lineWidth = 1;
    ovCtx.beginPath();
    ovCtx.moveTo(samples[0].x, samples[0].y);
    for (const s of samples) ovCtx.lineTo(s.x, s.y);
    ovCtx.stroke();
  }
  if (ui.showSamples.checked) {
    ovCtx.strokeStyle = '#d33';
    for (const s of samples) {
      ovCtx.beginPath();
      ovCtx.moveTo(s.x - 3, s.y); ovCtx.lineTo(s.x + 3, s.y);
      ovCtx.moveTo(s.x, s.y - 3); ovCtx.lineTo(s.x, s.y + 3);
      ovCtx.stroke();
    }
  }
  if (ui.showDabs.checked) {
    ovCtx.fillStyle = '#26c';
    for (const d of engine.dabs) {
      ovCtx.beginPath();
      ovCtx.arc(d.x, d.y, 1.5, 0, Math.PI * 2);
      ovCtx.fill();
    }
  }
}

function refreshStats(extra = '') {
  const st = engine.stats;
  const ink = canvasStats(canvas);
  const lat = analyzeLatency(engine.dabs);
  statsEl.textContent =
    `事件 ${st.events}  笔划 ${st.strokes}  断笔 ${st.gaps}\n` +
    `盖印 ${engine.dabs.length}  总墨量 ${ink.ink.toFixed(0)}\n` +
    `落笔延迟 mean ${lat.mean.toFixed(1)}ms  max ${lat.max.toFixed(1)}ms\n` + extra;
}

function refresh(extra) {
  blit();
  drawOverlay();
  refreshStats(extra);
}

// ---- 输入: 事件 -> 内核, 显示位置不做任何平滑/预测 ----
function toEvent(e) {
  const r = inkCanvas.getBoundingClientRect();
  const isPen = e.pointerType === 'pen';
  return {
    x: (e.clientX - r.left) * (W / r.width),
    y: (e.clientY - r.top) * (H / r.height),
    t: e.timeStamp,
    p: isPen && e.pressure > 0 ? e.pressure : Number(ui.mousePressure.value),
    tx: isPen ? Math.tan((e.tiltX * Math.PI) / 180) : 0,
    ty: isPen ? Math.tan((e.tiltY * Math.PI) / 180) : 0,
  };
}

inkCanvas.addEventListener('pointerdown', e => {
  if (replaying) return;
  inkCanvas.setPointerCapture(e.pointerId);
  drawing = true;
  const ev = toEvent(e);
  samples.push(ev);
  engine.beginStroke(ev);
  refresh();
});

inkCanvas.addEventListener('pointermove', e => {
  if (!drawing || replaying) return;
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ce of list) {
    const ev = toEvent(ce);
    samples.push(ev);
    engine.pushEvent(ev);
  }
  refresh();
});

function endStroke(e) {
  if (!drawing) return;
  drawing = false;
  if (e) {
    const ev = toEvent(e);
    samples.push(ev);
    engine.endStroke(ev);
  } else {
    engine.endStroke();
  }
  refresh();
}
inkCanvas.addEventListener('pointerup', endStroke);
inkCanvas.addEventListener('pointercancel', () => endStroke(null));

// ---- 重放固定输入: 与测试共用同一条连续轨迹 ----
document.getElementById('replay').addEventListener('click', () => {
  if (replaying) return;
  clearAll();
  replaying = true;
  const rate = Number(ui.replayRate.value);
  const events = sampleTrajectory(rate);
  const t0 = performance.now();
  let i = 0;
  engine.beginStroke(events[0]);
  samples.push(events[0]);
  i = 1;
  const tick = () => {
    const elapsed = performance.now() - t0;
    while (i < events.length && events[i].t <= elapsed) {
      samples.push(events[i]);
      engine.pushEvent(events[i]);
      i++;
    }
    refresh();
    if (i < events.length) {
      requestAnimationFrame(tick);
    } else {
      engine.endStroke();
      replaying = false;
      const peaks = findPressurePeaks(events, { minProminence: 0.3 });
      const lat = analyzeLatency(engine.dabs);
      refresh(
        `重放 ${rate}Hz 共 ${events.length} 事件\n` +
        `压力峰: 期望 ${DEMO_PEAKS.join('/')}ms, 检出 ${peaks.map(p => p.t.toFixed(0)).join('/') || '无'}ms\n` +
        `延迟: mean ${lat.mean.toFixed(1)}ms max ${lat.max.toFixed(1)}ms (采样间隔 ${(1000 / rate).toFixed(1)}ms)`
      );
    }
  };
  requestAnimationFrame(tick);
});

function clearAll() {
  canvas = createCanvas(W, H);
  engine = new BrushEngine(canvas, readParams());
  applyParams();
  samples = [];
  refresh();
}
document.getElementById('clear').addEventListener('click', clearAll);

document.getElementById('export').addEventListener('click', () => {
  inkCanvas.toBlob(blob => {
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = 'stroke.png';
    a.click();
    URL.revokeObjectURL(a.href);
  });
});

for (const id of ['showSamples', 'showDabs', 'showPath']) {
  ui[id].addEventListener('change', () => refresh());
}

initControls();
refresh();
