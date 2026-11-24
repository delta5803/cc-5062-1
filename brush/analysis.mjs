// 从采样轨迹与已提交 dab 复算: 压力峰、落笔延迟、覆盖率、画布差异。

export function findPressurePeaks(events, { minProminence = 0.08, minHeight = 0.15 } = {}) {
  const peaks = [];
  for (let i = 1; i < events.length - 1; i++) {
    const p = events[i].p;
    if (p < minHeight) continue;
    if (!(p > events[i - 1].p && p >= events[i + 1].p)) continue; // 平台取最左点
    let l = p, r = p;
    for (let j = i - 1; j >= 0 && events[j].p <= p; j--) l = Math.min(l, events[j].p);
    for (let j = i + 1; j < events.length && events[j].p <= p; j++) r = Math.min(r, events[j].p);
    const prominence = p - Math.max(l, r);
    if (prominence >= minProminence) {
      peaks.push({ index: i, t: events[i].t, p, prominence });
    }
  }
  return peaks;
}

// 每个 dab 的落笔延迟 = 提交时刻 - 该 dab 在路径上的插值时刻。
// 内核不做位置外推/平滑, 段 e0->e1 的 dab 只能等 e1 到达后提交, 延迟由采样轨迹完全决定。
export function analyzeLatency(dabs) {
  if (!dabs.length) return { count: 0, mean: 0, max: 0, min: 0, perDab: [] };
  const perDab = dabs.map(d => d.tCommit - d.t);
  const mean = perDab.reduce((a, b) => a + b, 0) / perDab.length;
  return {
    count: perDab.length,
    mean,
    max: Math.max(...perDab),
    min: Math.min(...perDab),
    perDab,
  };
}

export function canvasStats(canvas) {
  const { data } = canvas;
  let sum = 0, max = 0, nonzero = 0;
  const n = data.length / 4;
  for (let i = 0; i < n; i++) {
    const a = data[i * 4 + 3];
    sum += a;
    if (a > max) max = a;
    if (a > 1e-6) nonzero++;
  }
  return { ink: sum, maxAlpha: max, coveragePx: nonzero, meanAlpha: sum / n };
}

// 差异度量: 全图最大/平均绝对差 + 边缘带(任一画布 alpha 处于 (lo,hi) 的像素)最大差。
export function diffCanvases(a, b, { edgeLo = 0.02, edgeHi = 0.6 } = {}) {
  if (a.width !== b.width || a.height !== b.height) throw new Error('画布尺寸不一致');
  const da = a.data, db = b.data;
  let maxAbs = 0, sumAbs = 0, edgeMax = 0, edgeCount = 0;
  for (let i = 3; i < da.length; i += 4) {
    const d = Math.abs(da[i] - db[i]);
    if (d > maxAbs) maxAbs = d;
    sumAbs += d;
    const inEdge = (da[i] > edgeLo && da[i] < edgeHi) || (db[i] > edgeLo && db[i] < edgeHi);
    if (inEdge) {
      edgeCount++;
      if (d > edgeMax) edgeMax = d;
    }
  }
  const n = da.length / 4;
  return { maxAbs, meanAbs: sumAbs / n, edgeMax, edgeCount };
}

export function cloneCanvas(canvas) {
  return { width: canvas.width, height: canvas.height, data: new Float32Array(canvas.data) };
}
