/**
 * Skill file byte-size guard (Tier-0 absorption #0-6a, Claude Desktop 1.7196.3
 * — "Skill file is too large. Maximum size is 30 MB.").
 *
 * Why a hard cap and not a truncate-and-load: a SKILL.md whose frontmatter
 * parses but whose body is cut mid-instruction yields a skill the agent
 * BELIEVES is enabled, with broken instructions. Fail-closed (skip + log) is
 * the honest behavior — discovery proceeds with the rest of the directory.
 *
 * The discriminated return type — `ok:true` vs `ok:false` with a `reason`
 * literal — lets callers narrow without sniffing magic sentinel sizes
 * (e.g. -1). Stat errors are bucketed separately from "too-large" so a host
 * can choose to log them differently (the latter is user-actionable; the
 * former is filesystem-level noise).
 *
 * Slice discipline: pure leaf module. Imports only `node:fs/promises`.
 */
import { stat } from "node:fs/promises";
/** Anthropic public Skills API limit (30 MB, observed in Claude Desktop
 *  1.7196.3 error copy). */
export const MAX_SKILL_SIZE_BYTES = 30 * 1024 * 1024;
/** Test whether `path` is under the skill-size cap. A missing/unreadable file
 *  is reported with `reason: "stat-failed"` and `size: 0` — the caller can
 *  then distinguish quietly skipping (stat-failed: not a skill / not present)
 *  from logging a user-visible warning (too-large). */
export const checkSkillSize = async (path) => {
    let size;
    try {
        const st = await stat(path);
        size = st.size;
    }
    catch {
        return { ok: false, reason: "stat-failed", path, size: 0 };
    }
    if (size > MAX_SKILL_SIZE_BYTES) {
        return { ok: false, reason: "too-large", path, size };
    }
    return { ok: true, size };
};
