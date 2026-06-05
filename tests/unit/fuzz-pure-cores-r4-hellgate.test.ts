/**
 * ROUND-4 adversarial audit — FUZZ / DIFFERENTIAL / PROPERTY-BASED lens.
 *
 * Rounds 1-3 used CRAFTED inputs. This round generates MANY random inputs from a
 * SEEDED deterministic PRNG (no wall randomness — `Math.random` is banned in
 * src and the test dir is scanned, so every input is a pure function of a fixed
 * seed + loop index, making any counterexample reproducible) and asserts the
 * INVARIANTS each pure core promises:
 *
 *   1. zip-store    `unzip(buildStoredZip(entries))` === entries byte-for-byte.
 *   2. xlsx OOXML   `parseXlsx(buildXlsx(cells))` recovers the sanitized value.
 *   3. retry-after  `parseRetryAfterMs` never returns NaN / negative; monotonic.
 *   4. passive-vcs  `classifyPassiveVcs` never throws, terminates fast, and a
 *                   non-git command NEVER yields an event.
 *
 * Each property runs ≥200 iterations. A counterexample is MINIMIZED into a named
 * crafted regression case adjacent to its fuzz loop (so a fix is provably the
 * fix and the loop stays a permanent guard).
 *
 * Pure: no FS, no network, no clock (the retry parser's `now` is injected).
 */

import { describe, expect, test } from "bun:test"
import { classifyPassiveVcs } from "@/git/passive-classify"
import { parseRetryAfterMs } from "@/shared"
import { buildStoredZip, unzip, type ZipEntry } from "@/tool/document/authoring/zip-store"
import { buildXlsx, type XlsxSpec } from "@/tool/document/authoring/xlsx"
import { sanitizeSheetName } from "@/tool/document/authoring/xlsx"
import { stripIllegalXmlChars } from "@/tool/document/authoring/ooxml"
import { parseXlsx } from "@/tool/document/xlsx-read"

/* ===================================================== seeded PRNG (xorshift32) */
// A tiny xorshift32 — fully deterministic, reproducible from a fixed seed. We
// vary inputs by the loop index (re-seeding per iteration) so a failing iter is
// trivially reproduced by re-running with that seed.
class Rng {
  private s: number
  constructor(seed: number) {
    // Avoid the zero fixed-point; xorshift dies at 0.
    this.s = seed >>> 0 || 0x9e3779b9
  }
  next(): number {
    let x = this.s
    x ^= x << 13
    x ^= x >>> 17
    x ^= x << 5
    this.s = x >>> 0
    return this.s
  }
  /** Uniform integer in [0, n). */
  int(n: number): number {
    return n <= 0 ? 0 : this.next() % n
  }
  /** Uniform float in [0, 1). */
  float(): number {
    return this.next() / 0x100000000
  }
  bool(): boolean {
    return (this.next() & 1) === 1
  }
}

/* ========================================================= 1. ZIP ROUND-TRIP == */

describe("FUZZ r4: zip-store STORED round-trip identity", () => {
  // Byte alphabet weighted toward the danger bytes (0x00, 0xFF) plus the full
  // range, so a byte that survives write but corrupts on read is hit often.
  const randomBytes = (rng: Rng, len: number): Uint8Array => {
    const b = new Uint8Array(len)
    for (let i = 0; i < len; i++) {
      const roll = rng.int(5)
      b[i] = roll === 0 ? 0x00 : roll === 1 ? 0xff : rng.int(256)
    }
    return b
  }

  // Path alphabet: ascii, spaces, unicode (multi-byte UTF-8), the danger chars
  // a ZIP name might carry. We avoid duplicate paths (the writer's contract) by
  // prefixing each entry with its index.
  const PATH_CHARS = [
    "a",
    "Z",
    "0",
    "_",
    "-",
    ".",
    "/",
    " ",
    "é",
    "你",
    "𝟙", // astral (surrogate pair)
    "ñ",
  ]
  const randomPath = (rng: Rng, idx: number): string => {
    const len = 1 + rng.int(12)
    let s = `${idx}/`
    for (let i = 0; i < len; i++) s += PATH_CHARS[rng.int(PATH_CHARS.length)]
    return s
  }

  const bytesEqual = (a: Uint8Array, b: Uint8Array): boolean => {
    if (a.length !== b.length) return false
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
    return true
  }

  test("≥200 random entry-sets round-trip byte-for-byte (STORED)", () => {
    const ITERS = 240
    for (let iter = 0; iter < ITERS; iter++) {
      const rng = new Rng(0x5a17 + iter * 2654435761)
      const count = rng.int(6) // 0..5 entries (incl. empty archive)
      const entries: ZipEntry[] = []
      for (let i = 0; i < count; i++) {
        // Heavily vary sizes: empty, tiny, near a few KB.
        const roll = rng.int(4)
        const len = roll === 0 ? 0 : roll === 1 ? 1 + rng.int(8) : rng.int(3000)
        entries.push({ path: randomPath(rng, i), data: randomBytes(rng, len) })
      }

      const zip = buildStoredZip(entries)
      const result = unzip(zip)
      expect(result.ok).toBe(true)
      if (!result.ok) {
        throw new Error(`iter ${iter}: unzip failed: ${result.error}`)
      }
      expect(result.entries.length).toBe(entries.length)
      for (let i = 0; i < entries.length; i++) {
        const orig = entries[i] as ZipEntry
        const got = result.entries[i]
        if (got === undefined) throw new Error(`iter ${iter}: missing entry ${i}`)
        if (got.path !== orig.path) {
          throw new Error(`iter ${iter}: path drift "${orig.path}" -> "${got.path}"`)
        }
        if (!bytesEqual(got.data, orig.data)) {
          throw new Error(`iter ${iter}: data corruption on entry ${i} ("${orig.path}")`)
        }
      }
    }
  })

  // Larger-entry stress near (but under) the per-entry cap is too slow to fuzz
  // 200×; one crafted case proves a multi-KB binary payload round-trips.
  test("crafted: 100 KiB all-0xFF payload round-trips", () => {
    const data = new Uint8Array(100 * 1024).fill(0xff)
    const result = unzip(buildStoredZip([{ path: "big.bin", data }]))
    expect(result.ok).toBe(true)
    if (result.ok) expect(bytesEqual(result.entries[0]?.data ?? new Uint8Array(), data)).toBe(true)
  })

  // Many entries (entry-count boundary toward — but under — the 4096 cap).
  test("crafted: 1000 tiny entries round-trip (entry-count stress)", () => {
    const entries: ZipEntry[] = []
    for (let i = 0; i < 1000; i++) {
      entries.push({ path: `p/${i}.bin`, data: Uint8Array.from([i & 0xff, (i >>> 8) & 0xff]) })
    }
    const result = unzip(buildStoredZip(entries))
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.entries.length).toBe(1000)
      expect(Array.from(result.entries[500]?.data ?? [])).toEqual([500 & 0xff, (500 >>> 8) & 0xff])
    }
  })
})

/* =================================================== 2. OOXML XLSX ROUND-TRIP == */

describe("FUZZ r4: xlsx OOXML write→read value round-trip", () => {
  // String alphabet stuffed with XML metachars, the `]]>` CDATA-terminator,
  // control chars, unicode, and entity-lookalikes that a naive (double-)escape
  // would corrupt.
  const STR_CHARS = [
    "a",
    "Z",
    "0",
    " ",
    "<",
    ">",
    "&",
    '"',
    "'",
    "]]>",
    "&amp;",
    "&lt;",
    "&#65;",
    "&#x41;",
    "\t",
    "é",
    "你",
    "𝟙",
    String.fromCharCode(0x01), // SOH control — stripped by stripIllegalXmlChars
    String.fromCharCode(0x0b), // vertical tab — stripped
    String.fromCharCode(0xffff), // non-char — stripped
  ]

  const randomString = (rng: Rng): string => {
    const len = rng.int(10) // 0..9 tokens → includes empty string
    let s = ""
    for (let i = 0; i < len; i++) s += STR_CHARS[rng.int(STR_CHARS.length)]
    return s
  }

  // The value the READER should recover for a written string cell: the writer
  // applies stripIllegalXmlChars then escapes; the reader unescapes. So the
  // round-trip fixed point is `stripIllegalXmlChars(original)`. (Empty / stripped-
  // to-empty cells are OMITTED on write → recovered as "".)
  const expectedRecovered = (original: string): string => stripIllegalXmlChars(original)

  test("≥200 random cell grids: parseXlsx(buildXlsx) recovers stripped value", () => {
    const ITERS = 240
    for (let iter = 0; iter < ITERS; iter++) {
      const rng = new Rng(0xc0ffee + iter * 40503)
      const nRows = 1 + rng.int(5)
      const nCols = 1 + rng.int(5)
      const grid: (string | number | boolean | null)[][] = []
      // Track what we expect to read back at each (r,c).
      const expected: string[][] = []
      for (let r = 0; r < nRows; r++) {
        const row: (string | number | boolean | null)[] = []
        const exp: string[] = []
        for (let c = 0; c < nCols; c++) {
          const kind = rng.int(6)
          if (kind === 0) {
            // empty cell (null) — omitted on write, read back as ""
            row.push(null)
            exp.push("")
          } else if (kind === 1) {
            row.push("")
            exp.push("")
          } else if (kind === 2) {
            const num = (rng.int(20000) - 10000) / (rng.bool() ? 1 : 7)
            row.push(num)
            exp.push(String(num))
          } else if (kind === 3) {
            const b = rng.bool()
            row.push(b)
            exp.push(b ? "TRUE" : "FALSE")
          } else {
            const s = randomString(rng)
            row.push(s)
            // A string that strips to "" is ALSO omitted on write → "".
            exp.push(expectedRecovered(s))
          }
        }
        grid.push(row)
        expected.push(exp)
      }

      const spec: XlsxSpec = { sheets: [{ name: "S", rows: grid }] }
      const bytes = buildXlsx(spec)
      const parsed = parseXlsx(bytes)
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) throw new Error(`iter ${iter}: parse failed: ${parsed.error}`)
      const sheet = parsed.sheets[0]
      if (sheet === undefined) throw new Error(`iter ${iter}: no sheet`)

      for (let r = 0; r < nRows; r++) {
        for (let c = 0; c < nCols; c++) {
          const want = expected[r]?.[c] ?? ""
          const got = sheet.cellAt(r, c)
          if (got !== want) {
            throw new Error(
              `iter ${iter}: cell (${r},${c}) mismatch — wrote ${JSON.stringify(
                grid[r]?.[c],
              )}, expected ${JSON.stringify(want)}, got ${JSON.stringify(got)}`,
            )
          }
        }
      }
    }
  })

  // Crafted entity-confusion regressions (the classic double-escape traps).
  test("crafted: entity-lookalikes round-trip without double-unescape", () => {
    const cases = ["&amp;", "&lt;tag&gt;", "&#65;", "a&b<c>d\"e'f", "]]>", "&amp;amp;"]
    const spec: XlsxSpec = { sheets: [{ name: "S", rows: [cases] }] }
    const parsed = parseXlsx(buildXlsx(spec))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const sheet = parsed.sheets[0]
    if (sheet === undefined) return
    for (let i = 0; i < cases.length; i++) {
      expect(sheet.cellAt(0, i)).toBe(cases[i] as string)
    }
  })

  // Heavy mixed empty/non-empty pattern (R3 self-close positional drift lens):
  // sparse rows where only a few columns are populated must land at the RIGHT
  // column after the empty-cell omission.
  test("crafted: sparse columns keep positional placement", () => {
    // Row: [empty, "X", empty, empty, "Y"] — X must be col 1, Y must be col 4.
    const rows = [[null, "X", null, null, "Y"]]
    const parsed = parseXlsx(buildXlsx({ sheets: [{ name: "S", rows }] }))
    expect(parsed.ok).toBe(true)
    if (!parsed.ok) return
    const sheet = parsed.sheets[0]
    if (sheet === undefined) return
    expect(sheet.cellAt(0, 0)).toBe("")
    expect(sheet.cellAt(0, 1)).toBe("X")
    expect(sheet.cellAt(0, 2)).toBe("")
    expect(sheet.cellAt(0, 3)).toBe("")
    expect(sheet.cellAt(0, 4)).toBe("Y")
  })

  // Sheet-name sanitize is also a pure core in the round-trip; fuzz that a
  // sanitized name survives the workbook write→read.
  test("≥200 random sheet names survive write→read (sanitized)", () => {
    const NAME_CHARS = ["a", "Z", "0", " ", ":", "\\", "/", "?", "*", "[", "]", "é", "你"]
    const ITERS = 220
    for (let iter = 0; iter < ITERS; iter++) {
      const rng = new Rng(0xbeef01 + iter * 99991)
      const len = rng.int(40)
      let name = ""
      for (let i = 0; i < len; i++) name += NAME_CHARS[rng.int(NAME_CHARS.length)]
      const wantName = sanitizeSheetName(name, 0)
      const parsed = parseXlsx(buildXlsx({ sheets: [{ name, rows: [["v"]] }] }))
      expect(parsed.ok).toBe(true)
      if (!parsed.ok) continue
      expect(parsed.sheets[0]?.name).toBe(wantName)
    }
  })
})

/* ===================================================== 3. RETRY-AFTER PARSER == */

describe("FUZZ r4: parseRetryAfterMs invariants (never NaN/negative)", () => {
  const mkGet =
    (header: string, value: string | null) =>
    (name: string): string | null =>
      name === header ? value : null

  test("≥200 random header values never yield NaN/negative/Infinity", () => {
    const HEADERS = ["retry-after-ms", "retry-after", "x-ratelimit-reset"]
    const ITERS = 300
    const NOW = 1_700_000_000_000 // fixed ms-epoch (year 2023)
    for (let iter = 0; iter < ITERS; iter++) {
      const rng = new Rng(0xd00d + iter * 362437)
      const header = HEADERS[rng.int(HEADERS.length)] as string
      // Value-shape grab-bag: delta-secs, ms, epoch-s, epoch-ms, negative, huge,
      // garbage, empty, whitespace, fractional, HTTP-date, sign-prefixed.
      const shape = rng.int(14)
      let value: string
      switch (shape) {
        case 0:
          value = String(rng.int(3600))
          break // small delta-seconds
        case 1:
          value = String(rng.int(600000))
          break // ms-ish
        case 2:
          value = String(1_700_000_000 + rng.int(100000))
          break // epoch-seconds
        case 3:
          value = String(1_700_000_000_000 + rng.int(100000))
          break // epoch-ms
        case 4:
          value = String(-(rng.int(100000) + 1))
          break // negative
        case 5:
          value = String(rng.next() * rng.next())
          break // huge
        case 6:
          value = "garbage-" + rng.int(99)
          break
        case 7:
          value = ""
          break
        case 8:
          value = "   "
          break
        case 9:
          value = `${rng.int(1000)}.${rng.int(1000)}`
          break // fractional
        case 10:
          value = "Wed, 21 Oct 2026 07:28:00 GMT"
          break // HTTP-date
        case 11:
          value = `+${rng.int(1000)}`
          break // sign-prefixed
        case 12:
          value = String(Number.NaN)
          break // "NaN"
        case 13:
          value = String(rng.float() * 1e18)
          break // float in the ms-epoch band
        default:
          value = "0"
      }

      const out = parseRetryAfterMs(mkGet(header, value), () => NOW)
      if (out !== undefined) {
        if (Number.isNaN(out)) {
          throw new Error(`iter ${iter}: ${header}="${value}" -> NaN`)
        }
        if (!Number.isFinite(out)) {
          throw new Error(`iter ${iter}: ${header}="${value}" -> ${out} (non-finite)`)
        }
        if (out < 0) {
          throw new Error(`iter ${iter}: ${header}="${value}" -> ${out} (negative)`)
        }
      }
    }
  })

  // Monotonicity within the absolute-epoch bands: a LATER reset time must yield
  // a >= delay (for the same `now`). Property checked across random epochs.
  test("≥200 epoch resets: later reset → larger-or-equal delay (monotone)", () => {
    const ITERS = 220
    const NOW = 1_700_000_000_000
    for (let iter = 0; iter < ITERS; iter++) {
      const rng = new Rng(0xfeed + iter * 22695477)
      // epoch-SECONDS band: pick two future seconds-epochs, a < b.
      const baseS = 1_700_000_001 + rng.int(100000)
      const deltaS = 1 + rng.int(100000)
      const aSec = baseS
      const bSec = baseS + deltaS
      const da = parseRetryAfterMs(mkGet("x-ratelimit-reset", String(aSec)), () => NOW)
      const db = parseRetryAfterMs(mkGet("x-ratelimit-reset", String(bSec)), () => NOW)
      if (da !== undefined && db !== undefined && db < da) {
        throw new Error(`iter ${iter}: epoch-s monotonicity broken: ${aSec}->${da}, ${bSec}->${db}`)
      }
      // epoch-MILLISECONDS band.
      const baseMs = 1_700_000_000_001 + rng.int(100000)
      const aMs = baseMs
      const bMs = baseMs + 1 + rng.int(100000)
      const dam = parseRetryAfterMs(mkGet("x-ratelimit-reset", String(aMs)), () => NOW)
      const dbm = parseRetryAfterMs(mkGet("x-ratelimit-reset", String(bMs)), () => NOW)
      if (dam !== undefined && dbm !== undefined && dbm < dam) {
        throw new Error(`iter ${iter}: epoch-ms monotonicity broken`)
      }
    }
  })
})

/* ====================================================== 4. PASSIVE-VCS FUZZ == */

describe("FUZZ r4: classifyPassiveVcs total / no-throw / non-git-safe", () => {
  // Command alphabet: git/gh tokens, sequencing ops, flags, env prefixes, plus
  // pure-noise non-git command words. We separately assert the non-git subset.
  const CMD_TOKENS = [
    "git",
    "gh",
    "echo",
    "cat",
    "ls",
    "rm",
    "push",
    "merge",
    "rebase",
    "commit",
    "cherry-pick",
    "pr",
    "create",
    "--amend",
    "--dry-run",
    "-n",
    "--help",
    "-h",
    "&&",
    "||",
    ";",
    "|",
    "FOO=bar",
    "/usr/bin/git",
    "origin",
    "main",
    "feature",
    '"quoted git push"',
  ]
  const NON_GIT_FIRST = ["echo", "cat", "ls", "rm", "printf", "node", "python", "true"]

  // Stdout fragments that LOOK like git output (to bait false positives).
  const OUT_FRAGS = [
    "Fast-forward",
    "Merge made by the 'recursive' strategy.",
    "Successfully rebased and updated refs/heads/x.",
    "[main 1a2b3c4] subject",
    "[detached HEAD deadbeef] x",
    "HEAD is now at 1234567 msg",
    "   1a2b3c4..7654321  main -> main",
    " * [new branch]      feat -> feat",
    "https://github.com/o/r/pull/42",
    "Pull request #7",
    "Everything up-to-date",
    "",
    "\n\n",
    "garbage output",
    "0000000".repeat(50), // ReDoS bait: long hex-ish run
    "a".repeat(2000),
  ]

  const randomCommand = (rng: Rng, tokens: readonly string[], first?: string): string => {
    const n = 1 + rng.int(6)
    const parts: string[] = []
    if (first !== undefined) parts.push(first)
    for (let i = 0; i < n; i++) parts.push(tokens[rng.int(tokens.length)] as string)
    return parts.join(" ")
  }

  const randomStdout = (rng: Rng): string => {
    const n = rng.int(4)
    const parts: string[] = []
    for (let i = 0; i < n; i++) parts.push(OUT_FRAGS[rng.int(OUT_FRAGS.length)] as string)
    return parts.join("\n")
  }

  test("≥200 random inputs: never throws, terminates fast (<25ms each)", () => {
    const ITERS = 320
    for (let iter = 0; iter < ITERS; iter++) {
      const rng = new Rng(0xabcdef + iter * 16807)
      const command = randomCommand(rng, CMD_TOKENS)
      const stdout = randomStdout(rng)
      const exitCode = rng.int(3) === 0 ? rng.int(128) : 0
      const start = performance.now()
      expect(() => classifyPassiveVcs({ command, stdout, exitCode })).not.toThrow()
      const elapsed = performance.now() - start
      if (elapsed > 25) {
        throw new Error(`iter ${iter}: slow (${elapsed}ms) — possible ReDoS — cmd="${command}"`)
      }
    }
  })

  test("≥200 NON-git commands NEVER yield an event (even with git-looking stdout)", () => {
    const ITERS = 260
    for (let iter = 0; iter < ITERS; iter++) {
      const rng = new Rng(0x13579b + iter * 48271)
      // First word is a guaranteed-non-git command; remaining tokens are noise
      // that AVOID introducing a `&& git` segment (we only use non-control noise
      // plus quoted git words, which are arguments, not commands).
      const noiseTokens = ["foo", "bar", '"git push"', "'gh pr'", "--git", "origin", "main", "x"]
      const command = randomCommand(rng, noiseTokens, NON_GIT_FIRST[rng.int(NON_GIT_FIRST.length)])
      const stdout = randomStdout(rng)
      const ev = classifyPassiveVcs({ command, stdout, exitCode: 0 })
      if (ev !== null) {
        throw new Error(
          `iter ${iter}: phantom event from non-git command "${command}": ${JSON.stringify(ev)}`,
        )
      }
    }
  })

  test("crafted: echo of git-looking stdout yields no event", () => {
    expect(
      classifyPassiveVcs({ command: 'echo "Fast-forward"', stdout: "Fast-forward", exitCode: 0 }),
    ).toBeNull()
    expect(
      classifyPassiveVcs({
        command: "printf '%s' 'Pull request #9'",
        stdout: "Pull request #9",
        exitCode: 0,
      }),
    ).toBeNull()
  })
})
