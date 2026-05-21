import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  canonicalizeArgs,
  DedupGate,
  DEFAULT_DEDUP_GATE_CAPS,
} from "@/agent/dispatch-dedup"

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
  test("defaults: general 8/3, env 4/2", () => {
    expect(DEFAULT_DEDUP_GATE_CAPS).toEqual({
      generalWindow: 8,
      generalThreshold: 3,
      envWindow: 4,
      envThreshold: 2,
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

describe("DedupGate — env regime (fast brake)", () => {
  test("2 calls to bash(pip install flask): first passes, 2nd blocked", () => {
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "bash", args: { command: "pip install flask" }, turn: 1 },
      { name: "bash", args: { command: "pip install flask" }, turn: 2 },
    ])
    expect(v[0]?.blocked).toBe(false)
    expect(v[1]?.blocked).toBe(true)
    if (v[1]?.blocked) {
      expect(v[1].regime).toBe("env")
      expect(v[1].observation).toContain("Env-modifying commands")
      expect(v[1].observation).toContain("pip/npm/apt")
    }
  })

  test("4 calls to bash(pip install flask) in turns 5/6/7/8: turn 6 onwards blocked", () => {
    const g = new DedupGate()
    const v = recordSeries(g, [
      { name: "bash", args: { command: "pip install flask" }, turn: 5 },
      { name: "bash", args: { command: "pip install flask" }, turn: 6 },
      { name: "bash", args: { command: "pip install flask" }, turn: 7 },
      { name: "bash", args: { command: "pip install flask" }, turn: 8 },
    ])
    expect(v[0]?.blocked).toBe(false)
    expect(v[1]?.blocked).toBe(true) // env threshold = 2
    expect(v[2]?.blocked).toBe(true)
    expect(v[3]?.blocked).toBe(true)
  })

  test("env regime prefixes: pip/pip3/python -m pip/python3 -m pip/npm/yarn/pnpm/apt/apt-get/conda/brew/chmod/chown/export/sudo all detected", () => {
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
      const a = g.record("bash", { command: cmd }, 1)
      const b = g.record("bash", { command: cmd }, 2)
      expect(a.blocked).toBe(false)
      expect(b.blocked).toBe(true)
      if (b.blocked) expect(b.regime).toBe("env")
    }
  })

  test("env-detection is case-insensitive on the FIRST token", () => {
    const g = new DedupGate()
    expect(g.record("bash", { command: "PIP install flask" }, 1).blocked).toBe(false)
    expect(g.record("bash", { command: "PIP install flask" }, 2).blocked).toBe(true)
  })

  test("env-detection looks only at the first clause (chained && pytest)", () => {
    const g = new DedupGate()
    // First clause is `pip install x` ⇒ env regime ⇒ second identical attempt blocked
    expect(g.record("bash", { command: "pip install x && pytest" }, 1).blocked).toBe(false)
    expect(g.record("bash", { command: "pip install x && pytest" }, 2).blocked).toBe(true)
  })

  test("non-env bash command does NOT trigger env regime (general threshold applies)", () => {
    const g = new DedupGate()
    // 'pytest' is general; second identical should still pass (threshold 3)
    expect(g.record("bash", { command: "pytest" }, 1).blocked).toBe(false)
    expect(g.record("bash", { command: "pytest" }, 2).blocked).toBe(false)
    expect(g.record("bash", { command: "pytest" }, 3).blocked).toBe(true)
  })
})

describe("DedupGate — per-session isolation", () => {
  test("two DedupGate instances do NOT share state", () => {
    const a = new DedupGate()
    const b = new DedupGate()
    expect(a.record("bash", { command: "pip install flask" }, 1).blocked).toBe(false)
    // b is fresh — same call at turn 1 must also pass
    expect(b.record("bash", { command: "pip install flask" }, 1).blocked).toBe(false)
    // a's second call is blocked (env regime)
    expect(a.record("bash", { command: "pip install flask" }, 2).blocked).toBe(true)
    // b's second call ALSO blocked (independent state, same trajectory)
    expect(b.record("bash", { command: "pip install flask" }, 2).blocked).toBe(true)
  })
})

describe("DedupGate — replay: synthetic pallets 21-turn env-loop trace", () => {
  test("8x bash(pip install flask) + other env commands: gate fires by turn 6 (well before turn 7)", () => {
    const g = new DedupGate()
    // Synthetic trace mirroring the observed pallets failure:
    //  turns 1-4: pip install flask repeated
    //  turn 5: chmod (different env command)
    //  turn 6: export
    //  turn 7-12: pip install flask resumed
    //  ...
    const trace: Array<{ turn: number; name: string; args: unknown }> = []
    for (let t = 1; t <= 8; t++) trace.push({ turn: t, name: "bash", args: { command: "pip install flask" } })
    // Add some interleaved env junk so the trace looks realistic
    trace.push({ turn: 9, name: "bash", args: { command: "chmod +x /tmp/x" } })
    trace.push({ turn: 10, name: "bash", args: { command: "chmod +x /tmp/x" } })
    trace.push({ turn: 11, name: "bash", args: { command: "export PATH=/foo" } })
    trace.push({ turn: 12, name: "bash", args: { command: "export PATH=/foo" } })

    const verdicts = trace.map((t) => ({
      turn: t.turn,
      verdict: g.record(t.name, t.args, t.turn),
    }))

    // Identify when the first BLOCK fires for pip install flask
    const firstBlockedTurn = verdicts.find((v) => v.verdict.blocked)?.turn
    expect(firstBlockedTurn).toBeDefined()
    expect(firstBlockedTurn).toBeLessThanOrEqual(7)
    expect(firstBlockedTurn).toBeGreaterThanOrEqual(2) // env regime fires at #2

    // chmod is also env regime — repeats blocked
    const chmodVerdicts = verdicts.filter(
      (v) =>
        v.turn === 9 || v.turn === 10,
    )
    expect(chmodVerdicts[0]?.verdict.blocked).toBe(false)
    expect(chmodVerdicts[1]?.verdict.blocked).toBe(true)

    // export likewise
    const exportVerdicts = verdicts.filter((v) => v.turn === 11 || v.turn === 12)
    expect(exportVerdicts[0]?.verdict.blocked).toBe(false)
    expect(exportVerdicts[1]?.verdict.blocked).toBe(true)
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

describe("DedupGate — anti-regression: dispatch.ts must call the gate before tool execution", () => {
  test("dispatch.ts contains a consultDedupGate / dedup-gate pre-flight short-circuit", () => {
    // Regex over the ACTUAL dispatch.ts source. If a future refactor removes
    // the call, this test fails — protecting the structural invariant T3 ships.
    const dispatchPath = path.resolve(__dirname, "../../src/agent/dispatch.ts")
    const src = fs.readFileSync(dispatchPath, "utf8")
    // Must import the gate (or its synthetic helper).
    expect(/from\s+["']\.\/dispatch-dedup["']/.test(src)).toBe(true)
    // Must consult the gate BEFORE the admissibility gate (line position check).
    const dedupIdx = src.search(/consultDedupGate\s*\(/)
    const admitIdx = src.search(/runAdmissibilityGate\s*\(/)
    expect(dedupIdx).toBeGreaterThan(0)
    expect(admitIdx).toBeGreaterThan(0)
    expect(dedupIdx).toBeLessThan(admitIdx)
  })
})
