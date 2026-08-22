/**
 * HELLGATE — Wave-4 (jul-10) UUX-2-23 + UUX-5-18: welcome banner honesty.
 *
 * The gap: the banner's first paint advertises only /help + cancel + quit,
 * omitting the TWO default-ON interactive affordances a new operator cannot
 * discover otherwise — Shift+Tab permission-mode cycling (QUANTA_MODE_CYCLE)
 * and @-mention autocomplete (QUANTA_AT_AUTOCOMPLETE), both CLI-seeded ON in
 * `cli-feature-gates.ts` — and says NOTHING about the trust posture when the
 * untrusted-envelope defense (QUANTA_UNTRUSTED_ENVELOPE) is active
 * (UUX-5-18: security posture invisible).
 *
 * Structural rules pinned here:
 *  - the banner stays a PURE renderer: the gate states arrive as data
 *    (`buildWelcomeInfo` third arg, computed by the repl host);
 *  - the Shift+Tab chord copy derives from the keybind-truth SSOT
 *    (`KB_MODE_CYCLE`, the SAME object rendered by `/help`) — no third
 *    hand-written mirror;
 *  - honesty both ways: gate OFF (explicit operator opt-out) ⇒ the banner
 *    does NOT advertise the affordance.
 *
 * RED-first proof: `KB_MODE_CYCLE` is not exported and the banner renders
 * none of these lines at HEAD.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { KB_MODE_CYCLE, KEYBIND_TRUTH } from "@/apps/cli/keybind-truth"
import {
  buildWelcomeInfo,
  renderWelcomeBanner,
  type WelcomeBannerInfo,
} from "@/apps/cli/welcome-banner"
import { setColorPolicy, stripAnsi } from "@/ui/ui-helpers"

beforeEach(() => setColorPolicy("off"))
afterEach(() => setColorPolicy(null))

const baseInfo: WelcomeBannerInfo = {
  version: "0.0.0-test",
  provider: "openai",
  model: "gpt-test",
  mode: "default",
  cwd: "/tmp/w",
}

const banner = (info: WelcomeBannerInfo): string => stripAnsi(renderWelcomeBanner(info))

describe("keybind SSOT — Shift+Tab entry is exported and stays in the truth table", () => {
  test("KB_MODE_CYCLE is the SAME object the /help table renders (no second mirror)", () => {
    expect(KB_MODE_CYCLE.chord).toBe("Shift+Tab")
    expect(KEYBIND_TRUTH).toContain(KB_MODE_CYCLE)
  })
})

describe("UUX-2-23 — banner advertises the default-ON affordances", () => {
  test("modeCycle ON ⇒ the SSOT chord + mode-cycle copy render", () => {
    const out = banner({ ...baseInfo, modeCycle: true })
    expect(out).toContain(KB_MODE_CYCLE.chord)
    expect(out.toLowerCase()).toContain("cycle")
  })

  test("atMention ON ⇒ the @-mention affordance renders", () => {
    const out = banner({ ...baseInfo, atMention: true })
    expect(out).toContain("@")
    expect(out.toLowerCase()).toContain("mention")
  })

  test("gates OFF/omitted ⇒ neither affordance is advertised (honesty both ways)", () => {
    const out = banner(baseInfo)
    expect(out).not.toContain("Shift+Tab")
    expect(out.toLowerCase()).not.toContain("mention")
  })
})

describe("UUX-5-18 — trust posture line", () => {
  test("untrustedEnvelope ON ⇒ ONE trust line naming the posture", () => {
    const out = banner({ ...baseInfo, untrustedEnvelope: true })
    expect(out.toLowerCase()).toContain("trust")
    expect(out).toContain("untrusted")
    // Exactly one trust row.
    const rows = out.split("\n").filter((l) => l.toLowerCase().includes("untrusted"))
    expect(rows.length).toBe(1)
  })

  test("untrustedEnvelope OFF/omitted ⇒ no trust line (never claim a defense that is off)", () => {
    const out = banner(baseInfo)
    expect(out).not.toContain("untrusted")
  })
})

describe("buildWelcomeInfo — the repl host threads the gate states as data", () => {
  const setup = {
    provider: "p",
    model: "m",
    mode: "default",
    cwd: "/tmp",
    history: [],
    mcpClients: [],
    mcpTools: [],
    effortStore: { get: (): string => "med" },
  }

  test("gates argument lands on the info object", () => {
    const info = buildWelcomeInfo(setup, undefined, {
      modeCycle: true,
      atMention: false,
      untrustedEnvelope: true,
    })
    expect(info.modeCycle).toBe(true)
    expect(info.atMention).toBe(false)
    expect(info.untrustedEnvelope).toBe(true)
  })

  test("omitted gates keep the legacy shape (no accidental advertising)", () => {
    const info = buildWelcomeInfo(setup, undefined)
    expect(info.modeCycle).toBeUndefined()
    expect(info.atMention).toBeUndefined()
    expect(info.untrustedEnvelope).toBeUndefined()
  })
})
