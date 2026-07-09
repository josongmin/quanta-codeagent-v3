/**
 * WS-F move 1 (UUX-2-01) — the PERMANENT palette regression fence.
 *
 * Invariant: **every palette entry either executes or explains — a silent
 * no-op is unrepresentable.** For every entry in the production catalogue
 * (assembled exactly the way App assembles it, both offline and connected),
 * simulating an accept must produce exactly one observable result:
 *
 *   - draft mutated (a prefill/usage-correction return that the host APPLIES), or
 *   - an effect ran (transcript append / panel opened / HTTP request issued), or
 *   - a message was sent to the session (`server-slash`), or
 *   - an inline hint was shown AND the draft was kept (`unwired`).
 *
 * The pre-fix bug: App.tsx's submit path ran `slash.cmd.action(rest)` and
 * DISCARDED its return, then cleared the draft — typing `/rewind` + Enter
 * silently wiped the draft with zero feedback. This test enumerates ALL
 * entries so any future entry that regresses to that shape goes RED.
 */

import { afterEach, describe, expect, it, vi } from "vitest"
import type { SlashCommand, SlashCommandContext } from "./SlashPalette"
import {
  assembleSlashCommands,
  resolveSlashCommandFrom,
  type SlashCatalogDeps,
} from "./slash-catalog"
import { executeSlashCommand, type SlashAcceptOutcome } from "./slash-routing"

/* ------------------------------------------------------------------ */
/* Harness                                                             */
/* ------------------------------------------------------------------ */

const sampleContext: SlashCommandContext = {
  modelSlug: "gpt-5",
  connection: { kind: "connected" },
  sessionId: "s-1",
  sessionStatus: "idle",
  permissionMode: "default",
  identityMode: null,
  toolProfile: null,
  messageCount: 2,
  tokenUsage: {
    promptTokens: 10,
    completionTokens: 5,
    totalTokens: 15,
    costMicroUsd: 100,
    turns: 1,
  },
  contextUsage: null,
}

interface Effects {
  clearTranscript: number
  focusImageAttachment: number
  appendClientMessage: number
  openKnobsPanel: number
  fetchCalls: string[]
}

const makeHarness = (endpoint: SlashCatalogDeps["endpoint"]) => {
  const effects: Effects = {
    clearTranscript: 0,
    focusImageAttachment: 0,
    appendClientMessage: 0,
    openKnobsPanel: 0,
    fetchCalls: [],
  }
  const deps: SlashCatalogDeps = {
    clearTranscript: () => {
      effects.clearTranscript += 1
    },
    focusImageAttachment: () => {
      effects.focusImageAttachment += 1
    },
    appendClientMessage: () => {
      effects.appendClientMessage += 1
    },
    getContext: () => sampleContext,
    openKnobsPanel: () => {
      effects.openKnobsPanel += 1
    },
    endpoint,
  }
  const commands = assembleSlashCommands(deps)
  const effectCount = (): number =>
    effects.clearTranscript +
    effects.focusImageAttachment +
    effects.appendClientMessage +
    effects.openKnobsPanel +
    effects.fetchCalls.length
  const resetEffects = (): void => {
    effects.clearTranscript = 0
    effects.focusImageAttachment = 0
    effects.appendClientMessage = 0
    effects.openKnobsPanel = 0
    effects.fetchCalls = []
  }
  return { commands, effects, effectCount, resetEffects }
}

/** Minimal happy-path fetch stub: satisfies readout / llm-config / auth
 *  handlers so their success paths run (each records the URL as an effect). */
const stubFetch = (calls: string[]): void => {
  globalThis.fetch = vi.fn(async (url: unknown) => {
    calls.push(String(url))
    return {
      ok: true,
      status: 200,
      json: async () => ({
        output: "readout body",
        authorizeUrl: "http://127.0.0.1:1455/authorize",
        loggedIn: false,
      }),
      text: async () => "",
    } as unknown as Response
  }) as unknown as typeof fetch
}

/** `/login` touches `window.open` even in the popup path — give the node env
 *  a minimal window so accept simulation doesn't crash. */
const stubWindow = (): void => {
  vi.stubGlobal("window", {
    open: () => ({
      closed: false,
      close: () => undefined,
      location: { href: "" },
    }),
  })
}

const realFetch = globalThis.fetch
afterEach(() => {
  globalThis.fetch = realFetch
  vi.unstubAllGlobals()
})

/** Args that satisfy each command's usage-validation happy path. */
const REST_BY_SLUG: Record<string, string> = {
  effort: "high",
  model: "gpt-5",
}

const simulateAccept = async (cmd: SlashCommand, draft: string): Promise<SlashAcceptOutcome> =>
  executeSlashCommand(cmd, REST_BY_SLUG[cmd.slug] ?? "", draft)

/* ------------------------------------------------------------------ */
/* The invariant                                                       */
/* ------------------------------------------------------------------ */

const CATALOGUE_MODES: readonly {
  name: string
  endpoint: SlashCatalogDeps["endpoint"]
}[] = [
  { name: "offline (no resolved connection)", endpoint: null },
  {
    name: "connected (daemon endpoint resolved)",
    endpoint: { httpUrl: "http://127.0.0.1:4096", token: "tok" },
  },
]

describe("palette invariant — every entry executes or explains", () => {
  for (const mode of CATALOGUE_MODES) {
    it(`${mode.name}: no entry may silently no-op on accept`, async () => {
      stubWindow()
      const { commands, effectCount, resetEffects, effects } = makeHarness(mode.endpoint)
      stubFetch(effects.fetchCalls)
      expect(commands.length).toBeGreaterThan(10)

      for (const cmd of commands) {
        resetEffects()
        const draft = `/${cmd.slug}`
        const outcome = await simulateAccept(cmd, draft)

        const observable =
          outcome.kind === "sent"
            ? outcome.text.length > 0
            : outcome.kind === "hint"
              ? outcome.hint.length > 0 && outcome.keptDraft === draft
              : effectCount() > 0 || outcome.nextDraft.length > 0

        expect(
          observable,
          `palette entry /${cmd.slug} (kind=${cmd.kind}) silently no-opped: ` +
            `outcome=${JSON.stringify(outcome)} effects=${effectCount()}`,
        ).toBe(true)
      }
    })

    it(`${mode.name}: every entry carries an explicit kind classification`, () => {
      stubWindow()
      const { commands } = makeHarness(mode.endpoint)
      for (const cmd of commands) {
        expect(
          ["local", "server-slash", "readout", "unwired"],
          `/${cmd.slug} has no kind`,
        ).toContain(cmd.kind)
      }
    })
  }

  it("readout entries actually request the daemon readout route", async () => {
    stubWindow()
    const { commands, effects } = makeHarness({ httpUrl: "http://127.0.0.1:4096" })
    stubFetch(effects.fetchCalls)
    const readouts = commands.filter((c) => c.kind === "readout")
    expect(readouts.length).toBeGreaterThan(0)
    for (const cmd of readouts) {
      effects.fetchCalls.length = 0
      await simulateAccept(cmd, `/${cmd.slug}`)
      expect(
        effects.fetchCalls.some((u) => u.includes("/readout/")),
        `/${cmd.slug} is classified readout but did not fetch /readout/:name`,
      ).toBe(true)
    }
  })

  it("unwired entries KEEP the draft and explain (never clear silently)", async () => {
    stubWindow()
    const { commands, effectCount } = makeHarness(null)
    const unwired = commands.filter((c) => c.kind === "unwired")
    expect(unwired.length).toBeGreaterThan(0)
    for (const cmd of unwired) {
      const draft = `/${cmd.slug} some args`
      const outcome = await executeSlashCommand(cmd, "some args", draft)
      expect(outcome.kind).toBe("hint")
      if (outcome.kind === "hint") {
        expect(outcome.keptDraft).toBe(draft)
        expect(outcome.hint).toContain(cmd.slug)
      }
      expect(effectCount()).toBe(0)
    }
  })

  it("UUX-2-01 pin: /rewind + accept yields a hint and keeps the draft", async () => {
    stubWindow()
    const { commands } = makeHarness({ httpUrl: "http://127.0.0.1:4096" })
    const hit = resolveSlashCommandFrom(commands, "/rewind")
    expect(hit).not.toBeNull()
    if (hit === null) return
    const outcome = await executeSlashCommand(hit.cmd, hit.rest, "/rewind")
    expect(outcome.kind).toBe("hint")
    if (outcome.kind === "hint") expect(outcome.keptDraft).toBe("/rewind")
  })

  it("shadowing fix: connected /effort resolves to the LIVE llm-config command, not an unwired stub", () => {
    stubWindow()
    const { commands } = makeHarness({ httpUrl: "http://127.0.0.1:4096" })
    const hit = resolveSlashCommandFrom(commands, "/effort high")
    expect(hit).not.toBeNull()
    if (hit === null) return
    expect(hit.cmd.kind).toBe("local")
    expect(hit.rest).toBe("high")
  })

  it("no duplicate slugs survive assembly (first-match shadowing is unrepresentable)", () => {
    stubWindow()
    const { commands } = makeHarness({ httpUrl: "http://127.0.0.1:4096" })
    const slugs = commands.map((c) => c.slug)
    expect(new Set(slugs).size).toBe(slugs.length)
  })
})
