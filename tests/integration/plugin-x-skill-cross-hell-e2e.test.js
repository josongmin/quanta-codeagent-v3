/**
 * HELL-DIFFICULTY cross-feature end-to-end tests
 * (Cluster E / F13 + F14, ADR-0039 + ADR-0040).
 *
 * Runs the full pipeline end-to-end:
 *   discoverPlugins(root)
 *     → loadPluginManifest(pluginDir)
 *     → readFile(skillMdPath)
 *     → parseSkillMarkdown(raw)
 *     → classify(fm)
 *     → assertAllowedTool(fm, tool)
 *
 * Scenarios:
 *  1. One plugin with 5 well-formed skills (mix of skill + extension + edge).
 *  2. One plugin with 5 skills where 2 are malformed — plugin loads cleanly
 *     but each broken skill surfaces its OWN typed parse error, NOT a global
 *     plugin-load cascade.
 *  3. 20 plugins × 3 skills each = 60-skill stress + informational timing.
 *  4. Plugin Capability ↔ Skill allowedTools consistency — CURRENT loader
 *     performs NO cross-check; documented gap.
 *
 * Hard rule conformance: tmpdir only, exact assertions, no swallows.
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { __resetRuntimeConfig } from "../../src/shared";
import { discoverPlugins, loadPluginManifest } from "../../src/skill/plugin-loader";
import { FrontmatterParseError, parseSkillMarkdown, } from "../../src/skill/skill-frontmatter";
import { assertAllowedTool, classify, ToolNotAllowedBySkillError, } from "../../src/skill/skill-vs-extension";
const VI = {
    displayName: "Demo",
    shortDescription: "Demo plugin",
    longDescription: "Long description.",
    developerName: "Quanta",
    category: "developer-tools",
    capabilities: ["Read"],
    websiteURL: "https://example.com",
    privacyPolicyURL: "https://example.com/p",
    termsOfServiceURL: "https://example.com/t",
    logo: "logo.png",
    defaultPrompt: [],
    brandColor: "#abcdef",
    screenshots: [],
};
const validManifest = (name, overrides = {}) => ({
    name,
    version: "0.0.1",
    description: `Demo ${name}`,
    author: { name: "Quanta" },
    license: "MIT",
    keywords: [],
    interface: VI,
    ...overrides,
});
const skillBody = (overrides) => {
    const merged = {
        name: "demo",
        description: "demo desc",
        userInvocable: false,
        allowedTools: [],
        category: "skill",
        stability: "stable",
        ...overrides,
    };
    const list = merged.allowedTools.length === 0
        ? "[]"
        : `[${merged.allowedTools.map((t) => JSON.stringify(t)).join(", ")}]`;
    return [
        "---",
        `name: ${merged.name}`,
        `description: "${merged.description}"`,
        `userInvocable: ${merged.userInvocable}`,
        `allowedTools: ${list}`,
        `category: ${merged.category}`,
        `stability: ${merged.stability}`,
        "---",
        "",
        "Body.",
    ].join("\n");
};
const writePlugin = async (root, rel, manifest, skills) => {
    const dir = join(root, rel);
    await mkdir(join(dir, ".quanta-plugin"), { recursive: true });
    await writeFile(join(dir, ".quanta-plugin", "plugin.json"), JSON.stringify(manifest), "utf8");
    for (const s of skills) {
        await mkdir(join(dir, "skills", s.name), { recursive: true });
        await writeFile(join(dir, "skills", s.name, "SKILL.md"), s.body, "utf8");
    }
    return dir;
};
let ROOT = "";
beforeAll(async () => {
    ROOT = await mkdtemp(join(tmpdir(), "qcav3-plugin-x-skill-"));
});
beforeEach(() => {
    __resetRuntimeConfig();
});
afterAll(async () => {
    if (ROOT)
        await rm(ROOT, { recursive: true, force: true });
});
const assertSkillMatches = (fm, exp) => {
    expect(fm.stability).toBe(exp.stability);
    const c = classify(fm);
    expect(c.kind).toBe(exp.kind);
    expect(c.userInvocable).toBe(exp.userInvocable);
    for (const [tool, allowed] of exp.toolMatrix) {
        if (allowed) {
            expect(() => assertAllowedTool(fm, tool)).not.toThrow();
        }
        else {
            expect(() => assertAllowedTool(fm, tool)).toThrow(ToolNotAllowedBySkillError);
        }
    }
};
describe("scenario 1 — one plugin, five well-formed skills, full pipeline", () => {
    test("end-to-end discover → load → parse → classify → assertAllowedTool", async () => {
        const SKILLS = [
            {
                name: "skill-a",
                body: skillBody({
                    name: "skill-a",
                    description: "User-callable skill A",
                    userInvocable: true,
                    allowedTools: ["bash", "read"],
                    category: "skill",
                    stability: "stable",
                }),
            },
            {
                name: "skill-b",
                body: skillBody({
                    name: "skill-b",
                    description: "LLM-only skill B",
                    userInvocable: false,
                    allowedTools: ["grep"],
                    category: "skill",
                    stability: "experimental",
                }),
            },
            {
                name: "extension-c",
                body: skillBody({
                    name: "extension-c",
                    description: "System extension C",
                    userInvocable: false,
                    allowedTools: [],
                    category: "extension",
                    stability: "stable",
                }),
            },
            {
                name: "deprecated-d",
                body: skillBody({
                    name: "deprecated-d",
                    description: "Deprecated D",
                    userInvocable: true,
                    allowedTools: ["read"],
                    category: "skill",
                    stability: "deprecated",
                }),
            },
            {
                name: "empty-tools-e",
                body: skillBody({
                    name: "empty-tools-e",
                    description: "No tools E",
                    userInvocable: false,
                    allowedTools: [],
                    category: "skill",
                    stability: "stable",
                }),
            },
        ];
        const dir = await writePlugin(ROOT, "scenario1", validManifest("scenario1"), SKILLS);
        const discovered = await discoverPlugins(dir);
        expect(discovered.length).toBe(1);
        expect(discovered[0]?.dir).toBe(dir);
        const loaded = await loadPluginManifest(dir);
        expect(loaded.manifest.name).toBe("scenario1");
        expect(loaded.skillEntries.map((s) => s.name)).toEqual([
            "deprecated-d",
            "empty-tools-e",
            "extension-c",
            "skill-a",
            "skill-b",
        ]);
        // Build a name → entry index for direct lookup, then run the rest of the
        // pipeline per-skill with EXACT expected outcomes.
        const byName = Object.fromEntries(loaded.skillEntries.map((e) => [e.name, e]));
        const expectations = {
            "skill-a": {
                kind: "skill",
                userInvocable: true,
                stability: "stable",
                toolMatrix: [
                    ["bash", true],
                    ["read", true],
                    ["write", false],
                ],
            },
            "skill-b": {
                kind: "skill",
                userInvocable: false,
                stability: "experimental",
                toolMatrix: [
                    ["grep", true],
                    ["Grep", false],
                    ["bash", false],
                ],
            },
            "extension-c": {
                kind: "extension",
                userInvocable: false,
                stability: "stable",
                toolMatrix: [
                    ["bash", false],
                    ["read", false],
                ],
            },
            "deprecated-d": {
                kind: "skill",
                userInvocable: true,
                stability: "deprecated",
                toolMatrix: [
                    ["read", true],
                    ["bash", false],
                ],
            },
            "empty-tools-e": {
                kind: "skill",
                userInvocable: false,
                stability: "stable",
                toolMatrix: [
                    ["read", false],
                    ["bash", false],
                    ["any", false],
                ],
            },
        };
        for (const [name, exp] of Object.entries(expectations)) {
            const entry = byName[name];
            expect(entry).toBeDefined();
            if (!entry)
                continue;
            const raw = await readFile(entry.skillMdPath, "utf8");
            const r = parseSkillMarkdown(raw);
            expect(r.ok).toBe(true);
            if (!r.ok)
                continue;
            assertSkillMatches(r.value.frontmatter, exp);
        }
    });
});
/* ----------------------------- scenario 2 ----------------------------- */
describe("scenario 2 — malformed skills do NOT cascade to a plugin-load failure", () => {
    test("plugin loads, manifest is OK, each broken skill carries its own typed error", async () => {
        const SKILLS = [
            {
                name: "ok-a",
                body: skillBody({
                    name: "ok-a",
                    description: "well-formed A",
                    userInvocable: false,
                    allowedTools: ["read"],
                }),
            },
            {
                name: "ok-b",
                body: skillBody({
                    name: "ok-b",
                    description: "well-formed B",
                    userInvocable: true,
                    allowedTools: [],
                }),
            },
            {
                name: "broken-c",
                // Numeric scalar in description → parser rejects with line=3.
                body: [
                    "---",
                    "name: broken-c",
                    "description: 42",
                    "userInvocable: false",
                    "allowedTools: []",
                    "category: skill",
                    "stability: stable",
                    "---",
                ].join("\n"),
            },
            {
                name: "broken-d",
                // Missing `description:` entirely → Zod field error.
                body: [
                    "---",
                    "name: broken-d",
                    "userInvocable: false",
                    "allowedTools: []",
                    "category: skill",
                    "stability: stable",
                    "---",
                ].join("\n"),
            },
            {
                name: "ok-e",
                body: skillBody({
                    name: "ok-e",
                    description: "well-formed E",
                    userInvocable: false,
                    allowedTools: ["grep"],
                }),
            },
        ];
        const dir = await writePlugin(ROOT, "scenario2", validManifest("scenario2"), SKILLS);
        // Plugin load itself must SUCCEED — manifest is well-formed.
        const loaded = await loadPluginManifest(dir);
        expect(loaded.manifest.name).toBe("scenario2");
        expect(loaded.skillEntries.length).toBe(5);
        // Per-skill round-trip: 3 OK + 2 broken with typed errors at the correct
        // line numbers.
        const results = await Promise.all(loaded.skillEntries.map(async (e) => {
            const raw = await readFile(e.skillMdPath, "utf8");
            return [e.name, parseSkillMarkdown(raw)];
        }));
        const byName = Object.fromEntries(results);
        expect(byName["ok-a"]?.ok).toBe(true);
        expect(byName["ok-b"]?.ok).toBe(true);
        expect(byName["ok-e"]?.ok).toBe(true);
        const brokenC = byName["broken-c"];
        expect(brokenC?.ok).toBe(false);
        if (brokenC && !brokenC.ok) {
            expect(brokenC.error).toBeInstanceOf(FrontmatterParseError);
            expect(brokenC.error.line).toBe(3);
            expect(brokenC.error.message).toMatch(/numeric scalars/);
        }
        const brokenD = byName["broken-d"];
        expect(brokenD?.ok).toBe(false);
        if (brokenD && !brokenD.ok) {
            expect(brokenD.error).toBeInstanceOf(FrontmatterParseError);
            // Zod field error on missing required field → line=1 (Zod has no
            // source-line awareness).
            expect(brokenD.error.line).toBe(1);
            expect(brokenD.error.message).toMatch(/field 'description'/);
        }
    });
});
/* ----------------------------- scenario 3 ----------------------------- */
const buildStressSkill = (pIdx, sIdx) => {
    const sname = `s-${pIdx.toString().padStart(2, "0")}-${sIdx}`;
    return {
        name: sname,
        body: skillBody({
            name: sname,
            description: `desc ${sname}`,
            userInvocable: sIdx === 0,
            allowedTools: sIdx === 1 ? ["bash"] : [],
            category: sIdx === 2 ? "extension" : "skill",
            stability: "stable",
        }),
    };
};
const seedStressTree = async (root, pluginCount, skillsPerPlugin) => {
    for (let p = 0; p < pluginCount; p++) {
        const pname = `plug-${p.toString().padStart(2, "0")}`;
        const rel = p % 2 === 0 ? pname : join("subgroup", pname);
        const skills = [];
        for (let s = 0; s < skillsPerPlugin; s++)
            skills.push(buildStressSkill(p, s));
        await writePlugin(root, rel, validManifest(pname), skills);
    }
};
const tallySkill = (fm, tally) => {
    const c = classify(fm);
    tally.total++;
    if (c.kind === "extension")
        tally.extension++;
    if (c.userInvocable)
        tally.userInvocable++;
    if (fm.allowedTools.includes("bash")) {
        tally.bashAllowed++;
        expect(() => assertAllowedTool(fm, "bash")).not.toThrow();
    }
    else {
        expect(() => assertAllowedTool(fm, "bash")).toThrow(ToolNotAllowedBySkillError);
    }
};
describe("scenario 3 — 20 plugins × 3 skills = 60-skill stress", () => {
    test("end-to-end pipeline produces exactly 60 skills with expected results", async () => {
        const STRESS = await mkdtemp(join(tmpdir(), "qcav3-plugin-x-skill-stress-"));
        try {
            const PLUGIN_COUNT = 20;
            const SKILLS_PER_PLUGIN = 3;
            await seedStressTree(STRESS, PLUGIN_COUNT, SKILLS_PER_PLUGIN);
            const startedAt = Date.now();
            const discovered = await discoverPlugins(STRESS);
            expect(discovered.length).toBe(PLUGIN_COUNT);
            const loadedPlugins = await Promise.all(discovered.map((d) => loadPluginManifest(d.dir)));
            const tally = { total: 0, userInvocable: 0, extension: 0, bashAllowed: 0 };
            for (const lp of loadedPlugins) {
                expect(lp.skillEntries.length).toBe(SKILLS_PER_PLUGIN);
                for (const e of lp.skillEntries) {
                    const raw = await readFile(e.skillMdPath, "utf8");
                    const r = parseSkillMarkdown(raw);
                    expect(r.ok).toBe(true);
                    if (!r.ok)
                        continue;
                    tallySkill(r.value.frontmatter, tally);
                }
            }
            const elapsedMs = Date.now() - startedAt;
            // Exact counts: 60 total; one user-invocable per plugin (s=0); one
            // extension per plugin (s=2); one bash-permitting skill per plugin (s=1).
            expect(tally.total).toBe(60);
            expect(tally.userInvocable).toBe(20);
            expect(tally.extension).toBe(20);
            expect(tally.bashAllowed).toBe(20);
            // Informational only — assert wide ceiling so CI flake risk is zero.
            expect(elapsedMs).toBeLessThan(10_000);
        }
        finally {
            await rm(STRESS, { recursive: true, force: true });
        }
    });
});
/* ----------------------------- scenario 4 ----------------------------- */
describe("scenario 4 — Plugin capabilities ↔ Skill allowedTools consistency", () => {
    test("loader currently performs NO cross-check (documented gap, exact-behaviour observation)", async () => {
        // RCA #2 (production-code): there is no enforcement linking a plugin's
        // declared `interface.capabilities` (Read/Write/Interactive) to the
        // `allowedTools` of its shipped skills. Adding it would need an ADR
        // (e.g. mapping "Write" → {Write, Edit, ...}). Until then, this test
        // asserts the actual permissive behaviour so any future tightening
        // becomes a deliberate, breaking change.
        const dir = await writePlugin(ROOT, "scenario4-mismatch", validManifest("scenario4-mismatch", {
            interface: { ...VI, capabilities: ["Read"] }, // declared READ ONLY
        }), [
            {
                name: "writer",
                body: skillBody({
                    name: "writer",
                    description: "ships write-class tools despite Read-only declared",
                    userInvocable: false,
                    allowedTools: ["bash", "write"],
                    category: "skill",
                    stability: "stable",
                }),
            },
        ]);
        const loaded = await loadPluginManifest(dir);
        expect(loaded.manifest.interface.capabilities).toEqual(["Read"]);
        expect(loaded.skillEntries.length).toBe(1);
        const raw = await readFile(loaded.skillEntries[0]?.skillMdPath ?? "", "utf8");
        const r = parseSkillMarkdown(raw);
        expect(r.ok).toBe(true);
        if (!r.ok)
            return;
        // The skill is loadable and its allowedTools include `write` — exactly
        // the inconsistency the future check would block.
        expect(r.value.frontmatter.allowedTools).toEqual(["bash", "write"]);
        expect(() => assertAllowedTool(r.value.frontmatter, "write")).not.toThrow();
    });
    test.todo("future: loader should reject skills whose allowedTools exceed the plugin's declared capabilities (needs Tool→Capability map ADR)", () => {
        // Intentionally empty — implementation is gated on a Tool→Capability
        // map ADR. See scenario 4 above for the current permissive behaviour.
    });
});
