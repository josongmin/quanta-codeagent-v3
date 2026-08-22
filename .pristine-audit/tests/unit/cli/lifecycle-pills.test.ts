/**
 * lifecycle-pills hellgate — subagent / follow-up queue / MCP pills.
 *
 * Pins the surface contract for `createLifecyclePills`: the conditional
 * render matrix, the bracket format, the viewport-truncation fold, the
 * per-pill ENV/opt suppression, the ANSI-free output, and the disposed
 * + disabled posture. Every case targets a real branch.
 */

import { describe, expect, test } from "bun:test"
import {
  createLifecyclePills,
  isLifecyclePillsEnabled,
  readPillEnvFlags,
} from "../../../src/apps/cli/lifecycle-pills"

const capture = (): { sink: (s: string) => void; calls: string[] } => {
  const calls: string[] = []
  return { sink: (s) => calls.push(s), calls }
}

describe("lifecycle-pills · empty state", () => {
  test("renders empty string with no updates", () => {
    const { sink } = capture()
    const pills = createLifecyclePills({ enabled: true, out: sink })
    expect(pills.render()).toBe("")
  })

  test("subagent running=0 + total=0 omits the tasks pill", () => {
    const pills = createLifecyclePills({ enabled: true })
    pills.update({ subagent: { running: 0, total: 0 } })
    expect(pills.render()).toBe("")
  })

  test("followUp queued=0 omits the follow-up pill", () => {
    const pills = createLifecyclePills({ enabled: true })
    pills.update({ followUp: { queued: 0 } })
    expect(pills.render()).toBe("")
  })

  test("mcp with zero servers omits the mcp pill", () => {
    const pills = createLifecyclePills({ enabled: true })
    pills.update({ mcp: { servers: [] } })
    expect(pills.render()).toBe("")
  })

  test("flush is a no-op when render is empty (no blank line)", () => {
    const { sink, calls } = capture()
    const pills = createLifecyclePills({ enabled: true, out: sink })
    pills.flush()
    expect(calls.length).toBe(0)
  })
})

describe("lifecycle-pills · subagent pill", () => {
  test("running=2 total=5 renders [tasks: 2/5 running]", () => {
    const pills = createLifecyclePills({ enabled: true })
    pills.update({ subagent: { running: 2, total: 5 } })
    expect(pills.render()).toBe("[tasks: 2/5 running]")
  })

  test("total enforced as max(total, running) when caller passes stale total", () => {
    const pills = createLifecyclePills({ enabled: true })
    pills.update({ subagent: { running: 3, total: 1 } })
    expect(pills.render()).toBe("[tasks: 3/3 running]")
  })

  test("names list — head + overflow indicator", () => {
    const pills = createLifecyclePills({ enabled: true })
    pills.update({
      subagent: { running: 4, total: 4, names: ["Feynman", "Noether", "Curie", "Lovelace"] },
    })
    expect(pills.render()).toBe("[tasks: 4/4 running: Feynman, Noether, Curie +1]")
  })

  test("only settled tasks (running=0, total>0) still renders", () => {
    const pills = createLifecyclePills({ enabled: true })
    pills.update({ subagent: { running: 0, total: 3 } })
    expect(pills.render()).toBe("[tasks: 0/3 running]")
  })
})

describe("lifecycle-pills · follow-up pill", () => {
  test("queued=3 + pausedReason renders both", () => {
    const pills = createLifecyclePills({ enabled: true })
    pills.update({ followUp: { queued: 3, pausedReason: "tool_running" } })
    expect(pills.render()).toBe("[follow-up: 3 queued (paused: tool_running)]")
  })

  test("queued without pausedReason omits the parenthetical", () => {
    const pills = createLifecyclePills({ enabled: true })
    pills.update({ followUp: { queued: 1 } })
    expect(pills.render()).toBe("[follow-up: 1 queued]")
  })
})

describe("lifecycle-pills · mcp pill", () => {
  test("all connected → ✓ glyphs", () => {
    const pills = createLifecyclePills({ enabled: true, viewportCols: 200 })
    pills.update({
      mcp: {
        servers: [
          { name: "fs", status: "connected" },
          { name: "git", status: "connected" },
        ],
      },
    })
    expect(pills.render()).toBe("[mcp: ✓ fs, ✓ git]")
  })

  test("mixed connected + down → ✗ glyph for down", () => {
    const pills = createLifecyclePills({ enabled: true, viewportCols: 200 })
    pills.update({
      mcp: {
        servers: [
          { name: "fs", status: "connected" },
          { name: "playwright", status: "down" },
        ],
      },
    })
    expect(pills.render()).toBe("[mcp: ✓ fs, ✗ playwright]")
  })

  test("viewport fold collapses long server list to count summary", () => {
    const pills = createLifecyclePills({ enabled: true, viewportCols: 40 })
    pills.update({
      mcp: {
        servers: [
          { name: "fs", status: "connected" },
          { name: "git", status: "connected" },
          { name: "playwright", status: "down" },
          { name: "supabase", status: "connected" },
          { name: "chrome", status: "down" },
        ],
      },
    })
    // 5 servers exceeds MCP_FOLD_SERVER_COUNT=4 → fold.
    expect(pills.render()).toBe("[mcp: 3/5 connected]")
  })
})

describe("lifecycle-pills · composition + update semantics", () => {
  test("all three pills concatenate with single-space separators", () => {
    const pills = createLifecyclePills({ enabled: true, viewportCols: 200 })
    pills.update({
      subagent: { running: 3, total: 5 },
      followUp: { queued: 1, pausedReason: "tool_result" },
      mcp: {
        servers: [
          { name: "fs", status: "connected" },
          { name: "playwright", status: "down" },
        ],
      },
    })
    expect(pills.render()).toBe(
      "[tasks: 3/5 running] [follow-up: 1 queued (paused: tool_result)] [mcp: ✓ fs, ✗ playwright]",
    )
  })

  test("partial update preserves the untouched pills", () => {
    const pills = createLifecyclePills({ enabled: true, viewportCols: 200 })
    pills.update({ mcp: { servers: [{ name: "fs", status: "connected" }] } })
    pills.update({ subagent: { running: 1, total: 1 } })
    expect(pills.render()).toBe("[tasks: 1/1 running] [mcp: ✓ fs]")
  })

  test("flush writes the rendered line + trailing newline", () => {
    const { sink, calls } = capture()
    const pills = createLifecyclePills({ enabled: true, out: sink, viewportCols: 200 })
    pills.update({ subagent: { running: 1, total: 1 } })
    pills.flush()
    expect(calls).toEqual(["[tasks: 1/1 running]\n"])
  })

  test("disposed pills are inert — update + render + flush become no-ops", () => {
    const { sink, calls } = capture()
    const pills = createLifecyclePills({ enabled: true, out: sink })
    pills.update({ subagent: { running: 1, total: 1 } })
    pills.dispose()
    pills.update({ subagent: { running: 99, total: 99 } })
    expect(pills.render()).toBe("")
    pills.flush()
    expect(calls.length).toBe(0)
  })

  test("enabled=false ⇒ render empty regardless of state", () => {
    const pills = createLifecyclePills({ enabled: false })
    pills.update({ subagent: { running: 9, total: 9 } })
    expect(pills.render()).toBe("")
  })

  test("ANSI-free output (no escape codes in any pill segment)", () => {
    const pills = createLifecyclePills({ enabled: true, viewportCols: 200 })
    pills.update({
      subagent: { running: 1, total: 1 },
      followUp: { queued: 1 },
      mcp: { servers: [{ name: "fs", status: "connected" }] },
    })
    const line = pills.render()
    // U+001B (ESC) MUST NOT appear — pills are plain text, status-bar paint
    // is handled by a separate surface (status-bar.ts).
    expect(line.includes("\x1b")).toBe(false)
  })

  test("hideTasks suppresses the tasks pill even when state present", () => {
    const pills = createLifecyclePills({ enabled: true, hideTasks: true, viewportCols: 200 })
    pills.update({
      subagent: { running: 1, total: 1 },
      followUp: { queued: 2 },
    })
    expect(pills.render()).toBe("[follow-up: 2 queued]")
  })

  test("hideMcp suppresses the mcp pill", () => {
    const pills = createLifecyclePills({ enabled: true, hideMcp: true, viewportCols: 200 })
    pills.update({
      subagent: { running: 1, total: 1 },
      mcp: { servers: [{ name: "fs", status: "connected" }] },
    })
    expect(pills.render()).toBe("[tasks: 1/1 running]")
  })

  test("final viewport guard hard-truncates with ellipsis", () => {
    const pills = createLifecyclePills({ enabled: true, viewportCols: 12 })
    pills.update({ subagent: { running: 1, total: 1 } })
    // "[tasks: 1/1 running]" is 20 chars > 12 ⇒ truncated with single trailing
    // ellipsis (Unicode U+2026 counts as 1 column in our budget).
    const line = pills.render()
    expect(line.endsWith("…")).toBe(true)
    expect(line.length).toBeLessThanOrEqual(12)
  })
})

describe("lifecycle-pills · env helpers", () => {
  test("isLifecyclePillsEnabled — TTY + no knob ⇒ ON", () => {
    expect(isLifecyclePillsEnabled({}, true)).toBe(true)
  })

  test("isLifecyclePillsEnabled — non-TTY ⇒ OFF", () => {
    expect(isLifecyclePillsEnabled({}, false)).toBe(false)
    expect(isLifecyclePillsEnabled({}, undefined)).toBe(false)
  })

  test("isLifecyclePillsEnabled — explicit 0/false/off/no disables", () => {
    for (const v of ["0", "false", "off", "no", "FALSE", " Off "]) {
      expect(isLifecyclePillsEnabled({ QUANTA_LIFECYCLE_PILLS: v }, true)).toBe(false)
    }
  })

  test("isLifecyclePillsEnabled — any other value keeps it ON", () => {
    expect(isLifecyclePillsEnabled({ QUANTA_LIFECYCLE_PILLS: "1" }, true)).toBe(true)
    expect(isLifecyclePillsEnabled({ QUANTA_LIFECYCLE_PILLS: "yes" }, true)).toBe(true)
  })

  test("readPillEnvFlags — defaults are all ON (no hides)", () => {
    expect(readPillEnvFlags({})).toEqual({
      hideTasks: false,
      hideFollowUp: false,
      hideMcp: false,
    })
  })

  test("readPillEnvFlags — per-pill 0/off knobs flip hide=true", () => {
    expect(
      readPillEnvFlags({
        QUANTA_PILL_TASKS: "0",
        QUANTA_PILL_FOLLOWUP: "off",
        QUANTA_PILL_MCP: "no",
      }),
    ).toEqual({ hideTasks: true, hideFollowUp: true, hideMcp: true })
  })
})
