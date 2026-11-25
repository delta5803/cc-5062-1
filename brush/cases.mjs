// 图形回归样例与命令行验收共用的确定性输入。

import { groundTruth } from './trajectory.mjs';

export const VIEW_W = 960;
export const VIEW_H = 640;

export const HOLD_PARAMS = {
  minSize: 10,
  maxSize: 10,
  spacingRatio: 0.5,
  minSpacing: 0.5,
  flow: 0.35,
  hardness: 0.65,
};

export const PRESSURE_JUMP_PARAMS = {
  minSize: 4,
  maxSize: 24,
  spacingRatio: 0.2,
  minSpacing: 10,
  flow: 0.35,
  hardness: 0.65,
};

export function buildHoldEvents() {
  const events = [];
  for (let x = 120; x <= 320; x += 10) events.push({ x, y: 320, t: (x - 120) * 2, p: 0.8, tx: 0, ty: 0 });
  const repeated = { ...events[events.length - 1] };
  events.push(repeated, { ...repeated }); // 故意的精确重复输入
  for (let i = 1; i <= 12; i++) events.push({ x: 320, y: 320, t: 400 + i * 20, p: 0.8, tx: 0, ty: 0 });
  for (let x = 330; x <= 520; x += 10) events.push({ x, y: 320, t: 700 + (x - 320) * 2, p: 0.8, tx: 0, ty: 0 });
  return events;
}

export function buildPressureJumpEvents() {
  const events = [];
  for (let x = 120; x <= 720; x += 10) {
    events.push({ x, y: 400, t: (x - 120) * 2, p: x <= 320 ? 0.2 : 0.9, tx: 0, ty: 0 });
  }
  return events;
}

export function pressureJumpExpectedP(x) {
  return x <= 320 ? 0.2 : 0.9;
}

// 平缓手写风格曲线：避免自交，同时保留连续曲率变化。
export const HANDWRITTEN_POINTS = (() => {
  const points = [];
  for (let x = 100; x <= 860; x += 4) {
    const u = (x - 100) / 760;
    points.push({
      x,
      y: 320 + 70 * Math.sin(2 * Math.PI * u) + 24 * Math.sin(5 * Math.PI * u),
      p: 0.72,
    });
  }
  return points;
})();

export function buildHandwrittenEvents() {
  return HANDWRITTEN_POINTS.map((point, i) => ({ ...point, t: i * 8, tx: 0, ty: 0 }));
}

export function buildDefectStroke() {
  const before = [];
  const after = [];
  for (const point of HANDWRITTEN_POINTS) {
    if (point.x <= 340) before.push({ ...point, t: before.length * 8, tx: 0, ty: 0 });
    if (point.x >= 430) after.push({ ...point, t: 1200 + after.length * 8, tx: 0, ty: 0 });
  }
  const oversizePoint = HANDWRITTEN_POINTS.reduce((best, p) =>
    Math.abs(p.x - 620) < Math.abs(best.x - 620) ? p : best,
  HANDWRITTEN_POINTS[0]);
  return {
    events: [...before, ...after],
    expectedGapAfterX: 340,
    expectedGapBeforeX: 430,
    oversize: { ...oversizePoint, rx: 22, ry: 22, angle: 0, alpha: 1 },
    widthLimit: 18,
    widthTolerance: 2,
  };
}

export function buildDemoTruthPoints(stepMs = 4) {
  const points = [];
  for (let t = 0; t <= 3000; t += stepMs) points.push(groundTruth(t));
  return points;
}

export const REGRESSION_CASES = [
  { id: 'demo', label: '固定轨迹：频率/分包/压力峰' },
  { id: 'hold', label: '正反例：停笔与重复事件' },
  { id: 'pressure-jump', label: '正反例：突变压力响应' },
  { id: 'handwritten-good', label: '手写曲线：正常覆盖参照' },
  { id: 'handwritten-defects', label: '受控坏样例：最早断线/超宽' },
];
