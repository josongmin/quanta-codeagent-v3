import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { errMessage } from "@/shared";
import { MCPRootSchema, PLUGIN_DIR_NAME, PLUGIN_MANIFEST_FILE, PLUGIN_MCP_FILE, PLUGIN_SKILLS_DIR, PluginManifestSchema, } from "./plugin-manifest";
const MAX_DISCOVERY_DEPTH = 4;
/** Strongly-typed error so callers can branch on cause without string-match. */
export class PluginManifestError extends Error {
    name = "PluginManifestError";
    cause;
    path;
    constructor(message, cause, path) {
        super(message);
        this.cause = cause;
        this.path = path;
    }
}
const readJson = async (path) => {
    let raw;
    try {
        raw = await readFile(path, "utf8");
    }
    catch (e) {
        const code = e.code;
        if (code === "ENOENT") {
            return { ok: false, err: new PluginManifestError(`not found: ${path}`, "missing", path) };
        }
        const msg = errMessage(e);
        return { ok: false, err: new PluginManifestError(`io error at ${path}: ${msg}`, "io", path) };
    }
    try {
        return { ok: true, value: JSON.parse(raw) };
    }
    catch (e) {
        const msg = errMessage(e);
        return {
            ok: false,
            err: new PluginManifestError(`malformed JSON at ${path}: ${msg}`, "json", path),
        };
    }
};
/** Enumerate `<pluginDir>/skills/*` for `SKILL.md` files. Returns empty when
 *  the skills directory is absent — that is a legitimate state (a plugin may
 *  ship only MCP servers). Skills are returned sorted by name for
 *  deterministic test output. */
const collectSkillEntries = async (pluginDir) => {
    const skillsDir = join(pluginDir, PLUGIN_SKILLS_DIR);
    let entries;
    try {
        entries = (await readdir(skillsDir, { withFileTypes: true }));
    }
    catch (e) {
        const code = e.code;
        if (code === "ENOENT" || code === "ENOTDIR")
            return [];
        throw e;
    }
    const out = [];
    for (const ent of entries) {
        if (!ent.isDirectory() && !ent.isSymbolicLink())
            continue;
        const skillMd = join(skillsDir, ent.name, "SKILL.md");
        try {
            const st = await stat(skillMd);
            if (st.isFile())
                out.push({ name: ent.name, skillMdPath: skillMd });
        }
        catch {
            // No SKILL.md inside this dir (or it is unreadable) — not a plugin skill
            // entry. Silent skip here is intentional and documented: this enumerates
            // *plugin-shipped* skills only, so a foreign dir under skills/ is the
            // common, expected case, not an error. Logging it would be per-scan noise.
        }
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
};
/** Load + validate one plugin root. Order: manifest (required) → mcp
 *  (optional) → skills enumeration. Errors are raised as
 *  {@link PluginManifestError} so the caller can react to cause without
 *  string parsing. */
export const loadPluginManifest = async (pluginDir) => {
    const manifestPath = join(pluginDir, PLUGIN_DIR_NAME, PLUGIN_MANIFEST_FILE);
    const manifestRead = await readJson(manifestPath);
    if (!manifestRead.ok)
        throw manifestRead.err;
    const parsed = PluginManifestSchema.safeParse(manifestRead.value);
    if (!parsed.success) {
        const issues = parsed.error.issues
            .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
            .join("\n");
        throw new PluginManifestError(`manifest schema mismatch at ${manifestPath}:\n${issues}`, "schema", manifestPath);
    }
    const manifest = parsed.data;
    const mcpPath = join(pluginDir, PLUGIN_MCP_FILE);
    let mcpServers;
    const mcpRead = await readJson(mcpPath);
    if (mcpRead.ok) {
        const mcpParsed = MCPRootSchema.safeParse(mcpRead.value);
        if (!mcpParsed.success) {
            const issues = mcpParsed.error.issues
                .map((i) => `  - ${i.path.join(".") || "<root>"}: ${i.message}`)
                .join("\n");
            throw new PluginManifestError(`.mcp.json schema mismatch at ${mcpPath}:\n${issues}`, "schema", mcpPath);
        }
        mcpServers = mcpParsed.data.mcpServers;
    }
    else if (mcpRead.err.cause !== "missing") {
        // A present-but-broken `.mcp.json` is an error — we only ignore
        // genuinely-absent files. Cluster E hard rule: no swallowed errors.
        throw mcpRead.err;
    }
    const skillEntries = await collectSkillEntries(pluginDir);
    const loaded = { dir: pluginDir, manifest, skillEntries };
    if (mcpServers !== undefined)
        loaded.mcpServers = mcpServers;
    return loaded;
};
/** Recursively walk `rootDir` (capped at depth 4) collecting directories
 *  whose `.quanta-plugin/plugin.json` exists. Returns lightweight records;
 *  call {@link loadPluginManifest} on each to validate. Skips
 *  `node_modules` / `.git` / dotfile dirs other than `.quanta-plugin`
 *  itself so realistic monorepo scans terminate. */
const DISCOVERY_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build"]);
const safeReaddir = async (dir) => {
    try {
        return (await readdir(dir, { withFileTypes: true }));
    }
    catch (e) {
        const code = e.code;
        if (code === "ENOENT" || code === "ENOTDIR" || code === "EACCES")
            return null;
        throw e;
    }
};
const recordIfPluginRoot = async (dir, entries, found) => {
    if (!entries.some((e) => e.isDirectory() && e.name === PLUGIN_DIR_NAME))
        return;
    const manifestPath = join(dir, PLUGIN_DIR_NAME, PLUGIN_MANIFEST_FILE);
    try {
        const st = await stat(manifestPath);
        if (st.isFile())
            found.push({ dir, manifestPath });
    }
    catch {
        // .quanta-plugin/ exists but no plugin.json — not a plugin. Skip.
    }
};
const isDescendable = (n) => {
    if (n === PLUGIN_DIR_NAME)
        return false;
    if (DISCOVERY_SKIP_DIRS.has(n))
        return false;
    if (n.startsWith("."))
        return false;
    return true;
};
export const discoverPlugins = async (rootDir) => {
    const found = [];
    const visit = async (dir, depth) => {
        if (depth > MAX_DISCOVERY_DEPTH)
            return;
        const entries = await safeReaddir(dir);
        if (entries === null)
            return;
        await recordIfPluginRoot(dir, entries, found);
        for (const ent of entries) {
            if (!ent.isDirectory())
                continue;
            if (!isDescendable(ent.name))
                continue;
            await visit(join(dir, ent.name), depth + 1);
        }
    };
    await visit(rootDir, 0);
    found.sort((a, b) => {
        if (a.dir < b.dir)
            return -1;
        if (a.dir > b.dir)
            return 1;
        const ba = basename(a.dir);
        const bb = basename(b.dir);
        return ba < bb ? -1 : ba > bb ? 1 : 0;
    });
    return found;
};
