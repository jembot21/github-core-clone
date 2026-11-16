// The git wire primitives: pkt-line framing and packfiles. A pack we write is
// plain objects only (no deltas — the protocol allows a server to send none);
// a pack we read resolves OFS and REF deltas, including bases that already live
// in the caller's store, and verifies its trailer checksum.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import { hashObject, type GitObject, type ObjectType } from './gitstore.ts';

// ---------------------------------------------------------------------------
// pkt-line: 4 hex digits of total length (including themselves), then the
// payload. 0000 is a flush, 0001 a delimiter, 0002 the response end.

export function pktLine(payload: string | Buffer): Buffer {
  const data = typeof payload === 'string' ? Buffer.from(payload, 'utf8') : payload;
  const header = Buffer.from((data.length + 4).toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, data]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export function pktResponseEnd(): Buffer {
  return Buffer.from('0002', 'ascii');
}

export type PktItem =
  | { kind: 'data'; payload: Buffer }
  | { kind: 'flush' }
  | { kind: 'delim' }
  | { kind: 'end' };

/** Parse a complete buffer of pkt-lines (a request body is always whole). */
export function parsePktLines(buf: Buffer): PktItem[] {
  const items: PktItem[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const len = Number.parseInt(buf.toString('ascii', at, at + 4), 16);
    if (len === 0) {
      items.push({ kind: 'flush' });
      at += 4;
    } else if (len === 1) {
      items.push({ kind: 'delim' });
      at += 4;
    } else if (len === 2) {
      items.push({ kind: 'end' });
      at += 4;
    } else if (len >= 4 && at + len <= buf.length) {
      items.push({ kind: 'data', payload: buf.subarray(at + 4, at + len) });
      at += len;
    } else {
      break; // A truncated tail: callers treat what parsed as the message.
    }
  }
  return items;
}

/** Split a request body into its pkt-line items and the raw bytes after them. */
export function splitPktLines(buf: Buffer): { items: PktItem[]; rest: Buffer } {
  const items: PktItem[] = [];
  let at = 0;
  while (at + 4 <= buf.length) {
    const len = Number.parseInt(buf.toString('ascii', at, at + 4), 16);
    if (Number.isNaN(len) || len < 0 || len > 65520) break;
    if (len === 0) {
      items.push({ kind: 'flush' });
      at += 4;
      // A flush ends the framed part of a receive-pack body; a pack may follow.
      return { items, rest: buf.subarray(at) };
    }
    if (len === 1) {
      items.push({ kind: 'delim' });
      at += 4;
      continue;
    }
    if (len === 2) {
      items.push({ kind: 'end' });
      at += 4;
      continue;
    }
    if (len < 4 || at + len > buf.length) break;
    items.push({ kind: 'data', payload: buf.subarray(at + 4, at + len) });
    at += len;
  }
  return { items, rest: buf.subarray(at) };
}

// ---------------------------------------------------------------------------
// Packfiles.

const TYPE_CODES: Record<ObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const CODE_TYPES: Record<number, ObjectType | 'ofs-delta' | 'ref-delta'> = {
  1: 'commit',
  2: 'tree',
  3: 'blob',
  4: 'tag',
  6: 'ofs-delta',
  7: 'ref-delta',
};

/** Encode a pack object header: type in bits 4-6, size in the rest, varint. */
function encodeObjectHeader(type: ObjectType, size: number): Buffer {
  const bytes: number[] = [];
  let rest = size;
  const first = (TYPE_CODES[type] << 4) | (rest & 0x0f);
  rest >>= 4;
  bytes.push(rest > 0 ? first | 0x80 : first);
  while (rest > 0) {
    const byte = rest & 0x7f;
    rest >>= 7;
    bytes.push(rest > 0 ? byte | 0x80 : byte);
  }
  return Buffer.from(bytes);
}

/** Build a complete packfile (header, objects, SHA-1 trailer) from objects. */
export function buildPack(objects: Iterable<{ sha: string; type: ObjectType; data: Buffer }>): Buffer {
  const list = [...objects];
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(list.length, 8);
  parts.push(header);
  for (const obj of list) {
    parts.push(encodeObjectHeader(obj.type, obj.data.length));
    parts.push(deflateSync(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = createHash('sha1').update(body).digest();
  return Buffer.concat([body, trailer]);
}

/** Inflate one zlib stream starting at `at`; returns the data and bytes used. */
function inflateOne(buf: Buffer, at: number, expectedSize: number): { data: Buffer; used: number } {
  // inflateSync tolerates trailing bytes, so the smallest prefix that inflates
  // is exactly the stream: binary-search for it. The declared object size
  // bounds the search first (a deflated object is rarely larger than its raw
  // size plus slack); if that window holds no stream end, search the whole tail.
  const search = (hi: number): number => {
    let lo = at + 1;
    let best = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      try {
        inflateSync(buf.subarray(at, mid));
        best = mid;
        hi = mid - 1;
      } catch {
        lo = mid + 1;
      }
    }
    return best;
  };
  let best = search(Math.min(buf.length, at + Math.ceil(expectedSize * 1.05) + 512));
  if (best === -1) best = search(buf.length);
  if (best === -1) throw new Error('corrupt zlib stream in pack');
  return { data: inflateSync(buf.subarray(at, best)), used: best - at };
}

/** Apply a git delta to its base object's bytes. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let at = 0;
  const readVarint = (): number => {
    let value = 0;
    let shift = 0;
    for (;;) {
      const byte = delta[at] as number;
      at += 1;
      value |= (byte & 0x7f) << shift;
      shift += 7;
      if ((byte & 0x80) === 0) return value;
    }
  };
  const sourceSize = readVarint();
  if (sourceSize !== base.length) throw new Error('delta base size mismatch');
  const targetSize = readVarint();
  const out: Buffer[] = [];
  let produced = 0;
  while (at < delta.length) {
    const op = delta[at] as number;
    at += 1;
    if (op & 0x80) {
      let offset = 0;
      let size = 0;
      if (op & 0x01) { offset = delta[at] as number; at += 1; }
      if (op & 0x02) { offset |= (delta[at] as number) << 8; at += 1; }
      if (op & 0x04) { offset |= (delta[at] as number) << 16; at += 1; }
      if (op & 0x08) { offset |= (delta[at] as number) << 24; at += 1; }
      if (op & 0x10) { size = delta[at] as number; at += 1; }
      if (op & 0x20) { size |= (delta[at] as number) << 8; at += 1; }
      if (op & 0x40) { size |= (delta[at] as number) << 16; at += 1; }
      if (size === 0) size = 0x10000;
      out.push(base.subarray(offset, offset + size));
      produced += size;
    } else if (op > 0) {
      out.push(delta.subarray(at, at + op));
      at += op;
      produced += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  const result = Buffer.concat(out);
  if (produced !== targetSize || result.length !== targetSize) throw new Error('delta target size mismatch');
  return result;
}

interface PackEntry {
  offset: number;
  type: ObjectType | 'ofs-delta' | 'ref-delta';
  data?: Buffer;
  baseOffset?: number;
  baseSha?: string;
}

/**
 * Read a packfile into a sha → object map, resolving deltas against each other
 * and, for REF deltas whose base is absent from the pack, against `external`.
 */
export function readPack(
  pack: Buffer,
  external: (sha: string) => GitObject | null,
): Map<string, GitObject> {
  if (pack.length < 12 + 20 || pack.toString('ascii', 0, 4) !== 'PACK') throw new Error('not a packfile');
  const count = pack.readUInt32BE(8);
  const trailer = pack.subarray(pack.length - 20);
  const digest = createHash('sha1').update(pack.subarray(0, pack.length - 20)).digest();
  if (!trailer.equals(digest)) throw new Error('pack trailer checksum mismatch');
  const bodyEnd = pack.length - 20;
  const entries: PackEntry[] = [];
  const byOffset = new Map<number, PackEntry>();
  let at = 12;
  for (let i = 0; i < count; i += 1) {
    const start = at;
    let byte = pack[at] as number;
    at += 1;
    const typeCode = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while (byte & 0x80) {
      byte = pack[at] as number;
      at += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    const type = CODE_TYPES[typeCode];
    if (type === undefined) throw new Error(`unknown pack object type ${typeCode}`);
    const entry: PackEntry = { offset: start, type };
    if (type === 'ofs-delta') {
      let b = pack[at] as number;
      at += 1;
      let offset = b & 0x7f;
      while (b & 0x80) {
        b = pack[at] as number;
        at += 1;
        offset = ((offset + 1) << 7) | (b & 0x7f);
      }
      entry.baseOffset = start - offset;
    } else if (type === 'ref-delta') {
      entry.baseSha = pack.toString('hex', at, at + 20);
      at += 20;
    }
    const inflated = inflateOne(pack.subarray(0, bodyEnd + 20), at, size);
    if (inflated.data.length !== size) throw new Error('pack object size mismatch');
    entry.data = inflated.data;
    at += inflated.used;
    entries.push(entry);
    byOffset.set(start, entry);
  }

  const resolved = new Map<number, GitObject>();
  const resolve = (entry: PackEntry): GitObject => {
    const cached = resolved.get(entry.offset);
    if (cached !== undefined) return cached;
    let obj: GitObject;
    if (entry.type === 'ofs-delta' || entry.type === 'ref-delta') {
      let base: GitObject | null = null;
      if (entry.type === 'ofs-delta') {
        const baseEntry = byOffset.get(entry.baseOffset as number);
        if (baseEntry !== undefined) base = resolve(baseEntry);
      } else {
        base = external(entry.baseSha as string);
        if (base === null) {
          // The base may itself be an object earlier in this same pack.
          for (const candidate of entries) {
            if (candidate.type !== 'ofs-delta' && candidate.type !== 'ref-delta') {
              if (hashObject(candidate.type, candidate.data as Buffer) === entry.baseSha) {
                base = resolve(candidate);
                break;
              }
            }
          }
        }
      }
      if (base === null) throw new Error('delta base not found');
      obj = { type: base.type, data: applyDelta(base.data, entry.data as Buffer) };
    } else {
      obj = { type: entry.type, data: entry.data as Buffer };
    }
    resolved.set(entry.offset, obj);
    return obj;
  };

  const out = new Map<string, GitObject>();
  for (const entry of entries) {
    const obj = resolve(entry);
    out.set(hashObject(obj.type, obj.data), obj);
  }
  return out;
}
