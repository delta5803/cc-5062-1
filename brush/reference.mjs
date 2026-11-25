// 独立验收参照：弧长路径、期望盖印、简单光栅器和画布测量均不读取引擎内部积分。

import { createCanvas } from './engine.mjs';

export function makeArcPath(points) {
  if (!Array.isArray(points) || points.length < 2) throw new Error('路径至少需要两个点');
  const segments = [];
  let length = 0;
  for (let i = 0; i < points.length - 1; i++) {
    const a = points[i], b = points[i + 1];
    const len = Math.hypot(b.x - a.x, b.y - a.y);
    segments.push({ a, b, len, start: length });
    length += len;
  }
  return {
    points,
    length,
    at(distance) {
      const s = Math.max(0, Math.min(length, distance));
      let seg = segments[segments.length - 1];
      for (const candidate of segments) {
        if (s <= candidate.start + candidate.len + 1e-12) { seg = candidate; break; }
      }
      const u = seg.len < 1e-12 ? 0 : Math.max(0, Math.min(1, (s - seg.start) / seg.len));
      const x = seg.a.x + (seg.b.x - seg.a.x) * u;
      const y = seg.a.y + (seg.b.y - seg.a.y) * u;
      const tx = seg.len < 1e-12 ? 1 : (seg.b.x - seg.a.x) / seg.len;
      const ty = seg.len < 1e-12 ? 0 : (seg.b.y - seg.a.y) / seg.len;
      const result = { x, y, tx, ty, nx: -ty, ny: tx, s };
      if (seg.a.p !== undefined && seg.b.p !== undefined) result.p = seg.a.p + (seg.b.p - seg.a.p) * u;
      return result;
    },
  };
}

export function diameterAtPressure(params, p) {
  const q = Math.max(0, Math.min(1, p));
  return params.minSize + (params.maxSize - params.minSize) * q;
}

export function spacingAtPressure(params, p) {
  return Math.max(params.minSpacing, params.spacingRatio * diameterAtPressure(params, p));
}

// 按独立弧长行走生成期望盖印。spacingAt 可传入压力相关函数。
export function expectedArcDabs(path, {
  spacing = null,
  pressure = 0.5,
  params = null,
  alpha = params?.flow ?? 0.35,
  angle = 0,
} = {}) {
  const spacingAt = typeof spacing === 'function'
    ? spacing
    : typeof spacing === 'number'
      ? () => spacing
      : (s, point) => (params ? spacingAtPressure(params, point.p ?? pressure) : 5);
  const dabs = [];
  let s = 0;
  while (s <= path.length + 1e-9) {
    const point = path.at(s);
    const p = point.p ?? (typeof pressure === 'function' ? pressure(s, point) : pressure);
    const diameter = params ? diameterAtPressure(params, p) : 10;
    dabs.push({
      x: point.x,
      y: point.y,
      s,
      p,
      rx: diameter / 2,
      ry: diameter / 2,
      angle,
      alpha,
    });
    const step = spacingAt(s, { ...point, p });
    if (!(step > 0)) throw new Error('期望间距必须为正数');
    if (s + step > path.length + 1e-9) break;
    s += step;
  }
  return dabs;
}

// 与 engine.stampDab 规格相同但实现刻意独立：直接遍历包围盒并做 source-over。
export function rasterizeReferenceDabs(dabs, width, height, color, hardness) {
  const canvas = createCanvas(width, height);
  const data = canvas.data;
  for (const dab of dabs) {
    const cos = Math.cos(dab.angle), sin = Math.sin(dab.angle);
    const radius = Math.max(dab.rx, dab.ry);
    const x0 = Math.max(0, Math.floor(dab.x - radius - 1));
    const x1 = Math.min(width - 1, Math.ceil(dab.x + radius + 1));
    const y0 = Math.max(0, Math.floor(dab.y - radius - 1));
    const y1 = Math.min(height - 1, Math.ceil(dab.y + radius + 1));
    for (let py = y0; py <= y1; py++) {
      for (let px = x0; px <= x1; px++) {
        const dx = px + 0.5 - dab.x;
        const dy = py + 0.5 - dab.y;
        const ex = (dx * cos + dy * sin) / dab.rx;
        const ey = (-dx * sin + dy * cos) / dab.ry;
        const d = Math.hypot(ex, ey);
        if (d >= 1) continue;
        let profile = 1;
        if (d > hardness) {
          const u = (d - hardness) / (1 - hardness);
          profile = 1 - u * u * (3 - 2 * u);
        }
        const sourceAlpha = dab.alpha * profile;
        if (sourceAlpha <= 0) continue;
        const i = (py * width + px) * 4;
        const destinationAlpha = data[i + 3];
        const outAlpha = sourceAlpha + destinationAlpha * (1 - sourceAlpha);
        const keep = destinationAlpha * (1 - sourceAlpha);
        data[i] = (color[0] * sourceAlpha + data[i] * keep) / outAlpha;
        data[i + 1] = (color[1] * sourceAlpha + data[i + 1] * keep) / outAlpha;
        data[i + 2] = (color[2] * sourceAlpha + data[i + 2] * keep) / outAlpha;
        data[i + 3] = outAlpha;
      }
    }
  }
  return canvas;
}

export function compareDabSequence(actual, expected, { positionTolerance = 0.35, radiusTolerance = 0.08 } = {}) {
  const n = Math.min(actual.length, expected.length);
  const positionErrors = [];
  const radiusErrors = [];
  let maxPositionError = 0;
  let maxRadiusError = 0;
  let firstBadIndex = -1;
  for (let i = 0; i < n; i++) {
    const positionError = Math.hypot(actual[i].x - expected[i].x, actual[i].y - expected[i].y);
    const radiusError = Math.abs(actual[i].rx - expected[i].rx);
    positionErrors.push(positionError);
    radiusErrors.push(radiusError);
    maxPositionError = Math.max(maxPositionError, positionError);
    maxRadiusError = Math.max(maxRadiusError, radiusError);
    if (firstBadIndex < 0 && (positionError > positionTolerance || radiusError > radiusTolerance)) firstBadIndex = i;
  }
  const rms = Math.sqrt(positionErrors.reduce((sum, e) => sum + e * e, 0) / Math.max(1, n));
  const countMatch = actual.length === expected.length;
  return {
    countMatch,
    actualCount: actual.length,
    expectedCount: expected.length,
    comparedCount: n,
    maxPositionError,
    rmsPositionError: rms,
    maxRadiusError,
    firstBadIndex,
    positionTolerance,
    radiusTolerance,
    ok: countMatch && firstBadIndex < 0,
  };
}

export function compareCanvasPixels(actual, expected) {
  if (actual.width !== expected.width || actual.height !== expected.height) throw new Error('像素对照尺寸不一致');
  let maxAlphaError = 0;
  let sumAlphaSquared = 0;
  let maxColorError = 0;
  let badPixels = 0;
  const alphaErrors = [];
  for (let i = 0; i < actual.data.length; i += 4) {
    const alphaError = Math.abs(actual.data[i + 3] - expected.data[i + 3]);
    maxAlphaError = Math.max(maxAlphaError, alphaError);
    sumAlphaSquared += alphaError * alphaError;
    if (alphaError > 0.02) badPixels++;
    alphaErrors.push(alphaError);
    for (let c = 0; c < 3; c++) maxColorError = Math.max(maxColorError, Math.abs(actual.data[i + c] - expected.data[i + c]));
  }
  const pixelCount = actual.data.length / 4;
  return {
    maxAlphaError,
    rmseAlpha: Math.sqrt(sumAlphaSquared / pixelCount),
    maxColorError,
    badPixels,
    pixelCount,
  };
}

function pixelIndex(canvas, x, y) {
  const px = Math.floor(x), py = Math.floor(y);
  if (px < 0 || py < 0 || px >= canvas.width || py >= canvas.height) return -1;
  return (py * canvas.width + px) * 4 + 3;
}

// 双线性读取 alpha。画布像素 (px,py) 的中心是 (px+0.5,py+0.5)。
export function sampleAlpha(canvas, x, y) {
  const gx = x - 0.5, gy = y - 0.5;
  const x0 = Math.floor(gx), y0 = Math.floor(gy);
  const fx = gx - x0, fy = gy - y0;
  let sum = 0, weight = 0;
  for (const [ox, oy, w] of [[0, 0, (1 - fx) * (1 - fy)], [1, 0, fx * (1 - fy)], [0, 1, (1 - fx) * fy], [1, 1, fx * fy]]) {
    const i = pixelIndex(canvas, x0 + ox, y0 + oy);
    if (i >= 0) {
      sum += canvas.data[i] * w;
      weight += w;
    }
  }
  return weight > 0 ? sum / weight : 0;
}

export function measurePathOnCanvas(canvas, path, {
  step = 1,
  crossStep = 0.5,
  crossRadius = 28,
  coverThreshold = 0.16,
  widthThreshold = 0.24,
} = {}) {
  const samples = [];
  for (let s = 0; s <= path.length + 1e-9; s += step) {
    const point = path.at(Math.min(s, path.length));
    const offsets = [];
    let maxAlpha = 0;
    for (let d = -crossRadius; d <= crossRadius + 1e-9; d += crossStep) {
      const x = point.x + point.nx * d;
      const y = point.y + point.ny * d;
      const alpha = sampleAlpha(canvas, x, y);
      offsets.push({ d, alpha });
      maxAlpha = Math.max(maxAlpha, alpha);
    }

    let width = 0;
    let left = 0;
    let right = 0;
    const centerAlpha = sampleAlpha(canvas, point.x, point.y);
    if (centerAlpha >= widthThreshold) {
      let li = offsets.findIndex(o => o.d >= -1e-9);
      while (li > 0 && offsets[li - 1].alpha >= widthThreshold) li--;
      let ri = offsets.findIndex(o => o.d >= -1e-9);
      while (ri < offsets.length - 1 && offsets[ri + 1].alpha >= widthThreshold) ri++;
      left = offsets[li]?.d ?? 0;
      right = offsets[ri]?.d ?? 0;
      width = Math.max(0, right - left);
    }

    samples.push({
      s: point.s,
      x: point.x,
      y: point.y,
      centerAlpha,
      maxAlpha,
      covered: maxAlpha >= coverThreshold,
      width,
      left,
      right,
    });
  }

  const gaps = [];
  let start = null;
  for (const sample of samples) {
    if (!sample.covered) {
      if (start === null) start = sample;
    } else if (start !== null) {
      gaps.push({ startS: start.s, endS: sample.s, length: sample.s - start.s, start, end: sample });
      start = null;
    }
  }
  if (start !== null) {
    const end = samples[samples.length - 1];
    gaps.push({ startS: start.s, endS: end.s, length: end.s - start.s, start, end });
  }

  return {
    samples,
    gaps,
    coverage: samples.filter(s => s.covered).length / samples.length,
    firstGap(minLength = 2) {
      return gaps.find(g => g.length >= minLength) ?? null;
    },
    firstOversize(limit, tolerance = 0, minRunLength = 2) {
      let runStart = null;
      for (const sample of samples) {
        const expected = typeof limit === 'function' ? limit(sample.s, sample) : limit;
        if (sample.width > expected + tolerance) {
          if (runStart === null) runStart = sample;
        } else if (runStart !== null) {
          if (sample.s - runStart.s >= minRunLength) {
            return { ...runStart, runLength: sample.s - runStart.s, limit: typeof limit === 'function' ? limit(runStart.s, runStart) : limit };
          }
          runStart = null;
        }
      }
      if (runStart !== null) {
        const last = samples[samples.length - 1];
        if (last.s - runStart.s >= minRunLength) return { ...runStart, runLength: last.s - runStart.s };
      }
      return null;
    },
  };
}
