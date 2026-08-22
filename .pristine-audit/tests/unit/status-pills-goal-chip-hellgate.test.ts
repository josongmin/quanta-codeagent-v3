/**
 * Hellgate for the `/goal` status-pill chip (`src/apps/cli/status-pills.ts`) —
 * the "🎯 <objective> · <elapsed>" chip that mirrors Codex's Pursuing-goal UI.
 * Renders through the REAL composer; red-on-injection if the chip formatter,
 * the flag, or the elapsed math regresses.
 */

import { describe, expect, test } from "bun:test"
import { createStatusPills, stripAnsi } from "@/apps/cli/status-pills"

const pills = (
  initial: NonNullable<Parameters<typeof createStatusPills>[0]>["initial"],
  env: NodeJS.ProcessEnv = {},
) =>
  createStatusPills({
    enabled: true,
    isTTY: true,
    env,
    ...(initial !== undefined ? { initial } : {}),
  })

describe("/goal status-pill chip", () => {
  test("renders 🎯 + objective + elapsed while a goal is active", () => {
    const line = stripAnsi(pills({ goal: { text: "ship the pursuit", elapsedMs: 0 } }).render())
    expect(line).toContain("🎯 ship the pursuit · 0m")
  })

  test("elapsed formats as Codex-style hours+minutes", () => {
    // 2h 7m = 127 minutes
    const line = stripAnsi(pills({ goal: { text: "g", elapsedMs: 127 * 60_000 } }).render())
    expect(line).toContain("· 2h 7m")
  })

  test("long objective text is truncated with an ellipsis", () => {
    const long = "x".repeat(80)
    const line = stripAnsi(pills({ goal: { text: long, elapsedMs: 0 } }).render())
    expect(line).toContain("…")
    expect(line).not.toContain(long)
  })

  test("no chip when no goal is active (byte-identical)", () => {
    const line = stripAnsi(pills({ cwd: "/tmp/x" }).render())
    expect(line).not.toContain("🎯")
  })

  test("QUANTA_PILL_GOAL=0 suppresses the chip (opt-out)", () => {
    const line = stripAnsi(
      pills({ goal: { text: "hidden", elapsedMs: 0 } }, { QUANTA_PILL_GOAL: "0" }).render(),
    )
    expect(line).not.toContain("🎯")
    expect(line).not.toContain("hidden")
  })

  test("update() lights the chip then clears it", () => {
    const p = pills({})
    expect(stripAnsi(p.render())).not.toContain("🎯")
    p.update({ goal: { text: "now pursuing", elapsedMs: 0 } })
    expect(stripAnsi(p.render())).toContain("🎯 now pursuing")
    p.update({ goal: undefined })
    expect(stripAnsi(p.render())).not.toContain("🎯")
  })
})
