/**
 * A1 — Per-candidate repro artifact sink (jun-28 oracle-first RFC).
 *
 * Persists ONE directory per GENERATED repro candidate (the canonical + hardening
 * set from the repro-generation phase) so the non-selected candidates leave durable
 * RCA evidence. Today only the SELECTED `reproduce_issue.py` survives (in the
 * ephemeral sandbox); every other generated candidate evaporates, so "why was this
 * candidate rejected" is unanswerable post-hoc.
 *
 * SCOPE (audited): this covers the GENERATION phase. The repair-round re-validation
 * of canonical sources on the PATCHED tree (repro-vote / resolved-consensus) is NOT
 * persisted here — that signal is captured separately as `reproVoteOutcomes`
 * telemetry in the report. `sidecar.json` is written only when a raw pytest report
 * is supplied; `ReproTestSample` currently carries only the sidecar-DERIVED outcome,
 * so `outcome.json` is the authoritative verdict and `sidecarPresent` is false until
 * the raw report is threaded onto the sample.
 *
 * fs-FREE BY CONSTRUCTION: the sink takes an injected {@link ReproArtifactWritePort}
 * and never imports `node:fs` / `Bun.write`. Production binds the port to a root
 * UNDER the run's observe directory (auto-tarballed back on full-remote — no fetch
 * manifest edit). Tests bind a fake port and assert the write-set. When NO sink is
 * injected at the call site, persistence is simply skipped (no-op, byte-identical).
 *
 * Observation-ONLY: nothing here feeds the adopt/clear/select decision. No hidden
 * SWE-bench field is read or written (source + execution output only). Pure +
 * deterministic: `sourceHashOf` is a content hash (no clock/random).
 */

/** Tail bound for persisted stdout/stderr — full dumps would blow up disk across
 *  breadth × samples × rounds candidates on a full bench run (past `/tmp`
 *  evaporation). Mirrors the validator's 2000-char tail policy. */
export const REPRO_ARTIFACT_TAIL_BOUND = 2000

export type ReproArtifactKind = "canonical" | "hardening"

/** One candidate's persisted record. `sidecar` is the RAW controlled pytest
 *  report JSON when available; `undefined` records a missing sidecar (never
 *  fabricated from stdout). */
export interface ReproCandidateArtifact {
  readonly instanceId: string
  /** Per-kind position (canonical-0, canonical-1, hardening-0, …). */
  readonly index: number
  readonly kind: ReproArtifactKind
  readonly source: string
  readonly stdout: string
  readonly stderr: string
  /** The sidecar-DERIVED outcome (ReproTestOutcome). */
  readonly outcome: string
  /** F3D sub-classification when outcome === "exec_failed". */
  readonly execFailure?: string
  /** Raw pytest report JSON; absent ⇒ sidecar unavailable/missing. */
  readonly sidecar?: string
}

/** Injected write port — one file at a time, path RELATIVE to the artifact root
 *  the production caller bound. Keeps the sink hermetic-by-injection in tests. */
export interface ReproArtifactWritePort {
  writeFile(relPath: string, content: string): Promise<void>
}

export interface ReproArtifactSink {
  persist(a: ReproCandidateArtifact): Promise<void>
}

/** Deterministic candidate id — the directory leaf AND the join key prefix. */
export const candidateIdOf = (kind: ReproArtifactKind, index: number): string => `${kind}-${index}`

/** FNV-1a/32 hex over the UTF-8 source — a deterministic content hash that joins
 *  a generation-phase candidate to its validation/vote artifact (no clock/random,
 *  resume-safe). Collision risk within ONE instance's candidate set is negligible. */
export const sourceHashOf = (source: string): string => {
  let h = 0x811c9dc5
  const bytes = new TextEncoder().encode(source)
  for (const b of bytes) {
    h ^= b
    h = Math.imul(h, 0x01000193)
  }
  return (h >>> 0).toString(16).padStart(8, "0")
}

const boundTail = (s: string): string =>
  s.length > REPRO_ARTIFACT_TAIL_BOUND ? s.slice(-REPRO_ARTIFACT_TAIL_BOUND) : s

/** Path-segment hardening: the artifact directory is built from `instanceId`,
 *  which for a non-swebench / custom corpus is NOT guaranteed `/`- or `..`-free.
 *  Collapse every char outside `[A-Za-z0-9._-]` to `_` so a traversal/injection id
 *  can never escape the artifact root (mirrors the bench work-dir sanitizer). The
 *  ORIGINAL id is preserved verbatim inside `outcome.json` for join-back. */
const safeSegment = (s: string): string => s.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.\.+/g, "_")

/** Raw pytest sidecar is normally tiny (a repro is 1-few nodes), but a pathological
 *  report must not blow up disk. Tail/head-truncating raw JSON would CORRUPT it, so
 *  an oversized report is replaced by a small VALID-JSON marker instead. */
const SIDECAR_MAX_BYTES = 64 * 1024
const boundSidecar = (raw: string): string =>
  raw.length <= SIDECAR_MAX_BYTES
    ? raw
    : `${JSON.stringify({ sidecarOmitted: "oversized", bytes: raw.length })}\n`

/** Build a sink over an injected write port. The port's root is bound by the
 *  caller (production: under the observe dir; tests: a fake map). */
export const makeReproArtifactSink = (port: ReproArtifactWritePort): ReproArtifactSink => ({
  persist: async (a: ReproCandidateArtifact): Promise<void> => {
    const candidateId = candidateIdOf(a.kind, a.index)
    const dir = `repro/${safeSegment(a.instanceId)}/${candidateId}`
    const outcome = {
      // original (un-sanitized) id so a sanitized dir still maps back to the run.
      instanceId: a.instanceId,
      kind: a.kind,
      candidateId,
      sourceHash: sourceHashOf(a.source),
      outcome: a.outcome,
      ...(a.execFailure !== undefined ? { execFailure: a.execFailure } : {}),
      sidecarPresent: a.sidecar !== undefined,
    }
    await port.writeFile(`${dir}/candidate.py`, a.source)
    await port.writeFile(`${dir}/outcome.json`, `${JSON.stringify(outcome, null, 2)}\n`)
    await port.writeFile(`${dir}/stdout.txt`, boundTail(a.stdout))
    await port.writeFile(`${dir}/stderr.txt`, boundTail(a.stderr))
    if (a.sidecar !== undefined) {
      await port.writeFile(`${dir}/sidecar.json`, boundSidecar(a.sidecar))
    }
  },
})
