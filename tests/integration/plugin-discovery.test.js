/**
 * Plugin discovery integration test (Cluster E / F13, ADR-0039).
 *
 * Real tmpdir + real fs: stage 3 plugins at varying depths + several junk
 * dirs; assert discovery order, junk-dir rejection, and end-to-end
 * load-after-discover.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverPlugins, loadPluginManifest } from "../../src/skill/plugin-loader";
const baseInterface = {
    displayName: "Demo",
    shortDescription: "Demo plugin",
    longDescription: "Long description.",
    developerName: "Quanta",
    category: "dev",
    capabilities: ["Read", "Interactive"],
    websiteURL: "https://example.com",
    privacyPolicyURL: "https://example.com/p",
    termsOfServiceURL: "https://example.com/t",
    logo: "logo.png",
    defaultPrompt: [],
    brandColor: "#abcdef",
    screenshots: [],
};
const baseManifest = (name) => ({
    name,
    version: "0.0.1",
    description: `Demo ${name}`,
    author: { name: "Quanta" },
    license: "MIT",
    keywords: [],
    interface: baseInterface,
});
let ROOT = "";
beforeAll(async () => {
    ROOT = await mkdtemp(join(tmpdir(), "qcav3-plugin-discovery-e2e-"));
    // Three plugins at depths 1, 2, 3 + skills + mcp
    const plugins = [
        { rel: "alpha", name: "alpha", mcp: true, skills: ["s1"] },
        { rel: "tools/beta", name: "beta", mcp: false, skills: [] },
        { rel: "nested/deeper/gamma", name: "gamma", mcp: true, skills: ["a", "b"] },
    ];
    for (const p of plugins) {
        const dir = join(ROOT, p.rel);
        await mkdir(join(dir, ".quanta-plugin"), { recursive: true });
        await writeFile(join(dir, ".quanta-plugin", "plugin.json"), JSON.stringify(baseManifest(p.name)), "utf8");
        if (p.mcp) {
            await writeFile(join(dir, ".mcp.json"), JSON.stringify({
                mcpServers: { [`${p.name}-srv`]: { command: "node", args: ["server.js"] } },
            }), "utf8");
        }
        for (const s of p.skills) {
            await mkdir(join(dir, "skills", s), { recursive: true });
            await writeFile(join(dir, "skills", s, "SKILL.md"), `---\nname: ${s}\ndescription: stub\nuserInvocable: false\nallowedTools: []\ncategory: skill\nstability: experimental\n---\n`, "utf8");
        }
    }
    // Junk dirs that must be ignored
    await mkdir(join(ROOT, "node_modules", "fake", ".quanta-plugin"), { recursive: true });
    await writeFile(join(ROOT, "node_modules", "fake", ".quanta-plugin", "plugin.json"), "ignored", "utf8");
    await mkdir(join(ROOT, ".git", ".quanta-plugin"), { recursive: true });
    await writeFile(join(ROOT, ".git", ".quanta-plugin", "plugin.json"), "ignored", "utf8");
});
afterAll(async () => {
    if (ROOT)
        await rm(ROOT, { recursive: true, force: true });
});
describe("discoverPlugins (integration)", () => {
    test("finds all three plugins, junk excluded, sorted", async () => {
        const got = await discoverPlugins(ROOT);
        const rels = got.map((d) => d.dir.replace(`${ROOT}/`, ""));
        expect(rels).toEqual(["alpha", "nested/deeper/gamma", "tools/beta"]);
    });
    test("each discovered plugin loads cleanly", async () => {
        const got = await discoverPlugins(ROOT);
        expect(got.length).toBe(3);
        for (const d of got) {
            const loaded = await loadPluginManifest(d.dir);
            expect(loaded.manifest.name).toMatch(/^(alpha|beta|gamma)$/);
        }
    });
    test("alpha plugin reports its single skill entry", async () => {
        const loaded = await loadPluginManifest(join(ROOT, "alpha"));
        expect(loaded.skillEntries.map((s) => s.name)).toEqual(["s1"]);
        expect(loaded.mcpServers?.["alpha-srv"]?.command).toBe("node");
    });
    test("gamma plugin reports two skills in sorted order", async () => {
        const loaded = await loadPluginManifest(join(ROOT, "nested", "deeper", "gamma"));
        expect(loaded.skillEntries.map((s) => s.name)).toEqual(["a", "b"]);
    });
});
