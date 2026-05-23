/**
 * Skill `paths:` conditional activation e2e — catalog row 6.2 promotion from
 * pure-host-API (L1) to host-driven loop wiring (L2). The `paths:` filter
 * narrows the per-turn SKILL SUGGESTION inventory based on
 * `config.skills.changedPaths`. The invocable surface (the `Skill` tool) is
 * NEVER narrowed — a host can still invoke any discovered skill by name.
 *
 * Pinned contracts:
 *   1. `changedPaths` UNSET ⇒ inventory == full discovered set (byte-identical
 *      with prior behavior; RFC §1.2 default-OFF guarantee).
 *   2. `changedPaths=["src/foo.ts"]` ⇒ inventory =
 *        (skills WITHOUT `paths:`)  ∪  (skills WITH `paths:` that match foo.ts)
 *      — a skill whose globs DON'T match foo.ts is dropped from suggestions.
 *   3. Even after a skill is suggestion-dropped, it remains INVOKABLE by name
 *      via the `Skill` tool — narrowing suggestions ≠ removing authority.
 *
 * The agent loop's session-start path goes through `buildSessionFeatures →
 * buildSkillFeatures` (features.ts), so the assertion has to come from inside
 * a real `runAgent` session, not a unit call to `buildSkillFeatures`. We get
 * the inventory by inspecting the per-turn reminder rendered into the
 * `StreamInput.messages` the ScriptedLLM sees — that's the only post-loop
 * observable that carries the active-skills block.
 */
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runAgent } from "@/agent";
import { defaultTools, ToolRegistry } from "@/tool";
import { cfg, ev, RecordingStream, ScriptedLLM, text, toolUse, withTimeout } from "./_harness";
/** Render a SKILL.md file with optional `paths:` frontmatter. */
const writeSkill = async (root, name, description, paths) => {
    const dir = join(root, name);
    await mkdir(dir, { recursive: true });
    const frontmatter = [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        ...(paths !== undefined ? [`paths: [${paths.map((p) => `"${p}"`).join(", ")}]`] : []),
        "---",
    ].join("\n");
    await writeFile(join(dir, "SKILL.md"), `${frontmatter}\n\nbody of ${name}\n`);
};
/** Pull every text block out of the messages a ScriptedLLM saw on a given
 *  turn — the active-skills reminder is emitted as a `text` block. */
const allText = (messages) => messages
    .flatMap((m) => m.content.map((b) => b.type === "text" ? b.text : b.type === "tool_result" ? b.content : ""))
    .join("\n");
let skillsDir;
beforeAll(async () => {
    skillsDir = await mkdtemp(join(tmpdir(), "skill-paths-e2e-"));
    // Three skills:
    //   - "unconditional": no `paths:` ⇒ ALWAYS in inventory
    //   - "ts-only":      `paths: ["**/*.ts"]` ⇒ in inventory iff a .ts changed
    //   - "py-only":      `paths: ["**/*.py"]` ⇒ in inventory iff a .py changed
    await writeSkill(skillsDir, "unconditional", "always-on helper");
    await writeSkill(skillsDir, "ts-only", "TypeScript helper", ["**/*.ts"]);
    await writeSkill(skillsDir, "py-only", "Python helper", ["**/*.py"]);
});
afterAll(async () => {
    await rm(skillsDir, { recursive: true, force: true });
});
describe("Skill `paths:` activation e2e — runAgent honours changedPaths inventory filter", () => {
    test("changedPaths UNSET (control) → all 3 skills appear in the suggestion inventory", async () => {
        const llm = new ScriptedLLM([ev(text("done"))]);
        const config = cfg({
            llm,
            registry: new ToolRegistry(defaultTools),
            stream: new RecordingStream(),
            cwd: skillsDir,
            skills: { dir: skillsDir },
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "skill-paths control");
        expect(outcome.reason).toBe("completed");
        expect(llm.inputs.length).toBeGreaterThanOrEqual(1);
        const firstInput = llm.inputs[0];
        const txt = allText(firstInput.messages);
        expect(txt).toContain("unconditional");
        expect(txt).toContain("ts-only");
        expect(txt).toContain("py-only");
    }, 15_000);
    test("changedPaths=['src/foo.ts'] → unconditional + ts-only in inventory, py-only dropped", async () => {
        const llm = new ScriptedLLM([ev(text("done"))]);
        const config = cfg({
            llm,
            registry: new ToolRegistry(defaultTools),
            stream: new RecordingStream(),
            cwd: skillsDir,
            skills: { dir: skillsDir, changedPaths: ["src/foo.ts"] },
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "skill-paths ts");
        expect(outcome.reason).toBe("completed");
        const firstInput = llm.inputs[0];
        // The reminder block is rendered with skill NAMES near a stable header.
        // We sniff for the names directly because the catalog row 6.2 promises
        // exactly this surface (per-turn suggestion-only filter).
        const txt = allText(firstInput.messages);
        expect(txt).toContain("unconditional"); // unconditional always survives
        expect(txt).toContain("ts-only"); // matches **/*.ts
        expect(txt).not.toContain("py-only"); // doesn't match any changed path
    }, 15_000);
    test("changedPaths=['app.py','README.md'] → unconditional + py-only, ts-only dropped", async () => {
        const llm = new ScriptedLLM([ev(text("done"))]);
        const config = cfg({
            llm,
            registry: new ToolRegistry(defaultTools),
            stream: new RecordingStream(),
            cwd: skillsDir,
            skills: { dir: skillsDir, changedPaths: ["app.py", "README.md"] },
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "skill-paths py");
        expect(outcome.reason).toBe("completed");
        const firstInput = llm.inputs[0];
        const txt = allText(firstInput.messages);
        expect(txt).toContain("unconditional");
        expect(txt).toContain("py-only");
        expect(txt).not.toContain("ts-only");
    }, 15_000);
    test("changedPaths=[] (explicit empty) → identity (same as unset, no filter applied)", async () => {
        // Empty array MUST NOT be interpreted as "nothing activated" — that would
        // be a silent footgun (clears ALL conditional skills). The wiring treats
        // length === 0 the same as undefined (the docstring guarantees this).
        const llm = new ScriptedLLM([ev(text("done"))]);
        const config = cfg({
            llm,
            registry: new ToolRegistry(defaultTools),
            stream: new RecordingStream(),
            cwd: skillsDir,
            skills: { dir: skillsDir, changedPaths: [] },
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "skill-paths empty");
        expect(outcome.reason).toBe("completed");
        const firstInput = llm.inputs[0];
        const txt = allText(firstInput.messages);
        // All three present — empty array short-circuits to no-filter.
        expect(txt).toContain("unconditional");
        expect(txt).toContain("ts-only");
        expect(txt).toContain("py-only");
    }, 15_000);
    test("suggestion-narrowing does NOT remove authority: `Skill` tool can still invoke a dropped skill", async () => {
        // py-only is dropped from the suggestion inventory under TS-only changes,
        // but the Skill tool MUST still be able to invoke it by name. Otherwise
        // we've silently stripped authority — which the wiring contract forbids.
        const llm = new ScriptedLLM([
            ev(toolUse("s-1", "Skill", { name: "py-only" })),
            ev(text("invoked dropped skill ok")),
        ]);
        const stream = new RecordingStream();
        const config = cfg({
            llm,
            registry: new ToolRegistry(defaultTools),
            stream,
            cwd: skillsDir,
            skills: { dir: skillsDir, changedPaths: ["src/only.ts"] },
        });
        const outcome = await withTimeout(runAgent(config), 10_000, "skill-paths invoke-dropped");
        expect(outcome.reason).toBe("completed");
        const result = stream.events.find((e) => e.type === "tool_result" && e.name === "Skill");
        expect(result).toBeDefined();
        if (result && result.type === "tool_result") {
            expect(result.ok).toBe(true);
            // Body of the invoked skill is what the Skill tool returns.
            expect(result.preview).toContain("body of py-only");
        }
    }, 15_000);
});
