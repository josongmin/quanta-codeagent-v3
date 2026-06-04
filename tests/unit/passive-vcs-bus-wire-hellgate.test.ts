/**
 * H6 (jun-3-misc §3) — Passive-VCS adapter + assembler-wire hellgate (unit).
 *
 * Pins the two pure halves of the final bus-wire leg in isolation (no git
 * subprocess, no dispatch):
 *
 *   1. `createPassiveVcsStreamSink` maps a classified `VcsEvent` → a `recovery`
 *      AgentEvent tagged `reason:"vcs_event"`, serializing EVERY facet
 *      (commit/push/branch/pr — present and absent, with and without optional
 *      sub-fields) FAITHFULLY and DETERMINISTICALLY into `detail`.
 *   2. The sink is NO-THROW: a broken stream can never poison the caller.
 *   3. `assembleAgentConfig` wires `cfg.vcsEventSink` ONLY when
 *      `QUANTA_PASSIVE_VCS=1` — absent / "0" ⇒ slot UNSET (default-OFF), and a
 *      caller-pre-set sink is preserved (override precedence).
 */
import { describe, expect, test } from "bun:test"
import type { VcsEvent } from "@/git/passive-classify"
import {
  type AssemblerEnv,
  assembleAgentConfig,
  createPassiveVcsStreamSink,
} from "@/host/runtime/agent-config-assembler"
import type { RuntimeAgentConfigBase } from "@/sdk/runtime"
import type { AgentEvent, StreamPort } from "@/stream"

// ── stream double ─────────────────────────────────────────────────────────────

interface RecordingStream extends StreamPort {
  readonly events: AgentEvent[]
}
const recordingStream = (): RecordingStream => {
  const events: AgentEvent[] = []
  return { events, emit: (e) => void events.push(e) }
}

/** Narrow an emitted event to the `recovery` shape for facet assertions. */
const asRecovery = (e: AgentEvent | undefined): { reason: string; detail?: string } => {
  if (e === undefined || e.type !== "recovery") throw new Error(`expected recovery, got ${e?.type}`)
  return e
}

/* ================================================================== */
/*  1. faithful, deterministic VcsEvent → recovery mapping            */
/* ================================================================== */

describe("createPassiveVcsStreamSink · VcsEvent → recovery AgentEvent", () => {
  test("HELL-ADP-commit-sha: commit kind + sha", () => {
    const s = recordingStream()
    createPassiveVcsStreamSink(s).emit({ commit: { kind: "commit", sha: "abc1234" } })
    expect(s.events).toHaveLength(1)
    const rec = asRecovery(s.events[0])
    expect(rec.reason).toBe("vcs_event")
    expect(rec.detail).toBe("commit:commit@abc1234")
  })

  test("HELL-ADP-commit-nosha: amend with NO sha omits the @sha suffix", () => {
    const s = recordingStream()
    createPassiveVcsStreamSink(s).emit({ commit: { kind: "amend" } })
    expect(asRecovery(s.events[0]).detail).toBe("commit:amend")
  })

  test("HELL-ADP-push: push localRef/remoteRef", () => {
    const s = recordingStream()
    createPassiveVcsStreamSink(s).emit({ push: { localRef: "main", remoteRef: "origin/main" } })
    expect(asRecovery(s.events[0]).detail).toBe("push:main->origin/main")
  })

  test("HELL-ADP-push-partial: missing push refs degrade to '?'", () => {
    const s = recordingStream()
    createPassiveVcsStreamSink(s).emit({ push: {} })
    expect(asRecovery(s.events[0]).detail).toBe("push:?->?")
  })

  test("HELL-ADP-branch: branch action", () => {
    const s = recordingStream()
    createPassiveVcsStreamSink(s).emit({ branch: { action: "rebased" } })
    expect(asRecovery(s.events[0]).detail).toBe("branch:rebased")
  })

  test("HELL-ADP-pr-url: pr number + url", () => {
    const s = recordingStream()
    createPassiveVcsStreamSink(s).emit({
      pr: { number: 42, url: "https://github.com/o/r/pull/42" },
    })
    expect(asRecovery(s.events[0]).detail).toBe("pr:#42:https://github.com/o/r/pull/42")
  })

  test("HELL-ADP-pr-nourl: pr number with no url", () => {
    const s = recordingStream()
    createPassiveVcsStreamSink(s).emit({ pr: { number: 7 } })
    expect(asRecovery(s.events[0]).detail).toBe("pr:#7")
  })

  test("HELL-ADP-all-facets: every facet present serializes in fixed commit→push→branch→pr order", () => {
    const s = recordingStream()
    const full: VcsEvent = {
      commit: { kind: "merge", sha: "deadbee" },
      push: { localRef: "HEAD", remoteRef: "origin/main" },
      branch: { action: "merged" },
      pr: { number: 9, url: "https://x/pull/9" },
    }
    createPassiveVcsStreamSink(s).emit(full)
    expect(asRecovery(s.events[0]).detail).toBe(
      "commit:merge@deadbee push:HEAD->origin/main branch:merged pr:#9:https://x/pull/9",
    )
  })

  test("HELL-ADP-empty: an event with no facets serializes to an empty detail", () => {
    const s = recordingStream()
    createPassiveVcsStreamSink(s).emit({})
    expect(asRecovery(s.events[0]).detail).toBe("")
  })

  test("HELL-ADP-deterministic: the SAME event always yields the SAME detail", () => {
    const ev: VcsEvent = {
      commit: { kind: "cherry-pick", sha: "feed00d" },
      branch: { action: "amended" },
    }
    const a = recordingStream()
    const b = recordingStream()
    createPassiveVcsStreamSink(a).emit(ev)
    createPassiveVcsStreamSink(b).emit(ev)
    expect(asRecovery(a.events[0]).detail).toBe(asRecovery(b.events[0]).detail)
  })
})

/* ================================================================== */
/*  2. NO-THROW boundary                                              */
/* ================================================================== */

describe("createPassiveVcsStreamSink · NO-THROW boundary", () => {
  test("HELL-ADP-nothrow: a stream whose emit throws never propagates", () => {
    const throwing: StreamPort = {
      emit() {
        throw new Error("dead socket")
      },
    }
    const sink = createPassiveVcsStreamSink(throwing)
    expect(() => sink.emit({ branch: { action: "merged" } })).not.toThrow()
  })
})

/* ================================================================== */
/*  3. assembler wires the sink ONLY when the knob is on              */
/* ================================================================== */

/** Minimal RuntimeAgentConfigBase the assembler needs. The assembler reads
 *  `cfg.stream` to build the sink; everything else is opaque to this slot. */
const baseConfig = (): RuntimeAgentConfigBase =>
  ({
    stream: recordingStream(),
    cwd: "/repo",
  }) as unknown as RuntimeAgentConfigBase

const assembleWith = (env: AssemblerEnv) =>
  assembleAgentConfig({ mode: "interactive", base: baseConfig() }, env)

describe("assembleAgentConfig · maybeWireVcsEventSink gate", () => {
  test("HELL-WIRE-on: QUANTA_PASSIVE_VCS=1 wires a sink bound to cfg.stream", () => {
    const cfg = assembleWith({ QUANTA_PASSIVE_VCS: "1" })
    expect(cfg.vcsEventSink).toBeDefined()
    // The wired sink emits onto the SAME stream the rest of the loop uses.
    cfg.vcsEventSink?.emit({ branch: { action: "merged" } })
    const stream = cfg.stream as RecordingStream
    const vcs = stream.events.filter((e) => e.type === "recovery" && e.reason === "vcs_event")
    expect(vcs).toHaveLength(1)
  })

  test("HELL-WIRE-off-absent: knob ABSENT ⇒ slot UNSET (default-OFF byte-identical)", () => {
    const cfg = assembleWith({})
    expect(cfg.vcsEventSink).toBeUndefined()
  })

  test("HELL-WIRE-off-zero: knob='0' ⇒ slot UNSET (strict opt-in)", () => {
    const cfg = assembleWith({ QUANTA_PASSIVE_VCS: "0" })
    expect(cfg.vcsEventSink).toBeUndefined()
  })

  test("HELL-WIRE-override: a caller-pre-set sink is PRESERVED (override precedence)", () => {
    const base = baseConfig() as RuntimeAgentConfigBase & {
      vcsEventSink?: { emit(e: unknown): void }
    }
    const calls: unknown[] = []
    base.vcsEventSink = { emit: (e) => void calls.push(e) }
    const cfg = assembleAgentConfig({ mode: "interactive", base }, { QUANTA_PASSIVE_VCS: "1" })
    cfg.vcsEventSink?.emit({ pr: { number: 1 } })
    expect(calls).toHaveLength(1) // caller sink, not the adapter
  })
})
