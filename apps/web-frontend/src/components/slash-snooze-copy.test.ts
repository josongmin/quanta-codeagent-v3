/**
 * UUX-4-19 — the palette's /snooze copy must describe what CLI /snooze DOES.
 *
 * CLI `/snooze` is a NEW-TURN gate (idle-monitor.ts: suspends new turn entry
 * until `snoozedUntil` elapses, default 5m; `/resume` cancels it). The old
 * palette copy said "Snooze background tasks" — there is no background-task
 * snooze anywhere in the CLI. String-assert against the CLI registry's own
 * describe semantics (fix-queue proof rule: help/copy pins are string asserts
 * against the owning SSOT's wording).
 */

import { describe, expect, it } from "vitest"
import { buildDefaultSlashCommands } from "./SlashPalette"

const catalogue = buildDefaultSlashCommands({
  clearTranscript: () => {},
  focusImageAttachment: () => {},
  appendClientMessage: () => {},
  getContext: () => {
    throw new Error("not needed")
  },
  openKnobsPanel: () => {},
})

const bySlug = (slug: string) => catalogue.find((c) => c.slug === slug)

describe("UUX-4-19 — snooze/resume palette copy matches CLI semantics", () => {
  it("SN-01: /snooze describes the new-turn gate, not background tasks", () => {
    const snooze = bySlug("snooze")
    expect(snooze).toBeDefined()
    expect(snooze?.description).toBe(
      "Suspend new turns for a duration (default 5m). e.g. /snooze 10m",
    )
    expect(snooze?.description.toLowerCase()).not.toContain("background")
  })

  it("SN-02: /resume describes cancelling the snooze (turn gate), not background tasks", () => {
    const resume = bySlug("resume")
    expect(resume).toBeDefined()
    expect(resume?.description).toBe("Cancel an active snooze and resume new turns")
    expect(resume?.description.toLowerCase()).not.toContain("background")
  })
})
