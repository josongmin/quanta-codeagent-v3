/**
 * SKILL.md fixture integration test (Cluster E / F14, ADR-0040).
 *
 * 5 fixture SKILL.md files exercising both kinds (skill + extension) and
 * edge cases. Fixtures are written to a tmpdir and re-read through
 * `parseSkillMarkdown` so the test exercises the full file path.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseSkillMarkdown } from "../../src/skill/skill-frontmatter";
import { classify } from "../../src/skill/skill-vs-extension";
const FIXTURES = [
    {
        file: "skill-userinvocable.md",
        expect: "ok",
        body: [
            "---",
            "name: greeter",
            "description: Greets the user politely.",
            "userInvocable: true",
            'allowedTools: ["Read", "Bash"]',
            "category: skill",
            "stability: stable",
            "---",
            "",
            "# Greeter",
            "",
            "Hello, world.",
            "",
        ].join("\n"),
    },
    {
        file: "skill-llmonly.md",
        expect: "ok",
        body: [
            "---",
            "name: silent-skill",
            "description: LLM auto-trigger only; no slash command.",
            "userInvocable: false",
            "allowedTools: []",
            "category: skill",
            "stability: experimental",
            "---",
            "",
            "Body.",
            "",
        ].join("\n"),
    },
    {
        file: "extension.md",
        expect: "ok",
        body: [
            "---",
            "name: noop-extension",
            "description: System extension, never user-invokable.",
            "userInvocable: false",
            "allowedTools: []",
            "category: extension",
            "stability: stable",
            "---",
            "Extension body.",
            "",
        ].join("\n"),
    },
    {
        file: "deprecated.md",
        expect: "ok",
        body: [
            "---",
            "name: legacy",
            "description: Kept for back-compat only.",
            "userInvocable: false",
            'allowedTools: ["Read"]',
            "category: skill",
            "stability: deprecated",
            "---",
            "",
            "Use the new skill instead.",
            "",
        ].join("\n"),
    },
    {
        file: "broken-stability.md",
        expect: "fail",
        body: [
            "---",
            "name: oops",
            "description: invalid stability",
            "userInvocable: false",
            "allowedTools: []",
            "category: skill",
            "stability: alpha",
            "---",
        ].join("\n"),
    },
];
let DIR = "";
beforeAll(async () => {
    DIR = await mkdtemp(join(tmpdir(), "qcav3-skillmd-"));
    await mkdir(DIR, { recursive: true });
    for (const f of FIXTURES) {
        await writeFile(join(DIR, f.file), f.body, "utf8");
    }
});
afterAll(async () => {
    if (DIR)
        await rm(DIR, { recursive: true, force: true });
});
describe("SKILL.md fixtures", () => {
    test("each fixture round-trips through the parser as expected", async () => {
        for (const f of FIXTURES) {
            const raw = await readFile(join(DIR, f.file), "utf8");
            const r = parseSkillMarkdown(raw);
            if (f.expect === "ok") {
                expect(r.ok).toBe(true);
            }
            else {
                expect(r.ok).toBe(false);
            }
        }
    });
    test("classification matches category for each successful fixture", async () => {
        for (const f of FIXTURES) {
            if (f.expect !== "ok")
                continue;
            const raw = await readFile(join(DIR, f.file), "utf8");
            const r = parseSkillMarkdown(raw);
            expect(r.ok).toBe(true);
            if (!r.ok)
                continue;
            const c = classify(r.value.frontmatter);
            if (r.value.frontmatter.category === "skill") {
                expect(c.kind).toBe("skill");
            }
            else {
                expect(c.kind).toBe("extension");
            }
        }
    });
    test("body text is preserved for the user-invocable fixture", async () => {
        const raw = await readFile(join(DIR, "skill-userinvocable.md"), "utf8");
        const r = parseSkillMarkdown(raw);
        expect(r.ok).toBe(true);
        if (r.ok) {
            expect(r.value.body).toContain("# Greeter");
            expect(r.value.body).toContain("Hello, world.");
        }
    });
});
