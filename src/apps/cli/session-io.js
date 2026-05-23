import { existsSync } from "node:fs";
import { saveSession } from "@/agent";
import { saveSessionById } from "@/session";
import { logger } from "@/shared";
/**
 * CLI session I/O — switch-into-session-cwd + per-turn save plumbing.
 *
 * Extracted from `index.ts` as part of the Phase-3 split (RFC
 * may-22-unified-agent-runtime §3): pure structural refactor with ZERO
 * behavior change. Every code path in this module is verbatim relocation;
 * no new branches, no removed branches.
 *
 * Default-OFF posture: `persistTurn` is a no-op when neither `state`
 * (path-mode `--state <p>`) nor `idMeta` (id-mode `--resume <id>` /
 * `--new-session`) is set, matching the prior inline behavior.
 */
/**
 * HIGH-4 helper: if the resumed id-mode session lives in a different cwd
 * (e.g. a fork-worktree session), chdir into it BEFORE the cwd captured by
 * `SessionDeps` is read. Exits 1 with a clear error when the directory is
 * missing on disk (worktree removed since the session was saved). Returns
 * the post-chdir cwd.
 */
export const switchToSessionCwd = (current, target, slog) => {
    if (target === current)
        return current;
    if (!existsSync(target)) {
        logger.error(`Session cwd missing: ${target}. The worktree may have been removed.`);
        process.exit(1);
    }
    process.chdir(target);
    const next = process.cwd();
    slog.info("session.cwd.switched", { from: current, to: next });
    return next;
};
/**
 * Per-turn persistence — verbatim extract of the inline save block from
 * `main()`'s `turn` closure. Two independent default-OFF persistence paths:
 *
 *   1. `--state <p>` path-mode transcript (legacy `saveSession`).
 *   2. Id-mode auto-save via `saveSessionById` when `idMeta` is set
 *      (so `quanta --resume <id>` self-persists without `--state`).
 *
 * Both fire only when their respective gate is set — no new branches.
 */
export const persistTurn = async (input) => {
    const { state, idMeta, sessionId, messages, outcome } = input;
    if (state) {
        await saveSession(state, {
            sessionId,
            messages,
            reason: outcome.reason,
            turns: outcome.turns,
        });
    }
    if (idMeta) {
        // Auto-save in id-mode: per-turn persistence so `quanta --resume <id>`
        // self-persists without the user touching `--state`. No log emitted
        // here — would be too chatty inside the REPL.
        const payload = {
            reason: outcome.reason,
            turns: outcome.turns,
            messages,
        };
        await saveSessionById(idMeta, payload);
    }
};
