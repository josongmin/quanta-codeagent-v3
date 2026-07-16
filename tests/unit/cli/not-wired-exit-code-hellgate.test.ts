/**
 * HELLGATE — Wave-4 (jul-10) D-6 exit-code convention + "not wired" honesty.
 *
 * The lie class: a slash command whose backing wire is absent prints
 * "not wired" and exits **0** — indistinguishable from success for any
 * script, and usually WITHOUT naming the env gate that would turn it on
 * (UUX-2-22). Specific liar sites verified REAL in the jul-10 audit:
 *   - UUX-5-09  /dream without QUANTA_AUTO_DREAM
 *   - UUX-4-27  /onboard not-wired exit 0
 *   - UUX-6-17  /rewind-tool dual-flag opacity (QUANTA_PER_TOOL_RECORD
 *               AND QUANTA_SHADOW both required; the message never said
 *               which one is missing)
 *   - UUX-1-23  side chat HARD-THROWS "side chat not wired" instead of the
 *               honest posture
 *   - UUX-4-16  /cron create silently passes the title as BOTH title and
 *               prompt
 *
 * Structural kill (D-6): ONE leaf helper `notWired(out, {feature, gate?,
 * hint?})` prints `<feature>: not wired…` plus a machine-greppable
 * `hint: set <GATE>=1…` line when a gate is KNOWN, and returns EXIT CODE 2
 * (distinct from 0=ran and 1=user/runtime error). All liar sites adopt.
 *
 * RED-first proof: the helper module does not exist at HEAD (import fails),
 * and every adoption assertion below is RED against the exit-0 behavior.
 */

import { describe, expect, test } from "bun:test"
import { readFile } from "node:fs/promises"
import { join } from "node:path"
import { backgroundCmd } from "@/apps/cli/background-cmd"
import { dreamCmd } from "@/apps/cli/dream-cmd"
import { NOT_WIRED_EXIT, notWired } from "@/apps/cli/not-wired"
import { missingPerToolCheckpointGates, rewindToolCmd } from "@/apps/cli/rewind-tool-cmd"
import { sideCmd } from "@/apps/cli/side-cmd"
import { browserNetCmd } from "@/apps/cli/slash/browser-net-cmd"
import { cronCmd, inboxCmd, scheduleCmd } from "@/apps/cli/slash/cron-cmd"
import { kbCmd } from "@/apps/cli/slash/kb-cmd"
import { onboardCmd } from "@/apps/cli/slash/onboard-cmd"
import type { SlashContext } from "@/apps/cli/slash-contract"

const buildCtx = (
  partial?: Partial<SlashContext>,
): { ctx: SlashContext; out: () => string; err: () => string } => {
  let stdout = ""
  let stderr = ""
  const ctx: SlashContext = {
    out: (s) => {
      stdout += s
    },
    err: (s) => {
      stderr += s
    },
    cwd: "/tmp",
    ...partial,
  }
  return { ctx, out: () => stdout, err: () => stderr }
}

/* ------------------------------------------------------------------ */
/* D-6 helper contract                                                 */
/* ------------------------------------------------------------------ */

describe("D-6 — notWired helper contract", () => {
  const capture = (): { out: (s: string) => void; text: () => string } => {
    let buf = ""
    return {
      out: (s) => {
        buf += s
      },
      text: () => buf,
    }
  }

  test("exit code is 2 — distinct from success(0) and error(1)", () => {
    const cap = capture()
    expect(notWired(cap.out, { feature: "/x" })).toBe(2)
    expect(NOT_WIRED_EXIT).toBe(2)
  })

  test("prints `<feature>: not wired` on the first line", () => {
    const cap = capture()
    notWired(cap.out, { feature: "/dream" })
    expect(cap.text().startsWith("/dream: not wired")).toBe(true)
  })

  test("a KNOWN gate yields a machine-greppable `hint: set <GATE>=1` line", () => {
    const cap = capture()
    notWired(cap.out, { feature: "/dream", gate: "QUANTA_AUTO_DREAM" })
    expect(cap.text()).toContain("hint: set QUANTA_AUTO_DREAM=1")
  })

  test("a MULTI gate names every missing flag on the hint line", () => {
    const cap = capture()
    notWired(cap.out, {
      feature: "/rewind-tool",
      gate: ["QUANTA_PER_TOOL_RECORD", "QUANTA_SHADOW"],
    })
    const t = cap.text()
    expect(t).toContain("hint: set QUANTA_PER_TOOL_RECORD=1")
    expect(t).toContain("QUANTA_SHADOW=1")
  })

  test("no gate ⇒ NO fabricated `set …=1` hint (never invent an env var)", () => {
    const cap = capture()
    notWired(cap.out, { feature: "/onboard" })
    expect(cap.text()).not.toContain("=1")
  })

  test("a free-form hint renders on its own `hint:` line", () => {
    const cap = capture()
    notWired(cap.out, { feature: "/side", hint: "requires a runtime session host" })
    expect(cap.text()).toContain("hint: requires a runtime session host")
  })
})

/* ------------------------------------------------------------------ */
/* UUX-5-09 — /dream                                                   */
/* ------------------------------------------------------------------ */

describe("UUX-5-09 — /dream not-wired honesty", () => {
  test("unwired slot ⇒ exit 2 + QUANTA_AUTO_DREAM hint (was exit 0, no hint)", async () => {
    const { ctx, out } = buildCtx()
    const code = await dreamCmd.run([], ctx)
    expect(code).toBe(2)
    expect(out()).toContain("not wired")
    expect(out()).toContain("hint: set QUANTA_AUTO_DREAM=1")
  })

  test("wired but trigger disabled ⇒ exit 2 + hint (nothing happened; 0 was a lie)", async () => {
    const { ctx, out } = buildCtx({
      dream: {
        trigger: {
          enabled: false,
          targetPath: "/tmp/team.md",
          readState: () => ({ sessionsSinceLastDream: 0, lastOutcome: null }),
          hoursSinceLastDream: () => null,
          dream: async () => ({ kind: "below_threshold" }),
          noteSessionEnd: async () => ({ kind: "below_threshold" }),
        } as unknown as import("@/memory").CrossSessionDreamTrigger,
      },
    })
    const code = await dreamCmd.run([], ctx)
    expect(code).toBe(2)
    expect(out()).toContain("QUANTA_AUTO_DREAM=1")
  })
})

/* ------------------------------------------------------------------ */
/* UUX-4-27 — /onboard                                                 */
/* ------------------------------------------------------------------ */

describe("UUX-4-27 — /onboard not-wired exit code", () => {
  test("unwired identity ⇒ exit 2 (was exit 0) and no fabricated env hint", async () => {
    const { ctx, out } = buildCtx()
    const code = await onboardCmd.run([], ctx)
    expect(code).toBe(2)
    expect(out()).toContain("not wired")
    // No env gate exists for the identity wire — the helper must not invent one.
    expect(out()).not.toContain("QUANTA_")
  })
})

/* ------------------------------------------------------------------ */
/* UUX-6-17 — /rewind-tool dual-flag reason                            */
/* ------------------------------------------------------------------ */

describe("UUX-6-17 — /rewind-tool says WHICH flag is missing", () => {
  test("missingPerToolCheckpointGates enumerates exactly the unset flags", () => {
    expect(missingPerToolCheckpointGates({})).toEqual(["QUANTA_PER_TOOL_RECORD", "QUANTA_SHADOW"])
    expect(missingPerToolCheckpointGates({ QUANTA_PER_TOOL_RECORD: "1" })).toEqual([
      "QUANTA_SHADOW",
    ])
    expect(missingPerToolCheckpointGates({ QUANTA_SHADOW: "1" })).toEqual([
      "QUANTA_PER_TOOL_RECORD",
    ])
    expect(
      missingPerToolCheckpointGates({ QUANTA_PER_TOOL_RECORD: "1", QUANTA_SHADOW: "on" }),
    ).toEqual([])
  })

  test("unwired ⇒ exit 2 + hint naming the missing flag(s)", async () => {
    const savedCkpt = process.env.QUANTA_PER_TOOL_RECORD
    const savedShadow = process.env.QUANTA_SHADOW
    delete process.env.QUANTA_PER_TOOL_RECORD
    process.env.QUANTA_SHADOW = "1"
    try {
      const { ctx, out } = buildCtx()
      const code = await rewindToolCmd.run([], ctx)
      expect(code).toBe(2)
      expect(out()).toContain("not wired")
      // The ONE missing flag is named; the satisfied one is not blamed.
      expect(out()).toContain("hint: set QUANTA_PER_TOOL_RECORD=1")
      expect(out()).not.toContain("QUANTA_SHADOW=1")
    } finally {
      if (savedCkpt === undefined) delete process.env.QUANTA_PER_TOOL_RECORD
      else process.env.QUANTA_PER_TOOL_RECORD = savedCkpt
      if (savedShadow === undefined) delete process.env.QUANTA_SHADOW
      else process.env.QUANTA_SHADOW = savedShadow
    }
  })
})

/* ------------------------------------------------------------------ */
/* UUX-1-23 — side chat: honest posture, never a throw                 */
/* ------------------------------------------------------------------ */

describe("UUX-1-23 — /side not-wired posture (no throw)", () => {
  test("absent ctx.side ⇒ exit 2 (was exit 0)", async () => {
    const { ctx, out } = buildCtx()
    const code = await sideCmd.run(["hello"], ctx)
    expect(code).toBe(2)
    expect(out()).toContain("not wired")
  })

  test("start() resolving the typed 'not-wired' marker ⇒ exit 2, NO throw", async () => {
    // The composer's runtime closure returns "not-wired" instead of throwing
    // when the probe races the live wire (the old code threw an Error that
    // could take down the dispatch path).
    const { ctx, out } = buildCtx({
      side: {
        start: async () => "not-wired" as const,
        isWired: () => true, // stale probe — the race the throw guarded
        signal: new AbortController().signal,
      },
    })
    const code = await sideCmd.run(["hello"], ctx)
    expect(code).toBe(2)
    expect(out()).toContain("not wired")
  })

  test("surface-compose no longer hard-throws for the unwired side chat", async () => {
    const src = await readFile(
      join(import.meta.dir, "../../../src/apps/cli/repl/surface-compose.ts"),
      "utf8",
    )
    expect(src).not.toContain('throw new Error("side chat not wired')
    // The closure RETURNS the typed marker (a comment mentioning the marker
    // would not satisfy this pin).
    expect(src).toMatch(/^[^/]*return "not-wired"/m)
  })
})

/* ------------------------------------------------------------------ */
/* UUX-2-22 — known-gate sites adopt the hint + exit 2                 */
/* ------------------------------------------------------------------ */

describe("UUX-2-22 — not-wired sites with a KNOWN gate hint it and exit 2", () => {
  const cases: ReadonlyArray<{
    name: string
    run: (ctx: SlashContext) => Promise<number>
    gate: string
  }> = [
    { name: "/kb", run: (ctx) => kbCmd.run([], ctx), gate: "QUANTA_PROJECTS_KB" },
    {
      name: "/browser-net",
      run: (ctx) => browserNetCmd.run([], ctx),
      gate: "QUANTA_BROWSER_NETWORK",
    },
    { name: "/background", run: (ctx) => backgroundCmd.run(["list"], ctx), gate: "QUANTA_BG_TURN" },
    { name: "/cron", run: (ctx) => cronCmd.run([], ctx), gate: "QUANTA_AUTOMATION" },
    { name: "/schedule", run: (ctx) => scheduleCmd.run([], ctx), gate: "QUANTA_AUTOMATION" },
    { name: "/inbox", run: (ctx) => inboxCmd.run([], ctx), gate: "QUANTA_AUTOMATION" },
  ]
  for (const c of cases) {
    test(`${c.name} unwired ⇒ exit 2 + hint names ${c.gate}`, async () => {
      const { ctx, out } = buildCtx()
      const code = await c.run(ctx)
      expect(code).toBe(2)
      expect(out()).toContain("not wired")
      expect(out()).toContain(`hint: set ${c.gate}=1`)
    })
  }
})

/* ------------------------------------------------------------------ */
/* UUX-4-16 — /cron create: separate prompt arg                        */
/* ------------------------------------------------------------------ */

describe("UUX-4-16 — /cron create accepts a prompt distinct from the title", () => {
  interface CreateCall {
    title: string
    rule: string
    prompt: string
  }
  const wiredCtx = (): {
    ctx: SlashContext
    out: () => string
    err: () => string
    calls: CreateCall[]
  } => {
    const calls: CreateCall[] = []
    const base = buildCtx({
      automation: {
        list: async () => [],
        inbox: async () => [],
        create: async (title: string, rule: string, prompt: string) => {
          calls.push({ title, rule, prompt })
          return {
            ok: true as const,
            row: { id: "a1", title, rule, nextRunAt: 1, prompt },
          }
        },
      },
    })
    return { ...base, calls }
  }

  test("`create <RRULE> <title> -- <prompt>` passes the SEPARATE prompt", async () => {
    const { ctx, calls } = wiredCtx()
    const code = await cronCmd.run(
      ["create", "FREQ=DAILY", "nightly", "build", "--", "run", "the", "full", "suite"],
      ctx,
    )
    expect(code).toBe(0)
    expect(calls.length).toBe(1)
    expect(calls[0]?.title).toBe("nightly build")
    expect(calls[0]?.prompt).toBe("run the full suite")
  })

  test("prompt omitted ⇒ title-as-prompt is KEPT but SAID in the output", async () => {
    const { ctx, out, calls } = wiredCtx()
    const code = await cronCmd.run(["create", "FREQ=DAILY", "nightly", "build"], ctx)
    expect(code).toBe(0)
    expect(calls[0]?.prompt).toBe("nightly build")
    // The output must admit the default instead of silently duplicating.
    expect(out().toLowerCase()).toContain("prompt defaults to the title")
  })

  test("`--` with an empty prompt is a usage error (never a silent default)", async () => {
    const { ctx, calls } = wiredCtx()
    const code = await cronCmd.run(["create", "FREQ=DAILY", "nightly", "--"], ctx)
    expect(code).toBe(1)
    expect(calls.length).toBe(0)
  })
})
