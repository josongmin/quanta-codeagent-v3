/**
 * ★ E2E HELLGATE — H1 edit-reactor (ADR-0472) through the REAL dispatch bracket.
 *
 * Complements the unit hellgates (`edit-repair-loop-hellgate` = pure loop,
 * `edit-repair-wire-hellgate` = composition adapters, `dispatch-lint-delta-
 * hellgate` = the attach bracket + active-route smoke) by proving the parts
 * those leave open: ACTUAL CONVERGENCE of the active repair loop driven end to
 * end through `dispatchTool`, the LoopOnCommand path reaching green, the
 * iteration BOUND honoured when a re-edit seam never fixes the file, and the
 * knob-OFF byte-identical guarantee.
 *
 * Everything is INJECTED (fake DiagnosticsProvider / fake fast LLM / fake exec)
 * — no network, no real LSP, no shell. The fast-model "re-edit seam" is a fake
 * whose applied edit FLIPS the injected check to green on a chosen iteration, so
 * we observe the loop converge and the attempt count stay within `maxIters`.
 *
 * Axes:
 *   A. LINT LOOP — converges on iteration 2 (one failing post-snapshot, then the
 *      re-edit clears it) → "[edit-repair] cleared …" + bound respected.
 *   B. LINT LOOP — never clears → stops at maxIters, carries the could-not-clear
 *      annotation + the residual delta.
 *   C. COMMAND LOOP (LoopOnCommand/LoopOnTests parity) — exec fails once then
 *      passes after one repair → "[edit-repair] `cmd` passed".
 *   D. KNOB OFF — no bracket, no loop, model-facing output byte-identical.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import type { ExecRunner } from "@/agent/edit-repair-wire"
import type { LLMPort, StreamEvent, StreamInput, ToolUseBlock } from "@/llm"
import { __resetDefaultPermissionStore, type PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import {
  type DiagnosticItem,
  type DiagnosticsProvider,
  type Tool,
  type ToolEvent,
  ToolRegistry,
} from "@/tool"

// ─── tool / diagnostics fakes ────────────────────────────────────────────────

/** A path-bearing edit tool whose execute always succeeds (the real edit is
 *  irrelevant to the bracket — the provider drives the diagnostics). */
const editTool = (name: string): Tool => ({
  name,
  description: "edit test tool",
  inputSchema: z.object({ path: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "applied" } }
  },
})

const errItem = (msg: string, line = 3): DiagnosticItem => ({
  severity: "error",
  message: msg,
  range: { start: { line, character: 5 } },
  code: "TS2322",
})

/**
 * A DiagnosticsProvider modelling BOTH roles the dispatch bracket needs from the
 * one `config.diagnosticsProvider`, driven by a shared `clean` latch the fast
 * model flips once it "produces a fix":
 *   - call #1 (bracket PRE-snapshot, file before the edit)  → clean `[]`,
 *   - call #2 (bracket POST-snapshot, after the edit)       → the introduced
 *     error (so `computeLintDelta` reports it as NEW),
 *   - call #3+ (each loop RE-CHECK, fresh session per check) → follows the latch:
 *     the introduced error until a repair flips `clean.v`, then `[]` ⇒ green.
 * A single shared `calls` counter spans every `open()` so the sequence is stable
 * regardless of how many sessions the bracket vs the loop open.
 */
const reactorProvider = (clean: { v: boolean }): DiagnosticsProvider => {
  let calls = 0
  return {
    unavailableReason: () => "n/a",
    open: async () => ({
      diagnostics: async () => {
        calls += 1
        if (calls === 1) return [] // bracket pre-snapshot.
        if (calls === 2) return [errItem("Type mismatch introduced by edit")] // post.
        return clean.v ? [] : [errItem("Type mismatch introduced by edit")] // re-checks.
      },
      stop: async () => {},
    }),
  }
}

// ─── fast-model "re-edit seam" fakes ────────────────────────────────────────

/** A fast LLM whose reply, when the reactor APPLIES it (via writeFile), flips
 *  `clean.v` to true after `fixOnApply`-th application — so the loop converges on
 *  a chosen attempt. `applied` counts applications so a test can assert the bound.
 *  The reply is non-empty so the reactor proceeds to apply. */
const fixingLlm = (clean: { v: boolean }, fixOnApply: number, applied: { n: number }): LLMPort => ({
  model: "fast-fix",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    // Side-effect on STREAM start models "the model produced a corrected edit".
    // The actual flip happens when the reactor's apply runs; we hook apply via a
    // global the provider reads — but to keep this injected & pure we instead
    // flip here on the Nth call (each repair attempt = one stream), which is
    // exactly one-per-iteration because the reactor calls stream() once per req.
    applied.n += 1
    if (applied.n >= fixOnApply) clean.v = true
    async function* gen(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: "// corrected file contents\n" }
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
    return gen()
  },
})

/** A fast LLM that always replies but NEVER fixes anything (latch never flips). */
const uselessLlm = (applied: { n: number }): LLMPort => ({
  model: "fast-noop",
  stream(_input: StreamInput): AsyncIterable<StreamEvent> {
    applied.n += 1
    async function* gen(): AsyncGenerator<StreamEvent> {
      yield { type: "text_delta", delta: "// still wrong\n" }
      yield { type: "message_stop", stop_reason: "end_turn" }
    }
    return gen()
  },
})

// ─── config builder ─────────────────────────────────────────────────────────

// The active repair reactor (dispatch's `buildEditApplyReactor`) ACTUALLY writes
// the model's corrected content to disk via `writeFile(file, content, cwd)`. So
// the edit target must be a REAL writable path under the per-test tmp root, or
// the apply fails and the loop ends `model-declined` before it can converge.
// `target` is set in `beforeEach`; `cwd` is the tmp root.
let target = "x.ts"

const cfg = (over: {
  tool: Tool
  diag?: DiagnosticsProvider
  llm?: LLMPort
  editRepair?: AgentConfig["editRepair"]
}): AgentConfig =>
  ({
    registry: new ToolRegistry([over.tool]),
    cwd: root ?? "/repo",
    signal: new AbortController().signal,
    planMode: false,
    permission: { mode: "acceptEdits" } as PermissionContext,
    ...(over.diag !== undefined ? { diagnosticsProvider: over.diag } : {}),
    ...(over.llm !== undefined ? { llm: over.llm } : {}),
    ...(over.editRepair !== undefined ? { editRepair: over.editRepair } : {}),
  }) as AgentConfig

const call = (name: string): ToolUseBlock => ({
  type: "tool_use",
  id: "c1",
  name,
  input: { path: target },
})
const perm: PermissionContext = { mode: "acceptEdits" }

// ─── harness ────────────────────────────────────────────────────────────────

let root: string | null = null
const origPerm = process.env.QUANTA_PERMISSION_STATE
const origGate = process.env.QUANTA_EDIT_REPAIR_LOOP

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "edit-reactor-e2e-"))
  // A real, writable edit target so the active reactor's `writeFile` apply
  // succeeds (otherwise the loop short-circuits `model-declined`).
  target = join(root, "x.ts")
  writeFileSync(target, "// original\n")
  process.env.QUANTA_PERMISSION_STATE = join(root, "permission-state.json")
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})
afterEach(() => {
  if (root !== null) rmSync(root, { recursive: true, force: true })
  root = null
  if (origPerm === undefined) delete process.env.QUANTA_PERMISSION_STATE
  else process.env.QUANTA_PERMISSION_STATE = origPerm
  if (origGate === undefined) delete process.env.QUANTA_EDIT_REPAIR_LOOP
  else process.env.QUANTA_EDIT_REPAIR_LOOP = origGate
  __resetRuntimeConfig()
  __resetDefaultPermissionStore()
})

const enable = () => {
  process.env.QUANTA_EDIT_REPAIR_LOOP = "1"
  __resetRuntimeConfig()
}

// ─── A. LINT LOOP CONVERGENCE ────────────────────────────────────────────────

describe("A. active lint loop converges through dispatch", () => {
  test("A1 — re-edit clears the introduced lint ⇒ '[edit-repair] cleared' + within bound", async () => {
    enable()
    const clean = { v: false }
    const applied = { n: 0 }
    // Converge on the FIRST repair application (fixOnApply=1): post-snapshot is
    // dirty, the loop's reactor applies once → latch flips → re-check is green.
    const res = await dispatchTool(
      call("edit"),
      cfg({
        tool: editTool("edit"),
        diag: reactorProvider(clean),
        llm: fixingLlm(clean, 1, applied),
        editRepair: { maxIters: 3 },
      }),
      perm,
    )
    expect(res.preview).toContain("[edit-repair]")
    expect(res.preview).toContain("cleared")
    // The model edited the original "applied" output is still present (the
    // annotation is APPENDED, never replaces the tool output).
    expect(res.preview).toContain("applied")
    // Bound respected: converged in exactly one repair application (< maxIters).
    expect(applied.n).toBe(1)
  })

  test("A2 — converges on iteration 2 (one wasted attempt), attempts ≤ maxIters", async () => {
    enable()
    const clean = { v: false }
    const applied = { n: 0 }
    // fixOnApply=2 ⇒ the first re-edit does NOT clear (latch still false on
    // re-check), the second one does. So the loop runs 2 attempts then green.
    const res = await dispatchTool(
      call("edit"),
      cfg({
        tool: editTool("edit"),
        diag: reactorProvider(clean),
        llm: fixingLlm(clean, 2, applied),
        editRepair: { maxIters: 4 },
      }),
      perm,
    )
    expect(res.preview).toContain("cleared")
    expect(applied.n).toBe(2)
    expect(applied.n).toBeLessThanOrEqual(4)
  })
})

// ─── B. LINT LOOP EXHAUSTION (bound honoured) ────────────────────────────────

describe("B. lint loop honours the iteration bound", () => {
  test("B1 — a re-edit seam that never fixes ⇒ stops at maxIters with residual delta", async () => {
    enable()
    const clean = { v: false }
    const applied = { n: 0 }
    const res = await dispatchTool(
      call("edit"),
      cfg({
        tool: editTool("edit"),
        diag: reactorProvider(clean),
        llm: uselessLlm(applied),
        editRepair: { maxIters: 2 },
      }),
      perm,
    )
    // Could not auto-clear: the residual lint-delta is surfaced for the model.
    expect(res.preview).toContain("could not auto-clear")
    expect(res.preview).toContain("Type mismatch introduced by edit")
    // Exactly maxIters repair applications — the bound, never more.
    expect(applied.n).toBe(2)
  })
})

// ─── C. COMMAND LOOP (LoopOnCommand / LoopOnTests) ───────────────────────────

describe("C. command repair loop through dispatch", () => {
  test("C1 — exec fails once then passes after one repair ⇒ '[edit-repair] `cmd` passed'", async () => {
    enable()
    let runs = 0
    const exec: ExecRunner = async () => {
      runs += 1
      return runs === 1 ? { exitCode: 1, output: "1 failing" } : { exitCode: 0, output: "ok" }
    }
    const applied = { n: 0 }
    const res = await dispatchTool(
      call("edit"),
      cfg({
        tool: editTool("edit"),
        // No diagnostics provider — LoopOnCommand is INDEPENDENT of the LSP.
        llm: uselessLlm(applied),
        editRepair: { maxIters: 3, command: "bun test", exec },
      }),
      perm,
    )
    expect(res.preview).toContain("[edit-repair]")
    expect(res.preview).toContain("bun test")
    expect(res.preview).toContain("passed")
    // One repair application drove it green.
    expect(applied.n).toBe(1)
  })

  test("C2 — command never passes ⇒ stops at maxIters with 'still failing'", async () => {
    enable()
    const exec: ExecRunner = async () => ({ exitCode: 2, output: "boom" })
    const applied = { n: 0 }
    const res = await dispatchTool(
      call("edit"),
      cfg({
        tool: editTool("edit"),
        llm: uselessLlm(applied),
        editRepair: { maxIters: 2, command: "make check", exec },
      }),
      perm,
    )
    expect(res.preview).toContain("still failing")
    expect(res.preview).toContain("make check")
    expect(applied.n).toBe(2)
  })

  test("C3 — command already green on the first run ⇒ NO annotation (byte-clean)", async () => {
    enable()
    const exec: ExecRunner = async () => ({ exitCode: 0, output: "all pass" })
    const applied = { n: 0 }
    const res = await dispatchTool(
      call("edit"),
      cfg({
        tool: editTool("edit"),
        llm: uselessLlm(applied),
        editRepair: { maxIters: 3, command: "bun test", exec },
      }),
      perm,
    )
    // Already green (0 repair attempts) ⇒ no noise appended.
    expect(res.preview).not.toContain("[edit-repair]")
    expect(res.preview).toBe("applied")
    expect(applied.n).toBe(0)
  })
})

// ─── D. KNOB OFF — byte-identical ─────────────────────────────────────────────

describe("D. knob OFF ⇒ no bracket, no loop, byte-identical", () => {
  test("D1 — gate unset ⇒ provider + llm + command all wired but UNUSED", async () => {
    // NOTE: do NOT call enable() — gate stays OFF.
    const clean = { v: false }
    const applied = { n: 0 }
    let execRan = false
    const exec: ExecRunner = async () => {
      execRan = true
      return { exitCode: 1, output: "x" }
    }
    const res = await dispatchTool(
      call("edit"),
      cfg({
        tool: editTool("edit"),
        diag: reactorProvider(clean),
        llm: fixingLlm(clean, 1, applied),
        editRepair: { maxIters: 3, command: "bun test", exec },
      }),
      perm,
    )
    // Byte-identical to the raw tool output: no delta, no loop annotation.
    expect(res.preview).toBe("applied")
    expect(applied.n).toBe(0)
    expect(execRan).toBe(false)
  })
})
