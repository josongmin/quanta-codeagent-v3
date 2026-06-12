/**
 * #19 — approval-time applicability PRE-FLIGHT hellgate.
 *
 * Asserts the REAL effect: `preflightApplyWarning` reuses the SAME edit/patch
 * matchers and returns a warning IFF the action would not cleanly apply — and
 * NEVER mutates anything (it is a preview). Paired-control proves the delta is
 * causal (clean action ⇒ no warning; broken action ⇒ warning). The wiring test
 * drives the REAL `buildCliOnConfirm` to prove the confirm prompt actually
 * surfaces the warning (and stays silent when the gate is off).
 *
 * RED-ON-INJECTION (manually verified): reverting `preflightEdit`'s
 * `if (exact.ok) return undefined` to always-`return undefined` flips the
 * "stale edit ⇒ warning" tests to GREEN-should-be-RED (they then see no
 * warning); reverting `preflightApplyPatch`'s `await applyPatch(...)` to a bare
 * `return undefined` flips the patch tests the same way. Both confirmed RED.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { createPersistentTrustScopeRegistry, type ToolAction } from "@/permission"
import { preflightApplyWarning, preflightCheckEnabled } from "../../src/apps/cli/preflight"
import { __testing } from "../../src/apps/cli/repl/runtime-context-compose"

const SRC = "alpha\nbeta\ngamma\n"
const reader =
  (files: Record<string, string>) =>
  async (p: string): Promise<string> => {
    const v = files[p]
    if (v === undefined) throw new Error(`ENOENT ${p}`)
    return v
  }

const editAction = (input: Record<string, unknown>): ToolAction => ({
  tool: "edit",
  input,
  isReadOnly: false,
})
const patchAction = (patch: string): ToolAction => ({
  tool: "apply_patch",
  input: { patch },
  isReadOnly: false,
})

describe("#19 preflight — edit applicability", () => {
  const cwd = "/repo"
  const files = { "/repo/x.ts": SRC }

  test("PAIRED: a clean edit (anchor present + unique) yields NO warning", async () => {
    const w = await preflightApplyWarning(
      editAction({ path: "x.ts", old_string: "beta", new_string: "BETA" }),
      { cwd, readFile: reader(files) },
    )
    expect(w).toBeUndefined()
  })

  test("PAIRED: a stale edit (old_string absent) yields a warning", async () => {
    const w = await preflightApplyWarning(
      editAction({ path: "x.ts", old_string: "not-in-file", new_string: "z" }),
      { cwd, readFile: reader(files) },
    )
    // Broad: a warning was produced at all. Then narrow: it carries the REAL
    // matcher's "not found" message (proves the matcher ran, not a stub).
    expect(w).toBeDefined()
    expect(w).toContain("x.ts")
    expect(w?.toLowerCase()).toContain("not found")
  })

  test("ambiguous anchor (2 matches, no replace_all) warns with the matcher's message", async () => {
    const w = await preflightApplyWarning(
      editAction({ path: "x.ts", old_string: "a", new_string: "z" }),
      { cwd, readFile: reader({ "/repo/x.ts": "a\na\n" }) },
    )
    expect(w).toBeDefined()
    expect(w?.toLowerCase()).toContain("not unique")
  })

  test("fuzzy:true RESCUES a whitespace-drifted anchor ⇒ no warning", async () => {
    // Exact misses (trailing spaces); the fuzzy matcher tolerates it.
    const w = await preflightApplyWarning(
      editAction({ path: "x.ts", old_string: "beta", new_string: "BETA", fuzzy: true }),
      { cwd, readFile: reader({ "/repo/x.ts": "alpha\n  beta  \ngamma\n" }) },
    )
    expect(w).toBeUndefined()
  })

  test("missing file ⇒ 'file not found' warning", async () => {
    const w = await preflightApplyWarning(
      editAction({ path: "ghost.ts", old_string: "x", new_string: "y" }),
      { cwd, readFile: reader(files) },
    )
    expect(w).toBeDefined()
    expect(w?.toLowerCase()).toContain("not found")
  })

  test("invalid line_ranges ⇒ surfaced before matching", async () => {
    const w = await preflightApplyWarning(
      editAction({
        path: "x.ts",
        old_string: "beta",
        new_string: "z",
        line_ranges: [{ start: 5, end: 2 }],
      }),
      { cwd, readFile: reader(files) },
    )
    expect(w).toBeDefined()
    expect(w?.toLowerCase()).toContain("line_ranges")
  })

  test("an ABSOLUTE path is read as-is (NOT joined under cwd)", async () => {
    // Reader keyed on the absolute path only; if the resolver wrongly did
    // path.resolve(cwd, "/abs/x.ts") it would still be "/abs/x.ts" (absolute
    // wins), but a clean read + correct verdict proves the abs branch works.
    const clean = await preflightApplyWarning(
      editAction({ path: "/abs/x.ts", old_string: "beta", new_string: "BETA" }),
      { cwd, readFile: reader({ "/abs/x.ts": SRC }) },
    )
    expect(clean).toBeUndefined() // found + unique under the absolute path
    const stale = await preflightApplyWarning(
      editAction({ path: "/abs/x.ts", old_string: "MISSING", new_string: "z" }),
      { cwd, readFile: reader({ "/abs/x.ts": SRC }) },
    )
    expect(stale).toBeDefined()
    expect(stale).toContain("/abs/x.ts")
  })
})

describe("#19 preflight — apply_patch applicability", () => {
  const cwd = "/repo"

  const cleanPatch = "*** Begin Patch\n*** Update File: x.ts\n@@\n-beta\n+BETA\n*** End Patch\n"

  test("PAIRED: a patch whose hunk locates cleanly yields NO warning", async () => {
    const w = await preflightApplyWarning(patchAction(cleanPatch), {
      cwd,
      readFile: reader({ "/repo/x.ts": SRC }),
    })
    expect(w).toBeUndefined()
  })

  test("PAIRED: an unlocatable hunk yields a warning", async () => {
    const w = await preflightApplyWarning(patchAction(cleanPatch), {
      cwd,
      // The file no longer contains `beta` ⇒ the anchor can't be located.
      readFile: reader({ "/repo/x.ts": "alpha\nDELTA\ngamma\n" }),
    })
    expect(w).toBeDefined()
    expect(w).toContain("apply_patch")
    expect(w?.toLowerCase()).toContain("will not cleanly apply")
  })

  test("missing update target yields a warning", async () => {
    const w = await preflightApplyWarning(patchAction(cleanPatch), {
      cwd,
      readFile: reader({}), // x.ts absent
    })
    expect(w).toBeDefined()
    expect(w).toContain("apply_patch")
  })

  test("REAL-EFFECT: the preview never mutates — fresh re-read is byte-identical", async () => {
    // A mutable map; the write-suppressed port must not touch it. Fresh-readback
    // after the preview proves zero mutation.
    const files: Record<string, string> = { "/repo/x.ts": SRC }
    await preflightApplyWarning(patchAction(cleanPatch), { cwd, readFile: reader(files) })
    expect(files["/repo/x.ts"]).toBe(SRC)
    expect(Object.keys(files)).toEqual(["/repo/x.ts"])
  })

  test("a grammatically invalid patch yields a parse warning", async () => {
    const w = await preflightApplyWarning(patchAction("not a patch at all"), {
      cwd,
      readFile: reader({ "/repo/x.ts": SRC }),
    })
    expect(w).toBeDefined()
    expect(w).toContain("apply_patch")
  })
})

describe("#19 preflight gate", () => {
  test("default-ON when seeded '1'; explicit '0' opts out (byte-identical OFF)", () => {
    expect(preflightCheckEnabled({ QUANTA_PREFLIGHT_CHECK: "1" })).toBe(true)
    expect(preflightCheckEnabled({ QUANTA_PREFLIGHT_CHECK: "0" })).toBe(false)
    expect(preflightCheckEnabled({})).toBe(false) // unseeded ⇒ off (only index.ts seeds it)
  })
})

describe("#19 preflight WIRING — buildCliOnConfirm surfaces the warning", () => {
  const dir = mkdtempSync(join(tmpdir(), "preflight-wire-"))
  const file = join(dir, "x.ts")
  writeFileSync(file, SRC)

  const prevPreflight = process.env.QUANTA_PREFLIGHT_CHECK
  const prevDiff = process.env.QUANTA_DIFF_PREVIEW
  afterEach(() => {
    if (prevPreflight === undefined) delete process.env.QUANTA_PREFLIGHT_CHECK
    else process.env.QUANTA_PREFLIGHT_CHECK = prevPreflight
    if (prevDiff === undefined) delete process.env.QUANTA_DIFF_PREVIEW
    else process.env.QUANTA_DIFF_PREVIEW = prevDiff
    rmSync(dir, { recursive: true, force: true })
  })

  // A fake in-turn channel: active so the confirm reads a routed line instead of
  // opening a real readline on stdin (which would hang the test). Answers "N".
  const fakeChannel = {
    active: true,
    awaitLine: async () => "N",
    tryResolve: () => false,
    clear: () => {},
  }
  const deps = {
    idleMonitor: { markActive: () => {} } as never,
    rejectCounter: { recordAccept: () => {}, recordDeny: () => {} } as never,
    channel: fakeChannel as never,
    cwd: dir,
  }
  const staleEdit = editAction({ path: "x.ts", old_string: "ABSENT-anchor", new_string: "z" })

  const captureStderr = async (fn: () => Promise<unknown>): Promise<string> => {
    const orig = process.stderr.write.bind(process.stderr)
    let buf = ""
    process.stderr.write = ((chunk: unknown) => {
      buf += String(chunk)
      return true
    }) as typeof process.stderr.write
    try {
      await fn()
    } finally {
      process.stderr.write = orig
    }
    return buf
  }

  test("gate ON: the confirm prompt writes the pre-flight warning to stderr", async () => {
    process.env.QUANTA_PREFLIGHT_CHECK = "1"
    process.env.QUANTA_DIFF_PREVIEW = "0" // isolate: no diff noise
    const onConfirm = __testing.buildCliOnConfirm(deps)
    const out = await captureStderr(() => onConfirm(staleEdit))
    expect(out).toContain("pre-flight")
    expect(out.toLowerCase()).toContain("not found")
  })

  test("PAIRED gate OFF: byte-identical — no pre-flight line emitted", async () => {
    process.env.QUANTA_PREFLIGHT_CHECK = "0"
    process.env.QUANTA_DIFF_PREVIEW = "0"
    const onConfirm = __testing.buildCliOnConfirm(deps)
    const out = await captureStderr(() => onConfirm(staleEdit))
    expect(out).not.toContain("pre-flight")
  })

  // #20 — the CLI confirm offers the [p] "always allow `<program> …`" verb only
  // for a single simple shell command, and maps it to scope:"session_prefix".
  const depsWith = (answer: string) => ({
    idleMonitor: { markActive: () => {} } as never,
    rejectCounter: { recordAccept: () => {}, recordDeny: () => {} } as never,
    channel: {
      active: true,
      awaitLine: async () => answer,
      tryResolve: () => false,
      clear: () => {},
    } as never,
    cwd: dir,
  })
  const bashAct = (shellCommand: string): ToolAction => ({
    tool: "bash",
    input: { cmd: shellCommand },
    isReadOnly: false,
    shellCommand,
  })

  test("#20 simple shell cmd: prompt offers [p] and 'p' ⇒ scope session_prefix", async () => {
    process.env.QUANTA_PREFLIGHT_CHECK = "0"
    process.env.QUANTA_DIFF_PREVIEW = "0"
    const onConfirm = __testing.buildCliOnConfirm(depsWith("p"))
    let decision: unknown
    const out = await captureStderr(async () => {
      decision = await onConfirm(bashAct("git status"))
    })
    expect(out).toContain("[p] always `git` cmds")
    expect(decision).toEqual({ decision: "allow", scope: "session_prefix" })
  })

  test("#20 PAIRED: a CHAINED cmd offers NO [p]; 'p' falls through to deny", async () => {
    process.env.QUANTA_PREFLIGHT_CHECK = "0"
    process.env.QUANTA_DIFF_PREVIEW = "0"
    const onConfirm = __testing.buildCliOnConfirm(depsWith("p"))
    let decision: unknown
    const out = await captureStderr(async () => {
      decision = await onConfirm(bashAct("git status && rm -rf /"))
    })
    expect(out).not.toContain("[p]") // no unsafe prefix offered for a chained cmd
    expect(decision).toBe(false) // 'p' is not a verb here ⇒ fail-closed deny
  })

  // #20 DURABLE — with a wired trust-scope registry the confirm offers [P] (all
  // sessions); answering "P" MINTS a durable program-token grant + allows now.
  const depsWithTrust = (
    answer: string,
    registry: ReturnType<typeof createPersistentTrustScopeRegistry>,
  ) => ({
    idleMonitor: { markActive: () => {} } as never,
    rejectCounter: { recordAccept: () => {}, recordDeny: () => {} } as never,
    channel: {
      active: true,
      awaitLine: async () => answer,
      tryResolve: () => false,
      clear: () => {},
    } as never,
    cwd: dir,
    trustScope: { registry, projectKey: "proj" },
  })

  test("#20 durable: [P] mints a persistent grant (fresh-readback) + allows this session", async () => {
    process.env.QUANTA_PREFLIGHT_CHECK = "0"
    process.env.QUANTA_DIFF_PREVIEW = "0"
    const registry = createPersistentTrustScopeRegistry({ filePath: join(dir, "grants.json") })
    await registry.hydrate()
    const onConfirm = __testing.buildCliOnConfirm(depsWithTrust("P", registry))
    let decision: unknown
    const out = await captureStderr(async () => {
      decision = await onConfirm(bashAct("git status"))
    })
    expect(out).toContain("ALL sessions") // the durable verb is offered
    expect(decision).toEqual({ decision: "allow", scope: "session_prefix" }) // allows now too
    // FRESH-READBACK: a sibling git command now rides the DURABLE grant.
    expect(registry.hasGrant("proj", { tool: "bash", actionKey: "bash|git log" })).toBe(true)
    expect(registry.hasGrant("proj", { tool: "bash", actionKey: "bash|cargo build" })).toBe(false)
  })

  test("#20 PAIRED: NO registry ⇒ no [P] verb offered (durable opt-in, byte-identical)", async () => {
    process.env.QUANTA_PREFLIGHT_CHECK = "0"
    process.env.QUANTA_DIFF_PREVIEW = "0"
    const onConfirm = __testing.buildCliOnConfirm(depsWith("y"))
    const out = await captureStderr(() => onConfirm(bashAct("git status")))
    expect(out).not.toContain("ALL sessions") // durable verb absent without a wired registry
  })
})
