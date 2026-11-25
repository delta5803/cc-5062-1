import { BrushEngine, createCanvas, DEFAULT_PARAMS } from '../brush/engine.mjs';
import { analyzeLatency, canvasStats, findPressurePeaks } from '../brush/analysis.mjs';
import { sampleTrajectory, DEMO_PEAKS } from '../brush/trajectory.mjs';
import { REGRESSION_CASES } from '../brush/cases.mjs';
import { composePaperRgba, encodePngRgba } from '../brush/export.mjs';
import { evaluateLoadedCase, runRegressionCase } from '../brush/acceptance.mjs';

const W = 960, H = 640;

const inkCanvas = document.getElementById('ink');
const inkCtx = inkCanvas.getContext('2d');
const overlay = document.getElementById('overlay');
const ovCtx = overlay.getContext('2d');
const statsEl = document.getElementById('stats');
const errEl = document.getElementById('err');
const acceptanceEl = document.getElementById('acceptance');
const undoBtn = document.getElementById('undo');
const caseSelect = document.getElementById('caseSelect');
const openCaseBtn = document.getElementById('openCase');

const ui = {};
for (const id of ['maxSize', 'spacingRatio', 'flow', 'hardness', 'eccentricity', 'rotationMode',
  'gapTimeMs', 'mousePressure', 'showSamples', 'showDabs', 'showPath', 'replayRate']) {
  ui[id] = document.getElementById(id);
}

for (const item of REGRESSION_CASES) {
  const option = document.createElement('option');
  option.value = item.id;
  option.textContent = item.label;
  caseSelect.appendChild(option);
}

let hiddenParamOverrides = {};
let canvas = createCanvas(W, H);
let engine = new BrushEngine(canvas, readParams());
let samples = [];
let drawing = false;
let replaying = false;
let history = [];
let currentCaseId = 'free';
let lastReduction = null;
let caseReport = null;

function reportError(err) {
  console.error(err);
  errEl.textContent = '压感笔迹界面异常: ' + (err?.message || String(err));
  errEl.style.display = 'block';
}

function guard(fn) {
  return (...args) => {
    try {
      return fn(...args);
    } catch (err) {
      reportError(err);
    }
  };
}

window.addEventListener('error', event => reportError(event.error || event.message));
window.addEventListener('unhandledrejection', event => reportError(event.reason));

function readParams() {
  return {
    ...hiddenParamOverrides,
    maxSize: Number(ui.maxSize.value),
    spacingRatio: Number(ui.spacingRatio.value),
    flow: Number(ui.flow.value),
    hardness: Number(ui.hardness.value),
    eccentricity: Number(ui.eccentricity.value),
    rotationMode: ui.rotationMode.value,
    gapTimeMs: Number(ui.gapTimeMs.value),
  };
}

function updateValueLabel(id) {
  const span = document.getElementById('v-' + id);
  if (span && ui[id]) span.textContent = ` (${ui[id].value})`;
}

function setControlValues(params) {
  for (const id of ['maxSize', 'spacingRatio', 'flow', 'hardness', 'eccentricity', 'gapTimeMs']) {
    if (params[id] !== undefined) ui[id].value = params[id];
    updateValueLabel(id);
  }
  if (params.rotationMode) ui.rotationMode.value = params.rotationMode;
  if (params.mousePressure !== undefined) ui.mousePressure.value = params.mousePressure;
  updateValueLabel('mousePressure');
}

function applyParams() {
  try {
    const p = { ...DEFAULT_PARAMS, ...readParams() };
    const test = new BrushEngine(createCanvas(1, 1), p); // 校验失败会抛错
    engine.params = test.params;
    errEl.style.display = 'none';
  } catch (err) {
    reportError(err);
  }
}

function initControls() {
  setControlValues(DEFAULT_PARAMS);
  ui.mousePressure.value = 0.5;
  updateValueLabel('mousePressure');
  for (const id of ['maxSize', 'spacingRatio', 'flow', 'hardness', 'eccentricity', 'gapTimeMs', 'mousePressure']) {
    ui[id].addEventListener('input', guard(() => {
      updateValueLabel(id);
      applyParams();
    }));
  }
  ui.rotationMode.addEventListener('change', guard(applyParams));
}

function blit() {
  const img = new ImageData(composePaperRgba(canvas), W, H);
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
    `事件 ${st.events}  重复 ${st.duplicates}  笔划 ${st.strokes}  断笔 ${st.gaps}\n` +
    `盖印 ${engine.dabs.length}  总墨量 ${ink.ink.toFixed(0)}\n` +
    `落笔延迟 mean ${lat.mean.toFixed(1)}ms max ${lat.max.toFixed(1)}ms\n` + extra;
}

function renderAcceptance() {
  if (!caseReport) {
    acceptanceEl.style.display = 'none';
    acceptanceEl.textContent = '';
    acceptanceEl.className = '';
    return;
  }
  const status = caseReport.ok ? '[通过]' : caseReport.tone === 'warning' ? '[定位]' : '[失败]';
  acceptanceEl.className = caseReport.tone === 'ok' ? 'report ok' : `report ${caseReport.tone || 'error'}`;
  acceptanceEl.textContent = `${status} ${caseReport.title}\n${caseReport.lines.join('\n')}`;
  acceptanceEl.style.display = 'block';
}

function refresh(extra) {
  blit();
  drawOverlay();
  refreshStats(extra);
  renderAcceptance();
  undoBtn.disabled = history.length === 0 || replaying;
}

// ---- 撤销: 同时恢复像素、dabs、统计和界面采样点 ----
function pushHistory() {
  history.push({
    snapshot: engine.snapshot(),
    params: { ...engine.params, color: [...engine.params.color] },
    samples: samples.map(e => ({ ...e })),
    caseId: currentCaseId,
    reduction: lastReduction,
  });
  if (history.length > 30) history.shift();
  undoBtn.disabled = false;
}

function undo() {
  const entry = history.pop();
  if (!entry) return;
  canvas = createCanvas(W, H);
  engine = new BrushEngine(canvas, entry.params);
  engine.restore(entry.snapshot);
  samples = entry.samples.map(e => ({ ...e }));
  currentCaseId = entry.caseId || 'free';
  lastReduction = entry.reduction || null;
  caseReport = currentCaseId.startsWith('handwritten') || ['hold', 'pressure-jump', 'demo'].includes(currentCaseId)
    ? evaluateLoadedCase(currentCaseId, { engine, canvas, reduction: lastReduction })
    : null;
  refresh('已撤销上一笔/载入');
}
undoBtn.addEventListener('click', guard(undo));
window.addEventListener('keydown', guard(event => {
  if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 'z') {
    event.preventDefault();
    undo();
    return;
  }
  if (event.key === '[' || event.key === ']') {
    const current = Number(ui.mousePressure.value);
    const next = Math.min(1, Math.max(0.05, current + (event.key === ']' ? 0.05 : -0.05)));
    ui.mousePressure.value = next.toFixed(2);
    updateValueLabel('mousePressure');
    refreshStats(`鼠标模拟压力已调为 ${next.toFixed(2)}；继续拖动画笔即可看到压力响应`);
  }
}));

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

inkCanvas.addEventListener('pointerdown', guard(e => {
  if (replaying) return;
  pushHistory();
  currentCaseId = 'free';
  caseReport = null;
  inkCanvas.setPointerCapture(e.pointerId);
  drawing = true;
  const ev = toEvent(e);
  samples.push(ev);
  engine.beginStroke(ev);
  refresh();
}));

inkCanvas.addEventListener('pointermove', guard(e => {
  if (!drawing || replaying) return;
  const list = e.getCoalescedEvents ? e.getCoalescedEvents() : [e];
  for (const ce of list) {
    const ev = toEvent(ce);
    samples.push(ev);
    engine.pushEvent(ev);
  }
  refresh();
}));

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
inkCanvas.addEventListener('pointerup', guard(endStroke));
inkCanvas.addEventListener('pointercancel', guard(() => endStroke(null)));

function clearAll() {
  hiddenParamOverrides = {};
  canvas = createCanvas(W, H);
  engine = new BrushEngine(canvas, readParams());
  samples = [];
  currentCaseId = 'free';
  lastReduction = null;
  caseReport = null;
  refresh();
}
document.getElementById('clear').addEventListener('click', guard(() => {
  pushHistory();
  clearAll();
}));

// ---- 回归样例: 与命令行验收共用同一运行器 ----
function loadCase(id) {
  const runtime = runRegressionCase(id, { width: W, height: H });
  hiddenParamOverrides = runtime.params.minSize !== undefined ? { minSize: runtime.params.minSize } : {};
  setControlValues({ ...DEFAULT_PARAMS, ...runtime.params });
  canvas = runtime.canvas;
  engine = runtime.engine;
  currentCaseId = id;
  samples = runtime.events.map(e => ({ ...e }));
  lastReduction = runtime.reduction;
  caseReport = evaluateLoadedCase(id, { engine, canvas, reduction: lastReduction });
  refresh(`已从绘画窗口打开回归样例: ${caseSelect.selectedOptions[0]?.textContent || id}`);
}

openCaseBtn.addEventListener('click', guard(() => {
  pushHistory();
  loadCase(caseSelect.value);
}));

// ---- 重放固定输入: 与测试共用同一条连续轨迹 ----
document.getElementById('replay').addEventListener('click', guard(() => {
  if (replaying) return;
  pushHistory();
  clearAll();
  currentCaseId = 'demo';
  replaying = true;
  const rate = Number(ui.replayRate.value);
  const events = sampleTrajectory(rate);
  const t0 = performance.now();
  let i = 0;
  engine.beginStroke(events[0]);
  samples.push(events[0]);
  i = 1;
  const tick = () => {
    try {
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
        caseReport = evaluateLoadedCase('demo', { engine, canvas });
        refresh(
          `重放 ${rate}Hz 共 ${events.length} 事件\n` +
          `压力峰: 期望 ${DEMO_PEAKS.join('/')}ms, 检出 ${peaks.map(p => p.t.toFixed(0)).join('/') || '无'}ms\n` +
          `延迟 mean ${lat.mean.toFixed(1)}ms max ${lat.max.toFixed(1)}ms (采样间隔 ${(1000 / rate).toFixed(1)}ms)`
        );
      }
    } catch (err) {
      replaying = false;
      reportError(err);
      refresh();
    }
  };
  requestAnimationFrame(tick);
}));

document.getElementById('export').addEventListener('click', guard(() => {
  const png = encodePngRgba(composePaperRgba(canvas), W, H);
  const blob = new Blob([png], { type: 'image/png' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = 'pressure-stroke.png';
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  refresh(`已导出 PNG：${png.length} 字节`);
}));

for (const id of ['showSamples', 'showDabs', 'showPath']) {
  ui[id].addEventListener('change', guard(() => refresh()));
}

initControls();
applyParams();
refresh();
