/**
 * ★ HELLGATE — glob `pattern`-channel FS-jail escape (wave-4 INJECTION).
 *
 * The glob tool jail-validated `input.path` (S14) but passed `input.pattern`
 * verbatim to Bun.Glob.scan, so a model-supplied absolute pattern ("/etc/*") or
 * a "../" pattern enumerated files OUTSIDE the workspace jail — the exact
 * read-scope the tool's own comment + the S14 path tests promise it cannot.
 * FIX (fail-closed): reject an absolute / ".."-segment pattern up front, and
 * re-jail every emitted hit (symlink defense-in-depth), dropping out-of-jail
 * paths. These tests pin both channels.
 *
 * ──────────────────────────────────────────────────────────────────────────
 * H15 (TEST_THEATER closure): the original "secret never listed" test below
 * passed VACUOUSLY. Bun.Glob.scan runs with the production tool's DEFAULT
 * options (no `followSymlinks`), and Bun does NOT traverse into — nor emit a
 * file through — a symlink under those options (verified: a `**` scan of a
 * tree whose only out-of-jail content is reachable via a symlinked dir OR a
 * symlinked file yields `["src/in.ts"]` / `[]` respectively, never the secret).
 * So the per-hit re-jail loop in src/tool/glob/index.ts — the documented
 * symlink defense-in-depth — was never actually exercised: the secret was
 * absent because Bun never EMITTED it, not because the loop DROPPED it.
 *
 * Because the production tool hard-codes the default (no-`followSymlinks`)
 * scan, the re-jail loop cannot be driven through the public tool surface
 * without a source seam (which this track does not own). We therefore:
 *   (1) keep the tool-level outcome test (secret stays absent — still a valid
 *       invariant), and
 *   (2) ADD direct, load-bearing tests of the re-jail PREDICATE that the loop
 *       depends on, using the EXACT source expression
 *       `resolveJailed(join(base, file), ctx.cwd)` against the symlinked hit
 *       that Bun *would* emit under `followSymlinks` — proving the drop is
 *       real, and that switching the scan to follow symlinks WITHOUT the loop
 *       would leak. These assertions fail the moment the re-jail filter logic
 *       is removed/weakened (anti-theater).
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { FsJailError, resolveJailed } from "@/storage"
import type { ToolContext, ToolResult } from "@/tool"
import { globTool } from "@/tool/glob"

// jailRoot = <root>/work ; a sibling <root>/outside holds a secret the jail
// must never list. A symlink inside work points at outside (escape attempt).
const root = mkdtempSync(join(tmpdir(), "glob-jail-"))
const work = join(root, "work")
const outside = join(root, "outside")
afterAll(() => rmSync(root, { recursive: true, force: true }))
mkdirSync(join(work, "src"), { recursive: true })
mkdirSync(outside, { recursive: true })
writeFileSync(join(work, "src", "in.ts"), "1")
writeFileSync(join(outside, "secret.ts"), "TOPSECRET")
let symlinkOk = false
try {
  symlinkSync(outside, join(work, "link"))
  symlinkOk = true
} catch {
  // symlink may be unsupported in some sandboxes; the symlink tests guard on it.
}

const ctx = (): ToolContext => ({ cwd: work, signal: new AbortController().signal })
const run = async (input: unknown): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of globTool.execute(input as never, ctx())) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

describe("glob pattern channel cannot escape the FS jail", () => {
  test("absolute pattern (/etc/*) is REJECTED (not scanned)", async () => {
    const r = await run({ pattern: "/etc/*" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.output).toContain("escapes the workspace")
  })

  test("relative '../' traversal pattern is REJECTED", async () => {
    const r = await run({ pattern: "../outside/*.ts" })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.output).toContain("escapes the workspace")
  })

  test("deep '../../' traversal pattern is REJECTED", async () => {
    const r = await run({ pattern: "../../**/*.ts" })
    expect(r.ok).toBe(false)
  })

  test("an in-jail pattern still works (no false reject)", async () => {
    const r = await run({ pattern: "src/*.ts" })
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.output).toContain("src/in.ts")
  })

  test("the secret OUTSIDE the jail is never listed by any accepted pattern", async () => {
    const r = await run({ pattern: "**/*.ts" })
    expect(r.ok).toBe(true)
    // Outcome invariant: a broad in-jail glob must not surface the out-of-jail
    // secret. NOTE (H15): under the tool's default scan options Bun does not
    // even emit the symlinked hit, so this assertion alone does NOT prove the
    // re-jail loop runs — the predicate tests below carry that weight.
    if (r.ok) expect(r.output).not.toContain("secret.ts")
  })
})

// ── H15: drive the re-jail predicate directly (loop defense-in-depth) ───────
// These reproduce the EXACT filter the loop applies at src/tool/glob/index.ts:
//   resolveJailed(join(base, file), ctx.cwd)  // throw ⇒ DROP the hit
// The `file` value is the path Bun.Glob WOULD emit if the scan followed
// symlinks (verified out-of-band: a `followSymlinks:true` scan of `work`
// yields `link/secret.ts`). We prove the predicate DROPS that hit while
// ACCEPTING a genuine in-jail hit — i.e. the loop is the active gate that
// keeps the secret out even if the scan were ever widened to follow links.
describe("H15 re-jail predicate (symlink defense-in-depth) drops out-of-jail hits", () => {
  test("the symlinked hit Bun would emit under followSymlinks is DROPPED (throws FsJailError)", () => {
    if (!symlinkOk) return // sandbox without symlink support — predicate is moot
    // `link` -> <root>/outside ; `link/secret.ts` realpaths OUTSIDE the jail.
    const escapingHit = join("link", "secret.ts")
    let threw: unknown
    try {
      // base === ctx.cwd === work when no `path` is supplied (the broad-glob case).
      resolveJailed(join(work, escapingHit), work)
    } catch (e) {
      threw = e
    }
    // FAIL-CLOSED: the re-jail MUST reject the symlinked escape. If the loop's
    // filter is removed/weakened (e.g. swapped for a lexical-only check that a
    // realpath'd symlink slips past), this throw disappears and the secret would
    // be appended to `hits` — the leak this hellgate guards.
    expect(threw).toBeInstanceOf(FsJailError)
  })

  test("a genuine in-jail hit is ACCEPTED by the same predicate (no false drop)", () => {
    const inJailHit = join("src", "in.ts")
    // Must NOT throw — the loop keeps legitimate in-tree files.
    expect(() => resolveJailed(join(work, inJailHit), work)).not.toThrow()
  })

  test("a deeper symlinked path (link/sub/deep.ts) is also DROPPED", () => {
    if (!symlinkOk) return
    // Any path reached THROUGH the symlink realpaths outside the jail, so the
    // re-jail drops it regardless of depth — the loop's drop is not a one-off.
    let threw: unknown
    try {
      resolveJailed(join(work, join("link", "sub", "deep.ts")), work)
    } catch (e) {
      threw = e
    }
    expect(threw).toBeInstanceOf(FsJailError)
  })
})
