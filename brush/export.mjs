// 画布导出与纸张合成。PNG 编码使用无压缩 deflate 存储块，浏览器和 Node 均可运行。

export const PAPER_RGB = [0.96, 0.95, 0.92];

export function composePaperRgba(canvas, paper = PAPER_RGB) {
  const out = new Uint8ClampedArray(canvas.width * canvas.height * 4);
  const src = canvas.data;
  for (let i = 0, j = 0; i < src.length; i += 4, j += 4) {
    const a = src[i + 3];
    out[j] = (src[i] * a + paper[0] * (1 - a)) * 255;
    out[j + 1] = (src[i + 1] * a + paper[1] * (1 - a)) * 255;
    out[j + 2] = (src[i + 2] * a + paper[2] * (1 - a)) * 255;
    out[j + 3] = 255;
  }
  return out;
}

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes) {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const typeBytes = new TextEncoder().encode(type);
  const out = new Uint8Array(12 + data.length);
  const view = new DataView(out.buffer);
  view.setUint32(0, data.length);
  out.set(typeBytes, 4);
  out.set(data, 8);
  view.setUint32(8 + data.length, crc32(out.subarray(4, 8 + data.length)));
  return out;
}

function concat(chunks) {
  const length = chunks.reduce((sum, c) => sum + c.length, 0);
  const out = new Uint8Array(length);
  let offset = 0;
  for (const c of chunks) { out.set(c, offset); offset += c.length; }
  return out;
}

function adler32(bytes) {
  let a = 1, b = 0;
  for (let i = 0; i < bytes.length; i++) {
    a = (a + bytes[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

function zlibStored(data) {
  const blocks = [];
  const maxBlock = 65535;
  for (let offset = 0; offset < data.length; offset += maxBlock) {
    const length = Math.min(maxBlock, data.length - offset);
    const finalBlock = offset + length >= data.length;
    const block = new Uint8Array(5 + length);
    const view = new DataView(block.buffer);
    block[0] = finalBlock ? 1 : 0;
    view.setUint16(1, length, true);
    view.setUint16(3, length ^ 0xffff, true);
    block.set(data.subarray(offset, offset + length), 5);
    blocks.push(block);
  }
  const checksum = new Uint8Array(4);
  new DataView(checksum.buffer).setUint32(0, adler32(data));
  const header = new Uint8Array([0x78, 0x01]);
  return concat([header, ...blocks, checksum]);
}

export function encodePngRgba(rgba, width, height) {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error('PNG 尺寸非法');
  }
  if (rgba.length !== width * height * 4) throw new Error('RGBA 数据长度与尺寸不符');

  const stride = width * 4;
  const raw = new Uint8Array((stride + 1) * height);
  for (let y = 0; y < height; y++) {
    raw[y * (stride + 1)] = 0;
    raw.set(rgba.subarray(y * stride, (y + 1) * stride), y * (stride + 1) + 1);
  }

  const ihdr = new Uint8Array(13);
  const view = new DataView(ihdr.buffer);
  view.setUint32(0, width);
  view.setUint32(4, height);
  ihdr[8] = 8;  // bit depth
  ihdr[9] = 6;  // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const signature = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]);
  return concat([
    signature,
    chunk('IHDR', ihdr),
    chunk('IDAT', zlibStored(raw)),
    chunk('IEND', new Uint8Array(0)),
  ]);
}
