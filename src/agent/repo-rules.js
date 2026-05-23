import { existsSync } from "node:fs";
import { lstat, readFile } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
/** Files searched at each directory level, in priority order. The first
 *  present + non-empty file wins per directory. */
export const REPO_RULE_CANDIDATES = ["AGENTS.md", "CLAUDE.md", ".codex/CODEX-RULES.md"];
/** Max bytes per layer body. Bodies larger than this are truncated with a
 *  marker rather than rejected outright. Applies per-layer, not in total. */
export const MAX_BYTES = 64 * 1024;
/** Max directories the walk visits before forcibly terminating. Guards against
 *  pathological setups (very deep paths under no git repo) — real monorepos
 *  almost never nest beyond ~5 levels. */
const MAX_DEPTH = 16;
/** Load repo-local rules by walking CWD → repo root. Returns `undefined` when
 *  no layers are present anywhere along the walk. Errors other than ENOENT
 *  (e.g. permission) are swallowed per-layer; the loader continues to the
 *  next candidate / parent dir. Read ONCE per session by convention. */
export const loadRepoRules = async (cwd) => {
    const resolvedCwd = resolve(cwd);
    const collected = [];
    let dir = resolvedCwd;
    let depth = 0;
    for (let i = 0; i < MAX_DEPTH; i++) {
        const layer = await loadLayerForDir(dir, resolvedCwd, depth);
        if (layer !== undefined)
            collected.push(layer);
        // After processing the current dir, decide whether to walk up. The `.git`
        // boundary is checked AFTER the dir is processed so the repo-root layer
        // (if any) is always included.
        if (existsSync(join(dir, ".git")))
            break;
        const parent = dirname(dir);
        if (parent === dir)
            break; // filesystem root
        dir = parent;
        depth += 1;
    }
    if (collected.length === 0)
        return undefined;
    // collected is in cwd→root order (depth 0 first). For the rendered body we
    // want root→cwd so deeper layers appear LAST (LLM positional bias = deeper-
    // wins). The `layers` field exposes this same root→cwd ordering for callers
    // that want to inspect provenance.
    const ordered = [...collected].sort((a, b) => b.depth - a.depth);
    const deepest = collected[0]; // cwd-closest layer (depth ascending; pos 0 = smallest depth = closest to cwd)
    const body = ordered.length === 1 ? ordered[0].body : ordered.map(renderLayerSection).join("\n\n");
    return {
        sourcePath: deepest.sourcePath,
        entrypoint: deepest.entrypoint,
        body,
        loadedAt: Date.now(),
        layers: ordered,
    };
};
const loadLayerForDir = async (dir, resolvedCwd, depth) => {
    for (const name of REPO_RULE_CANDIDATES) {
        const sourcePath = join(dir, name);
        const body = await tryRead(sourcePath);
        if (body !== undefined && body.trim().length > 0) {
            return {
                sourcePath,
                entrypoint: name,
                body,
                relativePath: computeRelativePath(resolvedCwd, sourcePath),
                depth,
            };
        }
    }
    return undefined;
};
const computeRelativePath = (cwd, sourcePath) => {
    const rel = relative(cwd, sourcePath);
    // Normalize Windows backslashes to forward slashes for label stability —
    // the label rides into the LLM prompt and humans compare it to git paths.
    const normalized = rel.split(sep).join("/");
    if (normalized.startsWith(".."))
        return normalized;
    return `./${normalized}`;
};
const tryRead = async (path) => {
    try {
        // SECURITY: `lstat` does NOT follow symlinks. We reject symlinks entirely
        // because an attacker (or careless contributor) could symlink AGENTS.md
        // at `~/.ssh/id_rsa` (or any other secret), and the contents would then
        // ride into the LLM prompt every turn as REPO POLICY. Refusal is the only
        // safe policy: the link target has no trust relationship with the repo,
        // but the LLM would treat the rendered body as authority.
        const st = await lstat(path);
        if (st.isSymbolicLink())
            return undefined;
        if (!st.isFile())
            return undefined;
        const body = await readFile(path, "utf8");
        if (body.length > MAX_BYTES) {
            // Truncate per-layer with an explicit marker so the LLM (and human
            // auditors) can see that the rules were cut. The byte count refers to
            // the UTF-16 code units returned by `readFile("utf8")` — same unit
            // String.prototype.length reports, kept consistent for the marker.
            return `${body.slice(0, MAX_BYTES)}\n\n[truncated: ${body.length} bytes total, showing first 64 KiB]`;
        }
        return body;
    }
    catch {
        // ENOENT, EACCES, EISDIR, and any other transient/permission failure all
        // fall through silently — the loader is best-effort and the next
        // candidate (or no rules at all) is the correct outcome.
        return undefined;
    }
};
const renderLayerSection = (layer) => `### From ${layer.relativePath}\n${layer.body.trim()}`;
/** Render rules as the per-turn `<system-reminder>` section. The label cites
 *  the entrypoint so the LLM treats it as repo authority, distinct from the
 *  generic memory-hints section that lives downstream. */
export const renderRepoRulesBlock = (rules) => `## Repo-local rules (from ${rules.entrypoint})\n${rules.body.trim()}`;
