/**
 * T-AUTH-01 — closed selector authority taxonomy.
 *
 * Every signal the selector consumes has ONE fixed authority class. Clean
 * presets may only ever hard-reject on EXECUTABLE or STRUCTURAL authority; all
 * heuristic / answer-key / magic-score signals are `researchOnly` and can never
 * veto a clean-mode candidate. A signal absent from {@link SIGNAL_AUTHORITY} is
 * UNKNOWN and the selector must refuse to treat it as a hard gate (no silent
 * promotion of a new heuristic into admissibility).
 *
 * Authority classes (high → low):
 *   - `hardExecutable`   executed proof (repro quorum, executed witness suite).
 *                        May veto in clean mode.
 *   - `hardStructural`   structural impossibility (empty patch / non-applying).
 *                        May veto in clean mode.
 *   - `contractDominance`public-contract satisfaction. Orders BEFORE minimality;
 *                        never collapses into a hidden soft weight. (T-CON-10)
 *   - `familyOrdering`   candidate-family / owner authority class. Shapes
 *                        exploration + tie-break; never vetoes. (T-GEN-09)
 *   - `softTieBreak`     minimality / owner coverage. Final tie-break only.
 *   - `observeOnly`      telemetry; cannot affect selection.
 *   - `researchOnly`     gated behind a NAMED research knob; never clean
 *                        authority (declaredExpected answer-key matcher, issue
 *                        smoke, discovered-regression magic score, LLM rubric).
 */

export type SignalAuthority =
  | "hardExecutable"
  | "hardStructural"
  | "contractDominance"
  | "familyOrdering"
  | "softTieBreak"
  | "observeOnly"
  | "researchOnly"

export type SelectorMode = "clean" | "research"

/**
 * The fixed authority class of every selector signal. Keys MUST cover every
 * member of `HardGateSignals` and `SoftScoreSignals` (a completeness test pins
 * this) so no signal can reach the selector unclassified.
 *
 * `regressionGreen` is `hardExecutable` ONLY because clean mode requires it to
 * originate from an actually-executed witness suite (provenance enforced in
 * T-REG-03); a magic-score discovered rank that never executed is `researchOnly`
 * and must not arrive on this channel.
 */
export const SIGNAL_AUTHORITY: Record<string, SignalAuthority> = {
  // hard — executed proof
  baseValidatedRed: "hardExecutable",
  patchedResolvedKofN: "hardExecutable",
  regressionGreen: "hardExecutable",
  voterQuorum: "hardExecutable",
  // hard — structural impossibility
  patchProduced: "hardStructural",
  applyClean: "hardStructural",
  // research-only — heuristic / answer-key / magic-score; never clean veto
  smokeGreen: "researchOnly",
  declaredExpectedMatch: "researchOnly",
  rubricScore: "researchOnly",
  // soft tie-break
  minimality: "softTieBreak",
  ownerCoverage: "softTieBreak",
}

export type KnownSignal = keyof typeof SIGNAL_AUTHORITY

/** True when `name` has a declared authority class. A selector must NOT treat an
 *  unknown signal as a hard gate. */
export const isKnownSignal = (name: string): boolean => Object.hasOwn(SIGNAL_AUTHORITY, name)

/**
 * Whether a hard signal retains VETO power in the given mode.
 *
 * - `research` mode preserves every legacy hard gate (byte-identical to the
 *   pre-taxonomy selector).
 * - `clean` mode permits a veto only from `hardExecutable` / `hardStructural`
 *   authority. A `researchOnly` signal (smoke, declaredExpected, rubric) can
 *   never reject a clean candidate, even when it arrives as `false`.
 */
export const isCleanHardVeto = (signal: string, mode: SelectorMode): boolean => {
  if (mode === "research") return true
  const authority = SIGNAL_AUTHORITY[signal]
  return authority === "hardExecutable" || authority === "hardStructural"
}
