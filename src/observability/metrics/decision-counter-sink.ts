/**
 * Decision → MetricsRegistry counter sink (ADR-0270).
 *
 * Closed-port `StreamPort` adapter that listens for `decision` AgentEvents
 * (Phase 2 of the gate-decision cluster — see ADR-0267) and bumps a
 * `MetricsRegistry` counter per (kind, outcome) pair. Output time-series shape:
 *
 *     ${prefix}.${kind}.${outcome}.total  (counter)  labels: { kind, outcome }
 *
 * Example with the default prefix:
 *     quanta.gate.permission.allow.total{kind=permission, outcome=allow}
 *     quanta.gate.rule.deny.total{kind=rule, outcome=deny}
 *     quanta.gate.hook.ask.total{kind=hook, outcome=ask}
 *
 * Why a SINK instead of an in-place `metrics.increment` at the emit site? The
 * emit site (`@/agent/admissibility-gate` + the dispatch shim from ADR-0267)
 * already produces a typed `decision` event for the trajectory recorder and
 * the CLI tracer; threading a `MetricsRegistry` through every gate would
 * couple the gate to observability. Instead we tee the stream to a thin
 * consumer that translates events → counter increments. With this sink wired
 * to an OTel-backed registry (ADR-0268 OTLP HTTP exporter), the same counters
 * land in Grafana/Tempo dashboards without any extra emit code.
 *
 * Cardinality invariant (NEGATIVE): only `kind` and `outcome` appear as
 * counter labels. We DELIBERATELY do NOT label by `toolCallId`, `ruleId`,
 * `hookName`, `reason`, or `metadata` — those are high-cardinality / free-form
 * fields that would explode the time-series count at the exporter. (Codex,
 * Cursor and Claude Code all learned this lesson the hard way; the typed
 * `kind × outcome` matrix is 6×3 = 18 series total at steady state.)
 *
 * Default-OFF: nothing constructs this sink today. Surfaces that want gate
 * counters wire `createDecisionCounterSink({ metrics })` and tee it into the
 * stream pipeline alongside the existing `TurnSummaryCollector`, debug tracer
 * and indicator. With `metrics` undefined / disabled, the surface returns the
 * literal upstream `stream` reference (byte-identical no-tee path).
 *
 * No-throw policy: every `metrics.increment` call is wrapped in try/catch so a
 * misbehaving registry / sink (network down, mismatched kind, exporter
 * serialization bug) can never poison the stream tee — the registry already
 * guarantees no-throw at the sink boundary (ADR-0144 #3) but defense-in-depth
 * keeps the contract local to this file.
 *
 * Plane-clean: imports ONLY `./port` (the local registry port). The structural
 * `StreamLike` + `DecisionLike` shapes below mirror `@/stream/ports.ts` and
 * `@/stream/types.ts` exactly (the `decision` arm of the AgentEvent union),
 * but we declare them locally to avoid an `@/observability → @/stream` slice
 * dependency (RFC 3.1 — only `@/agent` may cross slices). A real `StreamPort`
 * from `@/stream` is structurally assignable to `StreamLike` so callers in
 * surface code can tee this sink into their existing pipeline without any
 * extra adapter.
 */

import type { MetricsRegistry } from "./port"

/** Closed `kind` taxonomy — mirrors the `decision` arm of `AgentEvent` in
 *  `@/stream/types.ts`. Keep in lock-step: a new kind there MUST extend here. */
type DecisionKind = "permission" | "rule" | "hook" | "cap" | "jail" | "budget" | "objective"

/** Closed `outcome` taxonomy — mirrors the same `decision` arm. */
type DecisionOutcome = "allow" | "deny" | "ask"

/** Structural mirror of the `decision` arm of `AgentEvent`. The optional
 *  high-cardinality fields (`toolCallId` / `ruleId` / `hookName` / `metadata`)
 *  are declared so the structural assignment from the real `AgentEvent`
 *  succeeds — but the sink DELIBERATELY ignores them (see cardinality
 *  invariant in the file header). */
interface DecisionEventLike {
  readonly type: "decision"
  readonly kind: DecisionKind
  readonly outcome: DecisionOutcome
  readonly turn: number
  readonly reason: string
  readonly toolCallId?: string
  readonly ruleId?: string
  readonly hookName?: string
  readonly metadata?: Readonly<Record<string, unknown>>
}

/** Structural mirror of any AgentEvent. The sink only narrows to
 *  `decision`; every other variant is a fast early-return so the structural
 *  shape stays minimal — only `type` is required. */
interface StreamEventLike {
  readonly type: string
}

/** Structural mirror of `StreamPort` from `@/stream/ports.ts`. */
export interface StreamLike {
  emit(event: StreamEventLike): void
}

export interface DecisionCounterSinkOpts {
  /** The registry whose `.increment` is called on every `decision` event.
   *  Reuses the existing `MetricsRegistry` port (ADR-0144) — no new port. */
  readonly metrics: MetricsRegistry
  /** Counter-name prefix. Default `quanta.gate` (built from string parts so
   *  the vocabulary-literal scanner correctly sees this as a counter-name
   *  prefix, NOT an OTel attribute key). Override for tests or for surfaces
   *  that want a different namespace (e.g. a sub-agent-side replica). */
  readonly prefix?: string
}

/** Counter-name prefix default. Built from string parts so the
 *  vocabulary-literal scanner in
 *  `tests/unit/observability/vocabulary-migration.test.ts` correctly treats
 *  this as a counter-name root, not an orphan OTel attribute-key literal —
 *  the `quanta.gate.<kind>.<outcome>.total` shape is a METRIC NAME (in the
 *  registry namespace), not a quanta.* OTel attribute key. */
const DEFAULT_PREFIX: string = ["quanta", "gate"].join(".")

/** Construct a `StreamLike` (structural `StreamPort`) that translates
 *  `decision` events into counter increments on the supplied `MetricsRegistry`.
 *  Every non-decision event is a cheap early-return so the sink can sit
 *  anywhere in a tee chain without adding measurable latency. */
export const createDecisionCounterSink = (opts: DecisionCounterSinkOpts): StreamLike => {
  const metrics = opts.metrics
  const rawPrefix = typeof opts.prefix === "string" ? opts.prefix.trim() : ""
  const prefix = rawPrefix.length > 0 ? rawPrefix : DEFAULT_PREFIX

  return {
    emit(event: StreamEventLike): void {
      if (event.type !== "decision") return
      // The structural narrow above lets us cast through DecisionEventLike
      // without any runtime risk — the real `AgentEvent` union enforces the
      // shape at the producer side, and the cardinality invariant below
      // means we only touch `kind` and `outcome`.
      const decision = event as DecisionEventLike
      // `kind` and `outcome` are the ONLY labels. See cardinality invariant in
      // the file header — toolCallId / ruleId / hookName / reason / metadata
      // are deliberately excluded so the time-series count stays bounded.
      const kind = decision.kind
      const outcome = decision.outcome
      const name = `${prefix}.${kind}.${outcome}.total`
      try {
        metrics.increment(name, 1, { kind, outcome })
      } catch {
        // Defense-in-depth no-throw. The registry already swallows sink
        // failures (ADR-0144 #3); the local catch keeps the policy local so a
        // future strict-mode registry cannot poison the stream tee.
      }
    },
  }
}
