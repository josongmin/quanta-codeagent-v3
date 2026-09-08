// Hellgate — ADR-0421: fast-apply fallback wired into the `apply_patch` tool.
//
// ADR-0417 shipped `FastApplyFallbackPort` as a pure port with no consumer.
// This wire makes `apply_patch` call the (optionally injected) fallback ONCE
// when a V4A patch FAILS to apply (anchor not found / generic apply error /
// parse error), retrying with the model-re-emitted patch. The fence:
//
//   - port ABSENT  ⇒ exact pre-ADR behavior — the typed V4A error THROWS out
//     of the generator, byte-identical, NO fallback attempt.
//   - port present + apply fails + fallback ok:true + retry succeeds ⇒ tool
//     yields ok:true, output notes the fallback (+ modelUsed when present).
//   - fallback ok:false OR retry also fails ⇒ the ORIGINAL typed error throws
//     (NOT the retry's), and AT MOST ONE fallback attempt was made.
//   - first apply succeeds ⇒ fallback NEVER called (attempt count == 0).
//   - fallback port THROWS ⇒ swallowed, original error throws (NO-THROW seam).
//   - errorKind derived from the V4A error class
//     (anchor_not_found | apply_error | parse_error).
//   - abort signal honored — aborted ctx ⇒ no fallback attempt.

import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type {
  FastApplyAttemptResult,
  FastApplyFailure,
  FastApplyFallbackPort,
} from "@/agent/fast-apply-fallback"
import {
  PatchAnchorNotFoundError,
  PatchApplyError,
  PatchConvertError,
  PatchParseError,
  PatchRollbackIncompleteError,
} from "@/patch"
import type { ToolContext, ToolResult } from "@/tool"
import { applyPatchTool } from "@/tool/apply-patch"
import { classifyFastApplyError, failingTargetPath } from "@/tool/apply-patch-fallback-wire"

const root = mkdtempSync(join(tmpdir(), "apply-patch-fast-apply-"))
afterAll(() => rmSync(root, { recursive: true, force: true }))

const tmpSub = (name: string): string => {
  const d = join(root, name)
  mkdirSync(d, { recursive: true })
  return d
}

/** Records every `attempt` call so a test can assert at-most-ONE invocation
 *  and inspect the derived `errorKind`. The behaviour is supplied by the test. */
interface FakeFallback extends FastApplyFallbackPort {
  readonly calls: { failure: FastApplyFailure; sourceFile?: string; sourceContent?: string }[]
}

const makeFallback = (
  behaviour: (input: {
    failure: FastApplyFailure
    sourceFile?: string
    sourceContent?: string
  }) => FastApplyAttemptResult | Promise<FastApplyAttemptResult>,
): FakeFallback => {
  const calls: FakeFallback["calls"] = []
  return {
    calls,
    async attempt(input, signal): Promise<FastApplyAttemptResult> {
      calls.push({
        failure: input.failure,
        ...(input.sourceFile !== undefined ? { sourceFile: input.sourceFile } : {}),
        ...(input.sourceContent !== undefined ? { sourceContent: input.sourceContent } : {}),
      })
      if (signal?.aborted === true) {
        return { ok: false, newPatch: null, rationale: "aborted" }
      }
      return behaviour(input)
    },
  }
}

const ctx = (cwd: string, fallback?: FastApplyFallbackPort, signal?: AbortSignal): ToolContext => ({
  cwd,
  signal: signal ?? new AbortController().signal,
  ...(fallback !== undefined ? { fastApplyFallback: fallback } : {}),
})

/** Drive the generator and capture either the terminal result OR the thrown
 *  error (mirrors the existing apply-patch.test.ts `run` helper). */
const run = async (input: unknown, c: ToolContext): Promise<ToolResult> => {
  let result: ToolResult | undefined
  for await (const ev of applyPatchTool.execute(input as never, c)) {
    if (ev.type === "result") result = ev.result
  }
  if (!result) throw new Error("no result")
  return result
}

// A patch whose anchor cannot be located in the target file (drift). The
// fallback can "fix" it by emitting a patch that uses the present context.
const driftPatch = [
  "*** Begin Patch",
  "*** Update File: f.txt",
  "@@",
  " unrelated context",
  "-not-present",
  "+replacement",
  "*** End Patch",
].join("\n")

// A correct patch for the same file that the fake fallback "re-emits".
const fixedPatch = [
  "*** Begin Patch",
  "*** Update File: f.txt",
  "@@",
  "-beta",
  "+BETA",
  "*** End Patch",
].join("\n")

const seedF = (dir: string): void => writeFileSync(join(dir, "f.txt"), "alpha\nbeta\n")

// ===========================================================================
// 1. Port ABSENT ⇒ byte-identical legacy throw, NO fallback attempt.
// ===========================================================================
describe("apply_patch fast-apply wire — port absent (byte-identical)", () => {
  test("anchor failure throws PatchAnchorNotFoundError when no fallback wired", async () => {
    const dir = tmpSub("absent-anchor")
    seedF(dir)
    await expect(run({ patch: driftPatch }, ctx(dir))).rejects.toBeInstanceOf(
      PatchAnchorNotFoundError,
    )
  })

  test("parse failure throws PatchParseError when no fallback wired", async () => {
    const dir = tmpSub("absent-parse")
    const bad = "*** Add File: x.txt\n+nope\n*** End Patch\n" // missing Begin Patch
    await expect(run({ patch: bad }, ctx(dir))).rejects.toBeInstanceOf(PatchParseError)
  })

  test("apply failure (Add exists) throws PatchApplyError when no fallback wired", async () => {
    const dir = tmpSub("absent-apply")
    writeFileSync(join(dir, "already.txt"), "")
    const p = ["*** Begin Patch", "*** Add File: already.txt", "+x", "*** End Patch"].join("\n")
    await expect(run({ patch: p }, ctx(dir))).rejects.toBeInstanceOf(PatchApplyError)
  })

  test("first-apply success still succeeds with no fallback wired (no behavior change)", async () => {
    const dir = tmpSub("absent-ok")
    seedF(dir)
    const r = await run({ patch: fixedPatch }, ctx(dir))
    expect(r.ok).toBe(true)
    expect(r.output).toContain("updated: f.txt")
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("alpha\nBETA\n")
  })
})

// ===========================================================================
// 2. Fallback ok:true + retry succeeds ⇒ tool success, notes fallback/modelUsed.
// ===========================================================================
describe("apply_patch fast-apply wire — fallback rescue", () => {
  test("anchor failure + fallback ok:true + retry succeeds ⇒ ok:true and file patched", async () => {
    const dir = tmpSub("rescue-anchor")
    seedF(dir)
    const fb = makeFallback(() => ({
      ok: true,
      newPatch: fixedPatch,
      rationale: "re-emitted",
      modelUsed: "gpt-fast",
    }))
    const r = await run({ patch: driftPatch }, ctx(dir, fb))
    expect(r.ok).toBe(true)
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("alpha\nBETA\n")
    expect(fb.calls.length).toBe(1)
  })

  test("rescue output notes the fallback was used (modelUsed surfaced)", async () => {
    const dir = tmpSub("rescue-note")
    seedF(dir)
    const fb = makeFallback(() => ({
      ok: true,
      newPatch: fixedPatch,
      rationale: "re-emitted",
      modelUsed: "claude-haiku",
    }))
    const r = await run({ patch: driftPatch }, ctx(dir, fb))
    expect(r.ok).toBe(true)
    expect(r.output.toLowerCase()).toContain("fast-apply")
    expect(r.output).toContain("claude-haiku")
  })

  test("rescue without modelUsed still succeeds and notes fallback", async () => {
    const dir = tmpSub("rescue-no-model")
    seedF(dir)
    const fb = makeFallback(() => ({ ok: true, newPatch: fixedPatch, rationale: "re-emitted" }))
    const r = await run({ patch: driftPatch }, ctx(dir, fb))
    expect(r.ok).toBe(true)
    expect(r.output.toLowerCase()).toContain("fast-apply")
  })
})

// ===========================================================================
// 3. Fallback ok:false ⇒ original error surfaces, exactly ONE attempt, no retry.
// ===========================================================================
describe("apply_patch fast-apply wire — fallback declines", () => {
  test("fallback ok:false ⇒ ORIGINAL PatchAnchorNotFoundError throws, one attempt, no retry", async () => {
    const dir = tmpSub("decline-anchor")
    seedF(dir)
    const fb = makeFallback(() => ({ ok: false, newPatch: null, rationale: "no patch in reply" }))
    await expect(run({ patch: driftPatch }, ctx(dir, fb))).rejects.toBeInstanceOf(
      PatchAnchorNotFoundError,
    )
    expect(fb.calls.length).toBe(1)
    // File untouched — no retry was attempted.
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("alpha\nbeta\n")
  })

  test("fallback returns ok:true but a STILL-BROKEN newPatch ⇒ retry fails ⇒ ORIGINAL error throws", async () => {
    const dir = tmpSub("decline-retry-fail")
    seedF(dir)
    // The re-emitted patch ALSO drifts ⇒ retry throws its own anchor error;
    // the tool must surface the ORIGINAL error, not the retry's.
    const stillBroken = [
      "*** Begin Patch",
      "*** Update File: f.txt",
      "@@",
      " still wrong",
      "-also-missing",
      "+x",
      "*** End Patch",
    ].join("\n")
    const fb = makeFallback(() => ({
      ok: true,
      newPatch: stillBroken,
      rationale: "re-emitted (still broken)",
    }))
    const err = await run({ patch: driftPatch }, ctx(dir, fb)).then(
      () => null,
      (e) => e,
    )
    expect(err).toBeInstanceOf(PatchAnchorNotFoundError)
    // Exactly one fallback attempt — NO infinite loop.
    expect(fb.calls.length).toBe(1)
    expect(readFileSync(join(dir, "f.txt"), "utf8")).toBe("alpha\nbeta\n")
  })
})

// ===========================================================================
// 4. First-apply success ⇒ fallback NEVER called (attempt count == 0).
// ===========================================================================
describe("apply_patch fast-apply wire — no failure ⇒ no fallback", () => {
  test("successful first apply never touches the fallback", async () => {
    const dir = tmpSub("success-no-call")
    seedF(dir)
    const fb = makeFallback(() => {
      throw new Error("fallback must NOT be called on a successful apply")
    })
    const r = await run({ patch: fixedPatch }, ctx(dir, fb))
    expect(r.ok).toBe(true)
    expect(fb.calls.length).toBe(0)
  })
})

// ===========================================================================
// 5. Fallback port THROWS ⇒ swallowed, original error surfaces (NO-THROW seam).
// ===========================================================================
describe("apply_patch fast-apply wire — fallback throws (NO-THROW)", () => {
  test("fallback attempt throwing is swallowed; ORIGINAL error surfaces", async () => {
    const dir = tmpSub("throw-anchor")
    seedF(dir)
    const fb = makeFallback(() => {
      throw new Error("side-conversation exploded")
    })
    await expect(run({ patch: driftPatch }, ctx(dir, fb))).rejects.toBeInstanceOf(
      PatchAnchorNotFoundError,
    )
    expect(fb.calls.length).toBe(1)
  })

  test("fallback rejecting (async throw) is swallowed; ORIGINAL error surfaces", async () => {
    const dir = tmpSub("reject-anchor")
    seedF(dir)
    const fb = makeFallback(async () => {
      await Promise.resolve()
      throw new Error("async boom")
    })
    await expect(run({ patch: driftPatch }, ctx(dir, fb))).rejects.toBeInstanceOf(
      PatchAnchorNotFoundError,
    )
    expect(fb.calls.length).toBe(1)
  })
})

// ===========================================================================
// 6. errorKind correctly derived from the V4A error type.
// ===========================================================================
describe("apply_patch fast-apply wire — errorKind derivation", () => {
  test("PatchAnchorNotFoundError ⇒ errorKind 'anchor_not_found'", async () => {
    const dir = tmpSub("kind-anchor")
    seedF(dir)
    const fb = makeFallback(() => ({ ok: false, newPatch: null, rationale: "n/a" }))
    await run({ patch: driftPatch }, ctx(dir, fb)).catch(() => {})
    expect(fb.calls[0]?.failure.errorKind).toBe("anchor_not_found")
    expect(fb.calls[0]?.failure.patch).toBe(driftPatch)
    expect(fb.calls[0]?.failure.errorMessage.length).toBeGreaterThan(0)
  })

  test("PatchApplyError ⇒ errorKind 'apply_error'", async () => {
    const dir = tmpSub("kind-apply")
    writeFileSync(join(dir, "already.txt"), "")
    const p = ["*** Begin Patch", "*** Add File: already.txt", "+x", "*** End Patch"].join("\n")
    const fb = makeFallback(() => ({ ok: false, newPatch: null, rationale: "n/a" }))
    await run({ patch: p }, ctx(dir, fb)).catch(() => {})
    expect(fb.calls[0]?.failure.errorKind).toBe("apply_error")
  })

  test("PatchParseError ⇒ errorKind 'parse_error'", async () => {
    const dir = tmpSub("kind-parse")
    const bad = "*** Add File: x.txt\n+nope\n*** End Patch\n" // missing Begin Patch
    const fb = makeFallback(() => ({ ok: false, newPatch: null, rationale: "n/a" }))
    await run({ patch: bad }, ctx(dir, fb)).catch(() => {})
    expect(fb.calls[0]?.failure.errorKind).toBe("parse_error")
  })

  test("PatchConvertError (inconsistent rename) ⇒ errorKind 'parse_error'", async () => {
    const dir = tmpSub("kind-convert")
    const bad = [
      "diff --git a/old.py b/new.py",
      "rename from old.py",
      "rename to new.py",
      "--- a/old.py",
      "+++ b/other.py",
      "@@ -1 +1 @@",
      "-old_content",
      "+new_content",
    ].join("\n")
    const fb = makeFallback(() => ({ ok: false, newPatch: null, rationale: "n/a" }))
    const err = await run({ patch: bad }, ctx(dir, fb)).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(PatchConvertError)
    expect(fb.calls[0]?.failure.errorKind).toBe("parse_error")
    expect(fb.calls[0]?.sourceFile).toBeUndefined()
  })

  test("PatchRollbackIncompleteError is not fast-apply-recoverable", () => {
    const incomplete = new PatchRollbackIncompleteError(new Error("commit boom"), [
      { path: "a.txt", cause: "undo write failed" },
    ])
    expect(classifyFastApplyError(incomplete)).toBeNull()
    expect(failingTargetPath(incomplete)).toBeUndefined()
    expect(classifyFastApplyError(new PatchConvertError("rename mismatch"))).toBe("parse_error")
  })

  test("sourceFile + sourceContent are threaded for an Update target", async () => {
    const dir = tmpSub("kind-source")
    seedF(dir)
    const fb = makeFallback(() => ({ ok: false, newPatch: null, rationale: "n/a" }))
    await run({ patch: driftPatch }, ctx(dir, fb)).catch(() => {})
    // The failing op targets f.txt; the wire reads its current bytes so the
    // model can re-anchor. (Parse errors have no target ⇒ omitted; not asserted here.)
    expect(fb.calls[0]?.sourceFile).toBe("f.txt")
    expect(fb.calls[0]?.sourceContent).toBe("alpha\nbeta\n")
  })
})

// ===========================================================================
// 7. Abort signal honored — aborted ctx ⇒ no fallback attempt.
// ===========================================================================
describe("apply_patch fast-apply wire — abort", () => {
  test("an already-aborted signal short-circuits: original error throws, no fallback call", async () => {
    const dir = tmpSub("abort-pre")
    seedF(dir)
    const ac = new AbortController()
    ac.abort()
    const fb = makeFallback(() => ({ ok: true, newPatch: fixedPatch, rationale: "n/a" }))
    await expect(run({ patch: driftPatch }, ctx(dir, fb, ac.signal))).rejects.toBeInstanceOf(
      PatchAnchorNotFoundError,
    )
    expect(fb.calls.length).toBe(0)
  })

  test("the tool's signal is forwarded to the fallback attempt", async () => {
    const dir = tmpSub("abort-forward")
    seedF(dir)
    let sawSignal = false
    const ac = new AbortController()
    const fb: FastApplyFallbackPort = {
      async attempt(_input, signal): Promise<FastApplyAttemptResult> {
        sawSignal = signal !== undefined
        return { ok: false, newPatch: null, rationale: "n/a" }
      },
    }
    await run({ patch: driftPatch }, ctx(dir, fb, ac.signal)).catch(() => {})
    expect(sawSignal).toBe(true)
  })
})
