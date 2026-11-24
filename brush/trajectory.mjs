// 可复算的固定输入轨迹: 连续真值 groundTruth(t) + 任意频率采样器。
// 同一条轨迹在 UI 重放与测试确定性比较中共用, 保证结果可复算。

export const DEMO_DURATION = 3000; // ms

const smooth = u => u * u * (3 - 2 * u);

// 路径: 正弦段 -> 急转弯 -> 半圆弧 -> 原地停顿(检验不堆墨) -> 斜线收尾
function positionAt(t) {
  if (t < 1000) {
    const u = smooth(t / 1000);
    return { x: 80 + 320 * u, y: 300 + 60 * Math.sin(3 * Math.PI * u) };
  }
  if (t < 1120) {
    const u = (t - 1000) / 120; // 急转弯: 方向突变
    return { x: 400, y: 300 - 150 * u };
  }
  if (t < 1800) {
    const u = (t - 1120) / 680;
    const a = Math.PI + Math.PI * u; // 圆心(550,150)半径150的下半圆, 起点(400,150)
    return { x: 550 + 150 * Math.cos(a), y: 150 + 150 * Math.sin(a) };
  }
  if (t < 2300) {
    return { x: 700, y: 150 }; // 停顿 500ms: 笔静止, 事件仍持续上报
  }
  const u = smooth(Math.min(1, (t - 2300) / 700));
  return { x: 700 + 150 * u, y: 150 + 150 * u };
}

// 压力: 两个已知峰(t=500, t=1500) + 一处低压谷, 供压力峰复算对照
export const DEMO_PEAKS = [500, 1500];

function pressureAt(t) {
  const g = (c, w, a) => a * Math.exp(-(((t - c) / w) ** 2));
  let p = 0.35 + g(500, 180, 0.6) + g(1500, 220, 0.55);
  p *= 1 - 0.85 * Math.exp(-(((t - 2500) / 120) ** 2)); // 低谷
  return Math.min(1, Math.max(0.03, p));
}

function tiltAt(t) {
  return {
    tx: 0.5 * Math.sin((2 * Math.PI * t) / 1500),
    ty: 0.4 * Math.cos((2 * Math.PI * t) / 900),
  };
}

export function groundTruth(t) {
  const { x, y } = positionAt(t);
  const { tx, ty } = tiltAt(t);
  return { x, y, t, p: pressureAt(t), tx, ty };
}

// 按给定频率(Hz)采样连续轨迹, 模拟设备事件流
export function sampleTrajectory(rateHz, { duration = DEMO_DURATION } = {}) {
  const dt = 1000 / rateHz;
  const events = [];
  for (let t = 0; t <= duration + 1e-9; t += dt) {
    events.push(groundTruth(Math.min(t, duration)));
  }
  return events;
}

// 把事件流切成指定大小的批次, 检验批次不影响结果
export function chunk(events, size) {
  const out = [];
  for (let i = 0; i < events.length; i += size) out.push(events.slice(i, i + size));
  return out;
}
