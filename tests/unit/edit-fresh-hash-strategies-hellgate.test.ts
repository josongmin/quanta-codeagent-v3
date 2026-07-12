/** jul-13 hellgate — edit-fresh-hash ACROSS EVERY EDIT STRATEGY + ADVERSARIAL BYTE SHAPE.
 *
 *  The landed feature (gated `QUANTA_EDIT_FRESH_HASH`, ctx.editFreshHash) appends
 *  `\nfresh sha256: <hex> (pass as expected_hash ...)` to a SUCCESSFUL edit's
 *  output. The hex is `sha256Hex(planned.next)` — the POST-edit bytes, computed IN
 *  MEMORY. The whole point is that the model can feed that hex straight back as the
 *  NEXT same-file edit's `expected_hash` WITHOUT re-reading. That contract is a LIE
 *  the instant the advertised hash disagrees with what the file actually holds on
 *  disk — because the next `expected_hash` precondition recomputes the digest off
 *  the FRESH on-disk bytes (`sha256Hex(await fs.readFile(path))`).
 *
 *  The sibling tests (edit-fresh-hash-hellgate.test.ts) prove this for ONE plain
 *  exact edit, and lean on an in-memory READ==WRITE port that CANNOT observe a real
 *  FS round-trip. This file closes that gap MAXIMALLY:
 *
 *    - it uses the DEFAULT port (`makeEditTool()`), i.e. the real `@/storage`
 *      Bun-backed FS, against a real tmpdir, so read→splice→write→read-back is a
 *      genuine disk round-trip (an EOL / encoding / trailing-newline normalizer
 *      anywhere in that chain would make the advertised hash a provable lie);
 *    - it exercises EVERY edit strategy: exact single, replace_all (multi-site),
 *      line_ranges-scoped, and the fuzzy (whitespace-tolerant) ladder;
 *    - it exercises adversarial BYTE SHAPES: UTF-8 BOM, mixed CRLF/LF, lone CR /
 *      no-trailing-newline / newline-only, multibyte+emoji+combining+surrogate,
 *      edit-to-empty-file, and a 5000+ line file (no truncation);
 *    - EVERY case asserts `advertised === sha256Hex(<bytes read back off REAL disk
 *      with node:fs readFileSync>)` — the real effect, not the mock;
 *    - EVERY case carries a NEGATIVE CONTROL `advertised !== sha256Hex(<PRE-edit
 *      disk bytes>)` so a mutant that hashes `before` instead of `next` is caught
 *      (non-vacuity by design — the edit genuinely changed the bytes);
 *    - the EMITTED hex is pinned to exactly `[0-9a-f]{64}` followed by a space (no
 *      uppercase, no whitespace drift) so it is byte-reusable as `expected_hash`.
 *
 *  Mutation-resistance is structural: we observe the DISK, never the in-memory
 *  value the tool computed; and the NEGATIVE control means the assertion can only
 *  pass when the digest actually tracks the post-edit content.
 *
 *  ⚠️ NOTE on the BOM shape (empirically verified, not assumed): the default port
 *  reads via `Bun.file().text()`, which STRIPS a leading UTF-8 BOM. The tool
 *  therefore hashes and re-writes the BOM-STRIPPED content, so the BOM is DROPPED
 *  from disk by the edit. The post-edit `readFileSync(path,"utf8")` bytes we hash
 *  here consequently carry NO BOM — and the advertised hash matches them exactly.
 *  This is round-trip-consistent (what the tool wrote == what the next precondition
 *  will read), which is the only property that matters for the feature. */

import { afterAll, describe, expect, test } from "bun:test"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { defaultFileSystemPort, sha256Hex } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"

// The advertised line, verbatim from src/tool/edit/index.ts:
//   `\nfresh sha256: ${sha256Hex(planned.next)} (pass as expected_hash ...)`
// We pin the SHAPE strictly: 64 LOWERCASE hex, then a single space (before the
// `(pass as expected_hash ...)` suffix). An uppercased/space-drifted mutant of the
// emitter fails this capture ⇒ `advertised` is undefined ⇒ every assertion below
// blows up. This is the "byte-reusable as the next expected_hash" guarantee.
const FRESH_STRICT_RE = /fresh sha256: ([0-9a-f]{64}) /

/** ctx with the fresh-hash gate ON (the only surface the feature reads). */
const freshCtx = (cwd: string): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  editFreshHash: true,
})

const dir = mkdtempSync(join(tmpdir(), "edit-fresh-hash-strategies-"))
afterAll(() => rmSync(dir, { recursive: true, force: true }))

let seq = 0
/** A fresh, unique real file seeded with `content`. Returns its absolute path. */
const seedFile = (content: string): string => {
  const p = join(dir, `f${seq++}.txt`)
  writeFileSync(p, content, "utf8")
  return p
}

/** Drive the DEFAULT-port edit tool (real FS) and return the single ToolResult. */
const runEdit = async (input: Record<string, unknown>): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of makeEditTool().execute(input as never, freshCtx(dir))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

/**
 * The load-bearing harness for every case. Seeds a REAL file, snapshots its
 * PRE-edit bytes off disk (for the negative control), runs the edit through the
 * default (real-FS) port, then asserts:
 *
 *   1. the edit succeeded;
 *   2. the emitted hex has the strict `[0-9a-f]{64} ` shape (byte-reusable);
 *   3. advertised === sha256 of the ACTUAL post-edit disk bytes (readFileSync) —
 *      the real-effect observation. This is EXACTLY what the next same-file edit's
 *      `expected_hash` precondition will recompute off disk;
 *   4. NEGATIVE CONTROL: advertised !== sha256 of the PRE-edit disk bytes — a
 *      mutant that hashes `before` is caught, and the edit provably changed bytes
 *      (non-vacuity by construction);
 *   5. FULL ROUND-TRIP: the advertised hash actually UNLOCKS a real chained edit —
 *      feed it as `expected_hash` on a follow-up same-file edit and it must NOT go
 *      stale (this is the whole feature). Optional: only when `chain` is supplied.
 *
 * Returns the post-edit disk bytes so a caller can add shape-specific assertions
 * (e.g. "CRLF preserved", "file is now empty").
 */
const assertFreshHashMatchesDisk = async (
  seed: string,
  input: Record<string, unknown>,
  opts: { chain?: { old_string: string; new_string: string }; expectContent?: string } = {},
): Promise<string> => {
  const path = seedFile(seed)
  const preEditDisk = readFileSync(path, "utf8")

  const r = await runEdit({ ...input, path })
  expect(r.ok).toBe(true)
  expect(r.failure).toBeUndefined()

  // (2) strict emitted-hex shape.
  const m = r.output?.match(FRESH_STRICT_RE)
  expect(m).not.toBeNull()
  const advertised = m?.[1] as string
  expect(advertised).toMatch(/^[0-9a-f]{64}$/)

  // (3) advertised == sha256 of ACTUAL on-disk post-edit bytes.
  const postEditDisk = readFileSync(path, "utf8")
  expect(advertised).toBe(sha256Hex(postEditDisk))

  // (4) NEGATIVE CONTROL — hashing the PRE-edit bytes would differ (catches
  //     hashing `before`; also proves the edit genuinely mutated the file).
  expect(advertised).not.toBe(sha256Hex(preEditDisk))
  expect(postEditDisk).not.toBe(preEditDisk)

  // Extra belt: the advertised hash also equals what the tool's OWN read path
  // (Bun.file().text(), used by the precondition) will compute — the truest
  // "what the next expected_hash sees" observation.
  const toolReadback = await defaultFileSystemPort.readFile(path)
  expect(advertised).toBe(sha256Hex(toolReadback))

  if (opts.expectContent !== undefined) {
    expect(postEditDisk).toBe(opts.expectContent)
  }

  // (5) FULL ROUND-TRIP — the advertised hash unlocks a chained same-file edit.
  if (opts.chain !== undefined) {
    const r2 = await runEdit({
      path,
      old_string: opts.chain.old_string,
      new_string: opts.chain.new_string,
      expected_hash: advertised,
    })
    expect(r2.ok).toBe(true)
    expect(r2.failure).toBeUndefined()
  }

  return postEditDisk
}

describe("edit-fresh-hash — every edit STRATEGY (advertised == sha256 of real disk)", () => {
  test("1. EXACT single-occurrence edit", async () => {
    await assertFreshHashMatchesDisk(
      "let alpha = 1\nlet beta = 2\n",
      { old_string: "alpha = 1", new_string: "alpha = 99" },
      { chain: { old_string: "beta = 2", new_string: "beta = 3" } },
    )
  })

  test("2. replace_all with MULTIPLE occurrences (hash reflects ALL replacements)", async () => {
    // `foo` appears 3×; replace_all must change EVERY site, and the fresh hash
    // must be over the fully-replaced content. If only one site changed (a partial
    // mutant), sha256(disk) would still equal advertised (both read the same disk),
    // so we ALSO pin the exact expected content — 3 replacements, zero `foo` left.
    const post = await assertFreshHashMatchesDisk(
      "foo()\nx = foo\nreturn foo\n",
      { old_string: "foo", new_string: "bar", replace_all: true },
      { expectContent: "bar()\nx = bar\nreturn bar\n" },
    )
    expect(post).not.toContain("foo")
    // 3 occurrences of `bar` landed.
    expect(post.split("bar").length - 1).toBe(3)
  })

  test("3. line_ranges-scoped edit (only the in-range occurrence changes)", async () => {
    // `dup = 1` on both line 1 and line 4. Scope to lines 3-5 ⇒ ONLY the line-4
    // occurrence is edited; line 1 stays. The fresh hash is over that scoped result.
    const post = await assertFreshHashMatchesDisk(
      "dup = 1\nmid\nspacer\ndup = 1\ntail\n",
      { old_string: "dup = 1", new_string: "dup = 2", line_ranges: [{ start: 3, end: 5 }] },
      { expectContent: "dup = 1\nmid\nspacer\ndup = 2\ntail\n" },
    )
    // Exactly one site changed: line 1 still `dup = 1`, line 4 now `dup = 2`.
    expect(post.split("\n")[0]).toBe("dup = 1")
    expect(post.split("\n")[3]).toBe("dup = 2")
  })

  test("4. fuzzy match path (whitespace-differing old_string, fuzzy=true)", async () => {
    // The file line has COLLAPSED internal whitespace vs the caller's old_string
    // (extra spaces). Exact match fails; fuzzy=true rescues it. The fresh hash is
    // over the fuzzily-applied on-disk result.
    const post = await assertFreshHashMatchesDisk(
      "const   spaced   =   1\nother = 2\n",
      // old_string differs only by internal whitespace runs — exact would miss.
      { old_string: "const spaced = 1", new_string: "const spaced = 42", fuzzy: true },
    )
    expect(post).toContain("42")
    expect(post).toContain("other = 2")
  })
})

describe("edit-fresh-hash — adversarial BYTE SHAPES (real round-trip fidelity)", () => {
  test("5. UTF-8 BOM-prefixed file (BOM behavior verified; hash tracks real disk)", async () => {
    // The default port strips the leading BOM on read, so the edit re-writes the
    // BOM-stripped content. The advertised hash MUST equal sha256 of whatever
    // actually lands on disk — which the harness reads back via readFileSync.
    const bom = "﻿"
    const post = await assertFreshHashMatchesDisk(
      `${bom}let a = 1\nlet b = 2\n`,
      { old_string: "a = 1", new_string: "a = 7" },
      { chain: { old_string: "b = 2", new_string: "b = 8" } },
    )
    expect(post).toContain("a = 7")
  })

  test("6. mixed EOL — some CRLF, some LF — per-line terminators preserved; hash == disk", async () => {
    // Lines 1 & 3 are CRLF-terminated; line 2 is LF-terminated. The edit touches
    // line 2 only. A whole-file EOL normalizer would rewrite lines 1/3 and make the
    // advertised (in-memory) hash disagree with the (normalized) disk bytes.
    const post = await assertFreshHashMatchesDisk(
      "first = 1\r\nsecond = 2\nthird = 3\r\n",
      { old_string: "second = 2", new_string: "second = 20" },
    )
    // Untouched CRLF lines kept their exact terminators; the edited LF line too.
    expect(post).toBe("first = 1\r\nsecond = 20\nthird = 3\r\n")
    // Sanity: mixed terminators genuinely coexist on disk.
    expect(post).toContain("\r\n")
    expect(post).toMatch(/second = 20\n/)
  })

  test("7a. lone CR (no LF) preserved; hash == disk", async () => {
    // A bare CR is NOT a line terminator to the \r?\n splitter — it lives inside the
    // line content. An over-eager normalizer that turns CR into CRLF/LF would drift
    // the disk bytes away from the advertised hash.
    const post = await assertFreshHashMatchesDisk(
      "keep\rthis line\nedit = 1\n",
      { old_string: "edit = 1", new_string: "edit = 2" },
    )
    expect(post).toBe("keep\rthis line\nedit = 2\n")
    expect(post).toContain("\r")
    expect(post).not.toContain("\r\n")
  })

  test("7b. NO trailing newline preserved; hash == disk", async () => {
    const post = await assertFreshHashMatchesDisk(
      "line1\nlast = 1", // no final newline
      { old_string: "last = 1", new_string: "last = 2" },
    )
    expect(post).toBe("line1\nlast = 2")
    // The trailing newline was NOT silently added back.
    expect(post.endsWith("\n")).toBe(false)
  })

  test("7c. file that is ONLY a newline; hash == disk", async () => {
    // Edit a single-newline file into non-empty. The digest must be over the exact
    // post-edit bytes (an appended/stripped newline would break the round-trip).
    const post = await assertFreshHashMatchesDisk(
      "\n",
      // old_string "\n" is unique; replace it with a real line + trailing newline.
      { old_string: "\n", new_string: "x = 1\n" },
    )
    expect(post).toBe("x = 1\n")
  })

  test("8. multibyte + emoji + combining chars + surrogate pairs in the edited region", async () => {
    // 한글 (multibyte), 👩‍🚀 (ZWJ emoji sequence = multiple surrogate pairs + ZWJ),
    // é as e + U+0301 combining acute (combining char). The edit lands INSIDE this
    // region; UTF-8 round-trip must be byte-exact or the hash lies.
    const emoji = "👩‍🚀" // woman astronaut (ZWJ sequence)
    const combining = "é" // é as base + combining acute
    const post = await assertFreshHashMatchesDisk(
      `한글 ${emoji} ${combining} val = 1\ntail = 0\n`,
      { old_string: "val = 1", new_string: "val = 2" },
      { chain: { old_string: "tail = 0", new_string: "tail = 9" } },
    )
    // The multibyte / emoji / combining region survived verbatim around the edit.
    expect(post).toContain(emoji)
    expect(post).toContain(combining)
    expect(post).toContain("한글")
    expect(post).toContain("val = 2")
  })

  test("9. edit whose RESULT is an EMPTY file (old_string == whole content)", async () => {
    // Delete the entire content: old_string is the whole file, new_string "".
    // The post-edit disk file is genuinely empty; sha256("") must be advertised.
    const whole = "everything = 1\ngoes = 2\n"
    const post = await assertFreshHashMatchesDisk(
      whole,
      { old_string: whole, new_string: "" },
      { expectContent: "" },
    )
    expect(post).toBe("")
    expect(post.length).toBe(0)
    // Explicit: the advertised hash equals the canonical sha256 of the empty string.
    const path = join(dir, "empty-explicit.txt")
    writeFileSync(path, whole, "utf8")
    const r = await runEdit({ path, old_string: whole, new_string: "" })
    const adv = r.output?.match(FRESH_STRICT_RE)?.[1]
    expect(adv).toBe(sha256Hex(""))
  })

  test("10. very large file (5000+ lines) — hash still exact, no truncation", async () => {
    const N = 5200
    const lines: string[] = []
    for (let i = 0; i < N; i++) lines.push(`line ${i} = ${i}`)
    // Insert a UNIQUE marker deep in the file so the edit target is unambiguous.
    const marker = "line 3777 = 3777"
    const big = `${lines.join("\n")}\n`
    const post = await assertFreshHashMatchesDisk(
      big,
      { old_string: marker, new_string: "line 3777 = CHANGED" },
    )
    // The whole large file round-tripped: first and last lines intact, marker edited.
    expect(post.startsWith("line 0 = 0\n")).toBe(true)
    expect(post.endsWith(`line ${N - 1} = ${N - 1}\n`)).toBe(true)
    expect(post).toContain("line 3777 = CHANGED")
    expect(post.split("\n").length).toBe(N + 1) // N lines + trailing empty
  })
})
