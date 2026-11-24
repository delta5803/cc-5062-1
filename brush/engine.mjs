// 压感绘画笔刷内核。
// 输入: {x, y, t(ms), p(0..1), tx, ty(倾斜分量)} 事件流。
// 处理: 事件 -> Catmull-Rom 位置插值(标量线性) -> 沿弧长积分 -> 按间距盖印。
// 输出: 浮点 RGBA 画布(直Alpha), 每个 dab 记录 {路径时刻 t, 提交时刻 tCommit} 供延迟复算。
// 保证: 同一事件流按任意批次到达结果逐位一致; 落墨量由弧长决定, 与事件回报频率无关。

export const DEFAULT_PARAMS = {
  minSize: 2,          // p=0 时笔尖直径(px)
  maxSize: 28,         // p=1 时笔尖直径(px)
  spacingRatio: 0.35,  // 间距 = spacingRatio * 当前直径
  minSpacing: 0.5,     // 间距下限(px), 防止压力归零时间距爆炸
  flow: 0.35,          // 单次盖印不透明度
  hardness: 0.65,      // 边缘硬度: 0..1, 内核实心比例
  eccentricity: 0.6,   // direction 模式下椭圆扁率
  rotationMode: 'tilt',// 'tilt' | 'direction' | 'fixed'
  fixedAngle: 0,       // fixed 模式角度(rad)
  gapTimeMs: 120,      // 超过则判定断笔: 冻结已绘区, 不补插
  gapDistPx: 64,       // 同上, 按跳变距离判定
  step: 0.5,           // 弧长积分步长(px)
  color: [0.08, 0.1, 0.35],
};

export function createCanvas(width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`画布尺寸非法: ${width}x${height}`);
  }
  return { width, height, data: new Float32Array(width * height * 4) };
}

export function validateParams(p) {
  const bad = [];
  if (!(p.minSize > 0)) bad.push('minSize 必须 > 0');
  if (!(p.maxSize >= p.minSize)) bad.push('maxSize 必须 >= minSize');
  if (!(p.spacingRatio > 0 && p.spacingRatio <= 1)) bad.push('spacingRatio 必须在 (0,1]');
  if (!(p.minSpacing > 0)) bad.push('minSpacing 必须 > 0');
  if (!(p.flow > 0 && p.flow <= 1)) bad.push('flow 必须在 (0,1]');
  if (!(p.hardness >= 0 && p.hardness < 1)) bad.push('hardness 必须在 [0,1)');
  if (!(p.eccentricity >= 0 && p.eccentricity < 1)) bad.push('eccentricity 必须在 [0,1)');
  if (!['tilt', 'direction', 'fixed'].includes(p.rotationMode)) bad.push('rotationMode 非法');
  if (!(p.gapTimeMs > 0)) bad.push('gapTimeMs 必须 > 0');
  if (!(p.gapDistPx > 0)) bad.push('gapDistPx 必须 > 0');
  if (!(p.step > 0 && p.step <= 2)) bad.push('step 必须在 (0,2]');
  if (!Array.isArray(p.color) || p.color.length !== 3 || p.color.some(c => !(c >= 0 && c <= 1))) {
    bad.push('color 必须为 [r,g,b] 且分量在 [0,1]');
  }
  if (bad.length) throw new Error('笔刷参数非法: ' + bad.join('; '));
}

export function normalizeEvent(e, lastT = -Infinity) {
  const x = Number(e.x), y = Number(e.y), t = Number(e.t);
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(t)) {
    throw new Error(`事件坐标/时间非法: ${JSON.stringify(e)}`);
  }
  const p = Number.isFinite(e.p) ? Math.min(1, Math.max(0, e.p)) : 0.5;
  const tx = Number.isFinite(e.tx) ? e.tx : 0;
  const ty = Number.isFinite(e.ty) ? e.ty : 0;
  return { x, y, t: Math.max(t, lastT), p, tx, ty }; // 时间单调, 防止负 dt 破坏断笔判定
}

const clamp01 = v => (v < 0 ? 0 : v > 1 ? 1 : v);

function catmullRom(p0, p1, p2, p3, u) {
  const u2 = u * u, u3 = u2 * u;
  return 0.5 * (2 * p1 + (-p0 + p2) * u + (2 * p0 - 5 * p1 + 4 * p2 - p3) * u2 + (-p0 + 3 * p1 - 3 * p2 + p3) * u3);
}

// 单次盖印: 椭圆足迹 + 硬度边缘轮廓, 直Alpha source-over 合成。
export function stampDab(canvas, dab, color, hardness) {
  const { width, height, data } = canvas;
  const cosA = Math.cos(dab.angle), sinA = Math.sin(dab.angle);
  const r = Math.max(dab.rx, dab.ry);
  const x0 = Math.max(0, Math.floor(dab.x - r - 1)), x1 = Math.min(width - 1, Math.ceil(dab.x + r + 1));
  const y0 = Math.max(0, Math.floor(dab.y - r - 1)), y1 = Math.min(height - 1, Math.ceil(dab.y + r + 1));
  const soft = 1 - hardness;
  for (let py = y0; py <= y1; py++) {
    for (let px = x0; px <= x1; px++) {
      const dx = px + 0.5 - dab.x, dy = py + 0.5 - dab.y;
      const ex = (dx * cosA + dy * sinA) / dab.rx;
      const ey = (-dx * sinA + dy * cosA) / dab.ry;
      const d = Math.hypot(ex, ey);
      if (d >= 1) continue;
      let w = 1;
      if (d > hardness) {
        const u = (d - hardness) / soft;
        w = 1 - u * u * (3 - 2 * u); // smoothstep 落墨轮廓
      }
      const srcA = dab.alpha * w;
      if (srcA <= 0) continue;
      const i = (py * width + px) * 4;
      const dstA = data[i + 3];
      const outA = srcA + dstA * (1 - srcA);
      if (outA <= 0) continue;
      const keep = dstA * (1 - srcA);
      data[i] = (color[0] * srcA + data[i] * keep) / outA;
      data[i + 1] = (color[1] * srcA + data[i + 1] * keep) / outA;
      data[i + 2] = (color[2] * srcA + data[i + 2] * keep) / outA;
      data[i + 3] = outA;
    }
  }
}

export class BrushEngine {
  constructor(canvas, params = {}) {
    this.canvas = canvas;
    this.params = { ...DEFAULT_PARAMS, ...params };
    validateParams(this.params);
    this.stroke = null;
    this.dabs = []; // 全部已提交 dab: {x,y,t,tCommit,rx,ry,angle,alpha}
    this.stats = { events: 0, strokes: 0, gaps: 0 };
    this._commitTime = 0;
  }

  diameter(p) { return this.params.minSize + (this.params.maxSize - this.params.minSize) * clamp01(p); }
  spacing(p) { return Math.max(this.params.minSpacing, this.params.spacingRatio * this.diameter(p)); }

  // 当前状态下的椭圆足迹(不改动状态)
  _ellipseFor(p, tx, ty) {
    const P = this.params;
    const st = this.stroke;
    const r = this.diameter(p) / 2;
    if (P.rotationMode === 'tilt') {
      // 倾斜模型: 圆笔尖向 tx,ty 方向倾倒, 足迹沿倾倒方向压缩为椭圆
      const mag = Math.hypot(tx, ty);
      const squeeze = Math.min(1, Math.max(0.3, Math.cos(Math.atan(Math.min(mag, 2)))));
      return { rx: r, ry: r * squeeze, angle: mag > 1e-3 ? Math.atan2(ty, tx) + Math.PI / 2 : st.lastAngle };
    }
    if (P.rotationMode === 'direction') {
      // 扁笔模型: 长轴垂直于行笔方向
      return { rx: r, ry: r * (1 - P.eccentricity), angle: st.lastDir + Math.PI / 2 };
    }
    return { rx: r, ry: r * (1 - P.eccentricity), angle: P.fixedAngle };
  }

  // 有效间距 = min(压力间距, spacingRatio * 沿程足迹直径):
  // 椭圆长轴不沿行笔方向时沿程足迹变薄, 收紧间距保证单位弧长覆盖均匀, 转角不相对堆积
  _spacingAt(p, tx, ty) {
    const base = this.spacing(p);
    const st = this.stroke;
    if (!st) return base;
    const { rx, ry, angle } = this._ellipseFor(p, tx, ty);
    const d = st.lastDir - angle;
    const rAlong = 1 / Math.sqrt((Math.cos(d) / rx) ** 2 + (Math.sin(d) / ry) ** 2);
    return Math.max(this.params.minSpacing, Math.min(base, this.params.spacingRatio * 2 * rAlong));
  }

  beginStroke(e) {
    if (this.stroke) this.endStroke();
    e = normalizeEvent(e);
    this.stats.strokes++;
    this.stats.events++;
    this._commitTime = e.t;
    this.stroke = {
      events: [e],
      lastPoint: { ...e },
      distSinceDab: 0,
      spacing: this.spacing(e.p),
      lastAngle: this.params.fixedAngle,
      lastDir: 0,
    };
    this.stroke.spacing = this._spacingAt(e.p, e.tx, e.ty);
    this._dab(e.x, e.y, e.p, e.tx, e.ty, e.t, 1); // 落笔即盖首印, 起点不留洞
  }

  pushEvent(raw) {
    if (!this.stroke) { this.beginStroke(raw); return; }
    const st = this.stroke;
    const e = normalizeEvent(raw, st.events[st.events.length - 1].t);
    this.stats.events++;
    const last = st.events[st.events.length - 1];
    const dt = e.t - last.t;
    const dist = Math.hypot(e.x - last.x, e.y - last.y);
    if (dt > this.params.gapTimeMs || dist > this.params.gapDistPx) {
      // 断笔: 冻结已绘区(不在缺口上补插), 新事件另起一笔
      this.stats.gaps++;
      this.endStroke();
      this.beginStroke(e);
      return;
    }
    st.events.push(e);
    this._commitTime = e.t; // 本段所有 dab 只有等 e 到达才能确定 -> 提交时刻 = e.t
    this._integrateSegment();
  }

  pushEvents(list) { for (const e of list) this.pushEvent(e); }

  endStroke(raw) {
    if (!this.stroke) return;
    if (raw) this.pushEvent(raw);
    const st = this.stroke;
    if (!st) return;
    // 收尾: 不足一个间距的残余段盖一枚按残余比例缩放的印, 既不丢笔尾也不堆墨
    const frac = st.distSinceDab / st.spacing;
    if (st.distSinceDab > 0.25 && frac > 0.05) {
      const lp = st.lastPoint;
      this._commitTime = lp.tCommit ?? this._commitTime;
      this._dab(lp.x, lp.y, lp.p, lp.tx, lp.ty, lp.t, Math.min(1, frac));
    }
    this.stroke = null;
  }

  _integrateSegment() {
    const evs = this.stroke.events;
    const n = evs.length;
    if (n < 2) return;
    const e0 = evs[n - 2], e1 = evs[n - 1];
    const em = n >= 3 ? evs[n - 3] : e0;
    const approx = Math.hypot(e1.x - e0.x, e1.y - e0.y);
    if (approx < 1e-9) { this.stroke.lastPoint = { ...e1 }; return; } // 原地不动: 弧长不前进, 不盖印
    const steps = Math.min(4096, Math.max(1, Math.ceil((approx * 1.6) / this.params.step)));
    for (let i = 1; i <= steps; i++) {
      const u = i / steps;
      this._advanceTo({
        x: catmullRom(em.x, e0.x, e1.x, e1.x, u),
        y: catmullRom(em.y, e0.y, e1.y, e1.y, u),
        t: e0.t + (e1.t - e0.t) * u, // 标量线性插值, 不虚构压力过冲
        p: e0.p + (e1.p - e0.p) * u,
        tx: e0.tx + (e1.tx - e0.tx) * u,
        ty: e0.ty + (e1.ty - e0.ty) * u,
      });
    }
  }

  _advanceTo(pt) {
    const st = this.stroke;
    let px = st.lastPoint.x, py = st.lastPoint.y;
    let dx = pt.x - px, dy = pt.y - py;
    let segLen = Math.hypot(dx, dy);
    if (segLen > 1e-9) st.lastDir = Math.atan2(dy, dx);
    let guard = 0;
    while (st.distSinceDab + segLen >= st.spacing && segLen > 1e-12 && guard++ < 10000) {
      const need = st.spacing - st.distSinceDab;
      const f = need / segLen;
      const nx = px + dx * f, ny = py + dy * f;
      const lp = st.lastPoint;
      const gp = lp.p + (pt.p - lp.p) * f;
      const gtx = lp.tx + (pt.tx - lp.tx) * f;
      const gty = lp.ty + (pt.ty - lp.ty) * f;
      const gt = lp.t + (pt.t - lp.t) * f;
      this._dab(nx, ny, gp, gtx, gty, gt, 1);
      st.distSinceDab = 0;
      st.spacing = this._spacingAt(gp, gtx, gty); // 间距随压力与足迹方向重算, 沿程距离继续累计
      px = nx; py = ny; dx = pt.x - px; dy = pt.y - py; segLen = Math.hypot(dx, dy);
      st.lastPoint = { x: nx, y: ny, t: gt, p: gp, tx: gtx, ty: gty, tCommit: this._commitTime };
    }
    st.distSinceDab += segLen;
    st.lastPoint = { ...pt, tCommit: this._commitTime };
  }

  _dab(x, y, p, tx, ty, t, alphaScale) {
    const st = this.stroke;
    const { rx, ry, angle } = this._ellipseFor(p, tx, ty);
    st.lastAngle = angle;
    const dab = {
      x, y, t, tCommit: this._commitTime,
      rx, ry, angle,
      alpha: this.params.flow * alphaScale,
    };
    stampDab(this.canvas, dab, this.params.color, this.params.hardness);
    this.dabs.push(dab);
  }
}
