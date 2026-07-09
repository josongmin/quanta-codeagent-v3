/**
 * `/dream` slash command tests (H16 cross-session auto-dream).
 *
 * Lives under `tests/unit/cli/**` (the biome slice-isolation allowlist for
 * CLI-internal imports). Drives `dreamCmd.run([...], ctx)` with an injected
 * `SlashContext.dream` carrying a real `CrossSessionDreamTrigger` built over
 * in-memory fakes + a deterministic injected clock (no Date.now()).
 */

import { describe, expect, test } from "bun:test"
import { dreamCmd, isDreamSlashEnabled } from "../../../src/apps/cli/dream-cmd"
import type { SlashContext } from "../../../src/apps/cli/slash-commands"
import { InMemoryLock } from "../../../src/auth/lock-in-memory"
import {
  CrossSessionDreamTrigger,
  type DreamConsolidatePort,
  type DreamConsolidateResult,
  type DreamPolicy,
  type DreamState,
  type DreamWriteTargetPort,
  InMemoryDreamState,
} from "../../../src/memory/dream"

const mkClock = (start = 1_700_000_000_000) => {
  const t = start
  return { now: (): number => t }
}

const POLICY: DreamPolicy = { sessionsThreshold: 3, hoursThreshold: 24 }

const mkConsolidate = (
  result: DreamConsolidateResult,
  calls: { n: number },
): DreamConsolidatePort => ({
  consolidate: async () => {
    calls.n += 1
    return result
  },
})

const mkWriteTarget = (
  targetPath = "/h/.quanta/memory/team/cross-session.md",
): DreamWriteTargetPort => ({
  targetPath,
  write: async (content: string): Promise<number> => Buffer.byteLength(content, "utf8"),
})

const mkTrigger = (opts: {
  policy?: DreamPolicy
  state?: DreamState
  now?: () => number
  calls?: { n: number }
  consolidateResult?: DreamConsolidateResult
  targetPath?: string
}): CrossSessionDreamTrigger => {
  const clock = mkClock()
  const now = opts.now ?? clock.now
  const calls = opts.calls ?? { n: 0 }
  return new CrossSessionDreamTrigger({
    state: new InMemoryDreamState(opts.state),
    consolidate: mkConsolidate(
      opts.consolidateResult ?? { kind: "consolidated", content: "knowledge!" },
      calls,
    ),
    writeTarget: mkWriteTarget(opts.targetPath),
    lock: new InMemoryLock(clock),
    now,
    ...(opts.policy !== undefined ? { policy: opts.policy } : {}),
  })
}

const mkCtx = (
  trigger?: CrossSessionDreamTrigger,
): { cap: { out: string; err: string }; ctx: SlashContext } => {
  const cap = { out: "", err: "" }
  const ctx: SlashContext = {
    out: (s) => {
      cap.out += s
    },
    err: (s) => {
      cap.err += s
    },
    cwd: "/tmp",
    ...(trigger !== undefined ? { dream: { trigger } } : {}),
  }
  return { cap, ctx }
}

describe("/dream slash command", () => {
  test("not wired ⇒ prints not-wired + QUANTA_AUTO_DREAM hint and exits 2 (D-6, UUX-5-09)", async () => {
    const { cap, ctx } = mkCtx() // no dream state
    const code = await dreamCmd.run([], ctx)
    expect(code).toBe(2)
    expect(cap.out).toContain("not wired")
    expect(cap.out).toContain("hint: set QUANTA_AUTO_DREAM=1")
  })

  test("manual /dream fires the trigger and reports completed", async () => {
    const calls = { n: 0 }
    const trigger = mkTrigger({
      policy: POLICY,
      calls,
      consolidateResult: { kind: "consolidated", content: "knowledge!" },
    })
    const { cap, ctx } = mkCtx(trigger)
    const code = await dreamCmd.run([], ctx)
    expect(code).toBe(0)
    expect(calls.n).toBe(1)
    expect(cap.out).toContain("wrote")
    expect(cap.out).toContain("team/cross-session.md")
  })

  test("/dream when feature OFF prints OFF + hint, exits 2, and does not fire (D-6)", async () => {
    const calls = { n: 0 }
    const trigger = mkTrigger({ calls }) // no policy → OFF
    const { cap, ctx } = mkCtx(trigger)
    const code = await dreamCmd.run([], ctx)
    expect(code).toBe(2) // nothing happened — exit 0 was the UUX-5-09 lie
    expect(calls.n).toBe(0)
    expect(cap.out).toContain("OFF")
    expect(cap.out).toContain("hint: set QUANTA_AUTO_DREAM=1")
  })

  test("/dream reports no_op when nothing to consolidate", async () => {
    const calls = { n: 0 }
    const trigger = mkTrigger({ policy: POLICY, calls, consolidateResult: { kind: "no_op" } })
    const { cap, ctx } = mkCtx(trigger)
    const code = await dreamCmd.run([], ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("no-op")
  })

  test("/dream status renders sessions/hours/outcome/target/enabled", async () => {
    const clock = mkClock()
    const trigger = mkTrigger({
      policy: POLICY,
      now: clock.now,
      state: {
        sessionsSinceLastDream: 2,
        lastDreamAtMs: clock.now() - 3 * 60 * 60 * 1000,
        lastOutcome: "completed",
      },
    })
    const { cap, ctx } = mkCtx(trigger)
    const code = await dreamCmd.run(["status"], ctx)
    expect(code).toBe(0)
    expect(cap.out).toContain("Sessions since:    2")
    expect(cap.out).toContain("3.0h")
    expect(cap.out).toContain("completed")
    expect(cap.out).toContain("team/cross-session.md")
    expect(cap.out).toContain("Enabled:           yes")
  })

  test("unknown subcommand ⇒ exit 1 + help", async () => {
    const trigger = mkTrigger({ policy: POLICY })
    const { cap, ctx } = mkCtx(trigger)
    const code = await dreamCmd.run(["bogus"], ctx)
    expect(code).toBe(1)
    expect(cap.err).toContain("unknown subcommand")
  })

  test("isDreamSlashEnabled honors the env knob (default ON)", () => {
    expect(isDreamSlashEnabled({})).toBe(true)
    expect(isDreamSlashEnabled({ QUANTA_DREAM_SLASH: "0" })).toBe(false)
    expect(isDreamSlashEnabled({ QUANTA_DREAM_SLASH: "1" })).toBe(true)
  })
})
