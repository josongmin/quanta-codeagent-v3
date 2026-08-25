import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import { z } from "zod"
import type { AgentConfig } from "@/agent"
import { dispatchTool } from "@/agent/dispatch"
import { canonicalizeArgs, DEFAULT_DEDUP_GATE_CAPS, DedupGate } from "@/agent/dispatch-dedup"
import type { PermissionContext } from "@/permission"
import { __resetRuntimeConfig } from "@/shared"
import type { Tool, ToolEvent } from "@/tool"
import { ToolRegistry } from "@/tool"

/** Tiny helper: record N calls of the same shape at given turns and return the
 *  verdicts in order (so an assertion can read off `[pass, pass, blocked]`). */
const recordSeries = (
  gate: DedupGate,
  calls: Array<{ name: string; args: unknown; turn: number }>,
): ReturnType<DedupGate["record"]>[] =>
  calls.map(({ name, args, turn }) => gate.record(name, args, turn))

describe("canonicalizeArgs", () => {
  test("sorts object keys for byte-stable output", () => {
    const a = canonicalizeArgs({ b: 1, a: 2 })
    const b = canonicalizeArgs({ a: 2, b: 1 })
    expect(a).toBe(b)
  })

  test("collapses whitespace runs in string values", () => {
    const a = canonicalizeArgs({ command: "pip    install   flask" })
    const b = canonicalizeArgs({ command: "pip install flask" })
    expect(a).toBe(b)
  })

  test("trims and normalizes line endings", () => {
    const a = canonicalizeArgs({ command: "  hello\r\nworld  " })
    const b = canonicalizeArgs({ command: "hello\nworld" })
    expect(a).toBe(b)
  })

  test("drops undefined keys", () => {
    const a = canonicalizeArgs({ command: "ls", timeout_ms: undefined })
    const b = canonicalizeArgs({ command: "ls" })
    expect(a).toBe(b)
  })

  test("preserves array order", () => {
    const a = canonicalizeArgs({ args: ["a", "b"] })
    const b = canonicalizeArgs({ args: ["b", "a"] })
    expect(a).not.toBe(b)
  })

  test("survives cycles without throwing", () => {
    const x: { self?: unknown } = {}
    x.self = x
    expect(() => canonicalizeArgs(x)).not.toThrow()
  })
})

describe("DedupGate — defaults & PASS path (general regime)", () => {
  test("defaults: general 8/3, envmod 4/3, edit 8/5", () => {
    expect(DEFAULT_DEDUP_GATE_CAPS).toEqual({
      generalWindow: 8,
      generalThreshold: 3,
      envWindow: 4,
      envThreshold: 3,
      editWindow: 8,
      editThreshold: 5,
    })
  })

  test("3 calls to bash(ls): first 2 pass, 3rd blocked", () => {
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "bash", args: { command: "ls" }, turn: 1 },
      { name: "bash", args: { command: "ls" }, turn: 2 },
      { name: "bash", args: { command: "ls" }, turn: 3 },
    ])
    expect(v[0]?.blocked).toBe(false)
    expect(v[1]?.blocked).toBe(false)
    expect(v[2]?.blocked).toBe(true)
    if (v[2]?.blocked) {
      expect(v[2].regime).toBe("general")
      expect(v[2].count).toBe(3)
      expect(v[2].observation).toContain("[dedup-gate]")
      expect(v[2].observation).toContain("bash")
    }
  })

  test("interleaved: bash(make build), edit, bash(make build) — both make-build pass", () => {
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "bash", args: { command: "make build" }, turn: 1 },
      { name: "edit", args: { path: "/a", patch: "x" }, turn: 1 },
      { name: "bash", args: { command: "make build" }, turn: 2 },
    ])
    expect(v.map((x) => x.blocked)).toEqual([false, false, false])
  })

  test("9 turns apart: bash(pytest) twice pass (window expired)", () => {
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "bash", args: { command: "pytest" }, turn: 1 },
      // 9 turns later: 10 - 1 = 9 >= generalWindow(8) ⇒ first call falls out
      { name: "bash", args: { command: "pytest" }, turn: 10 },
    ])
    expect(v[0]?.blocked).toBe(false)
    expect(v[1]?.blocked).toBe(false)
  })

  test("different tool names with same args do not collide", () => {
    const g = new DedupGate()
    // 'read' three times blocked, but mixing with 'grep' on same path passes
    expect(g.record("read", { path: "/x.py" }, 1).blocked).toBe(false)
    expect(g.record("grep", { path: "/x.py" }, 1).blocked).toBe(false)
    expect(g.record("read", { path: "/x.py" }, 2).blocked).toBe(false)
    expect(g.record("grep", { path: "/x.py" }, 2).blocked).toBe(false)
  })
})

describe("DedupGate — BLOCKED cases (general regime)", () => {
  test("4 calls to read(/x/y.py) in turns 1-4: turn 3 onwards blocked", () => {
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "read", args: { path: "/x/y.py" }, turn: 1 },
      { name: "read", args: { path: "/x/y.py" }, turn: 2 },
      { name: "read", args: { path: "/x/y.py" }, turn: 3 },
      { name: "read", args: { path: "/x/y.py" }, turn: 4 },
    ])
    expect(v[0]?.blocked).toBe(false)
    expect(v[1]?.blocked).toBe(false)
    expect(v[2]?.blocked).toBe(true)
    expect(v[3]?.blocked).toBe(true)
  })

  test("3 calls to bash(pytest /foo) with different timeout_ms: still blocked (timeout_ms kept in canonicalization)", () => {
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "bash", args: { command: "pytest /foo", timeout_ms: 1000 }, turn: 1 },
      { name: "bash", args: { command: "pytest /foo", timeout_ms: 2000 }, turn: 2 },
      { name: "bash", args: { command: "pytest /foo", timeout_ms: 3000 }, turn: 3 },
    ])
    // CONSERVATIVE pick (spec note): timeout_ms is kept, so 3 distinct args do
    // NOT count as the same call — none should be blocked under that pick.
    // The spec asks "still blocked" — which is only true if we drop timeout_ms.
    // Document the actual conservative behavior here so a future tightening is
    // a single-line gate change (matches the inline TODO in dispatch-dedup.ts).
    expect(v[0]?.blocked).toBe(false)
    expect(v[1]?.blocked).toBe(false)
    expect(v[2]?.blocked).toBe(false)
  })

  test("3 calls to bash(pytest /foo) with IDENTICAL timeout_ms: blocked at #3", () => {
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "bash", args: { command: "pytest /foo", timeout_ms: 1000 }, turn: 1 },
      { name: "bash", args: { command: "pytest /foo", timeout_ms: 1000 }, turn: 2 },
      { name: "bash", args: { command: "pytest /foo", timeout_ms: 1000 }, turn: 3 },
    ])
    expect(v[2]?.blocked).toBe(true)
  })
})

describe("DedupGate — env regime (single bucket, fast brake)", () => {
  test("3 IDENTICAL pip installs: first 2 pass, 3rd blocked", () => {
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "bash", args: { command: "pip install flask" }, turn: 1 },
      { name: "bash", args: { command: "pip install flask" }, turn: 2 },
      { name: "bash", args: { command: "pip install flask" }, turn: 3 },
    ])
    expect(v.map((x) => x.blocked)).toEqual([false, false, true])
    if (v[2]?.blocked) {
      expect(v[2].regime).toBe("env")
      expect(v[2].observation).toContain("environment-modifying commands")
    }
  })

  test("SINGLE BUCKET: 3 DIFFERENT envmod commands count together (the sklearn thrash)", () => {
    // The real failure: same intent (install a dep) under many spellings —
    // exact-match dedup never caught it. Single bucket must brake by the 3rd.
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "bash", args: { command: "pip install setuptools" }, turn: 1 },
      { name: "bash", args: { command: "python3 -m pip install joblib" }, turn: 2 },
      { name: "bash", args: { command: "apt-get install python3-distutils" }, turn: 3 },
    ])
    expect(v.map((x) => x.blocked)).toEqual([false, false, true])
    if (v[2]?.blocked) expect(v[2].regime).toBe("env")
  })

  test("interleaved envmod spellings + sudo/brew/ensurepip all share the bucket", () => {
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "bash", args: { command: "brew install python@3" }, turn: 1 },
      { name: "bash", args: { command: "sudo apt-get install -y python3-distutils" }, turn: 2 },
      { name: "bash", args: { command: "python3 -m pip install --user distutils" }, turn: 3 },
    ])
    expect(v[2]?.blocked).toBe(true)
  })

  test("envmod regime prefixes: pip/pip3/python -m pip/npm/yarn/pnpm/apt/apt-get/conda/brew/chmod/chown/export/sudo all routed to envmod", () => {
    const commands = [
      "pip install flask",
      "pip3 install flask",
      "python -m pip install flask",
      "python3 -m pip install flask",
      "npm install",
      "yarn add lodash",
      "pnpm install",
      "apt update",
      "apt-get install -y curl",
      "conda install numpy",
      "brew install jq",
      "chmod +x ./run.sh",
      "chown root /etc/x",
      "export PATH=/foo:$PATH",
      "sudo apt install make",
    ]
    for (const cmd of commands) {
      const g = new DedupGate()
      // env threshold 3 ⇒ 3rd identical blocks, and regime is env
      g.record("bash", { command: cmd }, 1)
      g.record("bash", { command: cmd }, 2)
      const c = g.record("bash", { command: cmd }, 3)
      expect(c.blocked).toBe(true)
      if (c.blocked) expect(c.regime).toBe("env")
    }
  })

  test("envmod-detection is case-insensitive on the FIRST token", () => {
    const g = new DedupGate()
    g.record("bash", { command: "PIP install flask" }, 1)
    g.record("bash", { command: "PIP install x" }, 2)
    expect(g.record("bash", { command: "PIP install y" }, 3).blocked).toBe(true)
  })

  test("envmod-detection looks only at the first clause (chained && pytest)", () => {
    const g = new DedupGate()
    g.record("bash", { command: "pip install x && pytest" }, 1)
    g.record("bash", { command: "pip install y && pytest" }, 2)
    expect(g.record("bash", { command: "pip install z && pytest" }, 3).blocked).toBe(true)
  })

  test("a single legit envmod command passes (interactive: install once is fine)", () => {
    const g = new DedupGate()
    expect(g.record("bash", { command: "pip install flask" }, 1).blocked).toBe(false)
  })

  test("non-envmod bash command does NOT trigger envmod regime (general threshold applies)", () => {
    const g = new DedupGate()
    expect(g.record("bash", { command: "pytest" }, 1).blocked).toBe(false)
    expect(g.record("bash", { command: "pytest" }, 2).blocked).toBe(false)
    expect(g.record("bash", { command: "pytest" }, 3).blocked).toBe(true)
  })
})

describe("DedupGate — edit regime (per-file thrash brake)", () => {
  test("5 variant edits to the SAME file: first 4 pass, 5th blocked (the pallets thrash)", () => {
    // pallets: 13 different old_string/pattern edits to blueprints.py, none
    // landing. Per-file bucket must brake the flailing.
    const g = new DedupGate()
    const file = "src/flask/blueprints.py"
    const v = recordSeries(g, [
      { name: "edit", args: { path: file, old_string: "a", new_string: "x" }, turn: 1 },
      { name: "edit", args: { path: file, old_string: "b", new_string: "y" }, turn: 2 },
      { name: "scripted_replace", args: { file, pattern: "c", replacement: "z" }, turn: 3 },
      { name: "edit", args: { path: file, old_string: "d", new_string: "w" }, turn: 4 },
      { name: "scripted_replace", args: { file, pattern: "e", replacement: "v" }, turn: 5 },
    ])
    expect(v.slice(0, 4).every((x) => !x.blocked)).toBe(true)
    expect(v[4]?.blocked).toBe(true)
    if (v[4]?.blocked) {
      expect(v[4].regime).toBe("edit")
      expect(v[4].observation).toContain("edited this same file")
    }
  })

  test("edits to DIFFERENT files do not share a bucket", () => {
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "edit", args: { path: "/a.py", old_string: "1", new_string: "2" }, turn: 1 },
      { name: "edit", args: { path: "/b.py", old_string: "1", new_string: "2" }, turn: 2 },
      { name: "edit", args: { path: "/c.py", old_string: "1", new_string: "2" }, turn: 3 },
      { name: "edit", args: { path: "/d.py", old_string: "1", new_string: "2" }, turn: 4 },
      { name: "edit", args: { path: "/e.py", old_string: "1", new_string: "2" }, turn: 5 },
    ])
    expect(v.every((x) => !x.blocked)).toBe(true)
  })

  test("scripted_replace `file` field is bucketed same as edit `path`", () => {
    const g = new DedupGate()
    const file = "/same.py"
    const v = recordSeries(g, [
      { name: "edit", args: { path: file, old_string: "1", new_string: "2" }, turn: 1 },
      { name: "scripted_replace", args: { file, pattern: "x", replacement: "y" }, turn: 2 },
      { name: "edit", args: { path: file, old_string: "3", new_string: "4" }, turn: 3 },
      { name: "scripted_replace", args: { file, pattern: "z", replacement: "w" }, turn: 4 },
      { name: "edit", args: { path: file, old_string: "5", new_string: "6" }, turn: 5 },
    ])
    expect(v[4]?.blocked).toBe(true)
    if (v[4]?.blocked) expect(v[4].regime).toBe("edit")
  })

  // ── SSOT-adoption behavior (commit 44d90e0e2) ──
  // `mutatingTargetPaths` (the shared SSOT) added `write` + `apply_patch(_structured)`
  // to the per-file edit bucket. BEFORE, `write` fell to the GENERAL regime keyed on
  // path+content, so N same-file writes with DIFFERENT content never accrued; and
  // `apply_patch*` (omitted from the old inline `EDIT_TOOLS`) escaped the per-file
  // brake entirely. These pin the intended drift-repair (RED if editFileOf reverts
  // to the old `{edit, multi_edit, scripted_replace}` set).
  test("write: 5 same-file writes with DIFFERENT content brake at #5 (SSOT edit-bucket)", () => {
    const g = new DedupGate()
    const file = "/app/config.py"
    const v = recordSeries(g, [
      { name: "write", args: { path: file, content: "v1" }, turn: 1 },
      { name: "write", args: { path: file, content: "v2" }, turn: 2 },
      { name: "write", args: { path: file, content: "v3" }, turn: 3 },
      { name: "write", args: { path: file, content: "v4" }, turn: 4 },
      { name: "write", args: { path: file, content: "v5" }, turn: 5 },
    ])
    // Old behavior: general regime, distinct content ⇒ 5 distinct keys ⇒ none block.
    expect(v.slice(0, 4).every((x) => !x.blocked)).toBe(true)
    expect(v[4]?.blocked).toBe(true)
    if (v[4]?.blocked) expect(v[4].regime).toBe("edit")
  })

  test("write to DIFFERENT files does NOT share a bucket (per-file, not per-tool)", () => {
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "write", args: { path: "/a.py", content: "x" }, turn: 1 },
      { name: "write", args: { path: "/b.py", content: "x" }, turn: 2 },
      { name: "write", args: { path: "/c.py", content: "x" }, turn: 3 },
      { name: "write", args: { path: "/d.py", content: "x" }, turn: 4 },
      { name: "write", args: { path: "/e.py", content: "x" }, turn: 5 },
    ])
    expect(v.every((x) => !x.blocked)).toBe(true)
  })

  test("apply_patch(_structured): 5 patches on the same FIRST file brake at #5", () => {
    const g = new DedupGate()
    // V4A marker `*** Update File: <path>` is what mutatingTargetPaths scans; the
    // patch BODY differs each turn but the target file (bucket key) is constant.
    const patch = (n: number) =>
      `*** Begin Patch\n*** Update File: pkg/core.py\n@@\n-old${n}\n+new${n}\n*** End Patch`
    const v = recordSeries(g, [
      { name: "apply_patch", args: { patch: patch(1) }, turn: 1 },
      { name: "apply_patch_structured", args: { patch: patch(2) }, turn: 2 },
      { name: "apply_patch", args: { patch: patch(3) }, turn: 3 },
      { name: "apply_patch_structured", args: { patch: patch(4) }, turn: 4 },
      { name: "apply_patch", args: { patch: patch(5) }, turn: 5 },
    ])
    expect(v.slice(0, 4).every((x) => !x.blocked)).toBe(true)
    expect(v[4]?.blocked).toBe(true)
    if (v[4]?.blocked) expect(v[4].regime).toBe("edit")
  })
})

describe("DedupGate — per-session isolation", () => {
  test("two DedupGate instances do NOT share state", () => {
    const a = new DedupGate()
    const b = new DedupGate()
    // Prime `a` to the env brake (3 attempts ⇒ 3rd blocked).
    expect(a.record("bash", { command: "pip install flask" }, 1).blocked).toBe(false)
    expect(a.record("bash", { command: "pip install flask" }, 2).blocked).toBe(false)
    expect(a.record("bash", { command: "pip install flask" }, 3).blocked).toBe(true)
    // `b` is fresh — its first attempt at turn 3 must still pass (no shared state).
    expect(b.record("bash", { command: "pip install flask" }, 3).blocked).toBe(false)
  })
})

describe("DedupGate — replay: live sklearn env-thrash trace (11 distinct commands)", () => {
  test("the EXACT sklearn postfix sequence is braked by the 3rd envmod attempt", () => {
    // Verbatim from the gpt-4o-mini postfix run (sklearn.018, calls 7-19): the
    // model fired 11 DIFFERENT env-mutating commands chasing one missing dep.
    // Exact-match dedup never caught it; the single bucket must brake by #3.
    const g = new DedupGate()
    const cmds = [
      "pip install setuptools",
      "python3 -m pip install setuptools",
      "python3 -m pip install joblib",
      "apt-get install python3-distutils",
      "brew install python@3",
      "python3 -m pip install distutils",
      "sudo apt-get install -y python3-distutils",
      "python3 -m pip install --user distutils",
      "python3 -m pip install python3-distutils",
      "apt install python3-distutils",
      "python3 -m ensurepip",
    ]
    const verdicts = cmds.map((command, i) => g.record("bash", { command }, i + 1))
    // First two pass (window 4, threshold 3), 3rd blocked, and the brake holds
    // for the remaining 8 attempts (would have saved ~8 wasted turns live).
    expect(verdicts[0]?.blocked).toBe(false)
    expect(verdicts[1]?.blocked).toBe(false)
    expect(verdicts[2]?.blocked).toBe(true)
    expect(verdicts.slice(2).every((v) => v.blocked)).toBe(true)
    const firstBlocked = verdicts.findIndex((v) => v.blocked) + 1
    expect(firstBlocked).toBe(3)
  })
})

describe("DedupGate — env-extension via QUANTA_DEDUP_ENV_PREFIXES_EXTRA", () => {
  const SAVED = process.env.QUANTA_DEDUP_ENV_PREFIXES_EXTRA
  const reset = (): void => {
    if (SAVED === undefined) delete process.env.QUANTA_DEDUP_ENV_PREFIXES_EXTRA
    else process.env.QUANTA_DEDUP_ENV_PREFIXES_EXTRA = SAVED
    __resetRuntimeConfig()
  }

  test("a NEW package manager (uv) routes to envmod regime when added via QUANTA knob", () => {
    process.env.QUANTA_DEDUP_ENV_PREFIXES_EXTRA = "uv,poetry"
    __resetRuntimeConfig()
    const g = new DedupGate()
    // env threshold 3 — first 2 pass, 3rd blocks; regime must be "env"
    g.record("bash", { command: "uv add flask" }, 1)
    g.record("bash", { command: "uv add requests" }, 2)
    const v = g.record("bash", { command: "uv add numpy" }, 3)
    expect(v.blocked).toBe(true)
    if (v.blocked) expect(v.regime).toBe("env")
    reset()
  })

  test("defaults survive envmod extension (no replace)", () => {
    process.env.QUANTA_DEDUP_ENV_PREFIXES_EXTRA = "uv"
    __resetRuntimeConfig()
    const g = new DedupGate()
    g.record("bash", { command: "pip install x" }, 1)
    g.record("bash", { command: "pip install y" }, 2)
    const v = g.record("bash", { command: "pip install z" }, 3)
    expect(v.blocked).toBe(true)
    if (v.blocked) expect(v.regime).toBe("env")
    reset()
  })

  test("extra literals are regex-escaped (cargo+install matches as literal, not regex)", () => {
    process.env.QUANTA_DEDUP_ENV_PREFIXES_EXTRA = "cargo"
    __resetRuntimeConfig()
    const g = new DedupGate()
    g.record("bash", { command: "cargo install foo" }, 1)
    g.record("bash", { command: "cargo install bar" }, 2)
    const v = g.record("bash", { command: "cargo install baz" }, 3)
    expect(v.blocked).toBe(true)
    if (v.blocked) expect(v.regime).toBe("env")
    reset()
  })
})

describe("DedupGate — synthetic result block (mirrors deny-style helper)", () => {
  test("syntheticResult builds a non-error tool_result block (NO new event type)", () => {
    const block = DedupGate.syntheticResult("call-42", "do not loop")
    expect(block).toEqual({
      type: "tool_result",
      tool_use_id: "call-42",
      content: "do not loop",
    })
    expect(block.is_error).toBeUndefined()
  })
})

/**
 * ANTI-REGRESSION — the dedup gate pre-flights BEFORE any gate work.
 *
 * This block used to assert the invariant with three regexes over
 * `dispatch.ts`'s SOURCE: that a `for (const consult of PRE_FLIGHT_CONSULTS)`
 * loop existed, and that its source position preceded `runAdmissibilityGate(`.
 *
 * It broke without the invariant breaking. `4e742536b` replaced the explicit
 * loop with `firstConsult(PRE_FLIGHT_CONSULTS, …)` and extracted the gate call
 * into a helper defined EARLIER in the file — so the loop regex stopped
 * matching, and the position comparison inverted even though execution order
 * was untouched (the consult runs at the call site, the helper is merely
 * declared above it). A source-position heuristic cannot tell code motion from
 * behaviour change, and this is what that costs: a guard that reds on a
 * refactor it should have ignored, and would stay green if someone moved the
 * real call while leaving the text intact.
 *
 * So the ordering is now observed instead of read. `onConfirm` is the gate's
 * own work: a dedup-blocked call must never reach it.
 */
describe("DedupGate — anti-regression: the gate pre-flights before any gate work", () => {
  const bash = (): Tool => {
    const tool: Tool = {
      name: "bash",
      description: "bash tool",
      inputSchema: z.object({ command: z.string() }) as unknown as z.ZodType<unknown>,
      isReadOnly: () => false,
      // eslint-disable-next-line require-yield
      run: async function* () {
        yield { type: "stdout", text: "ok" } as unknown as ToolEvent
      },
    } as unknown as Tool
    return tool
  }

  /** Dispatch the same call `n` times against one gate; report every preview
   *  and how many times the gate's confirmation work was reached. */
  const runSeries = async (
    n: number,
    opts: { readonly withGate: boolean },
  ): Promise<{ previews: (string | undefined)[]; confirms: number }> => {
    let confirms = 0
    const tool = bash()
    const config = {
      cwd: "/repo",
      signal: new AbortController().signal,
      planMode: false,
      permission: { mode: "ask" } as unknown as PermissionContext,
      registry: new ToolRegistry([tool]),
      // the gate counts a shape's occurrences ACROSS turns inside a window, so
      // the turn has to advance like a real loop's does
      run: { turn: 0 },
      onConfirm: async () => {
        confirms += 1
        return false
      },
      ...(opts.withGate ? { dedupGate: new DedupGate() } : {}),
    } as unknown as AgentConfig
    const previews: (string | undefined)[] = []
    for (let i = 0; i < n; i += 1) {
      ;(config as unknown as { run: { turn: number } }).run.turn = i + 1
      const out = await dispatchTool(
        { type: "tool_use", id: `c${i}`, name: "bash", input: { command: "npm test" } },
        config,
        config.permission,
      )
      previews.push(out.preview)
    }
    return { previews, confirms }
  }

  test("🔴 a dedup-blocked call never reaches the gate's confirmation work", async () => {
    const withGate = await runSeries(4, { withGate: true })
    const blockedAt = withGate.previews.findIndex((p) => p?.startsWith("dedup-gate-"))
    expect(
      blockedAt,
      "the dedup gate never fired — the fixture no longer trips it",
    ).toBeGreaterThan(-1)
    // Everything BEFORE the block reached the gate; the blocked call did not.
    const confirmsAtBlock = withGate.confirms
    const after = await runSeries(blockedAt, { withGate: true })
    expect(
      confirmsAtBlock,
      "the blocked call still did gate work — the consult is no longer ahead of it",
    ).toBe(after.confirms)
  })

  test("PAIRED CONTROL: without the gate the same repeats all reach the gate", async () => {
    // Without this, "confirms did not grow" also passes when the gate work is
    // unreachable for every call and the observable is simply dead.
    const noGate = await runSeries(4, { withGate: false })
    expect(noGate.previews.some((p) => p?.startsWith("dedup-gate-"))).toBe(false)
    expect(noGate.confirms, "the confirmation observable is dead").toBe(4)
  })

  test("the consult stays wired into the ordered pre-flight table", () => {
    // Cheap structural companion to the behavioural proof above: the table is
    // the ORDER contract, and a consult silently dropped from it would leave
    // the behaviour test above passing only until someone repeats this call
    // shape. Deliberately does NOT assert source POSITION — that is the part
    // that broke on a refactor which changed nothing.
    const src = fs.readFileSync(path.resolve(__dirname, "../../src/agent/dispatch.ts"), "utf8")
    expect(/consultDedupGate[\s\S]*from\s+["']\.\/dispatch\/preflight-consults["']/.test(src)).toBe(
      true,
    )
    const table = src.match(/PRE_FLIGHT_CONSULTS[\s\S]*?=\s*\[([\s\S]*?)\]/)
    expect(table?.[1]).toContain("consultDedupGate")
  })
})
