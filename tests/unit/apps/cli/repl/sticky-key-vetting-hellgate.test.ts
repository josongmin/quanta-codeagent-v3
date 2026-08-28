/**
 * ★ HELLGATE (MR-08 items 1 + 4) — a hostile STORAGE KEY cannot reach a display,
 * and the rejection log cannot become the payload's second delivery channel.
 *
 * `~/.quanta/sticky-model.json` is untrusted (any local process, and the agent's
 * own bash tool, can write it). Its VALUES were vetted; its KEYS were only
 * CLASSIFIED, by `key.includes(":")` + `key.startsWith(`${provider}:`)`.
 *
 * MEASURED PRE-FIX, end to end through the real wire below: a file holding
 *   {"anthropic:<ESC>[2J<ESC>]0;pwned<BEL>default": "claude-sonnet-4-6"}
 * cleared `vetPersistedPicks` untouched, seeded the session store, and came out
 * of `/sticky-model` (no args) as `/sticky-model: <ESC>[2J… = claude-sonnet-4-6`
 * — an escape sequence written straight to the operator's terminal from a JSON
 * key. Key length was unbounded, so the same path also carried arbitrarily large
 * strings into every display.
 *
 * This file drives the REAL production chain — `resolveStickyModelBoot` reads a
 * REAL file, its vetted snapshot seeds a REAL `sessionScopedStickyModelStore`,
 * a REAL `buildStickyModelAdapter` wraps it, and the REAL `/sticky-model` command
 * out of `SURFACE_SLASH_COMMANDS` renders it. Nothing here re-implements the
 * codec; the codec's own accept/reject table lives in
 * `src/agent/sticky-model/__tests__/key-codec.hellgate.test.ts`.
 *
 * RED-on-injection (each verified against a `cp` backup):
 *   - restore the `key.includes(":")` classifier in `vetPersistedPicks`
 *       ⇒ RENDER-1, VET-1 and LOGS-1 red.
 *   - log the raw `key` instead of `summarizeUntrustedId(key)`
 *       ⇒ LOGS-1 and LOGS-2 red.
 *   - drop the length cap in `summarizeUntrustedId`
 *       ⇒ LOGS-2 red.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fsBackedStickyModelStore, sessionScopedStickyModelStore } from "@/agent/sticky-model"
import { buildStickyModelAdapter } from "@/apps/cli/repl/ctx-adapters/sticky-model-adapter"
import { resolveStickyModelBoot, vetPersistedPicks } from "@/apps/cli/repl/sticky-model-boot"
import { SURFACE_SLASH_COMMANDS } from "@/apps/cli/slash/registry-surface"
import type { SlashContext } from "@/apps/cli/slash-contract"
import { logger, summarizeUntrustedId } from "@/shared"

/** The measured payload: a scoped-looking key whose MODE segment carries an
 *  erase-display CSI, an OSC title-set, and a newline that forges a fresh line. */
const HOSTILE_KEY = "anthropic:\u001b[2J\u001b]0;pwned\u0007default\nApprove destructive action?"
const PLAUSIBLE_VALUE = "claude-sonnet-4-6"

const scratch: string[] = []
const mkScratch = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "mr08-sticky-vet-"))
  scratch.push(dir)
  return dir
}

let warnSpy: ReturnType<typeof spyOn> | undefined
beforeEach(() => {
  warnSpy = spyOn(logger, "warn").mockImplementation(() => {})
})
afterEach(() => {
  warnSpy?.mockRestore()
  warnSpy = undefined
  for (const dir of scratch.splice(0)) rmSync(dir, { recursive: true, force: true })
})

const warnings = (): string[] =>
  ((warnSpy?.mock.calls ?? []) as ReadonlyArray<readonly unknown[]>).map((c) => String(c[0]))

const stickyCmd = () => {
  const c = SURFACE_SLASH_COMMANDS.find((x) => x.name === "/sticky-model")
  if (c === undefined) throw new Error("/sticky-model not registered")
  return c
}

/** The production chain, from a real file on disk to the real slash command's
 *  stdout. Every collaborator is the production one. */
const renderStickyListing = async (
  picks: Record<string, string>,
  provider: string,
): Promise<string> => {
  const path = join(mkScratch(), "sticky-model.json")
  writeFileSync(path, JSON.stringify(picks))
  const boot = resolveStickyModelBoot({ planMode: false, path, provider })
  const store = sessionScopedStickyModelStore({
    inner: fsBackedStickyModelStore({ path }),
    seed: boot.snapshot,
  })
  const out: string[] = []
  const ctx = {
    out: (s: string) => out.push(s),
    err: (s: string) => out.push(s),
    cwd: "/tmp",
    stickyModel: buildStickyModelAdapter({ store, provider }),
  } as unknown as SlashContext
  expect(await stickyCmd().run([], ctx)).toBe(0)
  return out.join("")
}

describe("MR-08 · hostile sticky KEYS never reach a display or a log verbatim", () => {
  test("RENDER-1: the hostile key never appears in `/sticky-model`'s output", async () => {
    const text = await renderStickyListing(
      { [HOSTILE_KEY]: PLAUSIBLE_VALUE, "anthropic:plan": "claude-sonnet-4-6" },
      "anthropic",
    )
    // Not one byte of the payload — not the CSI, not the OSC, not the forged line.
    expect(text).not.toContain("\u001b")
    expect(text).not.toContain("\u0007")
    expect(text).not.toContain("Approve destructive action?")
    expect(text).not.toContain("pwned")
    // Paired control: the LEGITIMATE pick sitting next to it in the same file is
    // still listed. A fix that dropped the whole snapshot on one bad key would
    // pass every assertion above and be wrong.
    expect(text).toContain("anthropic:plan = claude-sonnet-4-6")
  })

  test("RENDER-2: an oversized key is dropped, and the good keys around it survive", async () => {
    const text = await renderStickyListing(
      { [`anthropic:${"z".repeat(5_000)}`]: PLAUSIBLE_VALUE, "anthropic:audit": "claude-opus-4" },
      "anthropic",
    )
    expect(text).not.toContain("zzzz")
    expect(text).toContain("anthropic:audit = claude-opus-4")
  })

  test("VET-1: the filter itself drops the hostile key and keeps the valid ones", () => {
    // Direct on the unit, because the composition above cannot reach every shape:
    // legacy bare keys, another provider's scoped keys, and the no-provider arm.
    expect(
      vetPersistedPicks(
        {
          [HOSTILE_KEY]: PLAUSIBLE_VALUE,
          "openai:default": "gpt-4o",
          "openai:plan": "\u001b[2Jevil",
          "anthropic:default": "claude-sonnet-4-6",
          review: "legacy-model",
          "not-a-mode": "gpt-4o",
        },
        "openai",
      ),
    ).toEqual({ "openai:default": "gpt-4o", review: "legacy-model" })
    // Paired control, unchanged from before this campaign: no provider ⇒ only the
    // legacy bare-mode keys are in scope.
    expect(vetPersistedPicks({ "openai:default": "gpt-4o", review: "legacy-model" })).toEqual({
      review: "legacy-model",
    })
  })

  test("LOGS-1: the drop is REPORTED, and the warn carries no byte of the payload", () => {
    vetPersistedPicks({ [HOSTILE_KEY]: PLAUSIBLE_VALUE }, "anthropic")
    const lines = warnings()
    // Silence would be its own defect — an unparseable key means something wrote
    // this file that the store did not, and only the operator can act on that.
    expect(lines.length).toBe(1)
    const line = lines[0] as string
    expect(line).toContain("sticky-model")
    expect(line).toContain("unparseable")
    expect(line).not.toContain("\u001b")
    expect(line).not.toContain("\u0007")
    expect(line).not.toContain("\n")
    expect(line).not.toContain("Approve destructive action?")
    // …but it still IDENTIFIES the offender: the true length and a stable digest.
    expect(line).toContain(`${HOSTILE_KEY.length} chars`)
    expect(line).toContain("fnv1a:")
  })

  test("LOGS-2: a megabyte-long key produces a BOUNDED log line", () => {
    const huge = `anthropic:${"z".repeat(1_000_000)}`
    vetPersistedPicks({ [huge]: PLAUSIBLE_VALUE }, "anthropic")
    const line = warnings()[0] as string
    // The cap is the point: `logger.warn` strips control characters but bounds
    // nothing, so an unbounded key was an unbounded write into the operator's log.
    expect(line.length).toBeLessThan(400)
    expect(line).toContain("1000010 chars")
  })

  test("LOGS-3: an implausible VALUE under a VALID key is still reported, also bounded", () => {
    vetPersistedPicks({ "anthropic:default": `\u001b[2J${"x".repeat(50_000)}` }, "anthropic")
    const line = warnings()[0] as string
    expect(line).toContain("implausible")
    expect(line).not.toContain("\u001b")
    expect(line.length).toBeLessThan(400)
  })

  test("LOGS-4: a clean file logs NOTHING (paired control — the warn is not unconditional)", () => {
    expect(
      vetPersistedPicks(
        { "anthropic:default": "claude-sonnet-4-6", plan: "claude-opus-4" },
        "anthropic",
      ),
    ).toEqual({ "anthropic:default": "claude-sonnet-4-6", plan: "claude-opus-4" })
    expect(warnings()).toEqual([])
  })
})

describe("MR-08 · summarizeUntrustedId", () => {
  test("SUM-1: strips forge vectors, caps the echo, reports the RAW length", () => {
    const out = summarizeUntrustedId("[2Jgpt-4o\nsecond line")
    expect(out).not.toContain("\u001b")
    expect(out).not.toContain("\n")
    expect(out).toContain("gpt-4o")
    expect(out).toContain(`${"[2Jgpt-4o\nsecond line".length} chars`)
  })

  test("SUM-2: the digest is stable per value and differs across values", () => {
    expect(summarizeUntrustedId("alpha")).toBe(summarizeUntrustedId("alpha"))
    expect(summarizeUntrustedId("alpha")).not.toBe(summarizeUntrustedId("beta"))
  })

  test("SUM-3: a short benign id survives whole (no gratuitous truncation)", () => {
    const out = summarizeUntrustedId("gpt-5.6-terra")
    expect(out.startsWith('"gpt-5.6-terra" (13 chars, fnv1a:')).toBe(true)
    expect(out).not.toContain("…")
  })

  test("SUM-4: an astral character on the cut boundary is not split into a lone surrogate", () => {
    // The prefix cut goes through `sliceWholeChars`, so an emoji straddling the
    // boundary is dropped whole rather than re-encoded as U+FFFD.
    const out = summarizeUntrustedId(`${"a".repeat(23)}😀tail`)
    expect(out).not.toContain("�")
    expect(out).toContain("…")
  })
})
