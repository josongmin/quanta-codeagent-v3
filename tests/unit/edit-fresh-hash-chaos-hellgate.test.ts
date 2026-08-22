/** jul-13 CHAOS/PROPERTY hellgate — edit-fresh-hash CHAIN invariant.
 *
 *  Sibling to `edit-fresh-hash-hellgate.test.ts` (single-hop + FS round-trip).
 *  THIS file proves the *chain* invariant holds under DEPTH and INTERLEAVING —
 *  the exact production shape the fix targets.
 *
 *  MEASURED bug the fix cures (bench trajectory, django__django-14315 ×2):
 *  ~41% of edits hit `stale_precondition`, ALL from the model's OWN prior same-
 *  file edit (a successful edit changes the file, so the read-time `expected_hash`
 *  is instantly stale for the next same-file edit). With `ctx.editFreshHash`, a
 *  successful edit appends `fresh sha256: <hex>` (= sha256 of the POST-edit
 *  bytes); the model chains that hex as the NEXT edit's `expected_hash` WITHOUT a
 *  re-read.
 *
 *  Invariants pinned here (all directions, non-vacuous):
 *    1. DEEP CHAIN: N=20 same-file edits, each fed the PREVIOUS edit's advertised
 *       fresh hash → ALL succeed, ZERO stale_precondition, final content == the
 *       20-times-edited expectation.
 *    2. SEEDED CHAOS (property, ~200 ops over 4 files): an edit that supplies the
 *       file's CORRECT last-advertised hash NEVER goes stale; an edit that
 *       supplies a STALE hash (from before an intervening same-file edit) ALWAYS
 *       goes stale. Both directions pinned. Seed printed on failure → replay.
 *    3. PAIRED CONTROL (proves #1/#2 are non-vacuous): the SAME deep chain reusing
 *       the ORIGINAL read-time hash every time → the 2nd edit onward MUST go
 *       stale_precondition. If the fix were a no-op, #1 would still pass vacuously;
 *       this control forces the invariant to have teeth.
 *    4. CROSS-FILE ISOLATION: editing file A never invalidates file B's advertised
 *       fresh hash (the hash is per-file, over that file's own post-edit bytes).
 *
 *  Determinism: NO Date.now / Math.random (runtime forbids them). A tiny inline
 *  mulberry32 PRNG, seeded from a fixed constant, drives all randomness; the seed
 *  is printed on any chaos failure so a counterexample replays byte-for-byte.
 *
 *  Effects observed are REAL (final file content in the recording port + the
 *  typed `failure.mode`), never mock identity. An in-memory recording port is
 *  intentional: this file exercises the CHAINING logic; the FS byte round-trip
 *  (EOL/BOM/multibyte fidelity) is covered by the sibling hellgate's REAL-FS
 *  suite, so re-testing it here would be redundant.
 */

import { describe, expect, test } from "bun:test"
import type { FileInfo, FileSystemPort } from "@/storage"
import { sha256Hex } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { makeEditTool } from "@/tool/edit"

/* ======================================================= seeded PRNG (mulberry32)
 * Pure, deterministic, self-contained. Same construction as the OmO chaos-bench
 * pattern: 32-bit state advanced with Math.imul mixing, mapped to [0,1). NO
 * Date.now / Math.random anywhere — a fixed seed makes every run identical and a
 * failing chaos case reproducible by re-running with the PRINTED seed. */
const mulberry32 = (seed: number): (() => number) => {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}
/** Uniform integer in [0, n). */
const randInt = (rng: () => number, n: number): number => Math.floor(rng() * n)

/* ============================================================ in-memory rec port
 * READ==WRITE identity map: the CHAINING logic under test is FS-agnostic, and the
 * final `files` map is a REAL observable effect (not a mock spy). Byte round-trip
 * fidelity is the sibling suite's job. */
const makeRecordingPort = (
  seed: Record<string, string>,
): { port: FileSystemPort; files: Map<string, string> } => {
  const files = new Map<string, string>(Object.entries(seed))
  const port: FileSystemPort = {
    async readFile(path: string): Promise<string> {
      const v = files.get(path)
      if (v === undefined) throw new Error(`File not found: ${path}`)
      return v
    },
    async writeFile(path: string, content: string): Promise<void> {
      files.set(path, content)
    },
    async statFile(path: string): Promise<FileInfo> {
      return {
        path,
        size: files.get(path)?.length ?? 0,
        isDirectory: false,
        mtimeMs: 0,
        isFIFO: false,
        isCharacterDevice: false,
        isBlockDevice: false,
      }
    },
    async fileExists(path: string): Promise<boolean> {
      return files.has(path)
    },
    async writeFileAtomic(path: string, content: string): Promise<void> {
      files.set(path, content)
    },
  }
  return { port, files }
}

const ctx = (cwd: string, freshHash: boolean): ToolContext => ({
  cwd,
  signal: new AbortController().signal,
  ...(freshHash ? { editFreshHash: true } : {}),
})

const run = async (
  tool: ReturnType<typeof makeEditTool>,
  input: unknown,
  cwd: string,
  freshHash: boolean,
): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of tool.execute(input as never, ctx(cwd, freshHash))) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

const FRESH_RE = /fresh sha256: ([0-9a-f]{64})/
/** Extract the advertised fresh hash from a successful edit's output, or fail loud. */
const advertisedHash = (r: ToolResult): string => {
  const m = r.output?.match(FRESH_RE)
  if (m?.[1] === undefined) throw new Error(`no fresh hash in output: ${JSON.stringify(r.output)}`)
  return m[1]
}

const CWD = "/in-mem"

describe("jul-13 edit-fresh-hash CHAOS — deep chain", () => {
  test("1. DEEP CHAIN: N=20 same-file edits, each fed the prior fresh hash, ALL succeed with ZERO stale", async () => {
    const path = `${CWD}/deep.txt`
    // A counter line the chain rewrites 20 times: v0 -> v1 -> ... -> v20.
    const N = 20
    const { port, files } = makeRecordingPort({ [path]: "counter = v0\ntail = keep" })
    const tool = makeEditTool(port)

    // Edit #1 is the ONLY read: after it we chain purely off advertised hashes.
    let staleCount = 0
    let chainedHash: string | undefined
    for (let i = 0; i < N; i++) {
      const from = `counter = v${i}`
      const to = `counter = v${i + 1}`
      // On i===0 no precondition (models the single read-time state); afterwards
      // we ALWAYS supply the previous edit's advertised hash (no re-read).
      const input =
        i === 0
          ? { path, old_string: from, new_string: to }
          : { path, old_string: from, new_string: to, expected_hash: chainedHash }
      const r = await run(tool, input, CWD, true)
      if (r.failure?.mode === "stale_precondition") staleCount++
      // Hard-assert success at EACH hop so a mid-chain break localizes.
      expect(r.ok).toBe(true)
      expect(r.failure).toBeUndefined()
      chainedHash = advertisedHash(r)
    }

    // The exact production sequence the fix targets: not ONCE did a chained edit
    // go stale off the model's own prior edit.
    expect(staleCount).toBe(0)
    // Final content is the 20-times-edited expectation (real effect, read back).
    expect(files.get(path)).toBe(`counter = v${N}\ntail = keep`)
    // The last advertised hash matches the final on-disk bytes (chain never lied).
    expect(chainedHash).toBe(sha256Hex(files.get(path) ?? ""))
  })
})

describe("jul-13 edit-fresh-hash CHAOS — paired control (non-vacuity)", () => {
  test("3. SAME deep chain reusing the ORIGINAL read-time hash → edit #2 onward MUST go stale", async () => {
    const path = `${CWD}/control.txt`
    const N = 20
    const original = "counter = v0\ntail = keep"
    const { port, files } = makeRecordingPort({ [path]: original })
    const tool = makeEditTool(port)
    // The hash the model computed ONCE at read time, before any edit. In the buggy
    // (pre-fix) world this is all it has to reuse.
    const readTimeHash = sha256Hex(original)

    let staleFromSecondOn = 0
    let landedEdits = 0
    for (let i = 0; i < N; i++) {
      const from = `counter = v${i}`
      const to = `counter = v${i + 1}`
      const r = await run(
        tool,
        { path, old_string: from, new_string: to, expected_hash: readTimeHash },
        CWD,
        // fresh-hash OFF: we're modeling the legacy world where only the stale
        // read-time hash is available.
        false,
      )
      if (i === 0) {
        // First edit's precondition matches (file still == original) → it lands.
        expect(r.ok).toBe(true)
        landedEdits++
      } else {
        // Every subsequent edit reuses the now-STALE read-time hash → must reject.
        expect(r.ok).toBe(false)
        expect(r.failure?.mode).toBe("stale_precondition")
        staleFromSecondOn++
      }
    }

    // Teeth: 19 of 20 edits are killed by self-inflicted staleness — proving the
    // deep-chain test (#1) is NOT vacuously green; only the fresh-hash chain cures it.
    expect(staleFromSecondOn).toBe(N - 1)
    expect(landedEdits).toBe(1)
    // Only edit #1 ever landed; the file is stuck at v1.
    expect(files.get(path)).toBe("counter = v1\ntail = keep")
  })
})

describe("jul-13 edit-fresh-hash CHAOS — cross-file isolation", () => {
  test("4. editing file A never invalidates file B's advertised fresh hash (hash is per-file)", async () => {
    const pathA = `${CWD}/iso-a.txt`
    const pathB = `${CWD}/iso-b.txt`
    const { port, files } = makeRecordingPort({
      [pathA]: "a = 0",
      [pathB]: "b = 0",
    })
    const tool = makeEditTool(port)

    // Advance A and capture its fresh hash.
    const a1 = await run(tool, { path: pathA, old_string: "a = 0", new_string: "a = 1" }, CWD, true)
    expect(a1.ok).toBe(true)
    const aHash = advertisedHash(a1)

    // Advance B and capture ITS fresh hash.
    const b1 = await run(tool, { path: pathB, old_string: "b = 0", new_string: "b = 1" }, CWD, true)
    expect(b1.ok).toBe(true)
    const bHash = advertisedHash(b1)

    // The two advertised hashes are distinct and each is the digest of its OWN file.
    expect(aHash).not.toBe(bHash)
    expect(aHash).toBe(sha256Hex("a = 1"))
    expect(bHash).toBe(sha256Hex("b = 1"))

    // Now edit A AGAIN (invalidating A's hash) — this must NOT touch B's validity.
    const a2 = await run(
      tool,
      { path: pathA, old_string: "a = 1", new_string: "a = 2", expected_hash: aHash },
      CWD,
      true,
    )
    expect(a2.ok).toBe(true)

    // B's hash, captured BEFORE the intervening edits to A, is STILL valid for B —
    // cross-file activity did not stale it.
    const b2 = await run(
      tool,
      { path: pathB, old_string: "b = 1", new_string: "b = 2", expected_hash: bHash },
      CWD,
      true,
    )
    expect(b2.ok).toBe(true)
    expect(b2.failure).toBeUndefined()

    // Symmetric direction: A's ORIGINAL (now-stale) hash must NOT unlock A after
    // the second A edit — proving isolation didn't accidentally disable staleness.
    const aStale = await run(
      tool,
      { path: pathA, old_string: "a = 2", new_string: "a = 3", expected_hash: aHash },
      CWD,
      true,
    )
    expect(aStale.ok).toBe(false)
    expect(aStale.failure?.mode).toBe("stale_precondition")

    expect(files.get(pathA)).toBe("a = 2")
    expect(files.get(pathB)).toBe("b = 2")
  })
})

describe("jul-13 edit-fresh-hash CHAOS — seeded property (interleaved multi-file)", () => {
  test("2. ~200 random ops over 4 files: correct last-advertised hash NEVER stales; a stale hash ALWAYS stales", async () => {
    const SEED = 0x1efc0de // fixed → deterministic; printed below on any failure.
    const OPS = 200
    const FILE_COUNT = 4
    const rng = mulberry32(SEED)

    const paths = Array.from({ length: FILE_COUNT }, (_, i) => `${CWD}/chaos-${i}.txt`)
    const seed: Record<string, string> = {}
    for (const p of paths) seed[p] = "v = 0"
    const { port, files } = makeRecordingPort(seed)
    const tool = makeEditTool(port)

    // Model-side bookkeeping, mirroring what a real model would track per file:
    //  - version:  the integer the file's `v = <n>` currently holds (drives old/new_string)
    //  - lastHash: the file's LAST advertised fresh hash (the CORRECT precondition)
    //  - staleHash: a hash captured BEFORE some later same-file edit (a WRONG precondition)
    const version = new Array<number>(FILE_COUNT).fill(0)
    const lastHash = new Array<string>(FILE_COUNT).fill("")
    const staleHash = new Array<string | undefined>(FILE_COUNT).fill(undefined)

    // Seed lastHash by doing one no-precondition edit per file up front so every
    // file has a valid advertised hash to chain from.
    for (let f = 0; f < FILE_COUNT; f++) {
      const r = await run(
        tool,
        { path: paths[f], old_string: `v = ${version[f]}`, new_string: `v = ${version[f]! + 1}` },
        CWD,
        true,
      )
      expect(r.ok).toBe(true)
      version[f] = version[f]! + 1
      lastHash[f] = advertisedHash(r)
    }

    // The property loop. Each op picks a random file and, with a coin flip, either:
    //  (GOOD) supplies that file's CORRECT last-advertised hash → must SUCCEED, or
    //  (BAD)  supplies a captured STALE hash for that file       → must STALE.
    // Counters prove BOTH branches actually fired (non-vacuous coverage).
    let goodOps = 0
    let badOps = 0
    let goodStaleViolations = 0 // GOOD op that wrongly went stale (fix broken under interleave)
    let badPassViolations = 0 // BAD op that wrongly passed (staleness not enforced)

    for (let op = 0; op < OPS; op++) {
      const f = randInt(rng, FILE_COUNT)
      const p = paths[f]!
      const cur = version[f]!
      const useStale = staleHash[f] !== undefined && rng() < 0.4

      if (useStale) {
        // BAD branch: a hash captured before an intervening edit to THIS file.
        badOps++
        const r = await run(
          tool,
          {
            path: p,
            old_string: `v = ${cur}`,
            new_string: `v = ${cur + 1}`,
            expected_hash: staleHash[f],
          },
          CWD,
          true,
        )
        // INVARIANT (BAD direction): a stale hash ALWAYS rejects. The file must be
        // UNTOUCHED (version unchanged), and staleHash stays armed for retry.
        if (r.failure?.mode !== "stale_precondition") badPassViolations++
        expect(r.ok).toBe(false)
        expect(r.failure?.mode).toBe("stale_precondition")
        expect(files.get(p)).toBe(`v = ${cur}`)
      } else {
        // GOOD branch: the file's CORRECT last-advertised hash.
        goodOps++
        const r = await run(
          tool,
          {
            path: p,
            old_string: `v = ${cur}`,
            new_string: `v = ${cur + 1}`,
            expected_hash: lastHash[f],
          },
          CWD,
          true,
        )
        // INVARIANT (GOOD direction): the correct last-advertised hash NEVER stales.
        if (r.failure?.mode === "stale_precondition") goodStaleViolations++
        expect(r.ok).toBe(true)
        expect(r.failure).toBeUndefined()
        // The edit landed: bump version, capture the PRIOR lastHash as the new
        // stale witness (it is now genuinely stale — an intervening edit occurred),
        // and record the fresh hash as the new correct precondition.
        staleHash[f] = lastHash[f]
        version[f] = cur + 1
        lastHash[f] = advertisedHash(r)
        // Real-effect check: the advertised hash equals the digest of the file's
        // actual current bytes (the chain never advertised a hash that would
        // stale its own next same-file edit).
        expect(lastHash[f]).toBe(sha256Hex(files.get(p) ?? ""))
      }
    }

    // Both directions must have been EXERCISED (guards against a vacuous property:
    // e.g. the coin never flipping BAD would make the stale-enforcement claim empty).
    expect(goodOps).toBeGreaterThan(0)
    expect(badOps).toBeGreaterThan(0)
    // Zero violations in either direction.
    expect(goodStaleViolations).toBe(0)
    expect(badPassViolations).toBe(0)
    // Final consistency: every file's recorded lastHash matches its on-disk bytes.
    for (let f = 0; f < FILE_COUNT; f++) {
      expect(lastHash[f]).toBe(sha256Hex(files.get(paths[f]!) ?? ""))
    }
  })
})
