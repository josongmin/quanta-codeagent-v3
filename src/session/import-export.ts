/**
 * Session import / export primitive (ADR-0157).
 *
 * Pure serialization port for cross-workspace / cross-machine session migration.
 * Today sessions live in workspace-scoped storage (`<root>/<id>.json` under
 * `~/.quanta/sessions`); there is no typed surface for sharing one off-host. A
 * user wanting to debug a colleague's failure, archive a notable run, or
 * round-trip a session through CI replay had to copy the raw JSON manually —
 * losing version provenance, sidecar state (memory snapshot / budget / plan
 * queue), and platform metadata in the process.
 *
 * This module is the typed envelope. It is a PURE serialization port: no I/O,
 * no SQLite, no path resolution. Filesystem helpers live in the adapter file
 * (`./import-export-fs`) so this module stays free of `node:fs` for callers
 * that only need to round-trip in memory (Bun/browser test rigs, IPC
 * marshaling, CI replay buffers).
 *
 * Mirror of `ConversationCheckpointStore.serialize/hydrate` (ADR-0124),
 * `BudgetLedger.serialize/hydrate` (ADR-0138), `PlanQueueStore.serialize/
 * hydrate` (ADR-0128). Each of those is a per-subsystem snapshot; this slice
 * composes them under `sidecar.*` so an exported session carries the agent's
 * full restorable state in one envelope rather than three loose files.
 *
 * Default-OFF: nothing in the loop imports or exports today. Callers (future
 * `/session export` slash command, CI replay harness, sharing-on-failure
 * surface) opt in by calling `exportSession` / `importSession` and wiring the
 * result themselves. There is no automatic export at session-end.
 *
 * Plane-clean: imports only `./types` (SavedSession). No `node:fs`, no
 * `@/agent/*`, no `@/storage`. The FS adapter is a separate file.
 *
 * Contract:
 *   1. PURE: no I/O, no clock without injection (caller passes `now()` for
 *      determinism in tests).
 *   2. NO-THROW on the export path. `importSession` throws ONLY typed
 *      `SessionImportError` on shape/version failure.
 *   3. exactOptionalPropertyTypes strict — `sidecar`, `platform` are OMITTED
 *      on the wire when absent, never `undefined`.
 *   4. WIRE-STABLE: `version: 1` is the on-disk schema marker. Future bumps
 *      land as `version: 2` and an importer can branch on it.
 *   5. DEEP-CLONE on export: the envelope holds a JSON-clone of the session
 *      so the caller can keep mutating their in-memory `SavedSession`
 *      without corrupting an envelope they handed to a long-running writer.
 *   6. WARNINGS, not failures: by default an import with version or platform
 *      mismatch SUCCEEDS with warnings collected for the caller to surface.
 *      `strictVersion: true` upgrades a version mismatch to a typed throw.
 */

import { createHash, randomBytes } from "node:crypto"
import type { SavedSession } from "./types"

/**
 * Wire-stable session export envelope. Versioned so a future schema bump can
 * land additively without breaking older importers. `version: 1` is the
 * current shape; any other value is an `unsupported-version` typed throw.
 *
 * The `exporterMeta` block lets an importer attribute the envelope to a
 * specific quanta build and host platform — useful for triage when a session
 * imported on linux misbehaves vs. the darwin host it was exported from.
 *
 * `sidecar` is an optional bag of per-subsystem snapshots. Each field is a
 * pre-serialized JSON string (produced by the respective subsystem's own
 * `serialize()` method) so this module does not need to know any subsystem's
 * internal shape. An importer with the corresponding subsystem can call
 * `hydrate(envelope.sidecar.budgetLedger)` to restore that state; absent
 * sidecar fields are simply skipped.
 */
export interface SessionExportEnvelope {
  readonly version: 1
  /** Epoch ms when `exportSession` was called (from injected `now`). */
  readonly exportedAt: number
  readonly exporterMeta: {
    /** Quanta version string from the caller's package.json. */
    readonly quantaVersion: string
    /** Host platform — `process.platform` value at export time. */
    readonly platform: NodeJS.Platform
  }
  /** Deep-cloned `SavedSession`. JSON round-trip ensures the envelope is
   *  decoupled from the caller's live mutable copy. */
  readonly session: SavedSession
  /** Optional sidecar — per-subsystem serialized snapshots. Each field is a
   *  string produced by the respective subsystem's own `serialize()`. Absent
   *  fields are OMITTED, never `undefined` (exactOptional). */
  readonly sidecar?: {
    /** `ConversationCheckpointStore.serialize()` output (ADR-0124). */
    readonly conversationCheckpoint?: string
    /** `BudgetLedger.serialize()` output (ADR-0138). */
    readonly budgetLedger?: string
    /** `PlanQueueStore.serialize()` output (ADR-0128). */
    readonly planQueue?: string
  }
}

/**
 * v2 envelope shape (ADR-0170). Additive over v1: same `session` / `sidecar`
 * shape, but `exporterMeta` gains `capabilities` + `exportTraceId`, plus
 * optional top-level `annotations` and `digest` (sha256 integrity check
 * over the canonical `{session, sidecar}` serialization).
 *
 * Importers MUST accept BOTH v1 and v2 (forward-compat). Exporters default
 * to v1 (`emitV2` absent ⇒ v1, byte-identical to today). A caller wanting
 * the richer envelope opts in via `SessionExportOpts.emitV2 = true`.
 */
export interface SessionExportEnvelopeV2 {
  readonly version: 2
  readonly exportedAt: number
  readonly exporterMeta: {
    readonly quantaVersion: string
    readonly platform: NodeJS.Platform
    /** NEW in v2: structured exporter capabilities — receiver can branch on
     *  e.g. "did this exporter support image attachments?". */
    readonly capabilities: ReadonlyArray<string>
    /** NEW in v2: opaque tracing id (one per export). 16-hex characters
     *  from `crypto.randomBytes(8).toString("hex")`. */
    readonly exportTraceId: string
  }
  readonly session: SavedSession
  readonly sidecar?: SessionExportEnvelope["sidecar"]
  /** NEW in v2: structured annotations — caller-supplied tags/labels for
   *  filtering on import. Read-only at the envelope layer. */
  readonly annotations?: Readonly<Record<string, string>>
  /** NEW in v2: optional integrity digest (sha256) over the canonical
   *  serialization of session+sidecar. Verified on import if present. */
  readonly digest?: { readonly algo: "sha256"; readonly hex: string }
}

/** Discriminated union accepted by `importSession`. v1 stays as-is; v2 layers
 *  in the new fields. Branch via `envelope.version`. */
export type AnySessionExportEnvelope = SessionExportEnvelope | SessionExportEnvelopeV2

/**
 * Default exporter capability list — the well-known sidecar slots quanta
 * supports today (each maps to a per-subsystem `serialize/hydrate` ADR).
 * Auto-populated into v2 envelopes when caller does not pass `capabilities`.
 */
const DEFAULT_V2_CAPABILITIES: ReadonlyArray<string> = [
  "conversation-checkpoint",
  "plan-queue",
  "budget-ledger",
]

/**
 * Caller-supplied options for `exportSession`. `quantaVersion` is REQUIRED —
 * the slice does not read package.json itself to stay plane-clean (no
 * `node:fs`). `platform` defaults to `process.platform`; `now` defaults to
 * `Date.now`. Both are seams for deterministic tests.
 */
export interface SessionExportOpts {
  readonly quantaVersion: string
  readonly platform?: NodeJS.Platform
  readonly now?: () => number
  readonly sidecar?: {
    readonly conversationCheckpoint?: string
    readonly budgetLedger?: string
    readonly planQueue?: string
  }
  /** Emit v2 envelope shape (ADR-0170). Default false (v1, byte-identical
   *  to today's output). */
  readonly emitV2?: boolean
  /** v2-only: caller annotations passed through as-is. Ignored when
   *  `emitV2` is falsy. */
  readonly annotations?: Readonly<Record<string, string>>
  /** v2-only: when true, compute and attach a sha256 digest over the
   *  canonical `{session, sidecar}` serialization. Verified on import.
   *  Ignored when `emitV2` is falsy. */
  readonly withDigest?: boolean
  /** v2-only: capability list. Defaults to {@link DEFAULT_V2_CAPABILITIES}
   *  (the well-known exportable sidecar slots this envelope can actually
   *  carry today). Ignored when `emitV2` is falsy. */
  readonly capabilities?: ReadonlyArray<string>
}

/**
 * Result of a successful `importSession`. `session` is a fresh deep-clone the
 * caller may mutate freely. `sidecar` mirrors what was on the wire (still
 * pre-serialized strings — the caller hands each to the matching subsystem's
 * `hydrate()`). `versionDelta` flags whether the envelope was produced by
 * the same quanta build; `warnings` collects platform / version notes the
 * caller may want to surface to the user.
 */
export interface SessionImportResult {
  readonly session: SavedSession
  readonly sidecar?: SessionExportEnvelope["sidecar"]
  readonly versionDelta: {
    /** The version the IMPORT side is running. */
    readonly importerQuanta: string
    /** The version the export was produced under. */
    readonly exporterQuanta: string
    /** Convenience: `true` iff the two version strings are byte-equal. */
    readonly same: boolean
  }
  /** Human-readable notes (version mismatch, platform mismatch, etc.). Never
   *  contains failure messages — those are thrown as `SessionImportError`. */
  readonly warnings: ReadonlyArray<string>
  /** v2-only surface (ADR-0170). Populated when the envelope was a v2
   *  envelope; OMITTED entirely (key absent) when importing a v1 envelope —
   *  so downstream code branches with `if (result.v2Meta) { … }`. */
  readonly v2Meta?: {
    readonly annotations: Readonly<Record<string, string>>
    readonly capabilities: ReadonlyArray<string>
    readonly exportTraceId: string
  }
}

/**
 * Caller-supplied options for `importSession`. `quantaVersion` is the
 * importer's CURRENT version (caller looks up their own package.json).
 * `platform` defaults to `process.platform`. `strictVersion: true` upgrades
 * a quantaVersion mismatch from a warning to a typed throw — useful for CI
 * replay where a version drift invalidates the test.
 */
export interface SessionImportOpts {
  readonly quantaVersion: string
  readonly platform?: NodeJS.Platform
  /** When `true`, a version mismatch throws `version-mismatch` instead of
   *  collecting a warning. Defaults to `false`. */
  readonly strictVersion?: boolean
}

/** Typed failure for `importSession`. `code` discriminates the failure kind
 *  so callers can branch (e.g. surface "version mismatch — re-export" vs.
 *  "envelope corrupt — file unusable"). `digest-mismatch` (ADR-0170) fires
 *  when a v2 envelope carries an integrity digest that does not match the
 *  recomputed digest of its `{session, sidecar}` body — indicates tampering
 *  or transport corruption. */
export type SessionImportErrorCode =
  | "malformed"
  | "unsupported-version"
  | "version-mismatch"
  | "digest-mismatch"

export class SessionImportError extends Error {
  readonly code: SessionImportErrorCode
  constructor(code: SessionImportErrorCode, message: string) {
    super(message)
    this.name = "SessionImportError"
    this.code = code
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Export side
// ────────────────────────────────────────────────────────────────────────────

/** Construct the envelope from a live `SavedSession`. Deep-clones the session
 *  so the caller may keep mutating their copy without corrupting the
 *  envelope. Pure: no I/O, no globals beyond the injected `now()` and the
 *  unavoidable `crypto.randomBytes` for the v2 `exportTraceId`.
 *
 *  Branches on `opts.emitV2`: false / absent → v1 envelope (byte-identical
 *  to pre-0170 output); true → v2 envelope (ADR-0170 — auto-populates
 *  `exportTraceId` + `capabilities`, attaches `digest` when `withDigest:
 *  true`, threads `annotations` through). Overloads narrow the return type
 *  when the caller passes a literal `emitV2`. */
export function exportSession(
  session: SavedSession,
  opts: SessionExportOpts & { readonly emitV2: true },
): SessionExportEnvelopeV2
export function exportSession(
  session: SavedSession,
  opts: SessionExportOpts & { readonly emitV2?: false | undefined },
): SessionExportEnvelope
export function exportSession(
  session: SavedSession,
  opts: SessionExportOpts,
): AnySessionExportEnvelope
export function exportSession(
  session: SavedSession,
  opts: SessionExportOpts,
): AnySessionExportEnvelope {
  const now = opts.now ?? Date.now
  const platform = opts.platform ?? process.platform
  // JSON round-trip = simple, structural deep clone. Sessions never contain
  // Dates / Maps / Sets / functions (the SavedSession schema is all
  // primitives + arrays + plain objects), so structuredClone would buy us
  // nothing and JSON gives us free wire-shape validation along the way.
  const cloned = JSON.parse(JSON.stringify(session)) as SavedSession

  // exactOptional: build sidecar ONLY when at least one field is present, and
  // include each sub-field ONLY when defined. Same for the top-level
  // `sidecar` — when caller passes no sidecar opts, we OMIT the field
  // entirely from the envelope rather than writing `sidecar: undefined`.
  const sidecar = buildSidecar(opts.sidecar)

  if (opts.emitV2 === true) {
    return buildV2Envelope(cloned, sidecar, platform, now(), opts)
  }

  const exporterMeta = { quantaVersion: opts.quantaVersion, platform }
  if (sidecar === undefined) {
    return {
      version: 1,
      exportedAt: now(),
      exporterMeta,
      session: cloned,
    }
  }
  return {
    version: 1,
    exportedAt: now(),
    exporterMeta,
    session: cloned,
    sidecar,
  }
}

/** Build the v2 envelope. Extracted to keep `exportSession` under the
 *  cognitive-complexity cap. */
const buildV2Envelope = (
  cloned: SavedSession,
  sidecar: SessionExportEnvelope["sidecar"] | undefined,
  platform: NodeJS.Platform,
  exportedAt: number,
  opts: SessionExportOpts,
): SessionExportEnvelopeV2 => {
  const capabilities = opts.capabilities ?? DEFAULT_V2_CAPABILITIES
  const exportTraceId = randomBytes(8).toString("hex")
  const exporterMeta = {
    quantaVersion: opts.quantaVersion,
    platform,
    capabilities,
    exportTraceId,
  }

  // Compose the body for digest BEFORE we know the final shape — digest
  // covers `{session, sidecar}` only (NOT exporterMeta / annotations /
  // exportedAt) so the digest is stable across re-exports of the same
  // logical body and reproducible by a verifier.
  const digest = opts.withDigest === true ? computeBodyDigest(cloned, sidecar) : undefined

  // exactOptional: build the envelope key-by-key, omitting undefined keys.
  const out: {
    version: 2
    exportedAt: number
    exporterMeta: SessionExportEnvelopeV2["exporterMeta"]
    session: SavedSession
    sidecar?: SessionExportEnvelope["sidecar"]
    annotations?: Readonly<Record<string, string>>
    digest?: { algo: "sha256"; hex: string }
  } = { version: 2, exportedAt, exporterMeta, session: cloned }
  if (sidecar !== undefined) out.sidecar = sidecar
  if (opts.annotations !== undefined) out.annotations = opts.annotations
  if (digest !== undefined) out.digest = digest
  return out
}

/** Compute the sha256 digest over the canonical `{session, sidecar}`
 *  serialization. Top-level keys are fixed-order (`session` then `sidecar`)
 *  for stability — JSON.stringify preserves insertion order, so we build
 *  the body object in a deterministic order. Inner objects are NOT
 *  key-sorted: the on-the-wire envelope has been JSON.parse / JSON.stringify'd
 *  already (via the deep-clone), so its internal key order is the source of
 *  truth and both exporter and importer see the same string. */
const computeBodyDigest = (
  session: SavedSession,
  sidecar: SessionExportEnvelope["sidecar"] | undefined,
): { algo: "sha256"; hex: string } => {
  const body = sidecar === undefined ? { session } : { session, sidecar }
  const hex = createHash("sha256").update(JSON.stringify(body)).digest("hex")
  return { algo: "sha256", hex }
}

/** Build the optional sidecar block. Returns `undefined` when caller passed
 *  no sidecar at all OR passed an empty object — in both cases we OMIT the
 *  field from the envelope (exactOptional). */
const buildSidecar = (
  opts: SessionExportOpts["sidecar"],
): SessionExportEnvelope["sidecar"] | undefined => {
  if (opts === undefined) return undefined
  const out: {
    conversationCheckpoint?: string
    budgetLedger?: string
    planQueue?: string
  } = {}
  if (opts.conversationCheckpoint !== undefined) {
    out.conversationCheckpoint = opts.conversationCheckpoint
  }
  if (opts.budgetLedger !== undefined) out.budgetLedger = opts.budgetLedger
  if (opts.planQueue !== undefined) out.planQueue = opts.planQueue
  // All three absent → no sidecar block on the wire.
  if (Object.keys(out).length === 0) return undefined
  return out
}

/** Convenience: stringify the envelope. Pretty-prints with 2-space indent for
 *  diff-friendly transcripts (sessions are typically <1MB; the readability
 *  win outweighs the size cost). */
export const exportSessionToJson = (session: SavedSession, opts: SessionExportOpts): string =>
  JSON.stringify(exportSession(session, opts), null, 2)

// ────────────────────────────────────────────────────────────────────────────
// Import side
// ────────────────────────────────────────────────────────────────────────────

/** Validate the envelope shape + version, then build the import result.
 *  Throws `SessionImportError` on any shape/version/digest failure. Pure:
 *  no I/O.
 *
 *  ADR-0170: accepts BOTH v1 and v2 envelopes (forward-compat). Other
 *  versions throw `unsupported-version`. When the envelope is v2 and
 *  carries a `digest`, the digest is recomputed over the canonical
 *  `{session, sidecar}` serialization and mismatch throws
 *  `digest-mismatch`. v2 annotations / capabilities / exportTraceId
 *  surface as `result.v2Meta` (omitted entirely for v1 envelopes). */
export const importSession = (
  envelope: AnySessionExportEnvelope,
  opts: SessionImportOpts,
): SessionImportResult => {
  validateEnvelopeShape(envelope)
  // We check `version` via a structural cast first because the union literal
  // types (1 | 2) make any other value narrow to `never` — incorrect for
  // runtime input that might carry a future `version: 3`.
  const rawVersion = (envelope as { version: unknown }).version as number
  if (rawVersion !== 1 && rawVersion !== 2) {
    throw new SessionImportError(
      "unsupported-version",
      `session envelope version ${String(rawVersion)} not supported (this build understands version 1 and 2)`,
    )
  }
  const env = envelope as AnySessionExportEnvelope

  // v2-specific structural checks (must run BEFORE we touch v2-only fields).
  if (env.version === 2) {
    validateV2Shape(env)
    verifyV2Digest(env)
  }

  const importerPlatform = opts.platform ?? process.platform
  const exporterQuanta = env.exporterMeta.quantaVersion
  const importerQuanta = opts.quantaVersion
  const same = exporterQuanta === importerQuanta

  if (!same && opts.strictVersion === true) {
    throw new SessionImportError(
      "version-mismatch",
      `quanta version mismatch in strict mode: importer=${importerQuanta} exporter=${exporterQuanta}`,
    )
  }

  const warnings: string[] = []
  if (!same) {
    warnings.push(`quanta version mismatch: importer=${importerQuanta} exporter=${exporterQuanta}`)
  }
  if (env.exporterMeta.platform !== importerPlatform) {
    warnings.push(
      `platform mismatch: importer=${importerPlatform} exporter=${env.exporterMeta.platform}`,
    )
  }

  // Deep-clone the session on import too so the caller mutating the returned
  // value cannot corrupt the envelope they may still hold a reference to.
  const session = JSON.parse(JSON.stringify(env.session)) as SavedSession
  const versionDelta = { importerQuanta, exporterQuanta, same }

  return buildImportResult(env, session, versionDelta, warnings)
}

/** Assemble the `SessionImportResult` honoring exactOptional (omit absent
 *  keys entirely). Extracted from `importSession` to keep that function
 *  under the cognitive-complexity cap. */
const buildImportResult = (
  env: AnySessionExportEnvelope,
  session: SavedSession,
  versionDelta: SessionImportResult["versionDelta"],
  warnings: ReadonlyArray<string>,
): SessionImportResult => {
  const base: {
    session: SavedSession
    sidecar?: SessionExportEnvelope["sidecar"]
    versionDelta: SessionImportResult["versionDelta"]
    warnings: ReadonlyArray<string>
    v2Meta?: NonNullable<SessionImportResult["v2Meta"]>
  } = { session, versionDelta, warnings }
  if (env.sidecar !== undefined) base.sidecar = env.sidecar
  if (env.version === 2) {
    base.v2Meta = {
      annotations: env.annotations ?? {},
      capabilities: env.exporterMeta.capabilities,
      exportTraceId: env.exporterMeta.exportTraceId,
    }
  }
  return base
}

/** v2-only structural validation. Runs AFTER `validateEnvelopeShape` (which
 *  already confirmed `exporterMeta.quantaVersion` + `platform`). Here we
 *  enforce the v2-additions: `capabilities` array + `exportTraceId` string,
 *  and the optional `annotations` / `digest` shapes when present. */
const validateV2Shape = (env: SessionExportEnvelopeV2): void => {
  const meta = env.exporterMeta as unknown as Record<string, unknown>
  if (!Array.isArray(meta.capabilities)) {
    bad("envelope.exporterMeta.capabilities is missing or not an array (v2)")
  }
  if (typeof meta.exportTraceId !== "string" || meta.exportTraceId.length === 0) {
    bad("envelope.exporterMeta.exportTraceId is missing or empty (v2)")
  }
  if (env.annotations !== undefined) {
    if (env.annotations === null || typeof env.annotations !== "object") {
      bad("envelope.annotations is present but not an object (v2)")
    }
  }
  if (env.digest !== undefined) {
    const d = env.digest as unknown as Record<string, unknown>
    if (d.algo !== "sha256") bad("envelope.digest.algo must be 'sha256' (v2)")
    if (typeof d.hex !== "string" || d.hex.length === 0) {
      bad("envelope.digest.hex is missing or empty (v2)")
    }
  }
}

/** Recompute the v2 digest and compare to the wire value. No-op when the
 *  envelope carries no digest (callers MAY omit it). Mismatch throws
 *  `digest-mismatch` — the body has been tampered with or transport-
 *  corrupted between exporter and importer. */
const verifyV2Digest = (env: SessionExportEnvelopeV2): void => {
  if (env.digest === undefined) return
  const recomputed = computeBodyDigest(env.session, env.sidecar)
  if (recomputed.hex !== env.digest.hex) {
    throw new SessionImportError(
      "digest-mismatch",
      `session envelope digest mismatch: expected=${env.digest.hex} recomputed=${recomputed.hex}`,
    )
  }
}

/** Parse a JSON string then `importSession`. JSON parse failures land as
 *  `malformed` typed throws — surfaces don't need to know the JSON parse
 *  happened, only that the envelope was unusable. */
export const importSessionFromJson = (
  json: string,
  opts: SessionImportOpts,
): SessionImportResult => {
  let parsed: unknown
  try {
    parsed = JSON.parse(json)
  } catch (e) {
    throw new SessionImportError(
      "malformed",
      `session envelope JSON parse failed: ${e instanceof Error ? e.message : String(e)}`,
    )
  }
  return importSession(parsed as AnySessionExportEnvelope, opts)
}

/** Throw `malformed` with the given message. Inlined helper keeps each
 *  validator small (cognitive-complexity budget). */
const bad = (message: string): never => {
  throw new SessionImportError("malformed", message)
}

/** Validate `exporterMeta` sub-block. Extracted to keep `validateEnvelopeShape`
 *  under biome's cognitive-complexity cap. */
const validateExporterMeta = (meta: unknown): void => {
  if (meta === null || typeof meta !== "object") {
    bad("envelope.exporterMeta is missing or not an object")
  }
  const m = meta as Record<string, unknown>
  if (typeof m.quantaVersion !== "string" || m.quantaVersion.length === 0) {
    bad("envelope.exporterMeta.quantaVersion is missing or empty")
  }
  if (typeof m.platform !== "string" || m.platform.length === 0) {
    bad("envelope.exporterMeta.platform is missing or empty")
  }
}

/** Validate the inner `session` sub-block. We only check the top-level shape
 *  (must be object with `meta` object + `messages` array). Deep field
 *  validation is the responsibility of `loadSessionById`'s zod schema —
 *  keeping this slice zod-free and browser-parseable. */
const validateSessionBlock = (session: unknown): void => {
  if (session === null || typeof session !== "object") {
    bad("envelope.session is missing or not an object")
  }
  const s = session as Record<string, unknown>
  if (s.meta === null || typeof s.meta !== "object") {
    bad("envelope.session.meta is missing or not an object")
  }
  if (!Array.isArray(s.messages)) {
    bad("envelope.session.messages is not an array")
  }
}

/** Validate the OUTER envelope shape. Does NOT validate the inner SavedSession
 *  in deep detail — `loadSessionById` etc. use a zod schema for that and we
 *  intentionally do NOT couple this slice to zod (keeps it dependency-free
 *  and parseable in a browser). We DO check the fields a downstream consumer
 *  will dereference (version, exporterMeta, session.meta, session.messages). */
const validateEnvelopeShape = (envelope: unknown): void => {
  if (envelope === null || typeof envelope !== "object") {
    bad("envelope is not an object")
  }
  const e = envelope as Record<string, unknown>

  if (typeof e.version !== "number") bad("envelope.version is not a number")
  if (typeof e.exportedAt !== "number" || !Number.isFinite(e.exportedAt)) {
    bad("envelope.exportedAt is not a finite number")
  }

  validateExporterMeta(e.exporterMeta)
  validateSessionBlock(e.session)

  // `sidecar` is optional; when present it must be an object (each sub-field
  // is a string but the deep validation lives in the subsystem's own
  // `hydrate` — keeping responsibility split).
  if (e.sidecar !== undefined && (e.sidecar === null || typeof e.sidecar !== "object")) {
    bad("envelope.sidecar is present but not an object")
  }
}
