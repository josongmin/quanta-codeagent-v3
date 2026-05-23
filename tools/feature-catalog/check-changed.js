/** Files we never require to be in fc: tests, barrels, type-only modules,
 *  workspaces directory leftovers. */
const EXEMPT_PATTERNS = [
    /\.test\.ts$/,
    /\.spec\.ts$/,
    /\.d\.ts$/,
    /\/index\.ts$/,
    /^tests\//,
    /^\.claude\/worktrees\//,
    /^scripts\//,
    /^docs\//,
    /^tools\/feature-catalog\//,
];
/** True ⇒ this src file is exempt from the "must be in fc" rule. */
export function isExemptFromFc(path) {
    if (!path.endsWith(".ts"))
        return true;
    return EXEMPT_PATTERNS.some((re) => re.test(path));
}
export function runCheckChanged(diff, features) {
    const referenced = new Set();
    for (const { feature } of features) {
        for (const p of feature.evidence.code)
            referenced.add(p);
    }
    const addedUntracked = [];
    const modifiedUntracked = [];
    for (const f of diff) {
        if (isExemptFromFc(f.path))
            continue;
        if (referenced.has(f.path))
            continue;
        if (f.status === "A")
            addedUntracked.push(f.path);
        else if (f.status === "M")
            modifiedUntracked.push(f.path);
    }
    return {
        ok: addedUntracked.length === 0,
        addedUntracked,
        modifiedUntracked,
    };
}
/** Parse `git diff --name-status` output into structured records. The output
 *  format is `<status>\t<path>` per line (rename is `R<n>\t<from>\t<to>`). */
export function parseDiffNameStatus(stdout) {
    const out = [];
    for (const line of stdout.split("\n")) {
        if (line.trim() === "")
            continue;
        const parts = line.split("\t");
        const code = parts[0]?.[0];
        if (code !== "A" && code !== "M" && code !== "D" && code !== "R" && code !== "C")
            continue;
        // For renames/copies the destination is the second path field.
        const path = code === "R" || code === "C" ? parts[2] : parts[1];
        if (path === undefined)
            continue;
        out.push({ path, status: code });
    }
    return out;
}
