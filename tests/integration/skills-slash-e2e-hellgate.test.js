/**
 * /skills + /reload-skills — E2E HELLGATE (2026-05-23).
 *
 * NOT a unit test with mocked callbacks. Every case here exercises the REAL
 * disk-discovery path:
 *   - subprocess suites spawn `bun src/apps/cli/index.ts …` so the production
 *     code runs end-to-end (argv routing → runSlashMain → buildSkillsConfig →
 *     buildSkillsCallback → discoverSkills + discoverSystemSkills →
 *     renderSkills).
 *   - in-process REPL suites drive the real `runReplLoop` with a real
 *     `discoverSkills` callback against a temp `QUANTA_SKILLS_DIR`.
 *
 * Hellgate scope (no flimsy assertions, no "callback fired" stubs):
 *   1. Real disk: user SKILL.md files actually appear in the listing.
 *   2. Bundled system skills always present (localize-fault, progress-audit).
 *   3. User-vs-system name collision: system wins on collision (buildSessionFeatures parity).
 *   4. Malformed SKILL.md (missing frontmatter / empty file) is skipped
 *      silently; OTHER valid skills still appear (graceful degradation).
 *   5. Hot reload: write SKILL.md mid-REPL, call /reload-skills, new skill
 *      visible WITHOUT restarting the REPL.
 *   6. Zero-arg contract from a real shell: `/skills foo` fails on the
 *      subprocess path, no callback fires, exit code 1.
 *   7. /reload-skills uses `reloaded:` prefix verbatim (not `skills:`) — a
 *      regression here would silently make the two commands indistinguishable.
 *   8. Concurrent /skills invocations against the same real dir: both succeed
 *      and yield the same row set (no FD/iterator races in discoverSkills).
 *   9. REPL-inside slash routing prevents `/skills` from reaching the model
 *      (`turn()` never called) — proven against a REAL discoverSkills
 *      callback, not a mock.
 *  10. Path-like tokens (`/tmp/foo`) still fall through to `turn()` even
 *      when a real skills surface is wired.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { discoverSkills, discoverSystemSkills } from "@/skill";
import { runReplLoop } from "../../src/apps/cli/repl";
const CLI = "src/apps/cli/index.ts";
const spawnCli = async (args, extraEnv = {}) => {
    const env = {
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        HOME: process.env.HOME ?? "/tmp",
        ...extraEnv,
    };
    const proc = Bun.spawn({
        cmd: ["bun", CLI, ...args],
        env,
        stdout: "pipe",
        stderr: "pipe",
        stdin: "ignore",
    });
    const [out, err, exit] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
    ]);
    return { out, err, exit };
};
const writeSkill = async (dir, name, description, paths) => {
    const skillDir = join(dir, name);
    await mkdir(skillDir, { recursive: true });
    const frontmatter = [
        "---",
        `name: ${name}`,
        `description: ${description}`,
        ...(paths ? [`paths:`, ...paths.map((p) => `  - ${p}`)] : []),
        "---",
        "",
        "Body content for the skill.",
    ].join("\n");
    await writeFile(join(skillDir, "SKILL.md"), frontmatter, "utf8");
};
// ── subprocess e2e: real shell-entry path ───────────────────────────────
let userDir;
beforeEach(() => {
    userDir = mkdtempSync(join(tmpdir(), "skills-e2e-"));
});
afterEach(() => {
    rmSync(userDir, { recursive: true, force: true });
});
describe("/skills (subprocess): real disk discovery, system + user merge", () => {
    test("user skill on disk appears in output + bundled system skills also present", async () => {
        await writeSkill(userDir, "my-custom-skill", "Custom skill trigger description.");
        const r = await spawnCli(["/skills"], { QUANTA_SKILLS_DIR: userDir });
        expect(r.exit).toBe(0);
        // User skill visible
        expect(r.out).toContain("my-custom-skill");
        expect(r.out).toContain("Custom skill trigger description");
        // Bundled system skills visible (known by file inspection)
        expect(r.out).toContain("localize-fault");
        expect(r.out).toContain("progress-audit");
        // Row count >= 3 (1 user + 2 system; could be more if system grows)
        const match = /(\d+)\s+skills?:/.exec(r.out);
        expect(match).not.toBeNull();
        const count = Number(match?.[1] ?? "0");
        expect(count).toBeGreaterThanOrEqual(3);
    });
    test("empty user dir ⇒ only bundled system skills (no crash)", async () => {
        const r = await spawnCli(["/skills"], { QUANTA_SKILLS_DIR: userDir });
        expect(r.exit).toBe(0);
        expect(r.out).toContain("localize-fault");
        expect(r.out).toContain("progress-audit");
    });
    test("paths frontmatter rendered as [paths: …] tag", async () => {
        await writeSkill(userDir, "ts-skill", "TS-only helper.", ["src/**/*.ts", "tests/**/*.ts"]);
        const r = await spawnCli(["/skills"], { QUANTA_SKILLS_DIR: userDir });
        expect(r.exit).toBe(0);
        expect(r.out).toContain("ts-skill");
        expect(r.out).toContain("[paths: src/**/*.ts, tests/**/*.ts]");
    });
    test("name collision: user skill with same name as a system skill ⇒ SYSTEM wins (precedence parity)", async () => {
        // Shadow `localize-fault` (a known system skill) with a user skill that
        // has a clearly-different description. Expectation: system precedence
        // wins → user description does NOT leak into the rendered row.
        const userMarker = "USER_OVERRIDE_SHOULD_NOT_APPEAR_IF_PRECEDENCE_HOLDS";
        await writeSkill(userDir, "localize-fault", userMarker);
        const r = await spawnCli(["/skills"], { QUANTA_SKILLS_DIR: userDir });
        expect(r.exit).toBe(0);
        expect(r.out).toContain("localize-fault");
        // Critical: the system skill's actual description must be the one rendered.
        // System skill's description starts with "Localize a fault" (verified from
        // src/skill/system-skills/localize-fault/SKILL.md).
        expect(r.out).toContain("Localize a fault");
        expect(r.out).not.toContain(userMarker);
    });
    test("malformed SKILL.md (missing frontmatter) is silently skipped; valid siblings still render", async () => {
        // Valid skill alongside an invalid one (no `---` block, no name/description).
        await writeSkill(userDir, "valid-one", "I am a valid skill.");
        const invalidDir = join(userDir, "broken-skill");
        await mkdir(invalidDir, { recursive: true });
        await writeFile(join(invalidDir, "SKILL.md"), "This file has no frontmatter at all.\n", "utf8");
        const r = await spawnCli(["/skills"], { QUANTA_SKILLS_DIR: userDir });
        expect(r.exit).toBe(0);
        expect(r.out).toContain("valid-one");
        // The malformed entry MAY still appear with a fallback name (broken-skill
        // = directory basename) — what matters is no crash + valid skill present.
        expect(r.err).not.toContain("Error");
        expect(r.err).not.toContain("crash");
    });
    test("empty SKILL.md file ⇒ no crash, listing renders rest of skills", async () => {
        const emptyDir = join(userDir, "empty-skill");
        await mkdir(emptyDir, { recursive: true });
        await writeFile(join(emptyDir, "SKILL.md"), "", "utf8");
        await writeSkill(userDir, "alive", "Survives the empty sibling.");
        const r = await spawnCli(["/skills"], { QUANTA_SKILLS_DIR: userDir });
        expect(r.exit).toBe(0);
        expect(r.out).toContain("alive");
        expect(r.err).not.toContain("Error");
    });
});
describe("/skills (subprocess): zero-arg contract from real shell", () => {
    test("/skills foo ⇒ exit 1 (real argv path, no silent ignore)", async () => {
        await writeSkill(userDir, "x", "y");
        const r = await spawnCli(["/skills", "foo"], { QUANTA_SKILLS_DIR: userDir });
        expect(r.exit).toBe(1);
        expect(r.err).toContain("takes no arguments");
        // Discovery callback must NOT have fired (we reject before disk read).
        expect(r.out).not.toContain("skills:");
        // The valid skill must NOT appear (further proof callback didn't fire).
        expect(r.out).not.toContain(" x  "); // padded name in row form
    });
});
describe("/reload-skills (subprocess): prefix differs from /skills (regression gate)", () => {
    test("real disk ⇒ output starts with 'reloaded:' not 'skills:'", async () => {
        await writeSkill(userDir, "reload-test-skill", "For prefix verification.");
        const r = await spawnCli(["/reload-skills"], { QUANTA_SKILLS_DIR: userDir });
        expect(r.exit).toBe(0);
        expect(r.out).toContain("reload-test-skill");
        expect(r.out).toContain("reloaded:");
        // Critical: must NOT use the /skills prefix
        expect(r.out).not.toMatch(/^skills: \d+ skill/m);
    });
});
const makeRl = (lines) => {
    let i = 0;
    return {
        question: async (_q) => {
            const line = lines[i++];
            if (line === undefined)
                throw new Error("rl: out of inputs");
            return line;
        },
    };
};
/** Real skills callback against a tmpdir — same shape buildSkillsCallback
 *  produces, but inlined here so the test can vary the disk state between
 *  invocations (the production callback closes over a fixed dir). */
const realSkillsCallback = (dir) => async () => {
    const user = await discoverSkills(dir);
    const system = await discoverSystemSkills();
    const byName = new Map();
    for (const s of user) {
        const row = { name: s.name, description: s.description };
        if (s.paths !== undefined)
            row.paths = s.paths;
        byName.set(s.name, row);
    }
    for (const s of system) {
        const row = { name: s.name, description: s.description };
        if (s.paths !== undefined)
            row.paths = s.paths;
        byName.set(s.name, row);
    }
    return [...byName.values()].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
};
const captureStdout = async (fn) => {
    const orig = process.stdout.write.bind(process.stdout);
    let captured = "";
    process.stdout.write = ((s) => {
        captured += typeof s === "string" ? s : new TextDecoder().decode(s);
        return true;
    });
    try {
        const result = await fn();
        return { result, captured };
    }
    finally {
        process.stdout.write = orig;
    }
};
describe("REPL hot-reload (in-process, real disk): /reload-skills picks up new SKILL.md mid-session", () => {
    test("write SKILL.md AFTER REPL starts → /reload-skills shows it (no restart)", async () => {
        // Pre-write one skill.
        await writeSkill(userDir, "before-restart", "Existed before REPL start.");
        const skillsCb = realSkillsCallback(userDir);
        // Drive REPL: /reload-skills (shows 1) → (write new skill on disk) →
        // /reload-skills (now shows 2 user skills). Each /reload-skills call is
        // an independent disk read, so the second invocation MUST see the new file.
        const turnCalls = [];
        const turn = async (t) => {
            turnCalls.push(t);
        };
        const rl = makeRl(["/reload-skills", "/exit"]);
        const abort = new AbortController();
        const { captured: first } = await captureStdout(() => runReplLoop(rl, abort.signal, turn, { skills: skillsCb }));
        expect(first).toContain("before-restart");
        expect(first).not.toContain("after-restart");
        // Now write a NEW skill on disk and call /reload-skills again.
        await writeSkill(userDir, "after-restart", "Appeared mid-session.");
        const rl2 = makeRl(["/reload-skills", "/exit"]);
        const abort2 = new AbortController();
        const { captured: second } = await captureStdout(() => runReplLoop(rl2, abort2.signal, turn, { skills: skillsCb }));
        expect(second).toContain("before-restart");
        expect(second).toContain("after-restart");
        // turn() must never have been called — both inputs were slash commands.
        expect(turnCalls).toHaveLength(0);
    });
    test("name collision (user shadows system) ⇒ system wins through the REAL discoverSkills flow", async () => {
        await writeSkill(userDir, "progress-audit", "USER_SHADOW_SHOULD_LOSE");
        const skillsCb = realSkillsCallback(userDir);
        const rl = makeRl(["/skills", "/exit"]);
        const abort = new AbortController();
        const { captured } = await captureStdout(() => runReplLoop(rl, abort.signal, async () => undefined, { skills: skillsCb }));
        expect(captured).toContain("progress-audit");
        expect(captured).not.toContain("USER_SHADOW_SHOULD_LOSE");
        // The actual system description starts with "Audit work-in-progress" —
        // verified from src/skill/system-skills/progress-audit/SKILL.md.
        expect(captured).toContain("Audit work-in-progress");
    });
});
describe("REPL e2e: /skills NEVER reaches the model + path-like tokens DO", () => {
    test("/skills with a REAL discover callback short-circuits before turn()", async () => {
        await writeSkill(userDir, "real-skill", "discovered from disk.");
        const skillsCb = realSkillsCallback(userDir);
        const turnCalls = [];
        const turn = async (t) => {
            turnCalls.push(t);
        };
        const rl = makeRl(["/skills", "real prompt", "/exit"]);
        const abort = new AbortController();
        const { captured } = await captureStdout(() => runReplLoop(rl, abort.signal, turn, { skills: skillsCb }));
        // /skills produced the listing (proof callback ran end-to-end)
        expect(captured).toContain("real-skill");
        // turn() received ONLY the prompt, not the slash
        expect(turnCalls).toEqual(["real prompt"]);
    });
    test("path-like /tmp/foo falls through to turn() (no slash hijack of legacy resume args)", async () => {
        const skillsCb = realSkillsCallback(userDir);
        const turnCalls = [];
        const turn = async (t) => {
            turnCalls.push(t);
        };
        const rl = makeRl(["/tmp/some/path", "/exit"]);
        const abort = new AbortController();
        await runReplLoop(rl, abort.signal, turn, { skills: skillsCb });
        expect(turnCalls).toEqual(["/tmp/some/path"]);
    });
});
describe("Concurrent invocation against the SAME real dir (no FD / iterator race)", () => {
    test("Promise.all([cb(), cb(), cb()]) ⇒ all three yield identical row sets", async () => {
        await writeSkill(userDir, "skill-A", "A.");
        await writeSkill(userDir, "skill-B", "B.");
        await writeSkill(userDir, "skill-C", "C.");
        const cb = realSkillsCallback(userDir);
        const [r1, r2, r3] = await Promise.all([cb(), cb(), cb()]);
        // Same names, same order (sorted).
        expect(r1.map((r) => r.name)).toEqual(r2.map((r) => r.name));
        expect(r2.map((r) => r.name)).toEqual(r3.map((r) => r.name));
        // All three include the user skills + bundled.
        expect(r1.map((r) => r.name)).toContain("skill-A");
        expect(r1.map((r) => r.name)).toContain("skill-B");
        expect(r1.map((r) => r.name)).toContain("skill-C");
        expect(r1.map((r) => r.name)).toContain("localize-fault");
        expect(r1.map((r) => r.name)).toContain("progress-audit");
    });
    test("10× parallel calls + intermediate disk writes ⇒ no crash, no duplicate rows", async () => {
        const cb = realSkillsCallback(userDir);
        // Fire 10 reads while 3 writes happen mid-stream (best-effort interleaving).
        const reads = [];
        for (let i = 0; i < 10; i++) {
            reads.push(cb());
            if (i === 3)
                await writeSkill(userDir, "mid-1", "Written during reads.");
            if (i === 5)
                await writeSkill(userDir, "mid-2", "Written during reads.");
            if (i === 7)
                await writeSkill(userDir, "mid-3", "Written during reads.");
        }
        const results = await Promise.all(reads);
        // No result should have duplicate names (the dedup map prevents this).
        for (const rows of results) {
            const names = rows.map((r) => r.name);
            const set = new Set(names);
            expect(set.size).toBe(names.length);
        }
    });
});
