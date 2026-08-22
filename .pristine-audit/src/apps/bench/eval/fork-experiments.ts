import type { AgentConfig } from "@/agent"
import type { TurnContextInput } from "@/agent/prompt"
import { assertEvidenceTextBlind } from "@/runner/batch/eval/llm-evidence-packet"

/**
 * Named-experiment REGISTRY for trajectory fork-experiment troubleshooting.
 *
 * The agent loop already exposes ONE pure seam for this — `AgentConfig
 * .turnContextMutator`, a per-turn rewriter of the LLM input that is DEFAULT-OFF
 * (absent ⇒ byte-identical prompt; see `src/agent/types.ts`). This module is
 * the A/B fixture layer ON TOP of that seam: it turns a comma-separated env
 * list (`QUANTA_FORK_EXPERIMENT`) into concrete, named mutator arms so a bench
 * run can fork the same instance under different per-turn context tweaks and
 * compare outcomes.
 *
 * AI-OPERABILITY — this tool is meant to be driven by an LLM/agent, so the
 * registry is SELF-DESCRIBING: every experiment carries a `description` and a
 * typed list of the env `params` it reads, and {@link describeForkExperiments}
 * renders a copy-pasteable catalog. Misuse FAILS LOUD with that catalog in the
 * error (an unknown name, or a required param missing) instead of silently
 * doing nothing — a silent no-op is the worst failure mode for an agent that
 * can't see why its experiment had no effect.
 *
 * DESIGN POSTURE — machinery, NOT heuristics. The registry is deliberately
 * MINIMAL: a `baseline` control arm (identity) plus a GENERAL ad-hoc `inject`
 * arm (drop arbitrary text at a chosen turn). No instance-specific or
 * answer-key-derived steering is baked in here — that would be leaderboard
 * gaming. Ad-hoc injected text is screened by {@link assertEvidenceTextBlind}
 * at FACTORY-construction time, so an experiment that tries to smuggle a SWE
 * dataset marker (FAIL_TO_PASS / PASS_TO_PASS) throws LOUDLY rather than
 * silently feeding the model the answer key.
 *
 * DEFAULT-OFF: `QUANTA_FORK_EXPERIMENT` unset / "" / "0" ⇒ no experiments ⇒
 * the caller wires no `turnContextMutator` ⇒ byte-identical to the pre-feature
 * path.
 */

/** The non-optional shape of `AgentConfig.turnContextMutator`. A PURE rewriter:
 *  it returns a NEW input and never mutates `input` in place (the loop passes a
 *  shallow copy of working memory; mutating nested message content corrupts the
 *  transcript). May fire more than once per turn (refusal / nudge re-entry), so
 *  it must be idempotent for a given `(turn, input)`. */
export type ForkMutator = NonNullable<AgentConfig["turnContextMutator"]>

/** One env knob an experiment reads — surfaced in the catalog so an LLM driver
 *  knows exactly what to set. */
export interface ForkExperimentParam {
  readonly env: string
  readonly required: boolean
  readonly desc: string
}

/** A registered experiment: human/LLM-readable metadata + the factory that
 *  reads its params from `env` and returns a concrete mutator. The factory
 *  THROWS a guidance error when a required param is missing/invalid. */
export interface ForkExperimentSpec {
  readonly description: string
  readonly params: readonly ForkExperimentParam[]
  readonly build: (env: NodeJS.ProcessEnv) => ForkMutator
}

/** A resolved experiment arm: label + description (for the report) + mutator. */
export interface ForkExperiment {
  readonly name: string
  readonly description: string
  readonly mutator: ForkMutator
}

/** Append a single user-role text message to a turn's `baseMessages` WITHOUT
 *  mutating the original input. Returns a fresh `TurnContextInput` with a fresh
 *  `baseMessages` array; the original array and its nested message objects are
 *  left untouched (purity invariant the loop relies on). */
const withAppendedUserText = (input: TurnContextInput, text: string): TurnContextInput => ({
  ...input,
  baseMessages: [...input.baseMessages, { role: "user", content: [{ type: "text", text }] }],
})

export const FORK_EXPERIMENTS: Record<string, ForkExperimentSpec> = {
  baseline: {
    description:
      "A/B CONTROL arm — identity (never touches the input). Run this alongside another arm as the comparison branch; it is byte-identical to wiring no mutator.",
    params: [],
    // The control: identity. Same reference back, so it is provably a no-op.
    build: () => (_turn, input) => input,
  },

  inject: {
    description:
      "Append arbitrary text as a user message at ONE chosen turn (turn-scoped). The general-purpose 'give the LLM this hint at step N' lever. Other turns pass through unchanged.",
    params: [
      {
        env: "QUANTA_FORK_INJECT_TURN",
        required: true,
        desc: "1-based turn index to inject at (e.g. 5)",
      },
      {
        env: "QUANTA_FORK_INJECT_TEXT",
        required: true,
        desc: "the text to add as a trailing user message that turn",
      },
    ],
    build: (env) => {
      const injectText = env.QUANTA_FORK_INJECT_TEXT ?? ""
      // Fail LOUD (not a silent no-op) so an agent driver sees exactly what to
      // fix. Required text first...
      if (injectText.trim() === "") {
        throw new Error(
          'fork experiment "inject" requires QUANTA_FORK_INJECT_TEXT (the text to inject). ' +
            "Set it to the hint/evidence you want the model to see at the chosen turn.",
        )
      }
      // ...then the answer-key fence on that text (reject dataset markers up front)...
      assertEvidenceTextBlind("candidate_generation", [injectText])
      // ...then a valid 1-based turn.
      const injectTurn = Number.parseInt(env.QUANTA_FORK_INJECT_TURN ?? "", 10)
      if (Number.isNaN(injectTurn) || injectTurn < 1) {
        throw new Error(
          'fork experiment "inject" requires QUANTA_FORK_INJECT_TURN as a 1-based integer ' +
            `(turn 1 is the first turn). Got ${JSON.stringify(env.QUANTA_FORK_INJECT_TURN)}.`,
        )
      }
      return (turn, input) =>
        turn === injectTurn ? withAppendedUserText(input, injectText) : input
    },
  },
}

/** Stable, sorted list of registered experiment names (for error messages). */
const validNames = (): string => Object.keys(FORK_EXPERIMENTS).sort().join(", ")

/**
 * Render the experiment catalog as copy-pasteable text — the self-describing
 * surface an LLM/agent reads to learn what it can run and which env knobs each
 * arm needs. Deterministic (sorted by name); safe to print on error or on demand.
 */
export const describeForkExperiments = (): string => {
  const header =
    "Trajectory fork experiments — set QUANTA_FORK_EXPERIMENT=<name>[,<name>...] " +
    "(comma-list ⇒ one branch per name, compared side by side):"
  const blocks = Object.keys(FORK_EXPERIMENTS)
    .sort()
    .map((name) => {
      const spec = FORK_EXPERIMENTS[name] as ForkExperimentSpec
      const params =
        spec.params.length === 0
          ? "    (no params)"
          : spec.params
              .map((p) => `    ${p.env}${p.required ? " (required)" : " (optional)"} — ${p.desc}`)
              .join("\n")
      return `  ${name} — ${spec.description}\n${params}`
    })
  return [header, ...blocks].join("\n")
}

/**
 * Resolve the `QUANTA_FORK_EXPERIMENT` comma-list into concrete experiments.
 *
 *  - Unset / "" / "0" ⇒ `[]` (DEFAULT-OFF — caller wires no mutator).
 *  - Otherwise split on ",", trim, drop empties, preserve order (and any
 *    duplicates as given).
 *  - An UNKNOWN name THROWS (with the full catalog) — never a silent no-op, so a
 *    typo in a bench config fails loud instead of quietly running baseline.
 *  - A known name whose required param is missing also THROWS (from its factory)
 *    with guidance on which env var to set.
 */
export const resolveForkExperiments = (env: NodeJS.ProcessEnv): ForkExperiment[] => {
  const raw = env.QUANTA_FORK_EXPERIMENT
  if (raw === undefined || raw.trim() === "" || raw.trim() === "0") return []
  const names = raw
    .split(",")
    .map((name) => name.trim())
    .filter((name) => name !== "")
  return names.map((name) => {
    const spec = FORK_EXPERIMENTS[name]
    if (spec === undefined) {
      throw new Error(
        `unknown fork experiment "${name}" (QUANTA_FORK_EXPERIMENT); valid names: ${validNames()}.\n${describeForkExperiments()}`,
      )
    }
    return { name, description: spec.description, mutator: spec.build(env) }
  })
}
