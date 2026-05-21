import { loadSession } from "@/agent"
import type { Message } from "@/llm"
import type { StructuredLogger } from "@/observability"
import { loadSessionById, type SessionMeta, saveSessionById } from "@/session"
import { logger } from "@/shared"

/**
 * Session-resume state machine — extracted from `internal.ts` (ADR-0024 split).
 *
 * PURE w.r.t. argv/env: every input is passed explicitly (the caller resolves
 * the `--resume` / `--new-session` flags via the env/argv accessors that stay
 * in `internal.ts`), so this module never reads `process.env` and is unit-
 * testable in isolation. `internal.ts` re-exports every symbol here so existing
 * importers (`index.ts`, tests) are unaffected.
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
}

/** Resolved session-startup state. `idMeta` is `undefined` when the run is in
 *  legacy (path-mode or no-resume) mode — the auto-save branch in `index.ts`
 *  uses that as the "id-mode is unreachable" sentinel. */
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
  const { resume, newSession, title, cwd, initialSessionId, slog } = input
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
          history: prior.messages,
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
      history: saved.messages,
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
    logger.info(`session: ${newId}`)
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
