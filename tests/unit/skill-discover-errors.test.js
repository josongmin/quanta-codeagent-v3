/**
 * Skill discover error-path coverage — R-Phase3 P2-1.
 *
 * `discoverSkills(dir)` is the session-start entry point for the skill system
 * (Row 6.2). Its happy path is covered by `tests/unit/skill.test.ts`; the
 * error/edge paths were not pinned. This file closes them:
 *
 *   1. Missing directory       → [] (no throw)
 *   2. File-instead-of-dir at  → [] (readdir errors)
 *   3. Empty directory         → []
 *   4. Malformed YAML          → still produces a skill (frontmatter parser is
 *                                tolerant; the description falls back to the
 *                                first non-empty body line)
 *   5. Missing description     → first non-empty body line becomes description
 *   6. Empty body              → empty description (not a crash)
 *   7. `SKILL.md` directory form WINS over a flat `<name>.md` of the same id
 *      (deterministic collision resolution)
 *   8. Invalid `effort:` token → skill loads, effort silently dropped
 *   9. Nested vs flat order    → result sorted by name regardless
 *  10. Symlink directory       → followed if its target has SKILL.md
 *
 * Every test uses a fresh tmpdir; no real skill ever escapes the test.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills } from "@/skill";
let root;
beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "skill-discover-errors-"));
});
afterAll(async () => {
    await rm(root, { recursive: true, force: true });
});
const writeSkillFile = async (dir, body) => {
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "SKILL.md"), body);
};
describe("discoverSkills — error paths", () => {
    test("missing directory → [] (no throw)", async () => {
        const missing = join(root, "does-not-exist");
        const skills = await discoverSkills(missing);
        expect(skills).toEqual([]);
    });
    test("path is a file (not a dir) → [] (readdir errors gracefully)", async () => {
        const filePath = join(root, "is-a-file.txt");
        await writeFile(filePath, "not a directory");
        const skills = await discoverSkills(filePath);
        expect(skills).toEqual([]);
    });
    test("empty directory → []", async () => {
        const empty = await mkdtemp(join(root, "empty-"));
        const skills = await discoverSkills(empty);
        expect(skills).toEqual([]);
    });
    test("malformed YAML frontmatter → falls back gracefully, skill still loads", async () => {
        const dir = await mkdtemp(join(root, "malformed-"));
        // Frontmatter delimiters mismatched / colons missing on some lines —
        // `parseFrontmatter` is YAML-ish (not strict YAML) and skips lines it
        // can't parse rather than throwing.
        await writeSkillFile(join(dir, "bad-frontmatter"), "---\nname: bad-frontmatter\n  description\n  effort\n---\n\nThe body line that becomes description.\n");
        const skills = await discoverSkills(dir);
        expect(skills).toHaveLength(1);
        expect(skills[0]?.name).toBe("bad-frontmatter");
        expect(skills[0]?.description.length).toBeGreaterThan(0);
    });
    test("missing description → first non-empty body line becomes description", async () => {
        const dir = await mkdtemp(join(root, "no-desc-"));
        await writeSkillFile(join(dir, "no-desc"), "---\nname: no-desc\n---\n\nFirst body line becomes the description.\nMore body text after.\n");
        const skills = await discoverSkills(dir);
        expect(skills).toHaveLength(1);
        expect(skills[0]?.description).toBe("First body line becomes the description.");
    });
    test("empty body + missing description → empty string description (no crash)", async () => {
        const dir = await mkdtemp(join(root, "empty-body-"));
        await writeSkillFile(join(dir, "empty"), "---\nname: empty\n---\n");
        const skills = await discoverSkills(dir);
        expect(skills).toHaveLength(1);
        expect(skills[0]?.description).toBe("");
    });
    test("SKILL.md directory form WINS over flat <name>.md of same id", async () => {
        const dir = await mkdtemp(join(root, "collision-"));
        // Flat form first
        await writeFile(join(dir, "shared.md"), "---\nname: shared\ndescription: flat-loses\n---\n\nflat body\n");
        // Directory form second
        await writeSkillFile(join(dir, "shared"), "---\nname: shared\ndescription: nested-wins\n---\n\nnested body\n");
        const skills = await discoverSkills(dir);
        const shared = skills.find((s) => s.name === "shared");
        expect(shared).toBeDefined();
        expect(shared?.description).toBe("nested-wins");
    });
    test("invalid effort token → skill loads, effort silently dropped", async () => {
        const dir = await mkdtemp(join(root, "bad-effort-"));
        await writeSkillFile(join(dir, "bad-effort"), "---\nname: bad-effort\ndescription: e\neffort: ultrasonic\n---\nbody\n");
        const skills = await discoverSkills(dir);
        expect(skills).toHaveLength(1);
        expect(skills[0]?.effort).toBeUndefined();
    });
    test("output is sorted by name regardless of disk order", async () => {
        const dir = await mkdtemp(join(root, "sort-"));
        await writeSkillFile(join(dir, "zeta"), "---\nname: zeta\ndescription: z\n---\nb\n");
        await writeSkillFile(join(dir, "alpha"), "---\nname: alpha\ndescription: a\n---\nb\n");
        await writeSkillFile(join(dir, "middle"), "---\nname: middle\ndescription: m\n---\nb\n");
        const skills = await discoverSkills(dir);
        expect(skills.map((s) => s.name)).toEqual(["alpha", "middle", "zeta"]);
    });
    test("symlink directory whose target has SKILL.md → followed (filesystem-resolution test)", async () => {
        const realDir = await mkdtemp(join(root, "real-"));
        await writeSkillFile(join(realDir, "linked"), "---\nname: linked\ndescription: s\n---\nb\n");
        const linkDir = await mkdtemp(join(root, "link-"));
        try {
            await symlink(join(realDir, "linked"), join(linkDir, "linked-via-symlink"), "dir");
        }
        catch {
            // Some filesystems (or unprivileged Windows) cannot create dir symlinks.
            // Don't fail the test in that case — just exit the assertion early.
            return;
        }
        const skills = await discoverSkills(linkDir);
        expect(skills.some((s) => s.name === "linked")).toBe(true);
    });
    test("SKILL.md file containing zero frontmatter delimiters → loads with empty data, body-only description", async () => {
        const dir = await mkdtemp(join(root, "no-fm-"));
        // No `---` lines at all — the parser must treat the whole file as body.
        await mkdir(join(dir, "no-frontmatter"), { recursive: true });
        await writeFile(join(dir, "no-frontmatter", "SKILL.md"), "Just a plain skill body, no frontmatter at all.\n");
        const skills = await discoverSkills(dir);
        expect(skills).toHaveLength(1);
        // Name falls back to the directory name (the contract in toSkill).
        expect(skills[0]?.name).toBe("no-frontmatter");
        expect(skills[0]?.description).toContain("plain skill body");
    });
});
