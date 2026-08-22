/**
 * H16 — closed ports for the cross-session dream trigger.
 *
 * Three injected seams keep this slice plane-clean (no `@/llm`, no `node:*`,
 * no `@/agent`) and fully testable with in-memory fakes:
 *
 *  - {@link DreamStatePort} — persists the small counter/clock (`DreamState`)
 *    across process runs. Production wires a JSON file under `~/.quanta`;
 *    tests wire a Map.
 *  - {@link DreamConsolidatePort} — does the ACTUAL consolidation work. In
 *    production this is a thin adapter over the EXISTING `runPhase2`
 *    consolidate pipeline (the trigger does NOT reimplement consolidation).
 *    It returns the consolidated cross-session knowledge as text plus a
 *    terminal kind.
 *  - {@link DreamWriteTargetPort} — writes the consolidated text to a
 *    SEPARATE `team/`-style shared target, NEVER the user's live `MEMORY.md`.
 *
 * The dream-lock is NOT a new port: it reuses the codebase's existing
 * `OAuthRefreshLockPort` (in-memory / file-based impls), passed in by the
 * composition root.
 */

/** Result of the actual consolidation pass. */
export interface DreamConsolidateResult {
  /**
   * Terminal kind:
   *  - `consolidated` — produced cross-session knowledge text to write.
   *  - `no_op` — consolidator ran but had nothing to consolidate (e.g. no
   *    new promoted entries). The trigger records a `no_op` dream (counter
   *    reset — we DID dream).
   */
  readonly kind: "consolidated" | "no_op"
  /** The consolidated cross-session knowledge, present iff `consolidated`.
   *  Written verbatim to the team target. */
  readonly content?: string
}

/**
 * Persists the cross-session dream bookkeeping. Sync read/write — the state
 * is a tiny JSON blob. Implementations MUST NOT throw on a missing file
 * (return {@link import("./types").INITIAL_DREAM_STATE}); a corrupt file
 * SHOULD also degrade to initial state rather than crash the dream pass.
 */
export interface DreamStatePort {
  read(): import("./types").DreamState
  write(state: import("./types").DreamState): void
}

/**
 * Runs the actual cross-session consolidation. The production adapter wraps
 * the EXISTING `runPhase2` (+ stage1 store read + promotion gate) so this
 * slice never duplicates consolidation logic. May reject — the trigger wraps
 * any rejection into a `DreamError("consolidate_throw")`.
 */
export interface DreamConsolidatePort {
  consolidate(input: { readonly signal?: AbortSignal }): Promise<DreamConsolidateResult>
}

/**
 * Writes the consolidated knowledge to the shared `team/`-style target. MUST
 * target a path SEPARATE from the user's live `MEMORY.md` (enforced by
 * convention + the hellgate). Returns the byte length written. May reject —
 * the trigger wraps it into a `DreamError("write_throw")`.
 */
export interface DreamWriteTargetPort {
  write(content: string): Promise<number>
  /** The resolved absolute target path — surfaced by `dream status` and
   *  asserted by the hellgate to NOT be a `MEMORY.md`. */
  readonly targetPath: string
}
