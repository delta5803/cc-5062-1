import { inflateSync, crc32 } from 'node:zlib';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

import { BrushEngine, createCanvas, DEFAULT_PARAMS, stampDab } from '../brush/engine.mjs';
import { diffCanvases } from '../brush/analysis.mjs';
import { sampleTrajectory } from '../brush/trajectory.mjs';
import {
  reduceEventPackets,
  fixedPackets,
  variedPackets,
  coalesceTimePackets,
  shuffledPackets,
} from '../brush/reducer.mjs';
import {
  makeArcPath,
  expectedArcDabs,
  rasterizeReferenceDabs,
  compareDabSequence,
  compareCanvasPixels,
  measurePathOnCanvas,
} from '../brush/reference.mjs';
import { composePaperRgba, encodePngRgba } from '../brush/export.mjs';
import { evaluateLoadedCase, runRegressionCase } from '../brush/acceptance.mjs';
import {
  HOLD_PARAMS,
  PRESSURE_JUMP_PARAMS,
  buildHoldEvents,
  buildPressureJumpEvents,
  pressureJumpExpectedP,
  HANDWRITTEN_POINTS,
  buildHandwrittenEvents,
  buildDefectStroke,
} from '../brush/cases.mjs';

const W = 960;
const H = 640;
const __dirname = dirname(fileURLToPath(import.meta.url));
const root = join(__dirname, '..');

function runEngine(events, params = {}) {
  const canvas = createCanvas(W, H);
  const engine = new BrushEngine(canvas, params);
  engine.pushEvents(events);
  engine.endStroke();
  return { engine, canvas };
}

class ShiftedDabEngine extends BrushEngine {
  _dab(x, y, p, tx, ty, t, alphaScale) {
    super._dab(x + 6, y, p, tx, ty, t, alphaScale);
  }
}

class FullPressureFaultEngine extends BrushEngine {
  _dab(x, y, _p, tx, ty, t, alphaScale) {
    super._dab(x, y, 1, tx, ty, t, alphaScale);
  }
}

function decodePng(png) {
  if (png[0] !== 0x89 || png[1] !== 0x50 || png[2] !== 0x4e || png[3] !== 0x47) {
    throw new Error('PNG 签名错误');
  }
  const view = new DataView(png.buffer, png.byteOffset, png.byteLength);
  let offset = 8;
  let width = 0, height = 0;
  const idat = [];
  while (offset < png.length) {
    const length = view.getUint32(offset);
    const type = new TextDecoder().decode(png.subarray(offset + 4, offset + 8));
    const data = png.subarray(offset + 8, offset + 8 + length);
    if (type === 'IHDR') {
      width = new DataView(data.buffer, data.byteOffset, data.byteLength).getUint32(0);
      height = new DataView(data.buffer, data.byteOffset + 4, data.byteLength - 4).getUint32(0);
    }
    if (type === 'IDAT') idat.push(data);
    const storedCrc = view.getUint32(offset + 8 + length);
    const actualCrc = crc32(png.subarray(offset + 4, offset + 8 + length)) >>> 0;
    if (storedCrc !== actualCrc) throw new Error(`PNG ${type} CRC 错误`);
    offset += 12 + length;
  }
  if (!width || !height || !idat.length) throw new Error('PNG 缺少 IHDR/IDAT');
  const compressed = Buffer.concat(idat.map(b => Buffer.from(b)));
  const raw = inflateSync(compressed);
  const stride = width * 4 + 1;
  const rgba = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    if (raw[y * stride] !== 0) throw new Error('测试解码器只接受 filter=0');
    rgba.set(raw.subarray(y * stride + 1, (y + 1) * stride), y * width * 4);
  }
  return { width, height, rgba };
}

export function runAcceptance(check) {
  console.log('\n[9] 合包/乱序缩减: 等价重分块逐位一致, 重复事件可识别');
  {
    const events = sampleTrajectory(120);
    const base = runEngine(events);
    const packetSets = [
      ['逐个', fixedPackets(events, 1)],
      ['7个定长', fixedPackets(events, 7)],
      ['不规则', variedPackets(events, 20261125)],
      ['16ms合包', coalesceTimePackets(events, 16)],
    ];
    for (const [label, packets] of packetSets) {
      const reduced = reduceEventPackets(packets);
      const run = runEngine(reduced.events);
      const diff = diffCanvases(base.canvas, run.canvas);
      check(`${label}重分块=原始事件流`, diff.maxAbs === 0 && reduced.duplicateCount === 0,
        `maxAbs=${diff.maxAbs} duplicates=${reduced.duplicateCount}`);
    }

    const packets = variedPackets(events, 31);
    const shuffled = shuffledPackets(packets, 77);
    const reduced = reduceEventPackets(shuffled);
    check('乱序包被检出并复原', reduced.outOfOrderCount > 0, `outOfOrder=${reduced.outOfOrderCount}`);
    check('乱序归约后事件数不变', reduced.events.length === events.length,
      `${reduced.events.length} vs ${events.length}`);
    const reordered = runEngine(reduced.events);
    const diff = diffCanvases(base.canvas, reordered.canvas);
    check('乱序包归约后笔迹逐位一致', diff.maxAbs === 0, `maxAbs=${diff.maxAbs}`);

    const hold = buildHoldEvents();
    const duplicatedPackets = [hold.slice(0, 5), [hold[10], hold[10]], hold.slice(11)];
    const duplicateReduction = reduceEventPackets(duplicatedPackets);
    check('缩减器识别故意重复事件', duplicateReduction.duplicateCount >= 1,
      `duplicates=${duplicateReduction.duplicateCount}`);
    const direct = runEngine(hold, HOLD_PARAMS);
    check('引擎统计重复输入', direct.engine.stats.duplicates >= 1,
      `stats=${JSON.stringify(direct.engine.stats)}`);
  }

  console.log('\n[10] 解析轨迹反采样的适用范围: 重分块严格等价, 变频只在容差内等价');
  {
    const events240 = sampleTrajectory(240);
    const rechunked = reduceEventPackets(variedPackets(events240, 99)).events;
    const a = runEngine(events240);
    const b = runEngine(rechunked);
    check('原始240Hz事件等价重分块严格逐位一致', diffCanvases(a.canvas, b.canvas).maxAbs === 0);

    const coarse = runEngine(sampleTrajectory(30));
    const fine = runEngine(events240);
    const diff = diffCanvases(coarse.canvas, fine.canvas);
    check('30Hz解析反采样不是逐位真值, 但误差受控', diff.maxAbs > 0 && diff.maxAbs < 0.35,
      `maxAbs=${diff.maxAbs.toFixed(4)}`);
    check('30Hz总墨量仍在10%容差内',
      Math.abs(coarse.engine.dabs.length / fine.engine.dabs.length - 1) < 0.15);

    const jump = buildPressureJumpEvents();
    const sparse = [jump[0], jump[Math.floor(jump.length / 2)], jump[jump.length - 1]];
    const sparseRun = runEngine(sparse, PRESSURE_JUMP_PARAMS);
    const expectedSparse = expectedArcDabs(makeArcPath([{ x: 120, y: 400 }, { x: 720, y: 400 }]), {
      spacing: 300,
      pressure: s => pressureJumpExpectedP(120 + s),
      params: PRESSURE_JUMP_PARAMS,
      alpha: PRESSURE_JUMP_PARAMS.flow,
    });
    const sparseReport = compareDabSequence(sparseRun.engine.dabs, expectedSparse, { radiusTolerance: 1e-9 });
    check('超稀疏三点的事件中心仍可独立核对', sparseReport.ok,
      `counts=${sparseReport.actualCount}/${sparseReport.expectedCount}`);
    check('超稀疏三点越过断笔阈值，不能冒充连续反采样真值',
      sparseRun.engine.dabs.length === 3 && sparseRun.engine.stats.gaps === 2 && sparseRun.engine.stats.strokes === 3,
      `dabs=${sparseRun.engine.dabs.length} gaps=${sparseRun.engine.stats.gaps}`);

    const longParams = { ...HOLD_PARAMS, minSpacing: 5, gapDistPx: 1000, gapTimeMs: 500 };
    const longRun = runEngine([
      { x: 120, y: 320, t: 0, p: 0.8 },
      { x: 520, y: 320, t: 100, p: 0.8 },
    ], longParams);
    const longPath = makeArcPath([{ x: 120, y: 320 }, { x: 520, y: 320 }]);
    const longExpected = expectedArcDabs(longPath, { params: longParams, pressure: 0.8, alpha: longParams.flow });
    const longReport = compareDabSequence(longRun.engine.dabs, longExpected, { positionTolerance: 1e-8, radiusTolerance: 1e-9 });
    const longReference = rasterizeReferenceDabs(longExpected, W, H, DEFAULT_PARAMS.color, longParams.hardness);
    const longPixels = compareCanvasPixels(longRun.canvas, longReference);
    check('单个长事件段也按独立弧长补印', longReport.ok && longRun.engine.stats.gaps === 0,
      `dabs=${longRun.engine.dabs.length}/${longExpected.length} maxPos=${longReport.maxPositionError}`);
    check('长段弧长补印像素与独立参照零误差', longPixels.maxAlphaError === 0,
      `maxAlpha=${longPixels.maxAlphaError}`);
  }

  console.log('\n[11] 停笔正例: 盖印位置和像素误差均来自独立弧长/光栅参照');
  let holdEvidence;
  {
    const events = buildHoldEvents();
    const { engine, canvas } = runEngine(events, HOLD_PARAMS);
    const path = makeArcPath([{ x: 120, y: 320 }, { x: 520, y: 320 }]);
    const expected = expectedArcDabs(path, { params: HOLD_PARAMS, pressure: 0.8, alpha: HOLD_PARAMS.flow });
    const positions = compareDabSequence(engine.dabs, expected, { positionTolerance: 1e-6, radiusTolerance: 1e-9 });
    const reference = rasterizeReferenceDabs(expected, W, H, DEFAULT_PARAMS.color, HOLD_PARAMS.hardness);
    const pixels = compareCanvasPixels(canvas, reference);
    const measurement = measurePathOnCanvas(canvas, path, { crossRadius: 18 });
    const holdDabs = engine.dabs.filter(d => Math.hypot(d.x - 320, d.y - 320) < 1);
    holdEvidence = { positions, pixels, coverage: measurement.coverage };

    console.log(`  hold: dabs=${engine.dabs.length}/${expected.length} maxPos=${positions.maxPositionError.toExponential(2)} maxAlphaErr=${pixels.maxAlphaError} coverage=${measurement.coverage.toFixed(4)}`);
    check('停笔正例盖印序列与独立弧长期望一致', positions.ok,
      `badIndex=${positions.firstBadIndex} maxPos=${positions.maxPositionError}`);
    check('停笔处只有一枚盖印', holdDabs.length === 1, `holdDabs=${holdDabs.length}`);
    check('停笔正例像素与独立参照零误差', pixels.maxAlphaError === 0 && pixels.badPixels === 0,
      `maxAlpha=${pixels.maxAlphaError} bad=${pixels.badPixels}`);
    check('停笔笔迹独立路径覆盖为100%', measurement.coverage === 1 && measurement.gaps.length === 0,
      `coverage=${measurement.coverage}`);
  }

  console.log('\n[12] 突变压力正反例: 半径/宽度/像素误差暴露压力错误');
  let pressureEvidence;
  {
    const events = buildPressureJumpEvents();
    const { engine, canvas } = runEngine(events, PRESSURE_JUMP_PARAMS);
    const path = makeArcPath([{ x: 120, y: 400 }, { x: 720, y: 400 }]);
    const expected = expectedArcDabs(path, {
      spacing: 10,
      pressure: s => pressureJumpExpectedP(120 + s),
      params: PRESSURE_JUMP_PARAMS,
      alpha: PRESSURE_JUMP_PARAMS.flow,
    });
    const positions = compareDabSequence(engine.dabs, expected, { positionTolerance: 1e-6, radiusTolerance: 1e-9 });
    const reference = rasterizeReferenceDabs(expected, W, H, DEFAULT_PARAMS.color, PRESSURE_JUMP_PARAMS.hardness);
    const pixels = compareCanvasPixels(canvas, reference);
    const measurement = measurePathOnCanvas(canvas, path, { crossRadius: 18 });
    const beforeWidth = measurement.samples[200].width; // x=320
    const afterWidth = measurement.samples[240].width;  // x=360
    pressureEvidence = { positions, pixels, beforeWidth, afterWidth };

    console.log(`  pressure: maxRadiusErr=${positions.maxRadiusError} maxAlphaErr=${pixels.maxAlphaError} width ${beforeWidth} -> ${afterWidth}`);
    check('突变压力盖印位置/半径与独立推导一致', positions.ok,
      `badIndex=${positions.firstBadIndex} radiusErr=${positions.maxRadiusError}`);
    check('压力突变后笔尖半径由4增至11',
      Math.abs(engine.dabs.find(d => d.x === 320).rx - 4) < 1e-9 &&
      Math.abs(engine.dabs.find(d => d.x === 330).rx - 11) < 1e-9);
    check('压力突变在独立宽度测量中可见', afterWidth >= beforeWidth + 8,
      `${beforeWidth} -> ${afterWidth}`);
    check('突变压力正例像素与独立参照零误差', pixels.maxAlphaError === 0,
      `maxAlpha=${pixels.maxAlphaError}`);

    const shiftedCanvas = createCanvas(W, H);
    const shiftedEngine = new ShiftedDabEngine(shiftedCanvas, HOLD_PARAMS);
    shiftedEngine.pushEvents(buildHoldEvents());
    shiftedEngine.endStroke();
    const shiftedPositions = compareDabSequence(shiftedEngine.dabs, expectedArcDabs(
      makeArcPath([{ x: 120, y: 320 }, { x: 520, y: 320 }]),
      { params: HOLD_PARAMS, pressure: 0.8, alpha: HOLD_PARAMS.flow },
    ));
    const shiftedReference = rasterizeReferenceDabs(
      expectedArcDabs(makeArcPath([{ x: 120, y: 320 }, { x: 520, y: 320 }]), { params: HOLD_PARAMS, pressure: 0.8 }),
      W, H, DEFAULT_PARAMS.color, HOLD_PARAMS.hardness,
    );
    const shiftedPixels = compareCanvasPixels(shiftedCanvas, shiftedReference);
    check('受控移位必须被盖印位置验收捕获', !shiftedPositions.ok && shiftedPositions.maxPositionError >= 5.5,
      `maxPos=${shiftedPositions.maxPositionError}`);
    check('受控移位必须产生显著像素误差', shiftedPixels.maxAlphaError > 0.2,
      `maxAlpha=${shiftedPixels.maxAlphaError}`);

    const pressureFaultCanvas = createCanvas(W, H);
    const pressureFaultEngine = new FullPressureFaultEngine(pressureFaultCanvas, PRESSURE_JUMP_PARAMS);
    pressureFaultEngine.pushEvents(events);
    pressureFaultEngine.endStroke();
    const pressureFaultPositions = compareDabSequence(pressureFaultEngine.dabs, expected, { radiusTolerance: 0.1 });
    const pressureFaultPixels = compareCanvasPixels(pressureFaultCanvas, reference);
    check('受控满压力错误必须被半径验收捕获', !pressureFaultPositions.ok && pressureFaultPositions.maxRadiusError > 5,
      `maxRadiusErr=${pressureFaultPositions.maxRadiusError}`);
    check('受控压力错误必须产生像素误差', pressureFaultPixels.maxAlphaError > 0.05,
      `maxAlpha=${pressureFaultPixels.maxAlphaError}`);

    const shiftedReport = evaluateLoadedCase('hold', {
      engine: shiftedEngine,
      canvas: shiftedCanvas,
      reduction: { duplicateCount: 1 },
    });
    const pressureFaultReport = evaluateLoadedCase('pressure-jump', {
      engine: pressureFaultEngine,
      canvas: pressureFaultCanvas,
    });
    check('高层验收不会把移位坏例伪报为通过', shiftedReport.ok === false, shiftedReport.lines.join(' | '));
    check('高层验收不会把压力坏例伪报为通过', pressureFaultReport.ok === false, pressureFaultReport.lines.join(' | '));
  }

  console.log('\n[13] 手写曲线真值: 独立路径覆盖、最早断线和超宽定位');
  {
    const params = { minSize: 12, maxSize: 12, spacingRatio: 0.5, minSpacing: 6, flow: 0.5, hardness: 0.65 };
    const path = makeArcPath(HANDWRITTEN_POINTS);

    const good = runEngine(buildHandwrittenEvents(), params);
    const goodMeasure = measurePathOnCanvas(good.canvas, path, { crossRadius: 24 });
    check('正常手写曲线独立覆盖率100%', goodMeasure.coverage === 1 && goodMeasure.gaps.length === 0,
      `coverage=${goodMeasure.coverage} gaps=${goodMeasure.gaps.length}`);
    check('正常手写曲线无误报超宽', goodMeasure.firstOversize(18, 2, 3) === null);

    const defect = buildDefectStroke();
    const canvas = createCanvas(W, H);
    const engine = new BrushEngine(canvas, params);
    engine.pushEvents(defect.events);
    engine.endStroke();
    stampDab(canvas, defect.oversize, DEFAULT_PARAMS.color, params.hardness);
    const measure = measurePathOnCanvas(canvas, path, { crossRadius: 30 });
    const gap = measure.firstGap(3);
    const oversize = measure.firstOversize(defect.widthLimit, defect.widthTolerance, 3);

    console.log(`  handwritten: coverage=${measure.coverage.toFixed(3)} gapStart=(${gap?.start.x.toFixed(1)},${gap?.start.y.toFixed(1)}) over=(${oversize?.x.toFixed(1)},${oversize?.y.toFixed(1)}) width=${oversize?.width.toFixed(1)}`);
    check('独立覆盖计算识别断线', gap !== null && measure.coverage < 0.95,
      `coverage=${measure.coverage} gap=${JSON.stringify(gap && { s: gap.startS, len: gap.length })}`);
    check('最早断线定位在340事件点之后10px内',
      gap && gap.start.x > defect.expectedGapAfterX && gap.start.x <= defect.expectedGapAfterX + 10,
      `x=${gap?.start.x}`);
    check('断线末端定位在430恢复点附近',
      gap && gap.end.x >= defect.expectedGapBeforeX - 12 && gap.end.x <= defect.expectedGapBeforeX + 2,
      `x=${gap?.end.x}`);
    check('超宽处被定位且宽度超阈值',
      oversize && oversize.width > defect.widthLimit + defect.widthTolerance,
      `width=${oversize?.width}`);
    check('最早超宽点位于受控巨印附近24px',
      oversize && Math.hypot(oversize.x - defect.oversize.x, oversize.y - defect.oversize.y) <= 24,
      `distance=${oversize ? Math.hypot(oversize.x - defect.oversize.x, oversize.y - defect.oversize.y) : Infinity}`);
  }

  console.log('\n[14] 撤销: 恢复快照而非只看画布非空');
  {
    const canvas = createCanvas(W, H);
    const engine = new BrushEngine(canvas, { flow: 0.8 });
    engine.pushEvents([{ x: 80, y: 120, t: 0, p: 0.8 }]);
    for (let x = 90; x <= 180; x += 10) engine.pushEvent({ x, y: 120, t: x, p: 0.8 });
    engine.endStroke();
    const afterFirst = engine.snapshot();

    engine.beginStroke({ x: 700, y: 500, t: 1000, p: 0.8 });
    for (let x = 710; x <= 820; x += 10) engine.pushEvent({ x, y: 500, t: 1000 + x, p: 0.8 });
    engine.endStroke();
    const afterSecondDiff = diffCanvases(afterFirst.canvas, engine.canvas);
    check('第二笔确实改变画布', afterSecondDiff.maxAbs > 0.1, `maxAbs=${afterSecondDiff.maxAbs}`);

    engine.restore(afterFirst);
    const undoDiff = diffCanvases(afterFirst.canvas, engine.canvas);
    check('撤销后画布与第一笔快照逐位一致', undoDiff.maxAbs === 0, `maxAbs=${undoDiff.maxAbs}`);
    check('撤销后dabs也恢复', engine.dabs.length === afterFirst.dabs.length,
      `${engine.dabs.length} vs ${afterFirst.dabs.length}`);
    let secondRegionAlpha = 0;
    for (let x = 680; x < 840; x++) {
      for (let y = 480; y < 520; y++) secondRegionAlpha = Math.max(secondRegionAlpha, canvas.data[(y * W + x) * 4 + 3]);
    }
    let firstRegionAlpha = 0;
    for (let x = 70; x < 190; x++) firstRegionAlpha = Math.max(firstRegionAlpha, canvas.data[(120 * W + x) * 4 + 3]);
    check('撤销清空第二笔区域', secondRegionAlpha === 0, `alpha=${secondRegionAlpha}`);
    check('撤销保留第一笔区域', firstRegionAlpha > 0.2, `alpha=${firstRegionAlpha}`);
  }

  console.log('\n[15] 导出: PNG字节可解码且与纸张合成像素一致');
  {
    const { canvas } = runEngine(buildPressureJumpEvents(), PRESSURE_JUMP_PARAMS);
    const rgba = composePaperRgba(canvas);
    const png = encodePngRgba(rgba, W, H);
    const decoded = decodePng(png);
    check('导出PNG尺寸正确', decoded.width === W && decoded.height === H, `${decoded.width}x${decoded.height}`);
    check('导出PNG解码像素与合成参照逐字节一致', Buffer.from(decoded.rgba).equals(Buffer.from(rgba)),
      `pngBytes=${png.length}`);
    check('导出包含IEND结束块', png.subarray(png.length - 8, png.length - 4).every((v, i) => v === 'IEND'.charCodeAt(i)));
  }

  console.log('\n[16] 图形入口与文档: 回归样例能从绘画窗口打开');
  {
    for (const id of ['hold', 'pressure-jump', 'handwritten-good', 'handwritten-defects', 'demo']) {
      const runtime = runRegressionCase(id);
      const report = evaluateLoadedCase(id, runtime);
      check(`界面共享验收 ${id} 不报伪结果`, report.ok, report.lines.join(' | '));
    }

    const html = readFileSync(join(root, 'ui', 'index.html'), 'utf8');
    const uiJs = readFileSync(join(root, 'ui', 'ui.js'), 'utf8');
    const readme = readFileSync(join(root, 'README.md'), 'utf8');
    check('绘画窗口有回归样例选择/打开入口', html.includes('id="caseSelect"') && html.includes('id="openCase"'));
    check('界面脚本接入回归样例和实际验收', uiJs.includes('REGRESSION_CASES') && uiJs.includes('evaluateLoadedCase'));
    check('绘画窗口有撤销入口', html.includes('id="undo"') && uiJs.includes('engine.restore'));
    check('界面导出使用共享PNG编码', uiJs.includes('encodePngRgba') && uiJs.includes('composePaperRgba'));
    check('文档列出图形入口', readme.includes('ui/index.html') && /http:\/\/localhost:\d+\/ui\//.test(readme));
  }

  return { holdEvidence, pressureEvidence };
}
