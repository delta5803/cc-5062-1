// 事件合包与乱序归约：把不同分包/到达顺序还原成同一条规范事件流。

export function fingerprintEvent(e = {}) {
  return JSON.stringify([
    e.t ?? null,
    e.x ?? null,
    e.y ?? null,
    e.p ?? null,
    e.tx ?? null,
    e.ty ?? null,
  ]);
}

export function reduceEventPackets(packets, { deduplicate = true, sort = true } = {}) {
  const seen = new Map();
  const duplicates = [];
  const outOfOrder = [];
  const indexed = [];
  let received = 0;
  let maxT = -Infinity;

  packets.forEach((packet, packetIndex) => {
    if (!Array.isArray(packet)) throw new Error('事件包必须是数组');
    packet.forEach((event, eventIndex) => {
      received++;
      const fingerprint = fingerprintEvent(event);
      const arrivalOrder = indexed.length + duplicates.length;
      if (seen.has(fingerprint)) {
        duplicates.push({
          fingerprint,
          packetIndex,
          eventIndex,
          arrivalOrder,
          firstArrivalOrder: seen.get(fingerprint),
        });
        if (deduplicate) return;
      } else {
        seen.set(fingerprint, arrivalOrder);
      }

      const t = Number(event?.t);
      if (Number.isFinite(t)) {
        if (t + 1e-9 < maxT) {
          outOfOrder.push({ packetIndex, eventIndex, t, maxT, arrivalOrder });
        }
        maxT = Math.max(maxT, t);
      }
      indexed.push({ event, arrivalOrder });
    });
  });

  if (sort) {
    indexed.sort((a, b) => {
      const dt = Number(a.event?.t) - Number(b.event?.t);
      if (Number.isFinite(dt) && Math.abs(dt) > 1e-12) return dt;
      return a.arrivalOrder - b.arrivalOrder;
    });
  }

  return {
    events: indexed.map(item => item.event),
    received,
    count: indexed.length,
    duplicates,
    duplicateCount: duplicates.length,
    outOfOrder,
    outOfOrderCount: outOfOrder.length,
  };
}

export function fixedPackets(events, size = 1) {
  if (!Number.isInteger(size) || size <= 0) throw new Error('包大小必须是正整数');
  const packets = [];
  for (let i = 0; i < events.length; i += size) packets.push(events.slice(i, i + size));
  return packets;
}

// 确定性的不规则分包，避免验收只覆盖固定包长。
export function variedPackets(events, seed = 1) {
  let state = seed >>> 0;
  const next = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const packets = [];
  let i = 0;
  while (i < events.length) {
    const size = 1 + Math.floor(next() * 7); // 1..7
    packets.push(events.slice(i, i + size));
    i += size;
  }
  return packets;
}

export function coalesceTimePackets(events, intervalMs = 16) {
  if (!(intervalMs > 0)) throw new Error('合包时间窗必须 > 0');
  const packets = [];
  let current = [];
  let bucketStart = null;
  for (const event of events) {
    const bucket = Math.floor(Number(event.t) / intervalMs);
    if (bucketStart !== null && bucket !== bucketStart) {
      packets.push(current);
      current = [];
    }
    bucketStart = bucket;
    current.push(event);
  }
  if (current.length) packets.push(current);
  return packets;
}

// 只打乱包的到达顺序，不拆乱包内事件；归约器负责按时间复原。
export function shuffledPackets(packets, seed = 9) {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return state / 4294967296;
  };
  const out = packets.map(packet => packet.slice());
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [out[i], out[j]] = [out[j], out[i]];
  }
  return out;
}
