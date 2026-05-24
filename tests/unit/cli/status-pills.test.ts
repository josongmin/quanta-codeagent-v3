/**
 * Status-pills composer tests — workspace / mode+effort / skills / sandbox.
 *
 * These are PURE render tests (no real terminal): the composer is constructed
 * with an injected env + `isTTY: true` so it behaves identically across
 * test runners. The underlying StatusBar is also faked — we observe the
 * sequence of `setDefault(text)` calls instead of inspecting ANSI on stderr.
 *
 * Slice: imports ONLY from `src/apps/cli/status-pills` + the StatusBar TYPE
 * (no installStatusBar IO). Keeps the test hermetic and process-env-isolated.
 */

import { describe, expect, mock, test } from "bun:test"
import type { StatusBar } from "../../../src/apps/cli/status-bar"
import {
  createStatusPills,
  PILL_ENV_VARS,
  type SandboxMode,
  stripAnsi,
} from "../../../src/apps/cli/status-pills"

/** Asserts the public PILL_ENV_VARS array stays in sync with what the test
 *  override block expects to gate. Failing here means a knob was added/removed
 *  in `status-pills.ts` without a matching test update. */
const KNOWN_KNOBS = new Set<string>([
  "QUANTA_PILLS",
  "QUANTA_PILL_WORKSPACE",
  "QUANTA_PILL_MODE",
  "QUANTA_PILL_SKILLS",
  "QUANTA_PILL_SANDBOX",
  "QUANTA_PILL_RULES",
])

/** Hermetic env builder. We do NOT set any of {@link PILL_ENV_VARS}; the
 *  composer treats absent ⇒ default-ON master + default-ON per-pill. */
const cleanEnv = (overrides: Record<string, string> = {}): NodeJS.ProcessEnv =>
  ({ ...overrides }) as NodeJS.ProcessEnv

/** Capture-only StatusBar fake — records every setDefault call. */
const fakeStatusBar = (): { bar: StatusBar; defaults: string[] } => {
  const defaults: string[] = []
  return {
    defaults,
    bar: {
      setDefault: (t: string) => {
        defaults.push(t)
      },
      transient: () => undefined,
      clearTransient: () => undefined,
      teardown: () => undefined,
    },
  }
}

describe("status-pills — exported knob inventory", () => {
  test("PILL_ENV_VARS exactly matches the documented knob set", () => {
    const exported = new Set(PILL_ENV_VARS as readonly string[])
    expect(exported).toEqual(KNOWN_KNOBS)
  })
})

describe("status-pills — default render shape", () => {
  test("all 4 pills render when state is fully populated", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv(),
      initial: {
        cwd: "/Users/me/projects/quanta",
        mode: "plan",
        effort: "high",
        activeSkills: [{ name: "progress-audit" }],
        sandboxMode: "read-only",
      },
    })
    const plain = stripAnsi(pills.render())
    expect(plain).toContain("@ quanta")
    expect(plain).toContain("[PLAN]")
    expect(plain).toContain("[🧠 high]")
    expect(plain).toContain("[skills: progress-audit]")
    expect(plain).toContain("🔒 read-only")
  })

  test("default mode + default effort are suppressed (clutter reduction)", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv(),
      initial: {
        cwd: "/tmp/x",
        mode: "default",
        effort: "default",
        sandboxMode: "default",
      },
    })
    const plain = stripAnsi(pills.render())
    expect(plain).toContain("@ x")
    expect(plain).not.toContain("[default]")
    expect(plain).not.toContain("[DEFAULT]")
    expect(plain).not.toContain("🧠")
    // Sandbox "default" is also suppressed — no badge characters present.
    expect(plain).not.toContain("🔒")
    expect(plain).not.toContain("⚙")
    expect(plain).not.toContain("⚡")
  })

  test("effort=medium is suppressed (mirrors mode=default behaviour)", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv(),
      initial: { cwd: "/tmp/x", effort: "medium" },
    })
    expect(stripAnsi(pills.render())).not.toContain("🧠")
  })
})

describe("status-pills — skills fold", () => {
  test("1-2 skills render inline names", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv(),
      initial: { cwd: "/tmp/r", activeSkills: [{ name: "a" }, { name: "b" }] },
    })
    expect(stripAnsi(pills.render())).toContain("[skills: a · b]")
  })

  test("3+ skills fold to count form", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv(),
      initial: {
        cwd: "/tmp/r",
        activeSkills: [{ name: "a" }, { name: "b" }, { name: "c" }, { name: "d" }],
      },
    })
    expect(stripAnsi(pills.render())).toContain("[skills: 4 active]")
  })

  test("empty skills array suppresses the pill", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv(),
      initial: { cwd: "/tmp/r", activeSkills: [] },
    })
    expect(stripAnsi(pills.render())).not.toContain("skills:")
  })
})

describe("status-pills — sandbox badge matrix", () => {
  const cases: Array<{ mode: SandboxMode; needle: string }> = [
    { mode: "read-only", needle: "🔒 read-only" },
    { mode: "workspace", needle: "⚙ workspace" },
    { mode: "danger", needle: "⚡ danger" },
  ]
  for (const { mode, needle } of cases) {
    test(`sandbox=${mode} ⇒ "${needle}"`, () => {
      const pills = createStatusPills({
        isTTY: true,
        env: cleanEnv(),
        initial: { cwd: "/tmp/r", sandboxMode: mode },
      })
      expect(stripAnsi(pills.render())).toContain(needle)
    })
  }

  test("sandbox=default ⇒ no badge", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv(),
      initial: { cwd: "/tmp/r", sandboxMode: "default" },
    })
    const plain = stripAnsi(pills.render())
    expect(plain).not.toContain("🔒")
    expect(plain).not.toContain("⚙")
    expect(plain).not.toContain("⚡")
  })
})

describe("status-pills — update / dispose lifecycle", () => {
  test("partial update only changes the specified pill", () => {
    const { bar, defaults } = fakeStatusBar()
    const pills = createStatusPills({
      statusBar: bar,
      isTTY: true,
      env: cleanEnv(),
      initial: { cwd: "/tmp/r", mode: "plan" },
    })
    expect(stripAnsi(pills.render())).toContain("[PLAN]")
    pills.update({ effort: "high" })
    const out2 = stripAnsi(pills.render())
    expect(out2).toContain("[PLAN]") // mode preserved
    expect(out2).toContain("[🧠 high]")
    // Two setDefault calls observed: initial paint + post-update paint.
    expect(defaults.length).toBeGreaterThanOrEqual(2)
  })

  test("dispose() clears state and renders empty", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv(),
      initial: { cwd: "/tmp/r", mode: "plan" },
    })
    const disposeSpy = mock(pills.dispose)
    expect(pills.render()).not.toBe("")
    disposeSpy()
    expect(pills.render()).toBe("")
    // Update after dispose is a no-op (no throw).
    pills.update({ effort: "max" })
    expect(pills.render()).toBe("")
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })
})

describe("status-pills — TTY / env gating", () => {
  test("non-TTY ⇒ render() empty + dispose() no-op even without explicit dispose", () => {
    const pills = createStatusPills({
      isTTY: false,
      env: cleanEnv(),
      initial: { cwd: "/tmp/r", mode: "plan", effort: "high" },
    })
    const disposeSpy = mock(pills.dispose)
    expect(pills.render()).toBe("")
    pills.update({ mode: "review" })
    expect(pills.render()).toBe("")
    disposeSpy() // must not throw
    expect(disposeSpy).toHaveBeenCalledTimes(1)
  })

  test("QUANTA_PILLS=0 ⇒ master switch off, render empty", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv({ QUANTA_PILLS: "0" }),
      initial: { cwd: "/tmp/r", mode: "plan", effort: "high" },
    })
    expect(pills.render()).toBe("")
  })

  test("QUANTA_PILL_SKILLS=0 disables only the skills pill", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv({ QUANTA_PILL_SKILLS: "0" }),
      initial: {
        cwd: "/tmp/r",
        mode: "plan",
        activeSkills: [{ name: "a" }],
        sandboxMode: "read-only",
      },
    })
    const plain = stripAnsi(pills.render())
    expect(plain).toContain("@ r")
    expect(plain).toContain("[PLAN]")
    expect(plain).not.toContain("skills:")
    expect(plain).toContain("🔒 read-only")
  })

  test("QUANTA_PILL_WORKSPACE=0 disables only the workspace pill", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv({ QUANTA_PILL_WORKSPACE: "0" }),
      initial: { cwd: "/tmp/repo", mode: "plan" },
    })
    const plain = stripAnsi(pills.render())
    expect(plain).not.toContain("@ repo")
    expect(plain).toContain("[PLAN]")
  })

  test("`enabled: false` override beats default-ON env", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv(),
      enabled: false,
      initial: { cwd: "/tmp/r", mode: "plan" },
    })
    expect(pills.render()).toBe("")
  })
})

describe("status-pills — viewport / safety", () => {
  test("workspace pill truncates absurdly long basenames", () => {
    const long = `/tmp/${"a".repeat(80)}`
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv(),
      initial: { cwd: long },
    })
    const plain = stripAnsi(pills.render())
    // Must contain the ellipsis token and not the raw 80-char run.
    expect(plain).toContain("…")
    expect(plain.length).toBeLessThan(100)
  })

  test("trailing slash in cwd does not yield an empty workspace pill", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv(),
      initial: { cwd: "/Users/me/projects/quanta/" },
    })
    expect(stripAnsi(pills.render())).toContain("@ quanta")
  })

  test("render output is a single line (no embedded newlines)", () => {
    const pills = createStatusPills({
      isTTY: true,
      env: cleanEnv(),
      initial: {
        cwd: "/tmp/r",
        mode: "audit",
        effort: "max",
        activeSkills: [{ name: "x" }, { name: "y" }],
        sandboxMode: "danger",
      },
    })
    expect(pills.render().includes("\n")).toBe(false)
  })
})
