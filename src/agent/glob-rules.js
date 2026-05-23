import { lstat, readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { matchesAnyGlob, parseFrontmatter } from "../skill";
/**
 * File-scoped rule auto-injection (Cursor `.cursor/rules/*.mdc` parity — the
 * glob-matched + always-applied rule types).
 *
 * Cursor advertises four rule kinds: always-applied, glob-matched,
 * agent-requestable (lazy body), and manual (@-mention). This module implements
 * the two that AUTO-INJECT into the prompt without the model asking:
 *
 *   - `alwaysApply: true`  → body rides every turn (repo authority, file-agnostic)
 *   - `globs: [...]`       → body rides ONLY on turns whose `changedPaths`
 *                            include a file matching one of the globs.
 *
 * (agent-requestable / manual are out of scope here: the former is the existing
 * `Skill` progressive-disclosure path; the latter is a user-mention surface.)
 *
 * Distinct from `repo-rules.ts`: that loader ingests ONE top-level operational
 * contract (AGENTS.md/CLAUDE.md) whole, every turn. THIS loader ingests MANY
 * small file-scoped rules and selects per turn by the files in play — so a
 * "React component conventions" rule only burns prompt budget on turns that
 * actually touch `*.tsx`.
 *
 * Opt-in: the loop only consults `config.globRules` when a caller wires it
 * (typically via `loadGlobRules(cwd)` at session start + a per-turn
 * `changedPaths`). Absent ⇒ no block, byte-identical (RFC §1.2 default-OFF).
 */
/** Directories scanned for rule files, in priority order. `.cursor/rules` is
 *  the Cursor convention; `.quanta/rules` is the native path. Both are scanned;
 *  a rule's source basename is cited in the rendered block so the model can
 *  attribute authority. */
export const GLOB_RULE_DIRS = [".cursor/rules", ".quanta/rules"];
/** Rule file extensions recognised (`.mdc` is Cursor's; `.md` is native). */
const RULE_EXTENSIONS = [".mdc", ".md"];
/** Per-rule body cap. A runaway rule file is truncated with a marker rather
 *  than rejected — usability over a hard fail, but it cannot blow the budget. */
export const MAX_RULE_BYTES = 16 * 1024;
/** Cap on the TOTAL bytes the rendered glob-rules block contributes to the
 *  per-turn prompt. Without this, a malicious repo with N×`alwaysApply: true`
 *  rule files would inject N × MAX_RULE_BYTES every turn, blowing the prompt
 *  budget (and the provider's token limit). Matches the 64 KiB cap repo-rules
 *  uses for its single-file body — same scale, same per-turn budget posture.
 *  When the cap is hit, later rules are dropped with an explicit marker so
 *  the model (and auditor) can see the truncation. */
export const MAX_RENDER_BYTES = 64 * 1024;
/** Cap on the NUMBER of rule files loaded from disk. The render-bytes cap above
 *  bounds total output size, but `selectGlobRules` still does N rules × K paths
 *  matchesAnyGlob calls every turn. The audit measured a 10000-rule directory
 *  causing ~56s `selectGlobRules` per turn when globs no-match-exhaust — the
 *  render cap is useless if the loop freezes before reaching the renderer. 256
 *  covers any realistic repo (a real `.cursor/rules` directory ships at most a
 *  few dozen files); above that, additional files are silently dropped so a
 *  hostile repo (or a misconfigured one) can't pin CPU per turn. */
export const MAX_RULE_FILES = 256;
/** Normalize a frontmatter `globs` value (string | string[] | absent) to a
 *  trimmed, non-empty string[]. A bare string is comma-split (Cursor's `.mdc`
 *  writes `globs: *.ts,*.tsx`); an array is taken as-is. */
const normalizeGlobs = (raw) => {
    if (raw === undefined)
        return [];
    const parts = Array.isArray(raw) ? raw : raw.split(",");
    return parts.map((p) => p.trim()).filter((p) => p.length > 0);
};
/** Parse one rule file into a {@link GlobRule}, or `undefined` when it is a
 *  symlink, not a regular file, unreadable, has an empty body, or declares
 *  neither `globs` nor `alwaysApply` (a rule that can never inject is dropped
 *  so it doesn't masquerade as active). */
const tryLoadRule = async (path) => {
    try {
        // SECURITY: reject symlinks for the same reason repo-rules.ts does — a
        // symlinked rule file could point at a secret (`~/.ssh/id_rsa`) and its
        // contents would ride into the prompt as authority. `lstat` does not follow.
        const st = await lstat(path);
        if (st.isSymbolicLink() || !st.isFile())
            return undefined;
        const raw = await readFile(path, "utf8");
        const { data, body } = parseFrontmatter(raw);
        const trimmed = body.trim();
        if (trimmed.length === 0)
            return undefined;
        const globs = normalizeGlobs(data.globs);
        // `parseFrontmatter` yields string scalars, so a YAML `true` arrives as the
        // string "true" (case-insensitive tolerance for hand-written rule files).
        const alwaysApply = typeof data.alwaysApply === "string" && data.alwaysApply.toLowerCase() === "true";
        // A rule with neither globs nor alwaysApply can never auto-inject — drop it.
        if (globs.length === 0 && !alwaysApply)
            return undefined;
        const cappedBody = trimmed.length > MAX_RULE_BYTES
            ? `${trimmed.slice(0, MAX_RULE_BYTES)}\n\n[truncated: ${trimmed.length} bytes total]`
            : trimmed;
        // YAML fold-scalar guard: the dependency-free parser does not implement
        // `>` / `|` folding — a YAML-shaped multiline description like
        //   description: >
        //     line one
        //     line two
        // arrives with `description === ">"` (just the indicator) and the
        // continuation lines silently dropped. Treat a bare fold-indicator as
        // absent rather than rendering the literal `>` as authority surface.
        const rawDesc = typeof data.description === "string" ? data.description.trim() : "";
        const description = rawDesc.length > 0 && rawDesc !== ">" && rawDesc !== "|" ? rawDesc : undefined;
        return {
            sourcePath: path,
            ...(description !== undefined ? { description } : {}),
            globs,
            alwaysApply,
            body: cappedBody,
        };
    }
    catch {
        // ENOENT / EACCES / parse failure ⇒ skip this file (best-effort loader).
        return undefined;
    }
};
/** Load every file-scoped rule under `cwd`'s rule directories. Returns `[]`
 *  when no rule directory exists or none parse — the byte-identical no-op.
 *  Files are loaded in a deterministic order (dir priority, then sorted name)
 *  so the rendered block is stable across runs. Stops after {@link
 *  MAX_RULE_FILES} successfully-loaded rules — the per-turn `selectGlobRules`
 *  cost is O(N rules × K paths) and an unbounded N is the DoS-via-rule-count
 *  vector the audit measured (10k rules ⇒ ~56s/turn). Read ONCE per session
 *  by convention (the loop snapshots the result; selection is per-turn). */
export const loadGlobRules = async (cwd) => {
    const rules = [];
    for (const dir of GLOB_RULE_DIRS) {
        if (rules.length >= MAX_RULE_FILES)
            break;
        const abs = join(cwd, dir);
        let names;
        try {
            names = await readdir(abs);
        }
        catch {
            continue; // directory absent ⇒ skip
        }
        for (const name of [...names].sort()) {
            if (rules.length >= MAX_RULE_FILES)
                break;
            if (!RULE_EXTENSIONS.some((ext) => name.endsWith(ext)))
                continue;
            const rule = await tryLoadRule(join(abs, name));
            if (rule)
                rules.push(rule);
        }
    }
    return rules;
};
/**
 * Select the rules that apply THIS turn: every `alwaysApply` rule (regardless
 * of `changedPaths`), plus every glob rule with a glob matching any changed
 * path. Pure — the loop computes `changedPaths` and calls this each turn.
 * `changedPaths` paths are matched with the same gitignore-ish semantics the
 * skill `paths:` filter uses (basename-anywhere when the glob has no `/`).
 */
export const selectGlobRules = (rules, changedPaths) => rules.filter((r) => r.alwaysApply || changedPaths.some((p) => r.globs.length > 0 && matchesAnyGlob(p, r.globs)));
/** Render selected rules as the per-turn `<system-reminder>` section. Returns
 *  `undefined` when the selection is empty (nothing to inject). Each rule cites
 *  its source basename + scope so the model treats it as file-scoped repo
 *  authority.
 *
 *  Budget: rules are emitted in order until cumulative bytes would exceed
 *  {@link MAX_RENDER_BYTES}; remaining rules are dropped with an explicit
 *  truncation marker so the model (and an auditor) can see what was cut. This
 *  is the DoS guard against a repo planting many `alwaysApply: true` files. */
export const renderGlobRulesBlock = (rules) => {
    if (rules.length === 0)
        return undefined;
    const sections = [];
    let used = 0;
    let droppedAt = -1;
    for (let i = 0; i < rules.length; i++) {
        const r = rules[i];
        const scope = r.alwaysApply ? "always" : `globs: ${r.globs.join(", ")}`;
        const name = basename(r.sourcePath);
        const desc = r.description !== undefined ? ` — ${r.description}` : "";
        const section = `### ${name} (${scope})${desc}\n${r.body}`;
        // +2 accounts for the `\n\n` joiner between sections (over-counts on the
        // last section but that just makes the cap slightly stricter — safe).
        if (used + section.length + 2 > MAX_RENDER_BYTES) {
            droppedAt = i;
            break;
        }
        sections.push(section);
        used += section.length + 2;
    }
    const truncation = droppedAt >= 0
        ? `\n\n[truncated: ${rules.length - droppedAt} more rule(s) dropped; cumulative body exceeded ${MAX_RENDER_BYTES} bytes]`
        : "";
    return `## File-scoped rules\nThese rules apply to files in scope this turn; treat them as repo authority.\n\n${sections.join("\n\n")}${truncation}`;
};
