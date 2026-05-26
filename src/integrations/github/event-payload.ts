/**
 * ADR-0311 — GitHub event payload reader & normalizer.
 *
 * Reads `GITHUB_EVENT_PATH` (the JSON file Actions writes for every event)
 * and converts it into a {@link NormalizedGhEvent}. Two passes:
 *
 *  1. `safeReadEventFile` — reads the file with a strict byte cap (10MB
 *     default). Malformed JSON / oversized / missing → `undefined`. Never
 *     throws (boundary contract: hostile input collapses to no signal).
 *  2. `normalizeGhEvent` — pulls only the fields we model. Exhaustive over
 *     {@link GhEventKind}; new variants are a compile-error.
 */

import { createHash } from "node:crypto"

import type {
  FsPort,
  GhEventKind,
  NormalizedGhEvent,
  NormalizedRepo,
  NormalizedSender,
  SenderType,
} from "./types"

/** Max event-file size we will accept. GH delivers ≤25MB but realistic
 *  payloads are <100KB; 10MB is the bound documented in ADR-0311. */
const MAX_EVENT_BYTES = 10 * 1024 * 1024

/** Sender types we recognize. Unknown values collapse to "User" — the safest
 *  default (trust-scope filter still applies separately). */
const SENDER_TYPES: ReadonlyArray<SenderType> = ["User", "Bot", "Organization"]

interface RawEventEnvelope {
  readonly action?: string
  readonly repository?: { readonly owner?: { readonly login?: string }; readonly name?: string }
  readonly sender?: {
    readonly login?: string
    readonly type?: string
  }
  readonly pull_request?: {
    readonly number?: number
    readonly body?: string
    readonly user?: { readonly login?: string }
  }
  readonly issue?: {
    readonly number?: number
    readonly pull_request?: unknown
    readonly body?: string
  }
  readonly comment?: {
    readonly body?: string
    readonly author_association?: string
    readonly user?: { readonly login?: string }
  }
  readonly review?: {
    readonly body?: string
    readonly author_association?: string
    readonly user?: { readonly login?: string }
  }
  readonly inputs?: Record<string, unknown>
}

export interface ParseGhEventOpts {
  readonly fsPort: FsPort
  readonly path: string
  readonly maxBytes?: number
}

/**
 * Read + JSON-parse the GH event file. Never throws. Returns `undefined` on:
 *  - missing file / fs error,
 *  - file larger than `maxBytes`,
 *  - non-JSON / non-object root,
 *  - null bytes (defensive — GH never delivers them, so their presence is a
 *    strong signal of tampering / non-event content).
 */
export const parseGhEventFile = async (
  opts: ParseGhEventOpts,
): Promise<RawEventEnvelope | undefined> => {
  const cap = opts.maxBytes ?? MAX_EVENT_BYTES
  const buf = await safeReadEventFile(opts.fsPort, opts.path, cap)
  if (buf === undefined) return undefined
  // Reject NUL bytes — GH event JSON never contains them; their presence is
  // a non-event payload (binary, tampered, …).
  for (let i = 0; i < buf.length; i++) {
    if (buf[i] === 0x00) return undefined
  }
  // Strip UTF-8 BOM (some toolchains prepend it; JSON.parse rejects it).
  const start = buf.length >= 3 && buf[0] === 0xef && buf[1] === 0xbb && buf[2] === 0xbf ? 3 : 0
  const text = buf.subarray(start).toString("utf8")
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return undefined
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) return undefined
  return parsed as RawEventEnvelope
}

/**
 * Read the file under a byte cap. Stats first (cheap reject for oversized).
 * Never throws — fs faults collapse to `undefined`.
 */
export const safeReadEventFile = async (
  fsPort: FsPort,
  path: string,
  maxBytes: number,
): Promise<Buffer | undefined> => {
  try {
    const stat = await fsPort.stat(path)
    if (stat === undefined) return undefined
    if (stat.size > maxBytes) return undefined
    const buf = await fsPort.readFile(path, { maxBytes })
    if (buf === undefined) return undefined
    if (buf.length > maxBytes) return undefined
    return buf
  } catch {
    return undefined
  }
}

export interface NormalizeOpts {
  readonly raw: RawEventEnvelope | unknown
  readonly kind: GhEventKind
  /** When the host already knows the GH delivery id (e.g. it's running on the
   *  webhook hot path and pulled `X-GitHub-Delivery`). Falls back to a SHA-1
   *  of the canonicalized payload when absent. */
  readonly deliveryId?: string
}

/**
 * Normalize the raw payload. Returns `undefined` only when we can't anchor
 * a `repo` — every other absent field is surfaced as `undefined` in the
 * output (NOT silently dropped). Self-loop defense: a `sender.type === "Bot"`
 * is preserved so the caller can decide whether to filter.
 */
export const normalizeGhEvent = (opts: NormalizeOpts): NormalizedGhEvent | undefined => {
  if (opts.raw === null || typeof opts.raw !== "object") return undefined
  const raw = opts.raw as RawEventEnvelope
  const repo = extractRepo(raw)
  if (repo === undefined) return undefined
  const sender = extractSender(raw)
  const body = extractBody(raw, opts.kind)
  const prNumber = extractPrNumber(raw)
  const deliveryId = opts.deliveryId ?? computeDeliveryFallback(raw)
  const action = typeof raw.action === "string" ? raw.action : undefined
  const event: NormalizedGhEvent = Object.freeze({
    kind: opts.kind,
    deliveryId,
    repo,
    sender,
    raw,
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(body !== undefined ? { body } : {}),
    ...(action !== undefined ? { action } : {}),
  })
  return event
}

const extractRepo = (raw: RawEventEnvelope): NormalizedRepo | undefined => {
  const ownerLogin = raw.repository?.owner?.login
  const name = raw.repository?.name
  if (typeof ownerLogin !== "string" || ownerLogin.length === 0) return undefined
  if (typeof name !== "string" || name.length === 0) return undefined
  return Object.freeze({ owner: ownerLogin, name })
}

const extractSender = (raw: RawEventEnvelope): NormalizedSender => {
  const loginRaw = raw.sender?.login ?? raw.comment?.user?.login ?? raw.pull_request?.user?.login
  const login = typeof loginRaw === "string" && loginRaw.length > 0 ? loginRaw : "unknown"
  const typeRaw = raw.sender?.type
  const type =
    typeof typeRaw === "string" && (SENDER_TYPES as readonly string[]).includes(typeRaw)
      ? (typeRaw as SenderType)
      : "User"
  const assoc = raw.comment?.author_association ?? raw.review?.author_association
  const isCollaborator =
    typeof assoc === "string"
      ? assoc === "COLLABORATOR" || assoc === "MEMBER" || assoc === "OWNER"
      : undefined
  if (isCollaborator === undefined) {
    return Object.freeze({ login, type })
  }
  return Object.freeze({ login, type, isCollaborator })
}

const extractBody = (raw: RawEventEnvelope, kind: GhEventKind): string | undefined => {
  switch (kind) {
    case "pull_request_review_comment":
    case "issue_comment":
      return typeOrUndefined(raw.comment?.body)
    case "pull_request_review":
      return typeOrUndefined(raw.review?.body)
    case "pull_request":
      return typeOrUndefined(raw.pull_request?.body)
    case "issues":
      return typeOrUndefined(raw.issue?.body)
    case "workflow_dispatch":
      return safeStringifyInputs(raw.inputs)
    default:
      return assertExhaustive(kind)
  }
}

const typeOrUndefined = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

const safeStringifyInputs = (inputs: unknown): string | undefined => {
  if (inputs === null || typeof inputs !== "object") return undefined
  try {
    return JSON.stringify(inputs)
  } catch {
    return undefined
  }
}

const extractPrNumber = (raw: RawEventEnvelope): number | undefined => {
  const fromPr = raw.pull_request?.number
  if (typeof fromPr === "number" && Number.isFinite(fromPr) && fromPr > 0) return fromPr
  // `issue_comment` on a PR carries `issue.pull_request` (non-null) + `issue.number`.
  if (raw.issue?.pull_request !== undefined && typeof raw.issue.number === "number") {
    return raw.issue.number > 0 ? raw.issue.number : undefined
  }
  return undefined
}

const computeDeliveryFallback = (raw: RawEventEnvelope): string => {
  // SHA-1 of the JSON canonicalization. NOT cryptographically meaningful —
  // just a stable surrogate so two identical payloads dedupe.
  let serialized: string
  try {
    serialized = JSON.stringify(raw)
  } catch {
    serialized = String(Date.now())
  }
  return `fallback-${createHash("sha1").update(serialized).digest("hex").slice(0, 16)}`
}

const assertExhaustive = (kind: never): never => {
  throw new Error(`event-payload: unhandled GhEventKind ${String(kind)}`)
}
