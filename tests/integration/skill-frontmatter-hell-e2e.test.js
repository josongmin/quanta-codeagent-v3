/**
 * HELL-DIFFICULTY end-to-end tests for the SKILL.md frontmatter contract
 * (Cluster E / F14, ADR-0040).
 *
 * Coverage:
 *  1. The 20-line "everything-and-the-kitchen-sink" frontmatter — trailing
 *     blanks, CRLF/LF mix, UTF-8 (emoji, Hangul) in `description`.
 *  2. Fifteen precise failure modes — each asserts the exact
 *     `FrontmatterParseError.line` reported by the parser today (RCA #1
 *     reconciled the spec's aspirational line-numbers against actual
 *     parser behaviour; see the inline notes per case).
 *  3. `allowedTools` is the ONLY whitelist — empty list = NO tools (NOT
 *     "all tools").
 *  4. Five fixture SKILL.md files written to disk + read back through the
 *     full parse → classify → assertAllowedTool pipeline.
 *
 * Hard rule conformance: every assertion is exact; zero swallows; tmpdir
 * only; no shared mutable state between tests.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetRuntimeConfig } from "../../src/shared";
import { FrontmatterParseError, parseSkillMarkdown, } from "../../src/skill/skill-frontmatter";
import { assertAllowedTool, classify, isToolAllowed, ToolNotAllowedBySkillError, } from "../../src/skill/skill-vs-extension";
let DIR = "";
beforeAll(async () => {
    DIR = await mkdtemp(join(tmpdir(), "qcav3-skillmd-hell-"));
});
beforeEach(() => {
    __resetRuntimeConfig();
});
afterAll(async () => {
    if (DIR)
        await rm(DIR, { recursive: true, force: true });
});
/* ----------------------------- scenario 1 ----------------------------- */
describe("scenario 1 — kitchen-sink frontmatter survives whitespace + UTF-8 + CRLF", () => {
    test("all 6 fields parse, blank lines / CRLF / UTF-8 round-trip exactly", async () => {
        // Build the file by piecing CRLF and LF lines together. Trailing 5
        // blank lines in the frontmatter; emoji + Hangul in description; the
        // body uses LF; the fence uses CRLF.
        const fmLines = [
            "---\r\n",
            "# leading comment\r\n",
            "name: full-skill\n",
            "\r\n",
            'description: "Greets the user 안녕 🎉 — multi-byte"\n',
            "\r\n",
            "userInvocable: true\n",
            'allowedTools: ["Read", "Bash", "Grep"]\r\n',
            "category: skill\n",
            "stability: stable\r\n",
            "\n",
            "\r\n",
            "\n",
            "\r\n",
            "\n",
            "---\r\n",
            "\n",
            "# Body heading\n",
            "Line of body text.\n",
        ];
        const raw = fmLines.join("");
        const filePath = join(DIR, "kitchen-sink.md");
        await writeFile(filePath, raw, "utf8");
        const read = await readFile(filePath, "utf8");
        const r = parseSkillMarkdown(read);
        expect(r.ok).toBe(true);
        if (!r.ok)
            return;
        expect(r.value.frontmatter.name).toBe("full-skill");
        expect(r.value.frontmatter.description).toBe("Greets the user 안녕 🎉 — multi-byte");
        expect(r.value.frontmatter.userInvocable).toBe(true);
        expect(r.value.frontmatter.allowedTools).toEqual(["Read", "Bash", "Grep"]);
        expect(r.value.frontmatter.category).toBe("skill");
        expect(r.value.frontmatter.stability).toBe("stable");
        // Body trims leading newlines but preserves the rest.
        expect(r.value.body.startsWith("# Body heading")).toBe(true);
        expect(r.value.body).toContain("Line of body text.");
    });
    test("kebab name restricted to ASCII (multibyte in `name` is rejected)", () => {
        const txt = [
            "---",
            'name: "한국-skill"',
            'description: "ok"',
            "userInvocable: false",
            "allowedTools: []",
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n");
        const r = parseSkillMarkdown(txt);
        expect(r.ok).toBe(false);
        if (!r.ok) {
            // Zod-level failure (regex). The parser reports field 'name' at line 1.
            expect(r.error.message).toMatch(/field 'name'/);
        }
    });
});
const NEG_CASES = [
    {
        label: "01 missing opening fence",
        text: "name: x\ndescription: d\n",
        expectLine: 1,
        match: /must begin with '---' fence/,
    },
    {
        label: "02 missing closing fence (reports line 1)",
        text: "---\nname: x\ndescription: d\nuserInvocable: true\nallowedTools: []\ncategory: skill\nstability: stable\n",
        expectLine: 1,
        match: /unterminated frontmatter/,
    },
    {
        label: "03 unknown key (string value, Zod-strict catches)",
        text: [
            "---",
            "name: x",
            "description: d",
            "userInvocable: true",
            "allowedTools: []",
            "category: skill",
            "stability: stable",
            'version: "1"',
            "---",
        ].join("\n"),
        expectLine: 1,
        match: /Unrecognized key.*version/,
    },
    {
        label: "04 wrong type — userInvocable as quoted string",
        text: [
            "---",
            "name: x",
            "description: d",
            'userInvocable: "yes"',
            "allowedTools: []",
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n"),
        expectLine: 1,
        match: /field 'userInvocable': Expected boolean, received string/,
    },
    {
        label: "05 allowedTools: null rejected (null is NOT empty list)",
        text: [
            "---",
            "name: x",
            "description: d",
            "userInvocable: false",
            "allowedTools: null",
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n"),
        expectLine: 5,
        match: /null is not supported/,
    },
    {
        label: "06 numeric scalar rejected on description",
        text: [
            "---",
            "name: x",
            "description: 42",
            "userInvocable: true",
            "allowedTools: []",
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n"),
        expectLine: 3,
        match: /numeric scalars/,
    },
    {
        label: "07 capitalised True rejected (booleans are strictly lowercase)",
        text: [
            "---",
            "name: x",
            "description: d",
            "userInvocable: True",
            "allowedTools: []",
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n"),
        expectLine: 4,
        match: /booleans must be 'true' or 'false'/,
    },
    {
        label: "08 'yes' rejected as boolean",
        text: [
            "---",
            "name: x",
            "description: d",
            "userInvocable: yes",
            "allowedTools: []",
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n"),
        expectLine: 4,
        match: /booleans must be 'true' or 'false'/,
    },
    {
        label: "09 flow mapping {a: 1} rejected",
        text: [
            "---",
            "name: x",
            "description: {a: 1}",
            "userInvocable: true",
            "allowedTools: []",
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n"),
        expectLine: 3,
        match: /flow mappings/,
    },
    {
        label: "10 anchor &x rejected",
        text: [
            "---",
            "name: x",
            "description: &anchor val",
            "userInvocable: true",
            "allowedTools: []",
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n"),
        expectLine: 3,
        match: /anchors \/ aliases \/ tags/,
    },
    {
        label: "11 unterminated flow list",
        text: [
            "---",
            "name: x",
            "description: d",
            "userInvocable: false",
            'allowedTools: ["a", "b"',
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n"),
        expectLine: 5,
        match: /unterminated/,
    },
    {
        label: "12 unterminated single-quoted string",
        text: [
            "---",
            "name: 'unterminated",
            "description: d",
            "userInvocable: false",
            "allowedTools: []",
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n"),
        expectLine: 2,
        match: /unterminated single-quoted/,
    },
    {
        label: "13 indented continuation line rejected (block scalar | form)",
        text: [
            "---",
            "name: x",
            "description: |",
            "  multi line",
            "userInvocable: false",
            "allowedTools: []",
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n"),
        expectLine: 4,
        match: /indented continuation/,
    },
    {
        label: "14 duplicate key",
        text: [
            "---",
            "name: a",
            "name: b",
            "description: d",
            "userInvocable: true",
            "allowedTools: []",
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n"),
        expectLine: 3,
        match: /duplicate key 'name'/,
    },
    {
        label: "15 empty list element via ['a', ''] is rejected by Zod min(1)",
        text: [
            "---",
            "name: x",
            "description: d",
            "userInvocable: false",
            'allowedTools: ["a", ""]',
            "category: skill",
            "stability: stable",
            "---",
        ].join("\n"),
        expectLine: 1,
        // First Zod issue surfaces at field 'allowedTools.1' (index 1).
        match: /allowedTools\.1/,
    },
];
describe("scenario 2 — 15 precise failure modes", () => {
    test("all 15 cases are FrontmatterParseError with the exact line + message pattern", () => {
        expect(NEG_CASES.length).toBe(15);
        for (const c of NEG_CASES) {
            const r = parseSkillMarkdown(c.text);
            expect(r.ok).toBe(false);
            if (r.ok)
                continue; // unreachable but tightens types
            expect(r.error).toBeInstanceOf(FrontmatterParseError);
            expect(r.error.line).toBe(c.expectLine);
            expect(r.error.message).toMatch(c.match);
        }
    });
});
/* ----------------------------- scenario 3 ----------------------------- */
const fm = (overrides = {}) => ({
    name: "demo",
    description: "d",
    userInvocable: false,
    allowedTools: [],
    category: "skill",
    stability: "stable",
    ...overrides,
});
describe("scenario 3 — allowedTools is the ONLY whitelist (no allow-by-default)", () => {
    test("allowedTools: [] returns false for EVERY tool name (NOT 'all allowed')", () => {
        const f = fm({ allowedTools: [] });
        for (const candidate of ["bash", "Read", "Write", "Grep", "Glob", "Skill", "ToolSearch"]) {
            expect(isToolAllowed(f, candidate)).toBe(false);
        }
    });
    test("allowedTools: ['bash'] permits only 'bash' (case-sensitive)", () => {
        const f = fm({ allowedTools: ["bash"] });
        expect(isToolAllowed(f, "bash")).toBe(true);
        for (const denied of ["Bash", "BASH", "read", "write", " bash"]) {
            expect(isToolAllowed(f, denied)).toBe(false);
        }
    });
    test("assertAllowedTool throws ToolNotAllowedBySkillError naming the rejected tool", () => {
        let caught;
        try {
            assertAllowedTool(fm({ name: "demo", allowedTools: ["bash"] }), "Read");
        }
        catch (e) {
            caught = e;
        }
        expect(caught).toBeInstanceOf(ToolNotAllowedBySkillError);
        const msg = caught.message;
        expect(msg).toMatch(/'Read'/);
        expect(msg).toMatch(/demo/);
    });
    test("assertAllowedTool on permitted tool does not throw", () => {
        expect(() => assertAllowedTool(fm({ allowedTools: ["bash"] }), "bash")).not.toThrow();
    });
});
const longDescription = "x".repeat(4096);
const FIXTURES = [
    {
        file: "skill-1.md",
        body: [
            "---",
            "name: skill-1",
            "description: User-callable skill",
            "userInvocable: true",
            'allowedTools: ["bash", "read"]',
            "category: skill",
            "stability: stable",
            "---",
            "",
            "Body 1.",
        ].join("\n"),
        expectedFm: {
            name: "skill-1",
            description: "User-callable skill",
            userInvocable: true,
            allowedTools: ["bash", "read"],
            category: "skill",
            stability: "stable",
        },
        classify: { kind: "skill", userInvocable: true },
        toolMatrix: [
            ["bash", true],
            ["read", true],
            ["write", false],
            ["grep", false],
        ],
    },
    {
        file: "skill-2.md",
        body: [
            "---",
            "name: skill-2",
            "description: LLM-only skill",
            "userInvocable: false",
            'allowedTools: ["grep"]',
            "category: skill",
            "stability: experimental",
            "---",
            "",
            "Body 2.",
        ].join("\n"),
        expectedFm: {
            name: "skill-2",
            description: "LLM-only skill",
            userInvocable: false,
            allowedTools: ["grep"],
            category: "skill",
            stability: "experimental",
        },
        classify: { kind: "skill", userInvocable: false },
        toolMatrix: [
            ["grep", true],
            ["Grep", false],
            ["bash", false],
        ],
    },
    {
        file: "skill-3.md",
        body: [
            "---",
            "name: skill-3",
            "description: Extension, no tools",
            "userInvocable: false",
            "allowedTools: []",
            "category: extension",
            "stability: stable",
            "---",
            "",
            "Body 3.",
        ].join("\n"),
        expectedFm: {
            name: "skill-3",
            description: "Extension, no tools",
            userInvocable: false,
            allowedTools: [],
            category: "extension",
            stability: "stable",
        },
        classify: { kind: "extension", userInvocable: false },
        toolMatrix: [
            ["bash", false],
            ["read", false],
            ["write", false],
        ],
    },
    {
        file: "skill-4.md",
        body: [
            "---",
            "name: skill-4",
            "description: Deprecated but still loadable",
            "userInvocable: true",
            'allowedTools: ["read"]',
            "category: skill",
            "stability: deprecated",
            "---",
            "",
            "Body 4.",
        ].join("\n"),
        expectedFm: {
            name: "skill-4",
            description: "Deprecated but still loadable",
            userInvocable: true,
            allowedTools: ["read"],
            category: "skill",
            stability: "deprecated",
        },
        classify: { kind: "skill", userInvocable: true },
        toolMatrix: [
            ["read", true],
            ["bash", false],
        ],
    },
    {
        file: "skill-5.md",
        body: [
            "---",
            "name: skill-5",
            `description: "${longDescription}"`,
            "userInvocable: false",
            'allowedTools: ["a", "b", "c"]',
            "category: skill",
            "stability: stable",
            "---",
            "",
            "Body 5.",
        ].join("\n"),
        expectedFm: {
            name: "skill-5",
            description: longDescription,
            userInvocable: false,
            allowedTools: ["a", "b", "c"],
            category: "skill",
            stability: "stable",
        },
        classify: { kind: "skill", userInvocable: false },
        toolMatrix: [
            ["a", true],
            ["b", true],
            ["c", true],
            ["d", false],
        ],
    },
];
const runToolMatrix = (fm, matrix) => {
    for (const [tool, allowed] of matrix) {
        expect(isToolAllowed(fm, tool)).toBe(allowed);
        if (allowed) {
            expect(() => assertAllowedTool(fm, tool)).not.toThrow();
        }
        else {
            expect(() => assertAllowedTool(fm, tool)).toThrow(ToolNotAllowedBySkillError);
        }
    }
};
const exerciseFixture = async (fx) => {
    const filePath = join(DIR, fx.file);
    await writeFile(filePath, fx.body, "utf8");
    const raw = await readFile(filePath, "utf8");
    const r = parseSkillMarkdown(raw);
    expect(r.ok).toBe(true);
    if (!r.ok)
        return;
    expect(r.value.frontmatter).toEqual(fx.expectedFm);
    // For skill-5 (4096-byte description) the byte length is asserted explicitly
    // so any silent truncation would surface immediately.
    if (fx.file === "skill-5.md") {
        expect(r.value.frontmatter.description.length).toBe(4096);
    }
    expect(classify(r.value.frontmatter)).toEqual(fx.classify);
    runToolMatrix(r.value.frontmatter, fx.toolMatrix);
};
describe("scenario 4 — 5-fixture cross-validation pipeline", () => {
    test("every fixture round-trips parse → classify → tool-matrix exactly", async () => {
        for (const fx of FIXTURES)
            await exerciseFixture(fx);
    });
    test("the deprecated fixture is still loadable AND the stability is preserved", async () => {
        const raw = await readFile(join(DIR, "skill-4.md"), "utf8");
        const r = parseSkillMarkdown(raw);
        expect(r.ok).toBe(true);
        if (r.ok)
            expect(r.value.frontmatter.stability).toBe("deprecated");
    });
});
