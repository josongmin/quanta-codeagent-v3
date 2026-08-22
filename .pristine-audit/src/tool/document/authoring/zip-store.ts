/**
 * H14b — pure-TS STORED (uncompressed) ZIP writer.
 *
 * `.xlsx` / `.docx` / `.pptx` are ZIP containers of OOXML (XML) parts. We have
 * NO office library and installs are BLOCKED, so this module builds a valid ZIP
 * BY HAND using the ZIP "stored" method (compression method 0) — no compression
 * library needed. Excel / Word open a stored ZIP exactly like a deflated one;
 * the only cost is a larger file (text XML compresses well, but our parts are
 * tiny — a few KB — so STORED is the right call: zero deps, fully deterministic,
 * trivially auditable).
 *
 * Why STORED over node:zlib DEFLATE:
 *   - Dependency-free + deterministic: DEFLATE output varies by zlib version /
 *     level, so a STORED archive is byte-stable across machines (important for
 *     the hellgate's byte-level assertions and for reproducibility).
 *   - Simpler to PROVE correct: the hellgate parses the headers back and
 *     re-derives every CRC-32; with STORED, `compressedSize === uncompressedSize`
 *     and the stored bytes ARE the part bytes (no inflate step to trust).
 *
 * Format (PKZIP APPNOTE, sections 4.3.7 / 4.3.12 / 4.3.16):
 *   [local file header + raw bytes] × N   (one per part)
 *   [central directory header]      × N
 *   [end of central directory record]
 *
 * All multi-byte integers are little-endian. We emit DOS date/time = 0 and a
 * fixed "version needed = 20" so the archive is byte-identical run-to-run (no
 * `Date.now()` — see the no-heuristics / determinism discipline).
 *
 * Slice posture (RFC §3.1): imports ONLY `node:zlib` (for the DEFLATE READER —
 * see {@link unzip}). The WRITER stays dependency-free + STORED-only; the reader
 * MUST inflate DEFLATE entries because real-world `.xlsx`/`.docx` use method 8.
 */

import { inflateRawSync } from "node:zlib"
import { errMessage } from "@/shared"

// ── CRC-32 (IEEE 802.3 polynomial 0xEDB88320, reflected) ────────────────────
// Standard table-driven CRC-32 — the exact algorithm ZIP requires. Pure +
// deterministic; the table is computed once at module load.

const CRC32_TABLE: Uint32Array = (() => {
  const table = new Uint32Array(256)
  for (let n = 0; n < 256; n++) {
    let c = n
    for (let k = 0; k < 8; k++) {
      c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1
    }
    table[n] = c >>> 0
  }
  return table
})()

/** Standard CRC-32 of a byte buffer. Returned as an unsigned 32-bit number. */
export const crc32 = (bytes: Uint8Array): number => {
  let crc = 0xffffffff
  for (let i = 0; i < bytes.length; i++) {
    crc = (CRC32_TABLE[(crc ^ (bytes[i] as number)) & 0xff] as number) ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

// ── byte helpers ────────────────────────────────────────────────────────────

/** UTF-8 encode. ZIP part NAMES and OOXML TEXT are both UTF-8. */
const utf8 = (s: string): Uint8Array => new TextEncoder().encode(s)

/** A part of the archive: an in-zip path + raw (already-serialized) bytes. */
export interface ZipEntry {
  /** Forward-slash path inside the archive (e.g. `xl/workbook.xml`). */
  readonly path: string
  /** The raw part bytes (UTF-8 XML for OOXML; any bytes in general). */
  readonly data: Uint8Array
}

/** Convenience: a text part (the common case for OOXML XML). */
export const textEntry = (path: string, xml: string): ZipEntry => ({ path, data: utf8(xml) })

// A small growable byte sink — avoids O(n²) concat by collecting chunks and
// flattening once at the end.
class ByteSink {
  private chunks: Uint8Array[] = []
  private len = 0
  push(b: Uint8Array): void {
    this.chunks.push(b)
    this.len += b.length
  }
  /** Current absolute offset (used for central-directory back-references). */
  get offset(): number {
    return this.len
  }
  done(): Uint8Array {
    const out = new Uint8Array(this.len)
    let o = 0
    for (const c of this.chunks) {
      out.set(c, o)
      o += c.length
    }
    return out
  }
}

const u16 = (n: number): Uint8Array => {
  const b = new Uint8Array(2)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  return b
}
const u32 = (n: number): Uint8Array => {
  const b = new Uint8Array(4)
  b[0] = n & 0xff
  b[1] = (n >>> 8) & 0xff
  b[2] = (n >>> 16) & 0xff
  b[3] = (n >>> 24) & 0xff
  return b
}

// Field constants (PKZIP APPNOTE).
const LOCAL_SIG = 0x04034b50
const CENTRAL_SIG = 0x02014b50
const EOCD_SIG = 0x06054b50
const VERSION_NEEDED = 20 // 2.0 — STORED + folders; the minimum readers expect.
const VERSION_MADE_BY = 20
// General-purpose bit flag bit 11 = filename/comment are UTF-8. Our paths are
// ASCII today, but setting it is correct + future-proof and harmless.
const FLAG_UTF8 = 0x0800
const METHOD_STORED = 0

interface BuiltEntry {
  readonly path: string
  readonly nameBytes: Uint8Array
  readonly data: Uint8Array
  readonly crc: number
  readonly localHeaderOffset: number
}

/**
 * Build a valid STORED ZIP archive from `entries`, in the order given (OOXML
 * readers do not require a particular part order, but a STABLE order keeps the
 * output deterministic). Returns the complete archive bytes.
 *
 * Pure + deterministic: no clock, no randomness. Duplicate paths are the
 * caller's responsibility (the serializers never emit dupes).
 */
export const buildStoredZip = (entries: readonly ZipEntry[]): Uint8Array => {
  const sink = new ByteSink()
  const built: BuiltEntry[] = []

  // 1. Local file headers + raw stored bytes.
  for (const e of entries) {
    const nameBytes = utf8(e.path)
    const crc = crc32(e.data)
    const localHeaderOffset = sink.offset
    sink.push(u32(LOCAL_SIG))
    sink.push(u16(VERSION_NEEDED))
    sink.push(u16(FLAG_UTF8))
    sink.push(u16(METHOD_STORED))
    sink.push(u16(0)) // mod time (fixed 0 — determinism)
    sink.push(u16(0)) // mod date (fixed 0 — determinism)
    sink.push(u32(crc))
    sink.push(u32(e.data.length)) // compressed size == uncompressed (STORED)
    sink.push(u32(e.data.length)) // uncompressed size
    sink.push(u16(nameBytes.length))
    sink.push(u16(0)) // extra field length
    sink.push(nameBytes)
    sink.push(e.data)
    built.push({ path: e.path, nameBytes, data: e.data, crc, localHeaderOffset })
  }

  // 2. Central directory.
  const centralStart = sink.offset
  for (const b of built) {
    sink.push(u32(CENTRAL_SIG))
    sink.push(u16(VERSION_MADE_BY))
    sink.push(u16(VERSION_NEEDED))
    sink.push(u16(FLAG_UTF8))
    sink.push(u16(METHOD_STORED))
    sink.push(u16(0)) // mod time
    sink.push(u16(0)) // mod date
    sink.push(u32(b.crc))
    sink.push(u32(b.data.length)) // compressed size
    sink.push(u32(b.data.length)) // uncompressed size
    sink.push(u16(b.nameBytes.length))
    sink.push(u16(0)) // extra field length
    sink.push(u16(0)) // comment length
    sink.push(u16(0)) // disk number start
    sink.push(u16(0)) // internal attributes
    sink.push(u32(0)) // external attributes
    sink.push(u32(b.localHeaderOffset))
    sink.push(b.nameBytes)
  }
  const centralSize = sink.offset - centralStart

  // 3. End of central directory record.
  sink.push(u32(EOCD_SIG))
  sink.push(u16(0)) // this disk number
  sink.push(u16(0)) // disk with central dir
  sink.push(u16(built.length)) // entries on this disk
  sink.push(u16(built.length)) // total entries
  sink.push(u32(centralSize))
  sink.push(u32(centralStart)) // central dir offset
  sink.push(u16(0)) // comment length

  return sink.done()
}

// ── STORED-ZIP READER (used by the hellgate to PROVE the archive is valid) ───
// Minimal central-directory + local-header parser. STORED-only (method 0):
// the stored bytes ARE the part bytes, so there is no inflate to trust. We
// re-derive every CRC-32 and verify it against the header.

export interface ParsedZipEntry {
  readonly path: string
  readonly data: Uint8Array
  /** CRC-32 recorded in the central directory header. */
  readonly storedCrc: number
  /** CRC-32 we recomputed over `data` — must equal `storedCrc`. */
  readonly computedCrc: number
  readonly method: number
}

const readU16 = (b: Uint8Array, o: number): number => (b[o] as number) | ((b[o + 1] as number) << 8)
const readU32 = (b: Uint8Array, o: number): number =>
  ((b[o] as number) |
    ((b[o + 1] as number) << 8) |
    ((b[o + 2] as number) << 16) |
    ((b[o + 3] as number) << 24)) >>>
  0

/**
 * Parse a STORED ZIP back into its entries by walking the central directory
 * (the authoritative index a real reader uses). Throws on a malformed archive
 * (bad EOCD/central/local signatures, or a non-STORED method) — the hellgate
 * relies on these throws to prove the writer produced a well-formed container.
 */
export const parseStoredZip = (zip: Uint8Array): ParsedZipEntry[] => {
  // Find EOCD by scanning from the end for its signature (no trailing comment
  // in our output, but scan anyway for robustness).
  let eocd = -1
  for (let i = zip.length - 22; i >= 0; i--) {
    if (readU32(zip, i) === EOCD_SIG) {
      eocd = i
      break
    }
  }
  if (eocd < 0) throw new Error("zip: end-of-central-directory record not found")
  const total = readU16(zip, eocd + 10)
  const centralOffset = readU32(zip, eocd + 16)

  const out: ParsedZipEntry[] = []
  let p = centralOffset
  for (let n = 0; n < total; n++) {
    if (readU32(zip, p) !== CENTRAL_SIG) {
      throw new Error(`zip: bad central-directory signature at entry ${n}`)
    }
    const method = readU16(zip, p + 10)
    const storedCrc = readU32(zip, p + 16)
    const compSize = readU32(zip, p + 20)
    const nameLen = readU16(zip, p + 28)
    const extraLen = readU16(zip, p + 30)
    const commentLen = readU16(zip, p + 32)
    const localOffset = readU32(zip, p + 42)
    const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen))

    // Cross-check against the local file header + extract the stored bytes.
    if (readU32(zip, localOffset) !== LOCAL_SIG) {
      throw new Error(`zip: bad local-header signature for "${name}"`)
    }
    if (method !== METHOD_STORED) {
      throw new Error(`zip: entry "${name}" is not STORED (method=${method})`)
    }
    const localNameLen = readU16(zip, localOffset + 26)
    const localExtraLen = readU16(zip, localOffset + 28)
    const dataStart = localOffset + 30 + localNameLen + localExtraLen
    const data = zip.subarray(dataStart, dataStart + compSize)
    out.push({
      path: name,
      data: new Uint8Array(data),
      storedCrc,
      computedCrc: crc32(data),
      method,
    })
    p += 46 + nameLen + extraLen + commentLen
  }
  return out
}

// ── GENERAL ZIP READER (STORED method 0 + DEFLATE method 8) ──────────────────
// `parseStoredZip` above is STORED-only + throws — it exists to PROVE the
// writer's output. `unzip` below is the READER the real `xlsx_read`/`docx_read`
// tools use: no-throw (typed result), and it INFLATES method-8 entries via
// `node:zlib.inflateRawSync` because real-world Office files are DEFLATE-
// compressed. Size caps guard against a hostile/corrupt archive declaring a
// huge uncompressed size (zip bomb / OOM).

const METHOD_DEFLATE = 8

/** Hard cap on a SINGLE entry's uncompressed size (32 MiB). An OOXML part of an
 *  ordinary document is a few KB–MB; 32 MiB is generous while bounding memory. */
export const ZIP_MAX_ENTRY_BYTES = 32 * 1024 * 1024
/** Hard cap on the SUM of all uncompressed entries (64 MiB). */
export const ZIP_MAX_TOTAL_BYTES = 64 * 1024 * 1024
/** Max number of entries in the central directory (defends against a header
 *  claiming millions of entries). */
export const ZIP_MAX_ENTRIES = 4096

/** A decoded entry from {@link unzip}: in-zip path + inflated/raw bytes. */
export interface UnzippedEntry {
  readonly path: string
  readonly data: Uint8Array
}

/** Typed, NO-THROW result of {@link unzip}. */
export type UnzipResult =
  | { readonly ok: true; readonly entries: UnzippedEntry[] }
  | { readonly ok: false; readonly error: string }

const failUnzip = (error: string): UnzipResult => ({ ok: false, error })

/**
 * Decode ONE entry's payload to its raw bytes, bounded by `entryCap` (the
 * smaller of the per-entry cap and the REMAINING total budget). STORED bytes
 * ARE the payload; DEFLATE is inflated with `maxOutputLength: entryCap` so zlib
 * ABORTS the moment output would exceed the budget — a DEFLATE bomb (tiny
 * payload, lying small declared size) can never allocate past the budget.
 * Returns the decoded bytes or a string error (NO-THROW: the inflate throw is
 * caught and converted to the same typed failure shape). Extracted so `unzip`
 * stays under the biome cognitive-complexity cap.
 */
const decodeEntryPayload = (
  method: number,
  payload: Uint8Array,
  entryCap: number,
  name: string,
): { ok: true; data: Uint8Array } | { ok: false; error: string } => {
  if (method === METHOD_STORED) {
    if (payload.length > entryCap) {
      return { ok: false, error: `zip: entry "${name}" exceeds remaining size budget` }
    }
    return { ok: true, data: new Uint8Array(payload) }
  }
  if (method === METHOD_DEFLATE) {
    try {
      const inflated = inflateRawSync(Buffer.from(payload), { maxOutputLength: entryCap })
      if (inflated.length > entryCap) {
        return { ok: false, error: `zip: inflated "${name}" exceeds size budget` }
      }
      return {
        ok: true,
        data: new Uint8Array(inflated.buffer, inflated.byteOffset, inflated.byteLength),
      }
    } catch (e) {
      return { ok: false, error: `zip: inflate failed for "${name}": ${errMessage(e)}` }
    }
  }
  return { ok: false, error: `zip: entry "${name}" uses unsupported method ${method}` }
}

/**
 * Decode an entry's payload AND verify its CRC-32 against the central-directory
 * `storedCrc`. A tampered/corrupt `.xlsx`/`.docx`/`.pptx` whose decoded bytes do
 * not match its declared CRC is SILENT CORRUPTION (a spreadsheet that opens but
 * yields wrong cells); we surface it as a typed failure instead of accepting it.
 * Extracted from {@link unzip} so the main loop stays under the complexity cap.
 * NO-THROW (delegates to {@link decodeEntryPayload}, which catches inflate throws).
 */
const decodeAndVerifyCrc = (
  method: number,
  payload: Uint8Array,
  entryCap: number,
  name: string,
  storedCrc: number,
): { ok: true; data: Uint8Array } | { ok: false; error: string } => {
  const decoded = decodeEntryPayload(method, payload, entryCap, name)
  if (!decoded.ok) return decoded
  const actual = crc32(decoded.data)
  if (actual !== storedCrc >>> 0) {
    return {
      ok: false,
      error: `zip: CRC mismatch for "${name}" (declared ${storedCrc >>> 0}, computed ${actual}): corrupted or tampered archive`,
    }
  }
  return decoded
}

/**
 * Locate the End-Of-Central-Directory record by scanning backwards for its
 * signature (tolerating a trailing comment, bounded to the 0xFFFF max comment
 * length). Returns the EOCD offset or `-1` if absent. Pure helper extracted from
 * {@link unzip} to keep its cognitive complexity under the biome cap.
 */
const locateEocd = (zip: Uint8Array): number => {
  const scanFloor = Math.max(0, zip.length - 22 - 0xffff)
  for (let i = zip.length - 22; i >= scanFloor; i--) {
    if (readU32(zip, i) === EOCD_SIG) return i
  }
  return -1
}

/** One parsed central-directory record: the validated fields {@link unzip}
 *  needs plus the sliced (still-compressed) payload + the stride to the next
 *  record. The byte-window/offset validation lives in {@link readCentralRecord}. */
interface CentralRecord {
  readonly name: string
  readonly method: number
  readonly storedCrc: number
  readonly uncompSize: number
  readonly payload: Uint8Array
  /** Bytes from `p` to the next central record (`46 + name + extra + comment`). */
  readonly stride: number
}

/**
 * Parse + validate ONE central-directory record at offset `p`: bounds-check the
 * header window and name, decode the name, cross-check the local header, and
 * slice the (possibly compressed) payload bounded to the archive. Returns the
 * record or a typed error (NO-THROW). Extracted from {@link unzip} so the main
 * loop carries only the cap-accounting + decode branches.
 *
 * Behavior is byte-identical to the inlined original: the SAME checks in the
 * SAME order produce the SAME error strings.
 */
const readCentralRecord = (
  zip: Uint8Array,
  p: number,
  n: number,
): { ok: true; record: CentralRecord } | { ok: false; error: string } => {
  if (p + 46 > zip.length) {
    return { ok: false, error: `zip: truncated central directory at entry ${n}` }
  }
  if (readU32(zip, p) !== CENTRAL_SIG) {
    return { ok: false, error: `zip: bad central-directory signature at entry ${n}` }
  }
  const method = readU16(zip, p + 10)
  const storedCrc = readU32(zip, p + 16)
  const compSize = readU32(zip, p + 20)
  const uncompSize = readU32(zip, p + 24)
  const nameLen = readU16(zip, p + 28)
  const extraLen = readU16(zip, p + 30)
  const commentLen = readU16(zip, p + 32)
  const localOffset = readU32(zip, p + 42)
  if (p + 46 + nameLen > zip.length)
    return { ok: false, error: `zip: truncated name at entry ${n}` }
  const name = new TextDecoder().decode(zip.subarray(p + 46, p + 46 + nameLen))

  // Cheap early reject on the DECLARED size, in the SAME position as the original
  // inlined loop (after name decode, BEFORE touching the local header) so error
  // precedence is byte-identical: a record with both an oversized declared size
  // AND a bad local header still reports the size error first.
  if (uncompSize > ZIP_MAX_ENTRY_BYTES) {
    return { ok: false, error: `zip: entry "${name}" uncompressed size ${uncompSize} exceeds cap` }
  }

  if (localOffset + 30 > zip.length || readU32(zip, localOffset) !== LOCAL_SIG) {
    return { ok: false, error: `zip: bad local-header for "${name}"` }
  }
  const localNameLen = readU16(zip, localOffset + 26)
  const localExtraLen = readU16(zip, localOffset + 28)
  const dataStart = localOffset + 30 + localNameLen + localExtraLen
  if (dataStart + compSize > zip.length) {
    return { ok: false, error: `zip: payload for "${name}" runs past end of archive` }
  }
  return {
    ok: true,
    record: {
      name,
      method,
      storedCrc,
      uncompSize,
      payload: zip.subarray(dataStart, dataStart + compSize),
      stride: 46 + nameLen + extraLen + commentLen,
    },
  }
}

/**
 * Unzip an archive into its entries, supporting BOTH the STORED (method 0) and
 * DEFLATE (method 8) compression methods. No-throw: every malformed-input or
 * cap-violation case returns `{ok:false, error}` — the document readers depend
 * on this so a corrupt `.xlsx` surfaces as a typed `ToolResult`, never a crash.
 *
 * Walks the central directory (the authoritative index) and, for each entry,
 * cross-checks the local header, slices the (possibly compressed) payload, and:
 *   - method 0 (STORED): the payload bytes ARE the part bytes.
 *   - method 8 (DEFLATE): `inflateRawSync` the payload to the declared size.
 * Unknown methods → typed failure. The decoded bytes' CRC-32 is VERIFIED against
 * the central-directory CRC for EVERY entry; a mismatch (corrupt or tampered
 * payload) → typed `ok:false` failure rather than silently returning wrong data.
 *
 * Structure: header-parse + local-header cross-check + payload slice live in
 * {@link readCentralRecord}; payload decode + CRC verify in
 * {@link decodeAndVerifyCrc}; this body is the EOCD setup + per-entry cap
 * accounting only (keeping it under the cognitive-complexity cap).
 */
export const unzip = (zip: Uint8Array): UnzipResult => {
  if (zip.length < 22) return failUnzip("zip: too small to contain an EOCD record")

  const eocd = locateEocd(zip)
  if (eocd < 0) return failUnzip("zip: end-of-central-directory record not found")

  const total = readU16(zip, eocd + 10)
  const centralOffset = readU32(zip, eocd + 16)
  if (total > ZIP_MAX_ENTRIES) return failUnzip(`zip: too many entries (${total})`)
  if (centralOffset >= zip.length) return failUnzip("zip: central-directory offset out of range")

  const out: UnzippedEntry[] = []
  let totalUncompressed = 0
  let p = centralOffset

  for (let n = 0; n < total; n++) {
    const parsed = readCentralRecord(zip, p, n)
    if (!parsed.ok) return failUnzip(parsed.error)
    const { name, method, storedCrc, payload, stride } = parsed.record

    // The remaining TOTAL budget bounds this entry on top of the per-entry cap.
    // A hostile archive can declare tiny `uncompSize` for every entry (so the
    // pre-inflate declared-size check passes) while each payload ACTUALLY
    // inflates near the per-entry cap — N such entries would inflate to N×32 MiB,
    // blowing past the 64 MiB total even though no single entry trips its own cap.
    // We therefore cap each inflate by `min(per-entry, total budget left)` and
    // accumulate the ACTUAL decoded length, so the aggregate can never exceed
    // ZIP_MAX_TOTAL_BYTES regardless of the (lying) declared sizes.
    const remainingTotal = ZIP_MAX_TOTAL_BYTES - totalUncompressed
    const entryCap = Math.min(ZIP_MAX_ENTRY_BYTES, remainingTotal)
    // Budget already exhausted by prior entries — any non-trivial entry would
    // overflow. Reject with a clear total-cap message rather than letting a
    // zero `maxOutputLength` surface zlib's opaque range error. An entry whose
    // payload genuinely decodes to 0 bytes is vanishingly rare for real OOXML;
    // refusing it here is the safe, predictable bound.
    if (entryCap <= 0) return failUnzip("zip: total uncompressed size exceeds cap")

    // Decode, then VERIFY CRC-32 against the central-directory value. A payload
    // whose decoded bytes don't match its declared CRC is corrupt/tampered and
    // is rejected here — never returned as if it were valid data (silent
    // corruption would let a damaged spreadsheet yield wrong cells).
    const decoded = decodeAndVerifyCrc(method, payload, entryCap, name, storedCrc)
    if (!decoded.ok) return failUnzip(decoded.error)
    const data = decoded.data

    // Accumulate the ACTUAL decoded byte count (STORED payload length or the
    // inflated length) — never the declared `uncompSize` — so the total cap is
    // enforced against real allocation, immune to a lying central directory.
    totalUncompressed += data.length
    if (totalUncompressed > ZIP_MAX_TOTAL_BYTES) {
      return failUnzip("zip: total uncompressed size exceeds cap")
    }

    out.push({ path: name, data })
    p += stride
  }
  return { ok: true, entries: out }
}

/** Convenience: index {@link unzip} entries by path. Returns `undefined` on a
 *  failed unzip OR a missing part. Pure. */
export const findZipPart = (result: UnzipResult, path: string): Uint8Array | undefined => {
  if (!result.ok) return undefined
  return result.entries.find((e) => e.path === path)?.data
}
