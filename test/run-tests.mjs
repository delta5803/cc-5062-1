// 压感笔刷内核测试: node test/run-tests.mjs
import { BrushEngine, createCanvas, stampDab, DEFAULT_PARAMS } from '../brush/engine.mjs';
import { findPressurePeaks, analyzeLatency, canvasStats, diffCanvases, cloneCanvas } from '../brush/analysis.mjs';
import { sampleTrajectory, chunk, DEMO_PEAKS, DEMO_DURATION } from '../brush/trajectory.mjs';

const W = 960, H = 640;
let passed = 0, failed = 0;

function check(name, cond, detail = '') {
  if (cond) { passed++; console.log(`  PASS ${name}`); }
  else { failed++; console.log(`  FAIL ${name} ${detail}`); }
}

function runEngine(events, params = {}, { batchSize = 0 } = {}) {
  const canvas = createCanvas(W, H);
  const engine = new BrushEngine(canvas, params);
  if (batchSize > 0) for (const b of chunk(events, batchSize)) engine.pushEvents(b);
  else engine.pushEvents(events);
  engine.endStroke();
  return { engine, canvas };
}

function alphaAt(canvas, x, y) {
  return canvas.data[(Math.round(y) * W + Math.round(x)) * 4 + 3];
}

// 对照组: 每个事件盖一印的朴素实现(浓淡由回报频率决定)
function runNaive(events, flow = 0.1) {
  const canvas = createCanvas(W, H);
  for (const e of events) {
    const d = DEFAULT_PARAMS.minSize + (DEFAULT_PARAMS.maxSize - DEFAULT_PARAMS.minSize) * e.p;
    stampDab(canvas, { x: e.x, y: e.y, rx: d / 2, ry: d / 2, angle: 0, alpha: flow }, DEFAULT_PARAMS.color, DEFAULT_PARAMS.hardness);
  }
  return canvas;
}

console.log('\n[1] 批次不变性: 同一事件流任意分批, 像素逐位一致');
{
  const events = sampleTrajectory(120);
  const a = runEngine(events);                       // 一次性
  const b = runEngine(events, {}, { batchSize: 7 }); // 每批7个
  const c = createCanvas(W, H);
  const e3 = new BrushEngine(c, {});
  for (const e of events) e3.pushEvent(e);           // 逐个
  e3.endStroke();
  const d1 = diffCanvases(a.canvas, b.canvas);
  const d2 = diffCanvases(a.canvas, c);
  check('分批=一次性 逐位一致', d1.maxAbs === 0 && a.engine.dabs.length === b.engine.dabs.length, `maxAbs=${d1.maxAbs}`);
  check('逐个=一次性 逐位一致', d2.maxAbs === 0, `maxAbs=${d2.maxAbs}`);
}

console.log('\n[2] 频率鲁棒性: 同一连续轨迹按 30/60/120/240Hz 采样');
{
  const ref = runEngine(sampleTrajectory(240));
  const refInk = canvasStats(ref.canvas).ink;
  const refDabs = ref.engine.dabs.length;
  for (const rate of [30, 60, 120]) {
    const r = runEngine(sampleTrajectory(rate));
    const ink = canvasStats(r.canvas).ink;
    const dabs = r.engine.dabs.length;
    const diff = diffCanvases(r.canvas, ref.canvas);
    const inkRatio = ink / refInk, dabRatio = dabs / refDabs;
    console.log(`  ${rate}Hz: ink=${inkRatio.toFixed(3)}x dabs=${dabRatio.toFixed(3)}x maxAbs=${diff.maxAbs.toFixed(3)} edgeMax=${diff.edgeMax.toFixed(3)}`);
    check(`${rate}Hz 总墨量偏差<10%`, Math.abs(inkRatio - 1) < 0.1, `inkRatio=${inkRatio.toFixed(3)}`);
    check(`${rate}Hz dab数偏差<15%`, Math.abs(dabRatio - 1) < 0.15, `dabRatio=${dabRatio.toFixed(3)}`);
  }
  const n30 = canvasStats(runNaive(sampleTrajectory(30))).ink;
  const n240 = canvasStats(runNaive(sampleTrajectory(240))).ink;
  console.log(`  对照(每事件一印): 240Hz/30Hz 墨量比=${(n240 / n30).toFixed(2)}`);
  check('朴素实现墨量随频率失控(>2x), 内核稳定', n240 / n30 > 2);
}

console.log('\n[3] 断笔: 大缺口冻结已绘区, 小缺口正常补插');
{
  const mk = (gapX, gapT) => {
    const evs = [];
    for (let i = 0; i <= 100; i++) evs.push({ x: 100 + i, y: 400, t: i * 4, p: 0.6, tx: 0, ty: 0 });
    evs.push({ x: gapX, y: 400, t: gapT, p: 0.6, tx: 0, ty: 0 });
    for (let i = 1; i <= 100; i++) evs.push({ x: gapX + i, y: 400, t: gapT + i * 4, p: 0.6, tx: 0, ty: 0 });
    return evs;
  };
  // 大缺口: dt=500ms, 跳300px -> 冻结, 不在缺口上补插
  const g = runEngine(mk(500, 900));
  check('判定一次断笔, 拆成两笔', g.engine.stats.gaps === 1 && g.engine.stats.strokes === 2,
    `gaps=${g.engine.stats.gaps} strokes=${g.engine.stats.strokes}`);
  const inCorridor = g.engine.dabs.filter(d => d.x > 215 && d.x < 485).length;
  check('缺口走廊内无 dab(未补插)', inCorridor === 0, `corridor dabs=${inCorridor}`);
  // 冻结: 断点前已绘区域在后续事件到达后逐位不变
  const prefix = runEngine(mk(500, 900).slice(0, 101));
  const frozen = cloneCanvas(prefix.canvas);
  const full = runEngine(mk(500, 900));
  let frozenDiff = 0;
  for (let y = 0; y < H; y++) for (let x = 0; x < 250; x++) {
    const i = (y * W + x) * 4 + 3;
    frozenDiff = Math.max(frozenDiff, Math.abs(full.canvas.data[i] - frozen.data[i]));
  }
  check('已绘区冻结(断笔后像素不变)', frozenDiff === 0, `frozenDiff=${frozenDiff}`);
  // 小缺口: dt=40ms, 跳60px -> 正常插值补全
  const s = runEngine(mk(260, 440));
  const backfilled = s.engine.dabs.filter(d => d.x > 200 && d.x < 260).length;
  check('小缺口判定为连续(无断笔)', s.engine.stats.gaps === 0, `gaps=${s.engine.stats.gaps}`);
  check('小缺口沿路径补插', backfilled > 0, `backfilled=${backfilled}`);
}

console.log('\n[4] 压力峰可从采样轨迹复算');
{
  const events = sampleTrajectory(120);
  const peaks = findPressurePeaks(events, { minProminence: 0.3 });
  check('检出两个峰', peaks.length === 2, `peaks=${peaks.map(p => p.t.toFixed(0))}`);
  for (let i = 0; i < DEMO_PEAKS.length; i++) {
    const dt = peaks[i] ? Math.abs(peaks[i].t - DEMO_PEAKS[i]) : Infinity;
    check(`峰${i + 1} 时刻误差<=10ms (期望${DEMO_PEAKS[i]}ms)`, dt <= 10, `got ${peaks[i]?.t}`);
  }
}

console.log('\n[5] 落笔延迟可从采样轨迹复算, 且不随笔划变长而漂移');
{
  const { engine } = runEngine(sampleTrajectory(120));
  const lat = analyzeLatency(engine.dabs);
  const interval = 1000 / 120;
  const half = Math.floor(lat.perDab.length / 2);
  const m1 = lat.perDab.slice(0, half).reduce((a, b) => a + b, 0) / half;
  const m2 = lat.perDab.slice(half).reduce((a, b) => a + b, 0) / (lat.perDab.length - half);
  console.log(`  dabs=${lat.count} mean=${lat.mean.toFixed(2)}ms max=${lat.max.toFixed(2)}ms 前半=${m1.toFixed(2)}ms 后半=${m2.toFixed(2)}ms`);
  check('最大延迟 <= 一个采样间隔', lat.max <= interval + 1e-6, `max=${lat.max}`);
  check('平均延迟 <= 一个采样间隔', lat.mean <= interval + 1e-6, `mean=${lat.mean}`);
  check('延迟无漂移', Math.abs(m2 - m1) < 1, `drift=${Math.abs(m2 - m1)}`);
}

console.log('\n[6] 静止不堆墨: 原地按住1秒(240个事件)不多盖一印');
{
  const evs = [];
  for (let i = 0; i <= 120; i++) evs.push({ x: 100 + i * 2, y: 500, t: i * (1000 / 240), p: 1, tx: 0, ty: 0 });
  const t0 = 120 * (1000 / 240);
  for (let i = 1; i <= 240; i++) evs.push({ x: 340, y: 500, t: t0 + i * (1000 / 240), p: 1, tx: 0, ty: 0 });
  const { engine, canvas } = runEngine(evs);
  const dabsAtHold = engine.dabs.filter(d => Math.hypot(d.x - 340, d.y - 500) < 1).length;
  const holdAlpha = alphaAt(canvas, 340, 500);
  const midAlpha = alphaAt(canvas, 200, 500);
  console.log(`  停顿处dab=${dabsAtHold} alpha=${holdAlpha.toFixed(3)} 直线中段alpha=${midAlpha.toFixed(3)}`);
  check('停顿处只有途经的一印', dabsAtHold <= 1, `dabs=${dabsAtHold}`);
  check('停顿处不比行笔中段更浓', holdAlpha <= midAlpha + 0.02, `${holdAlpha} vs ${midAlpha}`);
}

console.log('\n[7] 笔划起止: 起点即盖印, 收尾无洞也不堆墨');
{
  const events = sampleTrajectory(120);
  const { engine, canvas } = runEngine(events);
  const dabs = engine.dabs;
  const first = dabs[0], last = dabs[dabs.length - 1];
  const startE = events[0], endE = events[events.length - 1];
  check('首印落在起点', Math.hypot(first.x - startE.x, first.y - startE.y) < 1e-6);
  check('起点像素有墨', alphaAt(canvas, startE.x, startE.y) > 0.2, `a=${alphaAt(canvas, startE.x, startE.y)}`);
  const endSpacing = engine.spacing(endE.p);
  check('末印距终点不超过当前间距', Math.hypot(last.x - endE.x, last.y - endE.y) <= endSpacing + 1e-6,
    `dist=${Math.hypot(last.x - endE.x, last.y - endE.y).toFixed(2)} spacing=${endSpacing.toFixed(2)}`);
  check('终点像素有墨(无尾洞)', alphaAt(canvas, endE.x, endE.y) > 0.1, `a=${alphaAt(canvas, endE.x, endE.y)}`);
}

console.log('\n[8] 急转弯: 转角无洞, 且无异常浓色结块');
{
  // 锯齿: 三段折线, 两个60度急转
  const pts = [[100, 100], [300, 100], [150, 250], [350, 250]];
  const evs = [];
  let t = 0;
  for (let s = 0; s < pts.length - 1; s++) {
    const [x0, y0] = pts[s], [x1, y1] = pts[s + 1];
    const len = Math.hypot(x1 - x0, y1 - y0);
    for (let d = s === 0 ? 0 : 2; d <= len; d += 2) {
      evs.push({ x: x0 + (x1 - x0) * (d / len), y: y0 + (y1 - y0) * (d / len), t: t += 4, p: 0.5, tx: 0, ty: 0 });
    }
  }
  const { canvas } = runEngine(evs, { rotationMode: 'direction' });
  const v1 = alphaAt(canvas, 300, 100), v2 = alphaAt(canvas, 150, 250);
  check('转角1有墨', v1 > 0.15, `a=${v1.toFixed(3)}`);
  check('转角2有墨', v2 > 0.15, `a=${v2.toFixed(3)}`);
  let turnMax = 0;
  for (let y = 92; y <= 108; y++) for (let x = 292; x <= 308; x++) turnMax = Math.max(turnMax, alphaAt(canvas, x, y));
  let straightMax = 0;
  for (let y = 96; y <= 104; y++) for (let x = 150; x <= 250; x++) straightMax = Math.max(straightMax, alphaAt(canvas, x, y));
  console.log(`  转角峰值=${turnMax.toFixed(3)} 直线峰值=${straightMax.toFixed(3)} 比=${(turnMax / straightMax).toFixed(2)}`);
  check('转角浓度不超过直线段1.35倍', turnMax <= straightMax * 1.35, `${turnMax} vs ${straightMax}`);
}

console.log(`\n结果: ${passed} 通过, ${failed} 失败`);
process.exit(failed ? 1 : 0);
