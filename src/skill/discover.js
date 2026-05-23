import { readdir, readFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { errMessage } from "@/shared";
import { parseFrontmatter } from "./frontmatter";
import { checkSkillSize } from "./skill-size";
/** Coerce a frontmatter value to a string[] (single scalar → one-element list). */
const asList = (v) => {
    if (v === undefined)
        return undefined;
    if (Array.isArray(v))
        return v.length > 0 ? v : undefined;
    return v.trim() === "" ? undefined : [v.trim()];
};
/** Parse an effort frontmatter value: numeric string → number, else the token. */
const asEffort = (v) => {
    if (typeof v !== "string" || v.trim() === "")
        return undefined;
    const t = v.trim();
    if (/^\d+$/.test(t))
        return Number(t);
    if (t === "low" || t === "medium" || t === "high" || t === "max")
        return t;
    return undefined;
};
const asScalar = (v) => typeof v === "string" && v.trim() !== "" ? v.trim() : undefined;
/** Build a {@link Skill} from a file's raw contents. */
const toSkill = (name, sourcePath, raw) => {
    const { data, body } = parseFrontmatter(raw);
    const description = asScalar(data.description) ??
        body
            .split("\n")
            .find((l) => l.trim() !== "")
            ?.trim() ??
        "";
    const skill = {
        name: asScalar(data.name) ?? name,
        description,
        body,
        sourcePath,
    };
    const tools = asList(data.tools);
    if (tools)
        skill.tools = tools;
    const model = asScalar(data.model);
    if (model)
        skill.model = model;
    const effort = asEffort(data.effort);
    if (effort !== undefined)
        skill.effort = effort;
    const paths = asList(data.paths);
    if (paths)
        skill.paths = paths;
    return skill;
};
/**
 * Scan `<dir>` for skills. Recognises both layouts CC supports:
 *   - `<dir>/<skill-name>/SKILL.md`  (skill id = directory name)
 *   - `<dir>/<skill-name>.md`        (legacy command; skill id = file stem)
 *
 * Frontmatter `name:` overrides the derived id. A missing/empty dir yields [].
 * Skills are returned sorted by name for deterministic output; on a name
 * collision the directory-form (SKILL.md) wins over the flat *.md form.
 */
/** Skip + log when a candidate file exceeds the 30 MB skill cap. Stat-failed
 *  outcomes are silent — a missing file is the normal "not a skill" case.
 *  `@/skill` is a leaf slice (no `@/observability` import allowed by Biome
 *  boundaries) so `console.warn` is the only sanctioned sink here. */
const tooLargeWarning = (path, size) => {
    // biome-ignore lint/suspicious/noConsole: leaf slice cannot import a structured logger
    console.warn(`[skill] skipped ${path}: ${size} bytes exceeds the 30 MB cap`);
};
/** Warn when a candidate file passed the size check (so it exists & is in
 *  range) yet the subsequent read failed — a genuine permissions / transient
 *  IO error rather than the normal "no SKILL.md, not a skill" case. Discovery
 *  still continues past the entry; this only makes the swallow observable.
 *  Same leaf-slice constraint as {@link tooLargeWarning}: `console.warn` is the
 *  only sanctioned sink. */
const unreadableWarning = (path, reason) => {
    // biome-ignore lint/suspicious/noConsole: leaf slice cannot import a structured logger
    console.warn(`[skill] skipped ${path}: unreadable (${reason})`);
};
/** Read the directory-form skill (`<dir>/<name>/SKILL.md`), or null if absent. */
const readNestedSkill = async (dir, name) => {
    const skillFile = join(dir, name, "SKILL.md");
    const sized = await checkSkillSize(skillFile);
    if (!sized.ok) {
        if (sized.reason === "too-large")
            tooLargeWarning(sized.path, sized.size);
        return null;
    }
    try {
        const raw = await readFile(skillFile, "utf8");
        return toSkill(name, skillFile, raw);
    }
    catch (e) {
        // `checkSkillSize` already stat-confirmed the file exists & is in range, so
        // reaching here means the read itself failed (permissions / transient IO),
        // NOT the normal "no SKILL.md, not a skill dir" case. Make it observable
        // then continue discovery past this entry.
        unreadableWarning(skillFile, errMessage(e));
        return null;
    }
};
/** Read a flat command file (`<dir>/<name>.md`), or null if not a skill / unreadable. */
const readFlatSkill = async (dir, fileName) => {
    const id = basename(fileName, ".md");
    if (id.toLowerCase() === "skill")
        return null; // SKILL.md handled via dir form
    const file = join(dir, fileName);
    const sized = await checkSkillSize(file);
    if (!sized.ok) {
        if (sized.reason === "too-large")
            tooLargeWarning(sized.path, sized.size);
        return null;
    }
    try {
        const raw = await readFile(file, "utf8");
        return toSkill(id, file, raw);
    }
    catch (e) {
        // `checkSkillSize` already stat-confirmed the file; a failure here is a
        // genuine read error (permissions / transient IO), not "not a skill".
        // Make it observable then continue discovery past this entry.
        unreadableWarning(file, errMessage(e));
        return null;
    }
};
/** Classify one directory entry, reading its skill if applicable. */
const readEntrySkill = async (dir, ent) => {
    if (ent.isDirectory() || ent.isSymbolicLink()) {
        const skill = await readNestedSkill(dir, ent.name);
        return skill ? { form: "nested", skill } : null;
    }
    if (ent.isFile() && ent.name.toLowerCase().endsWith(".md")) {
        const skill = await readFlatSkill(dir, ent.name);
        return skill ? { form: "flat", skill } : null;
    }
    return null;
};
export const discoverSkills = async (dir) => {
    let entries;
    try {
        entries = await readdir(dir, { withFileTypes: true });
    }
    catch {
        // Missing/unreadable skills root is the normal "user has no skills here"
        // case (fired for every absent search path at session start). Logging it
        // would be per-startup noise, so we stay silent by design and yield [].
        return [];
    }
    // Two passes so SKILL.md (directory form) deterministically wins collisions.
    const flat = [];
    const nested = [];
    for (const ent of entries) {
        const got = await readEntrySkill(dir, ent);
        if (!got)
            continue;
        if (got.form === "nested")
            nested.push(got.skill);
        else
            flat.push(got.skill);
    }
    const byName = new Map();
    for (const s of flat)
        byName.set(s.name, s);
    for (const s of nested)
        byName.set(s.name, s); // nested overrides flat
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};
