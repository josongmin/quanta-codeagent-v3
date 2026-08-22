/**
 * RFC03-2 — `SkillProposalArtifactPort` (the ONE new seam this RFC adds).
 *
 * Content-addressed staged bytes: `put` stores the normalized SKILL.md keyed by
 * its own hash, `get` retrieves by hash, `promote` performs the CAS write into
 * the live skills directory. The port EXPOSES only these three verbs; the host
 * adapter implements them by REUSING existing `@/storage` (atomic write, sha256,
 * realpath jail). The port itself contains NO hash / jail / atomic-write
 * reimplementation — those stay owned by `@/storage`.
 *
 * Immutability: `put` of the same bytes twice is idempotent (same hash, same
 * staged entry). A `get(hash)` returns exactly the bytes whose sha256 == hash,
 * or `null`. This makes staged bytes tamper-evident: a caller that received a
 * `draftHash` can re-`get` and re-hash to prove the staged content did not
 * change.
 *
 * Decision lifecycle is NOT here — that is the existing
 * `ApprovalStateMachinePort`. This port only moves bytes.
 */

/** A staged, content-addressed artifact. */
export interface StagedArtifact {
  /** sha256 of `bytes` (== the staging key). */
  readonly hash: string
  readonly bytes: string
}

/** Result of a CAS promote. Fail-closed: any precondition miss ⇒ a typed
 *  refusal, never a silent overwrite. */
export type PromoteResult =
  | { readonly ok: true; readonly path: string }
  | {
      readonly ok: false
      readonly reason:
        | "unknown_artifact"
        | "hash_mismatch"
        | "preimage_drift"
        | "jail_escape"
        | "write_error"
      readonly detail: string
    }

/**
 * The closed artifact port. All methods NO-THROW (return typed results).
 *
 *   - `put(bytes)` ⇒ stage and return the `{ hash }` (idempotent by content).
 *   - `get(hash)` ⇒ the staged artifact or `null`.
 *   - `promote(args)` ⇒ re-verify `hash === sha256(staged bytes)` AND the live
 *     target still matches `expectedPreimageHash`, then atomic-write into the
 *     jailed skills dir. Any mismatch ⇒ typed refusal (no write).
 */
export interface SkillProposalArtifactPort {
  put(bytes: string): Promise<StagedArtifact>
  get(hash: string): Promise<StagedArtifact | null>
  promote(args: {
    /** The approved artifact hash (== proposal.draftHash). */
    readonly hash: string
    /** Relative `<name>/SKILL.md` target under the skills dir. */
    readonly targetPath: string
    /** The proposal's `targetPreimageHash` captured at compile time. */
    readonly expectedPreimageHash: string
  }): Promise<PromoteResult>
}

/**
 * RFC03-2 cutover — the closed port `skill_create` uses INSTEAD of a live-dir
 * writer. The host (tier1) implements `stage` by composing the artifact port
 * (`put` the bytes) with the EXISTING approval machine (`request` an approval
 * bound to `artifactRef/artifactHash`). The tool itself never writes to disk and
 * never touches the approval machine directly (slice fence: `@/skill` must not
 * import `@/agent`). Absent this port ⇒ `skill_create` is not registered
 * (default-OFF, byte-identical), exactly like the old writer-port gate.
 */
export interface SkillProposalStageResult {
  /** The immutable proposal id (== draftHash) that was staged for review. */
  readonly proposalId: string
}

export interface SkillProposalStagePort {
  /** Stage the compiled proposal's bytes and open a human-review approval bound
   *  to the artifact. NO live write happens here — promotion occurs only on an
   *  operator approve. NO-THROW: returns a typed result. */
  stage(args: {
    readonly proposalId: string
    readonly artifactHash: string
    readonly bytes: string
    readonly name: string
    readonly targetPath: string
    readonly kind: string
  }): Promise<SkillProposalStageResult>
}
