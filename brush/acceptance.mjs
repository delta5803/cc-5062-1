// 浏览器界面和命令行共用的样例运行与验收结论。

import { BrushEngine, createCanvas, DEFAULT_PARAMS, stampDab } from './engine.mjs';
import { sampleTrajectory } from './trajectory.mjs';
import { reduceEventPackets } from './reducer.mjs';
import {
  makeArcPath,
  expectedArcDabs,
  rasterizeReferenceDabs,
  compareDabSequence,
  compareCanvasPixels,
  measurePathOnCanvas,
  diameterAtPressure,
} from './reference.mjs';
import {
  VIEW_W,
  VIEW_H,
  HOLD_PARAMS,
  PRESSURE_JUMP_PARAMS,
  pressureJumpExpectedP,
  buildHoldEvents,
  buildPressureJumpEvents,
  buildHandwrittenEvents,
  HANDWRITTEN_POINTS,
  buildDemoTruthPoints,
  buildDefectStroke,
} from './cases.mjs';

function line(label, value) {
  return `${label}: ${value}`;
}

export function runRegressionCase(id, { width = VIEW_W, height = VIEW_H } = {}) {
  let events;
  let params = {};
  let defect = null;

  if (id === 'demo') {
    events = sampleTrajectory(120);
  } else if (id === 'hold') {
    events = buildHoldEvents();
    params = HOLD_PARAMS;
  } else if (id === 'pressure-jump') {
    events = buildPressureJumpEvents();
    params = PRESSURE_JUMP_PARAMS;
  } else if (id === 'handwritten-good') {
    events = buildHandwrittenEvents();
    params = { minSize: 12, maxSize: 12, spacingRatio: 0.5, minSpacing: 6, flow: 0.5, hardness: 0.65 };
  } else if (id === 'handwritten-defects') {
    defect = buildDefectStroke();
    events = defect.events;
    params = { minSize: 12, maxSize: 12, spacingRatio: 0.5, minSpacing: 6, flow: 0.5, hardness: 0.65 };
  } else {
    throw new Error(`未知回归样例: ${id}`);
  }

  const canvas = createCanvas(width, height);
  const engine = new BrushEngine(canvas, { ...DEFAULT_PARAMS, ...params });
  const reduction = reduceEventPackets([events]);
  engine.pushEvents(events);
  engine.endStroke();
  if (defect) {
    stampDab(canvas, defect.oversize, DEFAULT_PARAMS.color, engine.params.hardness);
    engine.dabs.push({ ...defect.oversize, t: 0, tCommit: 0 });
  }
  return { id, canvas, engine, events, params, defect, reduction };
}

export function evaluateLoadedCase(caseId, { engine, canvas, reduction = null } = {}) {
  if (caseId === 'hold') {
    const path = makeArcPath([{ x: 120, y: 320 }, { x: 520, y: 320 }]);
    const expected = expectedArcDabs(path, { params: HOLD_PARAMS, pressure: 0.8, alpha: HOLD_PARAMS.flow });
    const positions = compareDabSequence(engine.dabs, expected, { positionTolerance: 1e-6, radiusTolerance: 1e-9 });
    const reference = rasterizeReferenceDabs(expected, canvas.width, canvas.height, DEFAULT_PARAMS.color, HOLD_PARAMS.hardness);
    const pixels = compareCanvasPixels(canvas, reference);
    const coverage = measurePathOnCanvas(canvas, path, { crossRadius: 18 });
    const duplicateCount = reduction?.duplicateCount ?? engine.stats.duplicates;
    const ok = positions.ok && pixels.maxAlphaError === 0 && coverage.coverage === 1 && duplicateCount >= 1;
    return {
      ok,
      tone: ok ? 'ok' : 'error',
      title: '停笔/重复事件验收',
      lines: [
        line('盖印数', `${engine.dabs.length}/${expected.length}`),
        line('最大位置误差', positions.maxPositionError.toExponential(2)),
        line('最大像素 alpha 误差', pixels.maxAlphaError.toExponential(2)),
        line('路径覆盖', `${(coverage.coverage * 100).toFixed(1)}%`),
        line('重复事件识别', `${duplicateCount} 个`),
      ],
    };
  }

  if (caseId === 'pressure-jump') {
    const path = makeArcPath([{ x: 120, y: 400 }, { x: 720, y: 400 }]);
    const expected = expectedArcDabs(path, {
      spacing: 10,
      pressure: s => pressureJumpExpectedP(120 + s),
      params: PRESSURE_JUMP_PARAMS,
      alpha: PRESSURE_JUMP_PARAMS.flow,
    });
    const positions = compareDabSequence(engine.dabs, expected, { positionTolerance: 1e-6, radiusTolerance: 1e-9 });
    const reference = rasterizeReferenceDabs(expected, canvas.width, canvas.height, DEFAULT_PARAMS.color, PRESSURE_JUMP_PARAMS.hardness);
    const pixels = compareCanvasPixels(canvas, reference);
    const measured = measurePathOnCanvas(canvas, path, { crossRadius: 18 });
    const beforeWidth = measured.samples[200]?.width ?? 0;
    const afterWidth = measured.samples[240]?.width ?? 0;
    const ok = positions.ok && pixels.maxAlphaError === 0 && afterWidth >= beforeWidth + 8;
    return {
      ok,
      tone: ok ? 'ok' : 'error',
      title: '突变压力验收',
      lines: [
        line('最大半径误差', positions.maxRadiusError.toExponential(2)),
        line('最大位置误差', positions.maxPositionError.toExponential(2)),
        line('最大像素 alpha 误差', pixels.maxAlphaError.toExponential(2)),
        line('独立宽度', `${beforeWidth.toFixed(1)}px -> ${afterWidth.toFixed(1)}px`),
      ],
    };
  }

  if (caseId === 'handwritten-good' || caseId === 'handwritten-defects') {
    const path = makeArcPath(HANDWRITTEN_POINTS);
    const measured = measurePathOnCanvas(canvas, path, { crossRadius: 30 });
    if (caseId === 'handwritten-good') {
      const oversize = measured.firstOversize(18, 2, 3);
      const ok = measured.coverage === 1 && measured.gaps.length === 0 && !oversize;
      return {
        ok,
        tone: ok ? 'ok' : 'error',
        title: '手写曲线覆盖验收',
        lines: [
          line('独立路径覆盖', `${(measured.coverage * 100).toFixed(1)}%`),
          line('断线', `${measured.gaps.length} 处`),
          line('超宽', oversize ? `${oversize.width.toFixed(1)}px @${oversize.x.toFixed(0)},${oversize.y.toFixed(0)}` : '无'),
        ],
      };
    }

    const defect = buildDefectStroke();
    const gap = measured.firstGap(3);
    const oversize = measured.firstOversize(defect.widthLimit, defect.widthTolerance, 3);
    const gapOk = gap && gap.start.x > defect.expectedGapAfterX && gap.start.x <= defect.expectedGapAfterX + 10;
    const overOk = oversize && Math.hypot(oversize.x - defect.oversize.x, oversize.y - defect.oversize.y) <= 24;
    const ok = Boolean(gapOk && overOk);
    return {
      ok,
      tone: 'warning',
      title: '受控坏样例定位',
      lines: [
        line('独立路径覆盖', `${(measured.coverage * 100).toFixed(1)}%`),
        line('最早断线', gap ? `(${gap.start.x.toFixed(1)}, ${gap.start.y.toFixed(1)})，长 ${gap.length.toFixed(1)}px` : '未找到'),
        line('最早超宽', oversize ? `(${oversize.x.toFixed(1)}, ${oversize.y.toFixed(1)})，宽 ${oversize.width.toFixed(1)}px` : '未找到'),
        line('验收器状态', ok ? '已定位受控错误' : '漏报/伪报'),
      ],
    };
  }

  if (caseId === 'demo') {
    const truth = buildDemoTruthPoints(8);
    const path = makeArcPath(truth);
    const measured = measurePathOnCanvas(canvas, path, { step: 2, crossRadius: 24 });
    const oversize = measured.firstOversize((s) => {
      const point = path.at(s);
      return diameterAtPressure(engine.params, point.p ?? 0.5);
    }, 8, 4);
    const ok = measured.coverage >= 0.995 && !oversize;
    return {
      ok,
      tone: ok ? 'ok' : 'warning',
      title: '固定轨迹独立覆盖',
      lines: [
        line('独立路径覆盖', `${(measured.coverage * 100).toFixed(2)}%`),
        line('断线', `${measured.gaps.length} 处`),
        line('相对压力真值超宽', oversize ? `${oversize.width.toFixed(1)}px` : '无'),
        line('盖印数', engine.dabs.length),
      ],
    };
  }

  return { ok: true, tone: 'ok', title: '自由绘画', lines: ['无解析真值；可切换采样点/盖印/轨迹人工核对。'] };
}
