/**
 * Hellgate — dedup gate (D1-dedup) two adversarial closures:
 *
 *  #15 — env-regime brake must NOT be keyed off the literal tool name `bash`.
 *        A sibling shell-equivalent tool (`shell`/`exec`/MCP `run`) whose
 *        command the registry's `extractShellCommand` resolves MUST hit the
 *        same tight env window. Before the fix, `bashCommandOf` short-circuited
 *        on `name !== "bash"`, so a tool named `shell` running `pip install …`
 *        N times sidestepped the env brake entirely (mirrors the S16 HARD_DENY
 *        gap closed by switching to `registry.extractShellCommand`).
 *
 *  #16 — same-turn PARALLEL identical calls must NOT accumulate into one window
 *        bucket as if they were a multi-turn spin. The spin brake counts
 *        DISTINCT turns; legitimate parallel fan-out (N identical reads/edits
 *        the loop dispatches together in one turn) must all execute. Before the
 *        fix, `kept.push(turn)` pushed the same turn N times, so the Nth
 *        parallel call (or N variant edits >= editThreshold in one turn) was
 *        false-blocked with a synthetic dedup observation.
 *
 * ANTI-THEATER: each test encodes the OLD (broken) behavior in its comment and
 * asserts the corrected behavior. Mentally reverting either fix flips the
 * asserted verdicts:
 *   - revert #15 (re-add `name !== "bash"` guard) ⇒ the `shell` tool's 3rd env
 *     call returns {blocked:false} ⇒ `expect(...blocked).toBe(true)` FAILS.
 *   - revert #16 (`kept.push(turn)` unconditionally) ⇒ the 3rd same-turn
 *     parallel call returns {blocked:true} ⇒ `expect(...blocked).toBe(false)`
 *     FAILS.
 */
import { describe, expect, test } from "bun:test"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { DedupGate, type ShellCommandExtractor } from "@/agent/dispatch-dedup"
import type { ToolUseBlock } from "@/llm"
import type { PermissionContext } from "@/permission"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

/** Canonical registry-style extractor: resolves a `command` field for the
 *  shell-equivalent tools and `null` for everything else — exactly the shape
 *  of `ToolRegistry.extractShellCommand(name, input)`. */
const SHELL_TOOLS = new Set(["bash", "shell", "exec", "run"])
const registryShellOf: ShellCommandExtractor = (name, args) => {
  if (!SHELL_TOOLS.has(name)) return null
  if (typeof args !== "object" || args === null) return null
  const cmd = (args as { command?: unknown }).command
  return typeof cmd === "string" ? cmd : null
}

describe("dedup #15 — env brake follows registry.extractShellCommand, not the name `bash`", () => {
  test("a non-bash shell-equivalent tool (`shell`) running env cmds hits the env brake at #3", () => {
    const g = new DedupGate()
    // 3 DIFFERENT env spellings under a tool literally named `shell`.
    // OLD behavior: `bashCommandOf` returns undefined for name !== "bash" ⇒
    // routed to the general regime ⇒ different-args means 3 distinct buckets ⇒
    // none blocked. The fix routes via the registry extractor ⇒ env single
    // bucket ⇒ braked by the 3rd.
    const v1 = g.record("shell", { command: "pip install setuptools" }, 1, registryShellOf)
    const v2 = g.record("shell", { command: "apt-get install python3-distutils" }, 2, registryShellOf)
    const v3 = g.record("shell", { command: "brew install python@3" }, 3, registryShellOf)
    expect(v1.blocked).toBe(false)
    expect(v2.blocked).toBe(false)
    expect(v3.blocked).toBe(true)
    if (v3.blocked) {
      expect(v3.regime).toBe("env")
      expect(v3.observation).toContain("environment-modifying commands")
    }
  })

  test("the registry extractor's null verdict keeps a genuinely non-shell tool in the general regime", () => {
    const g = new DedupGate()
    // `read` is NOT shell-equivalent: the extractor returns null even if a
    // `command`-shaped field were present, so it must use the general regime
    // (threshold 3 on exact args), never the tight env window.
    const v1 = g.record("read", { path: "/x.py" }, 1, registryShellOf)
    const v2 = g.record("read", { path: "/x.py" }, 2, registryShellOf)
    const v3 = g.record("read", { path: "/x.py" }, 3, registryShellOf)
    expect(v1.blocked).toBe(false)
    expect(v2.blocked).toBe(false)
    expect(v3.blocked).toBe(true)
    if (v3.blocked) expect(v3.regime).toBe("general")
  })

  test("built-in fallback (no extractor) still routes a `shell`-named env cmd to env regime (no `bash` hardcode)", () => {
    // Even without the registry extractor, the built-in probe reads `command`
    // for ANY tool name — it must NOT silently skip a tool named `shell`.
    const g = new DedupGate()
    g.record("shell", { command: "pip install a" }, 1)
    g.record("shell", { command: "pip install b" }, 2)
    const v = g.record("shell", { command: "pip install c" }, 3)
    expect(v.blocked).toBe(true)
    if (v.blocked) expect(v.regime).toBe("env")
  })
})

// ---------------------------------------------------------------------------
// #15-wire — the PRODUCTION dispatch seam must thread the registry's
// `extractShellCommand` into `gate.record(...)`. The unit tests above prove
// `DedupGate.record` HONORS a supplied extractor, but they hand it in directly
// and therefore say NOTHING about whether `consultDedupGate` in `dispatch.ts`
// actually passes it. The original incomplete fix left the seam calling
// `gate.record(call.name, call.input, turn)` with NO extractor — so in
// production a non-`bash` shell tool fell back to the built-in `command`-field
// probe, and a shell tool that carries its command under a DIFFERENT field name
// (the registry's `extractShellCommand` knows it; the built-in probe does not)
// silently sidestepped the env brake.
//
// This closes that hole at the real seam. The `shell` tool below declares
// `extractShellCommand` reading a NON-`command` field (`script`), so:
//   - With the wire (fixed): the registry extractor resolves the command ⇒
//     env regime ⇒ braked at the 3rd distinct turn ⇒ preview "dedup-gate-env".
//   - Without the wire (holed): the gate falls back to the built-in probe,
//     which only reads `command` and returns null for `{script}` ⇒ general
//     regime, exact-args keyed ⇒ THREE DIFFERENT spellings are three distinct
//     buckets ⇒ NONE reaches threshold ⇒ no block. The `toBe(false)` on the
//     "is wired" assertion FAILS against the holed code — ANTI-THEATER proven.
// ---------------------------------------------------------------------------
const wireShellTool: Tool = {
  name: "shell",
  description: "shell-equivalent tool whose command lives under `script`",
  // The command field is `script`, NOT `command` — so the built-in fallback
  // probe (which only reads `command`) cannot resolve it. Only the registry's
  // `extractShellCommand` can, which is exactly the production wire under test.
  inputSchema: z.object({ script: z.string() }) as z.ZodType<unknown>,
  isReadOnly: () => false,
  isConcurrencySafe: () => false,
  extractShellCommand: (input) => (input as { script: string }).script,
  execute: async function* (): AsyncIterable<ToolEvent> {
    yield { type: "result", result: { ok: true, output: "shell-ran" } } satisfies ToolEvent
  },
}

const wireCall = (script: string, id: string): ToolUseBlock => ({
  type: "tool_use",
  id,
  name: "shell",
  input: { script },
})

const wirePerm: PermissionContext = { mode: "acceptEdits" }

const wireCfg = (gate: DedupGate, turn: number): AgentConfig =>
  ({
    registry: new ToolRegistry([wireShellTool]),
    cwd: "/tmp",
    signal: new AbortController().signal,
    permission: { mode: "acceptEdits" } as PermissionContext,
    dedupGate: gate,
    run: { runId: "wire-test", turn },
  }) as AgentConfig

describe("dedup #15-wire — production dispatch seam threads registry.extractShellCommand", () => {
  test("a non-bash shell tool (command under `script`) hits the env brake via dispatchTool", async () => {
    // ONE gate across the run; the loop bumps `run.turn` each turn.
    const gate = new DedupGate()
    // Turn 1 + 2: env regime, below threshold ⇒ executes.
    const r1 = await dispatchTool(
      wireCall("pip install setuptools", "w1"),
      wireCfg(gate, 1),
      wirePerm,
    )
    const r2 = await dispatchTool(
      wireCall("apt-get install python3-distutils", "w2"),
      wireCfg(gate, 2),
      wirePerm,
    )
    expect(r1.ok).toBe(true)
    expect(r1.preview).toBe("shell-ran")
    expect(r2.ok).toBe(true)
    expect(r2.preview).toBe("shell-ran")

    // Turn 3: THREE distinct env spellings (all DIFFERENT exact args) now reach
    // the env single-bucket threshold (3). The brake fires ONLY because the
    // wire routed the `script` field through the registry extractor into the env
    // regime — the built-in fallback would have returned null and kept these in
    // the general regime as three distinct (never-blocked) buckets.
    const r3 = await dispatchTool(
      wireCall("brew install python@3", "w3"),
      wireCfg(gate, 3),
      wirePerm,
    )
    // `consultDedupGate` short-circuits with a synthetic NON-ERROR tool_result;
    // the preview tag is `dedup-gate-<regime>`. Env regime is the proof the wire
    // fired (general would be `dedup-gate-general`, which the holed code could
    // never even reach here because the three buckets stay distinct).
    expect(r3.ok).toBe(true)
    expect(r3.preview).toBe("dedup-gate-env")
    expect(r3.block.content).toContain("environment-modifying commands")
  })

  test("a genuinely non-shell tool stays in the general regime through the seam (no over-block)", async () => {
    // NO-OVER-CORRECTION: the wire must not turn every tool into env regime. A
    // `read`-shaped tool (no `extractShellCommand`) repeated across turns is the
    // GENERAL regime (exact-args keyed, threshold 3) — env brake never applies.
    const readTool: Tool = {
      name: "read",
      description: "read tool",
      inputSchema: z.object({ path: z.string() }) as z.ZodType<unknown>,
      isReadOnly: () => true,
      isConcurrencySafe: () => true,
      execute: async function* (): AsyncIterable<ToolEvent> {
        yield { type: "result", result: { ok: true, output: "data" } } satisfies ToolEvent
      },
    }
    const gate = new DedupGate()
    const cfg = (turn: number): AgentConfig =>
      ({
        registry: new ToolRegistry([readTool]),
        cwd: "/tmp",
        signal: new AbortController().signal,
        permission: { mode: "acceptEdits" } as PermissionContext,
        dedupGate: gate,
        run: { runId: "wire-test", turn },
      }) as AgentConfig
    const mk = (id: string): ToolUseBlock => ({
      type: "tool_use",
      id,
      name: "read",
      input: { path: "/x.py" },
    })
    const a = await dispatchTool(mk("r1"), cfg(1), wirePerm)
    const b = await dispatchTool(mk("r2"), cfg(2), wirePerm)
    const c = await dispatchTool(mk("r3"), cfg(3), wirePerm)
    expect(a.ok).toBe(true)
    expect(b.ok).toBe(true)
    // EXACT-same args three distinct turns ⇒ general threshold 3 ⇒ braked, but
    // as GENERAL (not env) — proving the wire did not mis-route a non-shell tool.
    expect(c.ok).toBe(true)
    expect(c.preview).toBe("dedup-gate-general")
  })
})

describe("dedup #16 — same-turn parallel fan-out is not a spin (count distinct turns only)", () => {
  test("N identical PARALLEL general calls in ONE turn all execute (none false-blocked)", () => {
    const g = new DedupGate()
    // 5 identical reads the loop dispatches together in turn 7. generalThreshold
    // is 3 — OLD behavior pushes turn 7 five times ⇒ count hits 3 on the 3rd
    // parallel call ⇒ false block. The fix collapses same-turn entries ⇒ count
    // stays 1 ⇒ all 5 execute.
    for (let i = 0; i < 5; i++) {
      const v = g.record("read", { path: "/pkg/mod.py" }, 7)
      expect(v.blocked).toBe(false)
    }
  })

  test("N identical PARALLEL env calls in ONE turn all execute (env single-bucket not tripped intra-turn)", () => {
    const g = new DedupGate()
    // 4 parallel env-equivalent calls in turn 2. envThreshold is 3 — OLD
    // behavior would block the 3rd and 4th. Distinct-turn counting keeps them
    // all running because it is one turn.
    for (let i = 0; i < 4; i++) {
      const v = g.record("bash", { command: `pip install dep${i}` }, 2)
      expect(v.blocked).toBe(false)
    }
  })

  test(">= editThreshold variant edits to one file in ONE turn all execute (parallel multi-edit fan-out)", () => {
    const g = new DedupGate()
    const file = "/src/mod.py"
    // editThreshold is 5 — fire 6 parallel variant edits to the same file in
    // turn 4. OLD behavior false-blocks the 5th/6th as flailing; distinct-turn
    // counting allows the whole one-turn batch.
    for (let i = 0; i < 6; i++) {
      const v = g.record("edit", { path: file, old_string: `o${i}`, new_string: `n${i}` }, 4)
      expect(v.blocked).toBe(false)
    }
  })

  test("a TRUE cross-turn spin is STILL braked after legitimate parallel fan-out", () => {
    const g = new DedupGate()
    const file = "/src/mod.py"
    // Turn 1: 4 parallel edits — all allowed (one distinct turn).
    for (let i = 0; i < 4; i++) {
      expect(g.record("edit", { path: file, old_string: `a${i}`, new_string: `b${i}` }, 1).blocked).toBe(
        false,
      )
    }
    // Now the model keeps editing the SAME file on separate turns 2..5.
    // editThreshold 5 ⇒ distinct turns 1,2,3,4 = 4 (pass), turn 5 = 5 (block).
    expect(g.record("edit", { path: file, old_string: "c", new_string: "d" }, 2).blocked).toBe(false)
    expect(g.record("edit", { path: file, old_string: "e", new_string: "f" }, 3).blocked).toBe(false)
    expect(g.record("edit", { path: file, old_string: "g", new_string: "h" }, 4).blocked).toBe(false)
    const v = g.record("edit", { path: file, old_string: "i", new_string: "j" }, 5)
    expect(v.blocked).toBe(true)
    if (v.blocked) {
      expect(v.regime).toBe("edit")
      expect(v.count).toBe(5)
    }
  })

  test("cross-turn env spin braked by distinct turns even when each turn fires parallel env calls", () => {
    const g = new DedupGate()
    // envWindow 4 / envThreshold 3. Each turn fires 2 parallel env calls.
    // Distinct turns are what count: turns 1,2 pass; turn 3 trips the brake.
    g.record("bash", { command: "pip install x" }, 1)
    expect(g.record("bash", { command: "pip install y" }, 1).blocked).toBe(false) // parallel, still 1 distinct
    g.record("bash", { command: "npm install" }, 2)
    expect(g.record("bash", { command: "yarn add z" }, 2).blocked).toBe(false) // 2 distinct
    g.record("bash", { command: "apt update" }, 3)
    const v = g.record("bash", { command: "brew install q" }, 3) // 3 distinct ⇒ brake
    expect(v.blocked).toBe(true)
    if (v.blocked) {
      expect(v.regime).toBe("env")
      expect(v.count).toBe(3)
    }
  })
})
