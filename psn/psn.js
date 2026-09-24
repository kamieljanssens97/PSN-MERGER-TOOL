'use strict';
/**
 * Minimal PosiStageNet (PSN) v2 encoder/decoder.
 * Protocol reference: chunk-based TLV format used by PSN_DATA_PACKET and PSN_INFO_PACKET.
 */

// Root chunk ids
const PSN_DATA_PACKET = 0x6755;
const PSN_INFO_PACKET = 0x6756;

// Data packet sub-chunk ids
const PSN_DATA_PACKET_HEADER = 0x0000;
const PSN_DATA_TRACKER_LIST = 0x0001;

// Per-tracker data sub-chunk ids
const PSN_DATA_TRACKER_POS = 0x0000;
const PSN_DATA_TRACKER_SPEED = 0x0001;
const PSN_DATA_TRACKER_ORI = 0x0002;
const PSN_DATA_TRACKER_STATUS = 0x0003;
const PSN_DATA_TRACKER_ACCEL = 0x0004;
const PSN_DATA_TRACKER_TRGTPOS = 0x0005;
const PSN_DATA_TRACKER_TIMESTAMP = 0x0006;

// Info packet sub-chunk ids
const PSN_INFO_PACKET_HEADER = 0x0000;
const PSN_INFO_SYSTEM_NAME = 0x0001;
const PSN_INFO_TRACKER_LIST = 0x0002;
const PSN_INFO_TRACKER_NAME = 0x0000;

const HAS_SUBCHUNKS_FLAG = 0x8000;
const LEN_MASK = 0x7fff;

/** Build a leaf chunk (raw data payload). */
function leaf(id, dataBuffer) {
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE(dataBuffer.length & LEN_MASK, 2);
  return Buffer.concat([header, dataBuffer]);
}

/** Build a chunk that contains nested sub-chunks. */
function container(id, subChunkBuffers) {
  const body = Buffer.concat(subChunkBuffers);
  const header = Buffer.alloc(4);
  header.writeUInt16LE(id, 0);
  header.writeUInt16LE((body.length & LEN_MASK) | HAS_SUBCHUNKS_FLAG, 2);
  return Buffer.concat([header, body]);
}

function vec3Buffer(v) {
  const b = Buffer.alloc(12);
  b.writeFloatLE(v.x || 0, 0);
  b.writeFloatLE(v.y || 0, 4);
  b.writeFloatLE(v.z || 0, 8);
  return b;
}

function headerBuffer(timestampMicros, versionHigh, versionLow, frameId, framePacketCount) {
  const b = Buffer.alloc(12);
  b.writeBigUInt64LE(BigInt(Math.floor(timestampMicros)) & 0xffffffffffffffffn, 0);
  b.writeUInt8(versionHigh, 8);
  b.writeUInt8(versionLow, 9);
  b.writeUInt8(frameId & 0xff, 10);
  b.writeUInt8(framePacketCount & 0xff, 11);
  return b;
}

/**
 * Encode a PSN_DATA_PACKET for a list of trackers.
 * trackers: [{ id, pos:{x,y,z}, ori:{x,y,z}, speed?, status? }]
 */
function encodeDataPacket(trackers, opts = {}) {
  const {
    timestampMicros = Number(process.hrtime.bigint() / 1000n),
    versionHigh = 2,
    versionLow = 0,
    frameId = 0,
    framePacketCount = 1,
  } = opts;

  const header = leaf(
    PSN_DATA_PACKET_HEADER,
    headerBuffer(timestampMicros, versionHigh, versionLow, frameId, framePacketCount)
  );

  const trackerChunks = trackers.map((t) => {
    const subs = [leaf(PSN_DATA_TRACKER_POS, vec3Buffer(t.pos))];
    if (t.speed) subs.push(leaf(PSN_DATA_TRACKER_SPEED, vec3Buffer(t.speed)));
    if (t.ori) subs.push(leaf(PSN_DATA_TRACKER_ORI, vec3Buffer(t.ori)));
    if (typeof t.status === 'number') {
      const b = Buffer.alloc(4);
      b.writeFloatLE(t.status, 0);
      subs.push(leaf(PSN_DATA_TRACKER_STATUS, b));
    }
    return container(t.id, subs);
  });

  const trackerList = container(PSN_DATA_TRACKER_LIST, trackerChunks);
  return container(PSN_DATA_PACKET, [header, trackerList]);
}

/** Encode a PSN_INFO_PACKET announcing tracker names. */
function encodeInfoPacket(systemName, trackers, opts = {}) {
  const {
    timestampMicros = Number(process.hrtime.bigint() / 1000n),
    versionHigh = 2,
    versionLow = 0,
    frameId = 0,
    framePacketCount = 1,
  } = opts;

  const header = leaf(
    PSN_INFO_PACKET_HEADER,
    headerBuffer(timestampMicros, versionHigh, versionLow, frameId, framePacketCount)
  );
  const nameChunk = leaf(PSN_INFO_SYSTEM_NAME, Buffer.from(systemName, 'utf8'));

  const trackerChunks = trackers.map((t) =>
    container(t.id, [leaf(PSN_INFO_TRACKER_NAME, Buffer.from(t.name || `Tracker ${t.id}`, 'utf8'))])
  );
  const trackerList = container(PSN_INFO_TRACKER_LIST, trackerChunks);
  return container(PSN_INFO_PACKET, [header, nameChunk, trackerList]);
}

/** Parse a raw chunk buffer into { id, hasSubchunks, data, chunks } recursively. */
function parseChunks(buf, offset, end) {
  const chunks = [];
  let pos = offset;
  while (pos + 4 <= end) {
    const id = buf.readUInt16LE(pos);
    const lenField = buf.readUInt16LE(pos + 2);
    const hasSubchunks = (lenField & HAS_SUBCHUNKS_FLAG) !== 0;
    const dataLen = lenField & LEN_MASK;
    const dataStart = pos + 4;
    const dataEnd = dataStart + dataLen;
    if (dataEnd > end) break; // malformed/truncated packet
    const chunk = { id, hasSubchunks };
    if (hasSubchunks) {
      chunk.chunks = parseChunks(buf, dataStart, dataEnd);
    } else {
      chunk.data = buf.subarray(dataStart, dataEnd);
    }
    chunks.push(chunk);
    pos = dataEnd;
  }
  return chunks;
}

function readVec3(buf) {
  return { x: buf.readFloatLE(0), y: buf.readFloatLE(4), z: buf.readFloatLE(8) };
}

/**
 * Decode a raw PSN UDP payload.
 * Returns { type: 'data'|'info'|null, trackers: [...] }
 */
function decodePacket(buf) {
  if (buf.length < 4) return null;
  const rootId = buf.readUInt16LE(0);
  const rootChunks = parseChunks(buf, 0, buf.length);
  if (rootChunks.length === 0) return null;
  const root = rootChunks[0];

  if (root.id === PSN_DATA_PACKET) {
    const trackers = [];
    for (const c of root.chunks || []) {
      if (c.id === PSN_DATA_TRACKER_LIST) {
        for (const trackerChunk of c.chunks || []) {
          const tracker = { id: trackerChunk.id };
          for (const sub of trackerChunk.chunks || []) {
            if (sub.id === PSN_DATA_TRACKER_POS) tracker.pos = readVec3(sub.data);
            else if (sub.id === PSN_DATA_TRACKER_SPEED) tracker.speed = readVec3(sub.data);
            else if (sub.id === PSN_DATA_TRACKER_ORI) tracker.ori = readVec3(sub.data);
            else if (sub.id === PSN_DATA_TRACKER_STATUS) tracker.status = sub.data.readFloatLE(0);
          }
          trackers.push(tracker);
        }
      }
    }
    return { type: 'data', trackers };
  }

  if (root.id === PSN_INFO_PACKET) {
    const trackers = [];
    let systemName = '';
    for (const c of root.chunks || []) {
      if (c.id === PSN_INFO_SYSTEM_NAME) systemName = c.data.toString('utf8').replace(/\0+$/, '');
      if (c.id === PSN_INFO_TRACKER_LIST) {
        for (const trackerChunk of c.chunks || []) {
          const tracker = { id: trackerChunk.id, name: '' };
          for (const sub of trackerChunk.chunks || []) {
            if (sub.id === PSN_INFO_TRACKER_NAME) tracker.name = sub.data.toString('utf8').replace(/\0+$/, '');
          }
          trackers.push(tracker);
        }
      }
    }
    return { type: 'info', systemName, trackers };
  }

  return null;
}

module.exports = {
  PSN_DATA_PACKET,
  PSN_INFO_PACKET,
  encodeDataPacket,
  encodeInfoPacket,
  decodePacket,
};
