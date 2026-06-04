import { loadSession } from "@/agent"
import type { Message } from "@/llm"
import { reconcileToolPairing } from "@/memory/history-sanitization"
import type { StructuredLogger } from "@/observability"
import { loadSessionById, type SessionMeta, saveSessionById } from "@/session"

/**
 * Session-resume state machine — surface-AGNOSTIC.
 *
 * Relocated to `@/runner/orchestrate` (Layer-2 slice). The previous home
 * `apps/cli/resume.ts` now re-exports from here so existing CLI imports
 * (`internal.ts`, `repl.ts`, the unit tests) keep working byte-identically.
 *
 * PURE w.r.t. argv/env: every input is passed explicitly. Surface entries
 * (CLI/Web/Tauri) resolve their own `--resume` / `--new-session` flags via
 * their own argv/env/HTTP accessors and call {@link resolveResume} with
 * typed inputs.
 *
 * Slice boundary (RFC 3.1): may import `@/agent`, `@/llm`, `@/observability`,
 * `@/session`, `@/shared`. MUST NOT import from `apps/**` (enforced by
 * biome `noRestrictedImports`).
 */

/** Heuristic: does this `--resume <token>` look like a filesystem path?
 *  PATH MODE when the token contains `/` or `\`, OR ends in `.json`.
 *  Otherwise the token is treated as an opaque session id (ID MODE). */
export const isPathLikeToken = (token: string): boolean =>
  token.includes("/") || token.includes("\\") || token.endsWith(".json")

/** Inputs for {@link resolveResume} — every reachable code path is either
 *  default-OFF or behind a flag the caller resolves up front. */
export interface ResolveResumeInput {
  resume: string | undefined
  newSession: boolean
  title: string | undefined
  cwd: string
  initialSessionId: string
  slog: StructuredLogger
  /** Surface-supplied hook fired ONCE when a fresh session id is minted via
   *  `--new-session`. Lets the CLI surface emit its legacy `session: <id>` log
   *  line without coupling the runner slice to `@/shared#logger`. Absent ⇒
   *  silent (Web/Tauri may prefer structured `slog.info` only, which fires
   *  unconditionally regardless of this hook). Byte-identical default-OFF:
   *  CLI passes the hook in its shim so the log line is preserved verbatim. */
  onSessionMinted?: (id: string) => void
}

/** Resolved session-startup state. `idMeta` is `undefined` when the run is in
 *  legacy (path-mode or no-resume) mode — the auto-save branch in the surface
 *  layer uses that as the "id-mode is unreachable" sentinel. */
export interface ResumeResolution {
  history: Message[]
  sessionId: string
  idMeta: SessionMeta | undefined
  /** True iff id-mode (resumed by id OR `--new-session`). The CLI uses this
   *  to defer the `quanta ready` log until the session id is known so the
   *  log line can carry the id (legacy paths emit the log up front). */
  inIdMode: boolean
  /** Set when `--resume <id>` fails to resolve a session — caller exits 1. */
  missingIdError: string | undefined
  /** HIGH-5: set when both `--new-session` and `--resume <id>` are passed.
   *  The combination is ambiguous (which session id wins?), so the caller
   *  prints an error and exits 1 instead of silently ignoring one flag. */
  conflictError: string | undefined
}

/** HIGH-LOW: default title for `--new-session`. Compact UTC `YYYY-MM-DD HH:mm`
 *  (16 chars) is much friendlier than the prior full ISO. */
export const defaultUntitled = (now: number): string =>
  `Untitled ${new Date(now).toISOString().slice(0, 16).replace("T", " ")}`

/** B4 (jun-04) — reconcile dangling `tool_use`↔`tool_result` pairs in a
 *  transcript freshly loaded from disk BEFORE it is handed back as `history`
 *  (and thus before the agent re-sends it to the provider). A resume/fork can
 *  carry a dangling pair the live-turn closeout never sealed; re-sending it is
 *  an Anthropic/OpenAI 400. The repair logic lives in the history-sanitization
 *  slice; this is the single wiring call. Always materializes a mutable
 *  `Message[]` (the `ResumeResolution.history` field is mutable — the turn
 *  loop appends to it). */
const reconcileLoadedHistory = (messages: readonly Message[]): Message[] => {
  const reconciled = reconcileToolPairing(messages)
  return reconciled === messages ? [...messages] : (reconciled as Message[])
}

/** Resolve `--resume` / `--new-session` startup state. Extracted out of
 *  `main()` to keep that function's cognitive complexity bounded. PURE w.r.t.
 *  argv/env — all inputs are explicit, so testable in isolation if needed.
 *
 *  Behavior matrix:
 *  - no resume / no new-session  → legacy default (empty history, initialId)
 *  - `--resume <path-like>`      → V1 path-mode (loadSession + log via slog)
 *  - `--resume <id-like>`        → V2 id-mode (loadSessionById, idMeta set)
 *  - `--new-session [--title t]` → V2 id-mode (fresh id, stub saved) */
export const resolveResume = async (input: ResolveResumeInput): Promise<ResumeResolution> => {
  const { resume, newSession, title, cwd, initialSessionId, slog, onSessionMinted } = input
  // HIGH-5: `--new-session --resume <id>` previously silently ignored
  // `--new-session` because the `if (resume !== undefined)` branch returned
  // first. Reject the combination up front so the caller can exit 1 with a
  // clear message — mirrors the `missingIdError` sentinel pattern.
  if (resume !== undefined && newSession) {
    return {
      history: [],
      sessionId: initialSessionId,
      idMeta: undefined,
      inIdMode: false,
      missingIdError: undefined,
      conflictError: "cannot combine --new-session with --resume",
    }
  }
  if (resume !== undefined) {
    if (isPathLikeToken(resume)) {
      const prior = await loadSession(resume)
      if (prior !== null) {
        slog.info("state.resumed", { path: resume, messages: prior.messages.length })
        return {
          history: reconcileLoadedHistory(prior.messages),
          sessionId: prior.sessionId,
          idMeta: undefined,
          inIdMode: false,
          missingIdError: undefined,
          conflictError: undefined,
        }
      }
      return {
        history: [],
        sessionId: initialSessionId,
        idMeta: undefined,
        inIdMode: false,
        missingIdError: undefined,
        conflictError: undefined,
      }
    }
    // ID MODE: opaque session id → load via the session store.
    const saved = await loadSessionById(resume)
    if (saved === undefined) {
      return {
        history: [],
        sessionId: initialSessionId,
        idMeta: undefined,
        inIdMode: true,
        missingIdError: resume,
        conflictError: undefined,
      }
    }
    slog.info("session.id_mode.on", {
      id: saved.meta.id,
      title: saved.meta.title,
      cwd: saved.meta.cwd,
      archived: saved.meta.archived,
    })
    return {
      history: reconcileLoadedHistory(saved.messages),
      sessionId: saved.meta.id,
      idMeta: saved.meta,
      inIdMode: true,
      missingIdError: undefined,
      conflictError: undefined,
    }
  }
  if (newSession) {
    const newId = crypto.randomUUID()
    const now = Date.now()
    const idMeta: SessionMeta = {
      id: newId,
      title: title ?? defaultUntitled(now),
      cwd,
      createdAt: now,
      lastTouched: now,
      archived: false,
    }
    await saveSessionById(idMeta, { reason: "fresh", turns: 0, messages: [] })
    onSessionMinted?.(newId)
    slog.info("session.id_mode.on", {
      id: idMeta.id,
      title: idMeta.title,
      cwd: idMeta.cwd,
      archived: idMeta.archived,
    })
    return {
      history: [],
      sessionId: newId,
      idMeta,
      inIdMode: true,
      missingIdError: undefined,
      conflictError: undefined,
    }
  }
  return {
    history: [],
    sessionId: initialSessionId,
    idMeta: undefined,
    inIdMode: false,
    missingIdError: undefined,
    conflictError: undefined,
  }
}
