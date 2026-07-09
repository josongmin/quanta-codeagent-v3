/**
 * UUX-2-10 / UUX-5-14 (jul-10 W4) — palette copy must say EXACTLY what the
 * command does, no more.
 *
 * `/clear` — the action is `clearTranscript` → `resetTranscript`
 * (ws/session-hooks.ts): it resets the LOCAL transcript reducer + the event
 * dedup set of THIS tab only. The daemon session, the agent's context, and the
 * persisted event log are untouched — a reload re-hydrates the full history
 * (App.tsx `hydrateTranscript`). The old copy ("Clear the visible transcript
 * (local only — session memory intact)") implied the transcript was gone; it
 * comes back on reload, so the copy must say so.
 *
 * `/plan` — CLI `/plan` is SHOW-only; the old palette copy "Show / edit the
 * current plan" promised an edit affordance that exists on no surface.
 *
 * Fix-queue proof rule: help/copy pins are string asserts against the owning
 * SSOT's wording (same pattern as slash-snooze-copy.test.ts).
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

describe("UUX-2-10 — /clear copy states the exact local-view-only effect", () => {
  it("CL-01: /clear says it clears this tab's view, keeps agent context, and that reload restores history", () => {
    const clear = bySlug("clear")
    expect(clear).toBeDefined()
    expect(clear?.description).toBe(
      "Clear this tab's transcript view (agent context kept; reload restores it)",
    )
  })

  it("CL-02: /clear copy never claims session/memory-wide effects it does not have", () => {
    const desc = bySlug("clear")?.description.toLowerCase() ?? ""
    // The old copy's "session memory intact" read as a claim ABOUT the session;
    // the honest copy scopes itself to the tab's view.
    expect(desc).toContain("this tab")
    expect(desc).toContain("reload restores")
  })
})

describe("UUX-5-14 — /plan copy is show-only (no edit lie)", () => {
  it("PL-01: /plan says exactly 'Show the current plan'", () => {
    const plan = bySlug("plan")
    expect(plan).toBeDefined()
    expect(plan?.description).toBe("Show the current plan")
  })

  it("PL-02: /plan copy never promises editing", () => {
    expect(bySlug("plan")?.description.toLowerCase()).not.toContain("edit")
  })
})
