/**
 * DOF-22 — LOCAL, cheap, deterministic PAIRED A/B measurement harness for the
 * behavioral default-OFF gates (prompt-directive, delegation-suppress,
 * closeout-critic, cap-enforcer, adaptive-thinking, edit-repair-loop,
 * refusal-fallback, …).
 *
 * GAP THIS CLOSES
 * ----------------
 * The board (docs/plans/jul-16-default-off-sota-plus-plus) gates any behavioral
 * gate's flip to default-ON on a PAIRED ON/OFF proof: "no regression + a real
 * gain". Two rails exist:
 *   (1) behavior regression  — cheap, local, deterministic  ← THIS HARNESS
 *   (2) efficacy (quality)   — EXPENSIVE (SWE picks A/B on EC2) ← operator only
 * Before this module there was NO local rail for (1): a maintainer flipping a
 * behavioral knob to default-ON had no hermetic, network-free way to prove the
 * ON path does not regress the OFF path's observable behavior. This harness IS
 * that rail. It does NOT measure efficacy — that needs the SWE campaign.
 *
 * HOW IT WORKS (hermetic, no network, no box, no process.env)
 * -----------------------------------------------------------
 * A gate is exercised through the SAME seam the composition root uses:
 * `wireOptionalAgentPorts(base, env)` — which takes the env as an EXPLICIT
 * argument and never reads `process.env`. So OFF = `wireOptionalAgentPorts(cfg,
 * {})` and ON = `wireOptionalAgentPorts(cfg, { [gateEnv]: "on" })`. The SAME
 * deterministic scripted-LLM scenario (a `ScenarioFactory`) is then run twice
 * through the REAL agent loop (`runAgent`) — once OFF, once ON — and the two
 * runs' OBSERVABLE behavior is captured and diffed.
 *
 * Observable axes captured per side (all deterministic under a scripted LLM):
 *   - reason        : the AgentOutcome stop reason (completed/aborted/…)
 *   - turns         : loop turn count
 *   - llmCalls      : number of `stream()` invocations the fake LLM saw
 *   - toolEvents    : count of tool_call AgentEvents emitted
 *   - recoveryEvents: count of `recovery` AgentEvents (the channel closeout-critic
 *                     / verify guards surface verdicts on)
 *   - systemBytes   : byte length of the FIRST assembled system prompt (prompt
 *                     mass — the axis prompt-directive / delegation-suppress move)
 *   - finalText     : concatenated visible text of the last assistant message
 *   - eventTypes    : ordered multiset (as a sorted "type×count" digest) of every
 *                     emitted AgentEvent type — a coarse structural fingerprint
 *
 * VERDICT
 * -------
 *   NO-REGRESSION : ON behavior is IDENTICAL to OFF on every captured axis
 *                   (byte-identical default-OFF gates land here — the ledger
 *                   claim "unset ⇒ base returned verbatim" is exactly this).
 *   CHANGED       : ON differs from OFF on ≥1 axis, but no axis is a regression
 *                   per the (conservative) regression predicate below.
 *   REGRESSION    : ON differs on a REGRESSION axis — the run's terminal outcome
 *                   degraded (OFF completed, ON did not) OR the loop did strictly
 *                   more work with a WORSE outcome. This is the promotion BLOCKER.
 *
 * Regression is deliberately conservative and behavior-only (this rail cannot
 * see answer QUALITY — that is the SWE efficacy rail). A CHANGED verdict is NOT
 * a pass to flip default-ON; it means "behavior moved, inspect it + measure
 * efficacy". Only NO-REGRESSION clears the local rail; efficacy (rail 2) is
 * still required for the actual flip.
 *
 * This module touches NO production code. It composes existing production seams
 * (`wireOptionalAgentPorts`, `runAgent`) around a scenario, exactly as a test
 * would, and lives only under tests/.
 */

import { runAgent } from "@/agent"
import { wireOptionalAgentPorts } from "@/agent/optional-ports"
import type { AgentConfig, AgentOutcome } from "@/agent/types"
import type { Message } from "@/llm"
import { RecordingStream, withTimeout } from "./_harness"

/** A scripted, deterministic scenario. The factory is called ONCE PER SIDE so
 *  each side gets a FRESH llm/stream/config (no shared mutable state can leak
 *  between the OFF and ON runs — a correctness property the self-test pins). */
export interface Scenario {
  /** The base AgentConfig for this side. The harness applies
   *  `wireOptionalAgentPorts(config, env)` to it (env = {} OFF / {gate:on} ON)
   *  before handing it to `runAgent`. Its `stream` MUST be a RecordingStream so
   *  the harness can read the emitted AgentEvent trace. */
  readonly config: AgentConfig
  /** The RecordingStream `config.stream` points at (returned explicitly so the
   *  harness need not down-cast `config.stream`). */
  readonly stream: RecordingStream
  /** Reads the fake LLM's observed `stream()` call count AFTER the run. */
  readonly llmCalls: () => number
  /** Reads the byte length of the FIRST system prompt the fake LLM saw. `-1`
   *  when the LLM never streamed (e.g. immediate abort) — a stable sentinel. */
  readonly firstSystemBytes: () => number
}

export type ScenarioFactory = () => Scenario

/** Observable behavior of ONE side (OFF or ON). Every field is deterministic
 *  under a scripted LLM. */
export interface SideObservation {
  readonly reason: AgentOutcome["reason"]
  readonly turns: number
  readonly llmCalls: number
  readonly toolEvents: number
  readonly recoveryEvents: number
  readonly systemBytes: number
  readonly finalText: string
  /** Sorted `"type×count"` digest of all emitted AgentEvent types. */
  readonly eventDigest: string
}

export type Verdict = "NO-REGRESSION" | "CHANGED" | "REGRESSION"

export interface PairedResult {
  readonly gateEnv: string
  readonly off: SideObservation
  readonly on: SideObservation
  readonly verdict: Verdict
  /** Per-axis diffs (only axes that differ). Empty ⇒ byte-identical behavior. */
  readonly diffs: ReadonlyArray<{
    readonly axis: keyof SideObservation
    readonly off: unknown
    readonly on: unknown
  }>
  /** Present iff verdict === "REGRESSION": the axis that regressed + why. */
  readonly regression?: { readonly axis: string; readonly why: string }
}

const TERMINAL_OK: ReadonlySet<AgentOutcome["reason"]> = new Set(["completed"])

const finalTextOf = (messages: readonly Message[]): string => {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]
    if (m?.role !== "assistant") continue
    const parts = Array.isArray(m.content)
      ? m.content
          .filter((c): c is { type: "text"; text: string } => c.type === "text")
          .map((c) => c.text)
      : typeof m.content === "string"
        ? [m.content]
        : []
    return parts.join("")
  }
  return ""
}

const eventDigestOf = (stream: RecordingStream): string => {
  const counts = new Map<string, number>()
  for (const e of stream.events) counts.set(e.type, (counts.get(e.type) ?? 0) + 1)
  return [...counts.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([t, n]) => `${t}×${n}`)
    .join(",")
}

const observe = (outcome: AgentOutcome, s: Scenario): SideObservation => ({
  reason: outcome.reason,
  turns: outcome.turns,
  llmCalls: s.llmCalls(),
  toolEvents: s.stream.events.filter((e) => e.type === "tool_call").length,
  recoveryEvents: s.stream.events.filter((e) => e.type === "recovery").length,
  systemBytes: s.firstSystemBytes(),
  finalText: finalTextOf(outcome.messages),
  eventDigest: eventDigestOf(s.stream),
})

export const AB_AXES: ReadonlyArray<keyof SideObservation> = [
  "reason",
  "turns",
  "llmCalls",
  "toolEvents",
  "recoveryEvents",
  "systemBytes",
  "finalText",
  "eventDigest",
]

/**
 * Conservative, behavior-only regression predicate. Returns the regressing axis
 * (+ reason) or undefined. This rail canNOT judge answer QUALITY — only the
 * terminal outcome + gross work. A gate flip is a REGRESSION when:
 *   (a) OFF reached a terminal-OK outcome and ON did NOT (outcome degraded), OR
 *   (b) same outcome bucket, but ON did strictly MORE loop turns AND did not
 *       reach terminal-OK (more work, no better landing) — a proxy for "the ON
 *       path spins".
 * Everything else that differs is CHANGED (surface for efficacy measurement),
 * not a blocker.
 */
const detectRegression = (
  off: SideObservation,
  on: SideObservation,
): { axis: string; why: string } | undefined => {
  const offOk = TERMINAL_OK.has(off.reason)
  const onOk = TERMINAL_OK.has(on.reason)
  if (offOk && !onOk) {
    return {
      axis: "reason",
      why: `OFF reached terminal-OK (${off.reason}) but ON did not (${on.reason}) — outcome regressed`,
    }
  }
  if (!onOk && on.turns > off.turns) {
    return {
      axis: "turns",
      why: `ON did more turns (${on.turns} vs ${off.turns}) without reaching terminal-OK (${on.reason}) — extra work, no better landing`,
    }
  }
  return undefined
}

export interface RunPairedOptions {
  /** Per-side hard hang guard. Default 20s. */
  readonly timeoutMs?: number
}

/**
 * Run the SAME scenario twice — gate OFF then gate ON — and return the paired
 * verdict. `scenarioFactory` is invoked ONCE PER SIDE (fresh state each side).
 * The ONLY difference between the two runs is the env handed to
 * `wireOptionalAgentPorts`: `{}` (OFF) vs `{ [gateEnv]: "on" }` (ON). Any
 * observable delta is therefore ATTRIBUTABLE to the gate.
 */
export const runPairedAB = async (
  gateEnv: string,
  scenarioFactory: ScenarioFactory,
  opts: RunPairedOptions = {},
): Promise<PairedResult> => {
  const timeoutMs = opts.timeoutMs ?? 20_000

  const runSide = async (env: Record<string, string>): Promise<SideObservation> => {
    const s = scenarioFactory()
    const wired = wireOptionalAgentPorts(s.config, env)
    const outcome = await withTimeout(
      runAgent(wired),
      timeoutMs,
      `ab:${gateEnv}:${JSON.stringify(env)}`,
    )
    return observe(outcome, s)
  }

  const off = await runSide({})
  const on = await runSide({ [gateEnv]: "on" })

  return computePairedVerdict(gateEnv, off, on)
}

/**
 * PURE verdict computation over two already-captured observations. Exported so
 * the verdict/diff/regression logic can be unit-tested WITHOUT a real gate that
 * regresses (which cannot be constructed hermetically without introducing a
 * production regression) — the harness self-test feeds constructed
 * observations directly. `runPairedAB` uses this exact function, so the pure
 * tests pin the SAME logic the live path runs.
 */
export const computePairedVerdict = (
  gateEnv: string,
  off: SideObservation,
  on: SideObservation,
): PairedResult => {
  const diffs = AB_AXES.filter((axis) => off[axis] !== on[axis]).map((axis) => ({
    axis,
    off: off[axis],
    on: on[axis],
  }))

  const regression = detectRegression(off, on)
  const verdict: Verdict =
    regression !== undefined ? "REGRESSION" : diffs.length === 0 ? "NO-REGRESSION" : "CHANGED"

  return {
    gateEnv,
    off,
    on,
    verdict,
    diffs,
    ...(regression !== undefined ? { regression } : {}),
  }
}

/** Human-readable one-liner for a paired result — for smoke reports/logs. */
export const formatPairedResult = (r: PairedResult): string => {
  const head = `[A/B ${r.gateEnv}] ${r.verdict}`
  if (r.verdict === "NO-REGRESSION") return `${head} (byte-identical on ${AB_AXES.length} axes)`
  const body = r.diffs.map((d) => `${String(d.axis)}: ${String(d.off)}→${String(d.on)}`).join("; ")
  const reg = r.regression !== undefined ? ` REASON=${r.regression.why}` : ""
  return `${head} — ${body}${reg}`
}
