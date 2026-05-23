/**
 * `@/ipc/session-import` — portable v1 → quanta session.
 *
 * Mirrors Claude Code A11's `importCliSession` direction: a Web client
 * (or another surface) hands the CLI a portable session blob; the CLI
 * materializes it as a NEW local session (fresh id) so the imported state
 * does not collide with an existing in-flight session.
 *
 * Validation is strict: a malformed portable blob is REJECTED — we never
 * coerce or guess. The caller gets a typed `ImportError` (string discriminant
 * for cross-process serialization) and decides whether to surface or retry.
 */

import { type SessionMeta, saveSessionById } from "@/session"

import { PORTABLE_SESSION_VERSION, type PortableSessionV1 } from "./session-export"

/* ------------------------------------------------------------------ */
/* Public types.                                                        */
/* ------------------------------------------------------------------ */

export interface ImportSessionOpts {
  /** Override the new session id. Defaults to a fresh `crypto.randomUUID()`. */
  readonly newId?: string
  /** Override `createdAt` — defaults to `Date.now()` so the import is a
   *  visible "fresh" session, not a backdated one. The original creation
   *  time is preserved in the audit trail by the caller if needed. */
  readonly now?: () => number
  /** Optional title prefix — e.g. `"[imported] "` — applied to the portable
   *  meta's title. Empty / undefined leaves the title verbatim. */
  readonly titlePrefix?: string
}

/** Closed taxonomy of import failure modes. */
export type ImportErrorKind =
  | "not_an_object"
  | "schema_mismatch"
  | "version_unsupported"
  | "meta_invalid"
  | "messages_invalid"

export interface ImportError {
  readonly kind: ImportErrorKind
  readonly message: string
}

export class PortableSessionImportError extends Error {
  readonly kind: ImportErrorKind
  constructor(kind: ImportErrorKind, message: string) {
    super(message)
    this.name = "PortableSessionImportError"
    this.kind = kind
  }
}

/* ------------------------------------------------------------------ */
/* Validation — narrow `unknown` to `PortableSessionV1`.                */
/* ------------------------------------------------------------------ */

const isString = (v: unknown): v is string => typeof v === "string"
const isNumber = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v)
const isBool = (v: unknown): v is boolean => typeof v === "boolean"

const validatePortableMeta = (m: unknown): m is PortableSessionV1["meta"] => {
  if (m === null || typeof m !== "object") return false
  const o = m as Record<string, unknown>
  if (!isString(o.id) || o.id.length === 0) return false
  if (!isString(o.title)) return false
  if (!isString(o.cwd) || o.cwd.length === 0) return false
  if (!isNumber(o.created_at)) return false
  if (!isNumber(o.last_touched)) return false
  if (!isBool(o.archived)) return false
  // Optional git fingerprint fields — when present, must be non-empty strings.
  for (const key of ["git_sha", "git_branch", "git_origin_url"] as const) {
    const v = o[key]
    if (v !== undefined && (!isString(v) || v.length === 0)) return false
  }
  return true
}

/**
 * Validate a `PortableSessionV1` shape without trusting any field. Returns
 * the typed object or throws a `PortableSessionImportError` whose `kind`
 * pinpoints the failure.
 */
export const parsePortableSession = (value: unknown): PortableSessionV1 => {
  if (value === null || typeof value !== "object") {
    throw new PortableSessionImportError("not_an_object", "portable session must be a JSON object")
  }
  const o = value as Record<string, unknown>
  if (o.schema !== "quanta.session.portable") {
    throw new PortableSessionImportError(
      "schema_mismatch",
      `expected schema "quanta.session.portable", got ${JSON.stringify(o.schema)}`,
    )
  }
  if (o.version !== PORTABLE_SESSION_VERSION) {
    throw new PortableSessionImportError(
      "version_unsupported",
      `unsupported portable session version: ${JSON.stringify(o.version)} (this build accepts ${PORTABLE_SESSION_VERSION})`,
    )
  }
  if (!validatePortableMeta(o.meta)) {
    throw new PortableSessionImportError(
      "meta_invalid",
      "portable session meta is missing required fields or has wrong types",
    )
  }
  if (!isString(o.reason)) {
    throw new PortableSessionImportError("meta_invalid", "portable session reason must be a string")
  }
  if (!isNumber(o.turns) || o.turns < 0 || !Number.isInteger(o.turns)) {
    throw new PortableSessionImportError(
      "meta_invalid",
      "portable session turns must be a non-negative integer",
    )
  }
  if (!Array.isArray(o.messages)) {
    throw new PortableSessionImportError(
      "messages_invalid",
      "portable session messages must be an array",
    )
  }
  // Messages are deliberately not deep-validated here — `@/llm`'s Message
  // shape evolves; we trust the wire-source to send a compatible shape and
  // let downstream load-time validation catch true breakage. (The
  // saveSessionById path serializes back to JSON unchanged.)
  return {
    schema: o.schema as "quanta.session.portable",
    version: PORTABLE_SESSION_VERSION,
    meta: o.meta as PortableSessionV1["meta"],
    reason: o.reason,
    turns: o.turns,
    messages: o.messages as PortableSessionV1["messages"],
  }
}

/* ------------------------------------------------------------------ */
/* Portable → SessionMeta materialization.                              */
/* ------------------------------------------------------------------ */

const portableMetaToSessionMeta = (
  portable: PortableSessionV1,
  newId: string,
  now: () => number,
  titlePrefix: string | undefined,
): SessionMeta => {
  const ts = now()
  const title =
    titlePrefix !== undefined && titlePrefix.length > 0
      ? `${titlePrefix}${portable.meta.title}`
      : portable.meta.title
  // exactOptionalPropertyTypes forbids assigning `undefined`; build the base
  // and conditionally spread the optional git fingerprint slots.
  const base: SessionMeta = {
    id: newId,
    title,
    cwd: portable.meta.cwd,
    createdAt: ts,
    lastTouched: ts,
    archived: false, // import always lands in the active state.
  }
  return {
    ...base,
    ...(portable.meta.git_sha !== undefined ? { gitSha: portable.meta.git_sha } : {}),
    ...(portable.meta.git_branch !== undefined ? { gitBranch: portable.meta.git_branch } : {}),
    ...(portable.meta.git_origin_url !== undefined
      ? { gitOriginUrl: portable.meta.git_origin_url }
      : {}),
  }
}

/**
 * Import a portable session blob: validate → mint new id → persist via
 * `@/session#saveSessionById`. Returns the new `SessionMeta` (id is the
 * caller's handle to load / archive / fork the imported session).
 *
 * Idempotency: calling twice on the same blob creates TWO separate
 * sessions (different ids by default). Pass `opts.newId` to make the
 * operation idempotent when the caller has a stable correlation key.
 */
export const importSession = async (
  portable: unknown,
  opts: ImportSessionOpts = {},
): Promise<SessionMeta> => {
  const parsed = parsePortableSession(portable)
  const newId = opts.newId ?? crypto.randomUUID()
  const now = opts.now ?? Date.now
  const meta = portableMetaToSessionMeta(parsed, newId, now, opts.titlePrefix)
  await saveSessionById(meta, {
    reason: parsed.reason,
    turns: parsed.turns,
    messages: [...parsed.messages],
  })
  return meta
}
