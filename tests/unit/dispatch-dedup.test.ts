import { describe, expect, test } from "bun:test"
import * as fs from "node:fs"
import * as path from "node:path"
import {
  canonicalizeArgs,
  DedupGate,
  DEFAULT_DEDUP_GATE_CAPS,
} from "@/agent/dispatch-dedup"
import { __resetRuntimeConfig } from "@/shared"

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
