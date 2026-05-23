import { realpathSync } from "node:fs";
import { mkdir, rename, stat, unlink } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { QuantaError, runtimeConfig } from "@/shared";
/** Raised when a tool's filesystem access escapes its `ctx.cwd` jail root.
 *  Tools MUST catch this and surface `ok:false` — it is a hard stop, never a
 *  partial read/write. Mirrors the posture of `@/runtime`'s SandboxPolicyError
 *  but stays inside the storage slice (no cross-slice import). */
export class FsJailError extends QuantaError {
    constructor(message) {
        super("fs_jail", message);
    }
}
/** The FS jail is ON by default (secure-by-default). The escape hatch
 *  `QUANTA_FS_JAIL=off` is read ONCE at startup via {@link runtimeConfig}
 *  and frozen — mid-run env mutation does not flip it. */
const jailDisabled = () => runtimeConfig().fsJailDisabled;
/** Normalize an absolute path to its canonical segment list (collapsing `.`
 *  and resolving `..` lexically). Returns the cleaned absolute path. */
const lexicalNormalize = (abs) => {
    const out = [];
    for (const seg of abs.split("/")) {
        if (seg === "" || seg === ".")
            continue;
        if (seg === "..") {
            out.pop();
            continue;
        }
        out.push(seg);
    }
    return `/${out.join("/")}`;
};
/** True iff `child` is the jail root itself or strictly inside it. Compared on
 *  segment boundaries so `/jailX` cannot pass a `/jail` root. */
const isInside = (root, child) => {
    if (child === root)
        return true;
    const prefix = root === "/" ? "/" : `${root}/`;
    return child.startsWith(prefix);
};
/** Resolve the realpath of the nearest EXISTING ancestor of `abs`, then
 *  re-append the not-yet-existing trailing segments. This makes a symlink in
 *  the existing portion unable to smuggle the final path outside the jail
 *  (the classic symlink-escape) while still supporting writes to a not-yet-
 *  created file. Falls back to the lexical path if nothing resolves
 *  (extremely unusual — `/` always exists). */
const realResolve = (abs) => {
    const segs = abs.split("/").filter(Boolean);
    for (let i = segs.length; i >= 0; i--) {
        const candidate = `/${segs.slice(0, i).join("/")}`;
        try {
            const real = realpathSync(candidate || "/");
            const tail = segs.slice(i);
            return tail.length > 0 ? lexicalNormalize(`${real}/${tail.join("/")}`) : real;
        }
        catch {
            // This ancestor does not exist (or is not resolvable) — climb up.
        }
    }
    return lexicalNormalize(abs);
};
/** Enforce the jail: resolve `requested` against `baseDir`, lexically and via
 *  realpath of the existing parent, and reject any final path that lands
 *  outside the `baseDir` root. Throws {@link FsJailError} on escape. Only
 *  invoked when a tool explicitly passes its `ctx.cwd` as `baseDir`. */
const enforceJail = (requested, baseDir, abs) => {
    if (jailDisabled())
        return abs;
    const root = realResolve(lexicalNormalize(resolve(baseDir)));
    const target = realResolve(lexicalNormalize(abs));
    if (!isInside(root, target)) {
        throw new FsJailError(`Path escapes the working-directory jail: "${requested}" resolves outside ${root}. ` +
            "Set QUANTA_FS_JAIL=off to allow cross-directory access.");
    }
    return abs;
};
/**
 * Resolve a possibly-relative path against `baseDir` (default `process.cwd()`)
 * to an absolute path. An absolute `path` is returned unchanged. Tool callers
 * pass their session `ctx.cwd`; non-tool callers keep the cwd default.
 *
 * BACK-COMPAT SEAM. Prefer {@link resolveJailed} in NEW tool code — it
 * returns a branded `JailedPath` and refuses an empty/undefined `baseDir`
 * (the prior silent-bypass bug). This `resolvePath` keeps the pre-jail
 * `baseDir`-optional surface so existing non-tool callers (state.ts, session
 * meta) work unchanged.
 *
 * FS JAIL (secure-by-default): when a tool explicitly passes a `baseDir`
 * (its `ctx.cwd`), the resolved real path is confined to that jail root.
 * No-baseDir callers keep the exact pre-jail behavior for back-compat.
 * `QUANTA_FS_JAIL=off` opts out (read once at startup via `runtimeConfig`).
 */
export const resolvePath = (path, baseDir) => {
    const abs = resolve(baseDir || process.cwd(), path);
    if (baseDir !== undefined && baseDir !== "")
        return enforceJail(path, baseDir, abs);
    return abs;
};
/**
 * The canonical "tool-supplied path → safe absolute path" constructor.
 *
 * Returns a {@link JailedPath} (branded). The brand is the only way for a
 * downstream tool (spawn/argv builder, Bun.Glob, LSP open) to receive a
 * path-typed value — the type system enforces that every spawn arg is
 * jail-validated.
 *
 * Refuses an empty or undefined `jailRoot`. The prior "baseDir is
 * `undefined`/`""` ⇒ skip the jail" code path was a silent-bypass surface:
 * a caller that forgot to thread `ctx.cwd` got the legacy un-jailed
 * behavior with no error.
 */
export const resolveJailed = (requested, jailRoot) => {
    if (typeof jailRoot !== "string" || jailRoot.length === 0) {
        throw new FsJailError("resolveJailed requires a non-empty jail root — caller must thread ctx.cwd explicitly");
    }
    const abs = resolve(jailRoot, requested);
    return enforceJail(requested, jailRoot, abs);
};
export const readFile = async (path, baseDir) => {
    const file = Bun.file(resolvePath(path, baseDir));
    if (!(await file.exists()))
        throw new Error(`File not found: ${path}`);
    return file.text();
};
export const writeFile = async (path, content, baseDir) => {
    const abs = resolvePath(path, baseDir);
    await Bun.write(abs, content);
};
export const statFile = async (path, baseDir) => {
    const abs = resolvePath(path, baseDir);
    const s = await stat(abs);
    return { path: abs, size: s.size, isDirectory: s.isDirectory() };
};
export const fileExists = async (path, baseDir) => Bun.file(resolvePath(path, baseDir)).exists();
export const parentDir = (path, baseDir) => dirname(resolvePath(path, baseDir));
/**
 * Jailed file delete. Resolves `path` through {@link resolvePath} (so an
 * explicit `baseDir` confines it to the same jail root as read/write/edit),
 * then unlinks. Added so `apply_patch` can route its delete op through the ONE
 * storage jail instead of carrying a second bespoke jail. */
export const deleteFile = async (path, baseDir) => {
    await unlink(resolvePath(path, baseDir));
};
/**
 * Jailed file rename. BOTH endpoints go through {@link resolvePath}, so an
 * explicit `baseDir` jails the source AND the destination identically to the
 * read/write/edit chokepoint — neither end can escape. Creates the
 * destination's parent directory first (mirrors {@link writeFile}'s implicit
 * `Bun.write` mkdir). */
export const renameFile = async (from, to, baseDir) => {
    const absFrom = resolvePath(from, baseDir);
    const absTo = resolvePath(to, baseDir);
    await mkdir(dirname(absTo), { recursive: true });
    await rename(absFrom, absTo);
};
/** Real `@/storage`-backed {@link FileSystemPort}. The default for every tool;
 *  using it leaves behavior byte-identical to the pre-port direct calls. */
export const defaultFileSystemPort = {
    readFile,
    writeFile,
    statFile,
    fileExists,
};
