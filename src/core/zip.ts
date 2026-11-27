/**
 * Minimal ZIP writer (Spec 09). STORE method only (no compression), CRC-32,
 * local headers, central directory and end record, UTF-8 names (general purpose
 * flag bit 11). No ZIP64: archives of 4 GB or more, or with 65535 or more
 * entries, are refused. Pure and deterministic: the timestamp is an input.
 */

export interface ZipEntry {
  /** Forward-slash relative path, e.g. `Memex Vault/Note.md`. */
  path: string;
  data: Uint8Array;
}

export interface ZipOptions {
  /** ISO-8601 timestamp stored for every entry (UTC fields, 1980 to 2107). Default 1980-01-01T00:00:00Z. */
  modified?: string;
}

export const ZIP_MAX_ENTRIES = 0xfffe;
export const ZIP_MAX_BYTES = 0xfffffffe;
const LOCAL_SIG = 0x04034b50;
const CENTRAL_SIG = 0x02014b50;
const END_SIG = 0x06054b50;
const FLAG_UTF8 = 0x0800;
const VERSION = 20;
/** DOS date for 1980-01-01 and DOS time 00:00:00. */
const DEFAULT_DOS = { date: (0 << 9) | (1 << 5) | 1, time: 0 };

const CRC_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

/** CRC-32 (IEEE 802.3) of `data`, as an unsigned 32-bit integer. */
export function crc32(data: Uint8Array): number {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

/** DOS `{ date, time }` words for an ISO timestamp; the default constant when absent or unparseable. */
export function toDosDateTime(iso: string | undefined): { date: number; time: number } {
  if (iso === undefined) return DEFAULT_DOS;
  const ms = Date.parse(iso);
  if (!Number.isFinite(ms)) return DEFAULT_DOS;
  const d = new Date(ms);
  const year = d.getUTCFullYear();
  if (year < 1980 || year > 2107) return DEFAULT_DOS;
  return {
    date: ((year - 1980) << 9) | ((d.getUTCMonth() + 1) << 5) | d.getUTCDate(),
    time: (d.getUTCHours() << 11) | (d.getUTCMinutes() << 5) | (d.getUTCSeconds() >> 1),
  };
}

/** True for a safe relative archive path: no empty, `.` or `..` segment, no backslash, colon or control character. */
export function isSafeZipPath(path: string): boolean {
  if (path === "" || path.startsWith("/")) return false;
  if (/[\\\u0000-\u001F\u007F]/.test(path) || /^[A-Za-z]:/.test(path)) return false;
  return path.split("/").every((seg) => seg !== "" && seg !== "." && seg !== "..");
}

/**
 * Builds the archive. Throws `Error` for an unsafe or duplicate path, more than
 * `ZIP_MAX_ENTRIES` entries, or a total size of `ZIP_MAX_BYTES` or more.
 */
export function createZip(entries: readonly ZipEntry[], options: ZipOptions = {}): Uint8Array<ArrayBuffer> {
  if (entries.length > ZIP_MAX_ENTRIES) {
    throw new Error(`Too many files for a ZIP archive (limit ${ZIP_MAX_ENTRIES}).`);
  }
  const encoder = new TextEncoder();
  const dos = toDosDateTime(options.modified);
  const seen = new Set<string>();
  const prepared = entries.map((entry) => {
    if (!isSafeZipPath(entry.path)) throw new Error(`Unsafe path in archive: ${JSON.stringify(entry.path)}`);
    if (seen.has(entry.path)) throw new Error(`Duplicate path in archive: ${JSON.stringify(entry.path)}`);
    seen.add(entry.path);
    const name = encoder.encode(entry.path);
    if (name.length > 0xffff) throw new Error("A file name in the archive is too long.");
    return { name, data: entry.data, crc: crc32(entry.data) };
  });

  let total = 22;
  for (const p of prepared) total += 30 + p.name.length + p.data.length + 46 + p.name.length;
  if (total > ZIP_MAX_BYTES) throw new Error("The archive would be 4 GB or larger, which is not supported.");

  const out = new Uint8Array(total);
  const view = new DataView(out.buffer);
  let at = 0;
  const offsets: number[] = [];
  for (const p of prepared) {
    offsets.push(at);
    view.setUint32(at, LOCAL_SIG, true);
    view.setUint16(at + 4, VERSION, true);
    view.setUint16(at + 6, FLAG_UTF8, true);
    view.setUint16(at + 8, 0, true); // STORE
    view.setUint16(at + 10, dos.time, true);
    view.setUint16(at + 12, dos.date, true);
    view.setUint32(at + 14, p.crc, true);
    view.setUint32(at + 18, p.data.length, true);
    view.setUint32(at + 22, p.data.length, true);
    view.setUint16(at + 26, p.name.length, true);
    view.setUint16(at + 28, 0, true);
    out.set(p.name, at + 30);
    out.set(p.data, at + 30 + p.name.length);
    at += 30 + p.name.length + p.data.length;
  }
  const centralStart = at;
  prepared.forEach((p, i) => {
    view.setUint32(at, CENTRAL_SIG, true);
    view.setUint16(at + 4, VERSION, true); // version made by
    view.setUint16(at + 6, VERSION, true); // version needed
    view.setUint16(at + 8, FLAG_UTF8, true);
    view.setUint16(at + 10, 0, true);
    view.setUint16(at + 12, dos.time, true);
    view.setUint16(at + 14, dos.date, true);
    view.setUint32(at + 16, p.crc, true);
    view.setUint32(at + 20, p.data.length, true);
    view.setUint32(at + 24, p.data.length, true);
    view.setUint16(at + 28, p.name.length, true);
    view.setUint16(at + 30, 0, true); // extra
    view.setUint16(at + 32, 0, true); // comment
    view.setUint16(at + 34, 0, true); // disk number
    view.setUint16(at + 36, 0, true); // internal attributes
    view.setUint32(at + 38, 0, true); // external attributes
    view.setUint32(at + 42, offsets[i], true);
    out.set(p.name, at + 46);
    at += 46 + p.name.length;
  });
  view.setUint32(at, END_SIG, true);
  view.setUint16(at + 4, 0, true);
  view.setUint16(at + 6, 0, true);
  view.setUint16(at + 8, prepared.length, true);
  view.setUint16(at + 10, prepared.length, true);
  view.setUint32(at + 12, at - centralStart, true);
  view.setUint32(at + 16, centralStart, true);
  view.setUint16(at + 20, 0, true);
  return out;
}
