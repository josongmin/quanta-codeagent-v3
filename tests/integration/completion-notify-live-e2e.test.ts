import { describe, expect, test } from "bun:test"
import { runAgent } from "@/agent"
import {
  createOscNotificationPort,
  type NotificationPort,
  resolveNotifyChannel,
} from "@/apps/cli/notify"
import { notifyTurnComplete } from "@/apps/cli/repl/session-loop/turn-helpers"
import type { StreamEvent } from "@/llm"
import { cfg, FakeLLM, RecordingStream, text, toolUse, withTimeout } from "./_harness"

/**
 * TRUE end-to-end for `completion-notify` (ADR-0444), driven by a FAKE LLM
 * through the REAL agent loop (`runAgent`) + the REAL production notify SEAM —
 * NOT the isolated osc-adapter unit doubles (which construct a synthetic
 * `TurnCompleteInfo` by hand). This closes the `runAgent × scripted == 0` gap:
 * the catalog lists ZERO integration/contract coverage, only osc-adapter +
 * notify-enabled unit hellgates.
 *
 * The production wire (session-loop.ts): a finished turn's `RunOneTurnResult`
 * (its runner-measured `durationMs` + `result`/`turnAborted`) is fed to
 * `notifyTurnComplete(notify, out, cwd)`, which calls `notify.onTurnComplete`.
 * We reproduce that EXACT seam over a REAL `runAgent` outcome:
 *
 *   1. Drive `runAgent` with a scripted LLM (real loop, real messages/turns).
 *   2. Measure `durationMs` around it (same shape the runner produces) and
 *      derive `ok` from the REAL `AgentOutcome.reason` — no hand-built info.
 *   3. Feed it through the PRODUCTION `notifyTurnComplete` into the PRODUCTION
 *      `createOscNotificationPort`, capturing the port's raw terminal writes.
 *
 * Ground truth: the port's captured OSC/BEL writes (the real effect). We assert
 * the notification actually fires at completion (slow turn), carries the ✓/✗
 * glyph that MATCHES the real outcome, latches idle-awaiting-input ONCE, and —
 * the load-bearing control — fires NOTHING when the knob is OFF (channel="off",
 * the byte-identical default) even though the identical real turn ran.
 */

const BEL = "\x07"
const ESC = "\x1b"
const osc = (title: string): string => `${ESC}]0;${title}${BEL}`

/** Collect the port's raw terminal writes — the SSOT effect the OSC adapter
 *  produces (an empty array ⇒ nothing was notified). */
const makeSink = (): { out: string[]; write: (s: string) => void } => {
  const out: string[] = []
  return { out, write: (s) => out.push(s) }
}

/** Drive a REAL `runAgent` turn and return the production-shaped turn-completion
 *  info the session-loop hands to `notifyTurnComplete` — the runner-measured
 *  duration + `result`/`turnAborted` derived from the REAL outcome. `slowMs`
 *  forces the slow-turn gate deterministically (the real turn is sub-ms) so we
 *  test the gate's decision, not wall-clock flakiness. */
const runTurnAndBuildNotifyInput = async (args: {
  scripts: StreamEvent[][]
  slowMs: number
}): Promise<{
  readonly durationMs: number
  readonly result: unknown
  readonly turnAborted: boolean
}> => {
  const llm = new FakeLLM(args.scripts)
  const outcome = await withTimeout(
    runAgent(
      cfg({
        llm,
        stream: new RecordingStream(),
        messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
        maxTurns: 5,
      }),
    ),
    10_000,
    "completion-notify-turn",
  )
  // Mirror session-loop's `notifyTurnComplete` input shape: `result` present iff
  // the turn produced an outcome (it did), `turnAborted` from the real signal
  // (false here — a clean completion). `durationMs` is the runner's wall-clock;
  // we substitute the forced `slowMs` so the slow-turn gate is deterministic.
  return {
    durationMs: args.slowMs,
    result: outcome,
    turnAborted: outcome.reason === "aborted",
  }
}

describe("completion-notify — real loop (runAgent) + production notify seam end-to-end", () => {
  test("SLOW real turn completes ⇒ onTurnComplete fires the ✓ done OSC title + BEL", async () => {
    const { out, write } = makeSink()
    // The REAL production port with the REAL slow-turn threshold gate.
    const notify: NotificationPort = createOscNotificationPort({
      write,
      channel: "bell",
      slowTurnThresholdMs: 10_000,
    })

    // A real, clean completion (single finish turn through runAgent).
    const info = await runTurnAndBuildNotifyInput({
      scripts: [text("all done")],
      slowMs: 15_000, // >= threshold ⇒ SLOW ⇒ the gate admits the push
    })
    // Sanity: the loop actually completed (so ok ⇒ ✓).
    expect((info.result as { reason: string }).reason).toBe("completed")

    // PRODUCTION seam: the exact call the session-loop makes after a finished turn.
    notifyTurnComplete(notify, info, "proj")

    // Ground truth: the port really wrote the done title (✓ ⇐ ok from the real
    // outcome) plus a separate BEL (channel "bell").
    expect(out).toEqual([osc("✓ proj — done"), BEL])
  })

  test("FAST real turn (< threshold) ⇒ onTurnComplete fires NOTHING (anti-spam gate)", async () => {
    const { out, write } = makeSink()
    const notify = createOscNotificationPort({ write, channel: "bell", slowTurnThresholdMs: 10_000 })

    const info = await runTurnAndBuildNotifyInput({
      scripts: [text("quick")],
      slowMs: 500, // < threshold ⇒ FAST ⇒ silent
    })
    expect((info.result as { reason: string }).reason).toBe("completed")

    notifyTurnComplete(notify, info, "proj")
    // Anti-spam: a fast turn notifies nothing — the same real completion, gated.
    expect(out).toEqual([])
  })

  test("a real turn that ends via tool round-trip still fires ✓ (ok derived from the real outcome)", async () => {
    const { out, write } = makeSink()
    const notify = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 0,
    })

    // Tool turn then a finish turn — exercises the loop past a tool_result before
    // the completed seal, so the notify runs off a genuinely multi-turn outcome.
    const info = await runTurnAndBuildNotifyInput({
      scripts: [toolUse("t1", "read_file", { path: "/tmp/x" }), text("done after tool")],
      slowMs: 1,
    })
    expect((info.result as { reason: string; turns: number }).reason).toBe("completed")
    expect((info.result as { turns: number }).turns).toBe(2)

    notifyTurnComplete(notify, info, "proj")
    expect(out).toEqual([osc("✓ proj — done")]) // title_only ⇒ no separate BEL
  })

  test("idle-awaiting-input lifecycle transition ⇒ latched ONCE; markActive re-arms it", async () => {
    // The feature DISTINGUISHES turn-completion from idle-awaiting-input (two
    // NotificationPort methods). Drive a real turn's completion notify, then the
    // idle transition, and prove the idle latch is the REAL production one.
    const { out, write } = makeSink()
    const notify = createOscNotificationPort({
      write,
      channel: "title_only",
      slowTurnThresholdMs: 10_000,
    })

    const info = await runTurnAndBuildNotifyInput({ scripts: [text("done")], slowMs: 15_000 })
    notifyTurnComplete(notify, info, "proj") // ✓ done

    // The agent goes idle awaiting input — fires ONCE even if probed repeatedly
    // (the once-per-idle latch), which is the "idle-awaiting-input" half of the
    // lifecycle the YAML calls out.
    notify.onIdleAwaitingInput({ cwdBasename: "proj" })
    notify.onIdleAwaitingInput({ cwdBasename: "proj" })
    notify.onIdleAwaitingInput({ cwdBasename: "proj" })

    // markActive (a new prompt accepted) resets the latch ⇒ the NEXT idle re-fires.
    notify.markActive()
    notify.onIdleAwaitingInput({ cwdBasename: "proj" })

    expect(out).toEqual([
      osc("✓ proj — done"), // turn completion
      osc("… proj — waiting"), // first idle entry (latched)
      // (three idle probes collapsed to ONE by the latch)
      osc("… proj — waiting"), // re-armed by markActive
    ])
  })

  test("CONTROL (knob OFF): resolveNotifyChannel unset ⇒ channel 'off' ⇒ same real turn notifies NOTHING", async () => {
    // Non-vacuity: the production gate. With QUANTA_NOTIFY unset the channel is
    // "off" and the port is a pure no-op — the IDENTICAL real turn drives ZERO
    // writes. If the assertions above matched on something always-present, this
    // control would also emit and fail. This is the default-OFF byte-identical
    // contract, proven through the real gate + a real completed turn.
    const channel = resolveNotifyChannel({}, true) // QUANTA_NOTIFY unset, TTY present
    expect(channel).toBe("off")

    const { out, write } = makeSink()
    const notify = createOscNotificationPort({ write, channel })

    const info = await runTurnAndBuildNotifyInput({ scripts: [text("done")], slowMs: 999_999 })
    expect((info.result as { reason: string }).reason).toBe("completed")

    // Every lifecycle event on the off-channel port is silent.
    notifyTurnComplete(notify, info, "proj")
    notify.onIdleAwaitingInput({ cwdBasename: "proj" })
    notify.markActive()
    notify.dispose()
    expect(out).toEqual([])
  })

  test("CONTROL (non-TTY): resolveNotifyChannel with QUANTA_NOTIFY=bell but a pipe ⇒ 'off' (never OSC to a pipe)", async () => {
    // The hard gate: even an explicit opt-in is suppressed when stdout is not a
    // TTY — so a real completed turn in a piped/CI context emits nothing.
    const channel = resolveNotifyChannel({ QUANTA_NOTIFY: "bell" }, false)
    expect(channel).toBe("off")

    const { out, write } = makeSink()
    const notify = createOscNotificationPort({ write, channel })
    const info = await runTurnAndBuildNotifyInput({ scripts: [text("done")], slowMs: 999_999 })
    notifyTurnComplete(notify, info, "proj")
    expect(out).toEqual([])
  })
})
