/**
 * /skills + /reload-skills hellgate (2026-05-23, Codex forceReloadSkills parity).
 *
 * Pins the surface contract for the two new slash commands AND the REPL-inside
 * slash routing (was previously only at shell entry; the inside-loop gate is
 * new). Every case targets a real behavioral branch — no flimsy "callback
 * returns" assertions; we exercise the actual render, the empty path, the
 * truncation rules, the throwing-callback recovery, and the route-vs-turn
 * discrimination inside the REPL loop.
 */
import { describe, expect, test } from "bun:test";
import { runReplLoop } from "../../../../src/apps/cli/repl";
import { runSlashCommand } from "../../../../src/apps/cli/slash-commands";
const makeCtx = (cap, skills) => ({
    out: (s) => {
        cap.out += s;
    },
    err: (s) => {
        cap.err += s;
    },
    cwd: "/tmp",
    ...(skills !== undefined ? { skills } : {}),
});
// ── /skills: callback-absent path (not-wired surface) ───────────────────
describe("/skills: callback unwired", () => {
    test("prints 'not wired' and exits 0 (default-OFF byte-identical)", async () => {
        const cap = { out: "", err: "" };
        const code = await runSlashCommand("/skills", makeCtx(cap));
        expect(code).toBe(0);
        expect(cap.out).toContain("not wired");
        expect(cap.err).toBe("");
    });
    test("/reload-skills mirrors the same not-wired contract", async () => {
        const cap = { out: "", err: "" };
        const code = await runSlashCommand("/reload-skills", makeCtx(cap));
        expect(code).toBe(0);
        expect(cap.out).toContain("not wired");
    });
});
// ── /skills: empty + populated discovery ────────────────────────────────
describe("/skills: empty discovery", () => {
    test("0 skills ⇒ '(0 skills found)' + exit 0", async () => {
        const cap = { out: "", err: "" };
        const code = await runSlashCommand("/skills", makeCtx(cap, async () => []));
        expect(code).toBe(0);
        expect(cap.out).toContain("0 skills found");
    });
});
describe("/skills: populated", () => {
    const fixtures = [
        {
            name: "alpha",
            description: "First skill — short description, no paths.",
        },
        {
            name: "beta",
            description: "Second skill triggers on 'second', 'two', '둘'.",
            paths: ["src/**/*.ts", "tests/**/*.ts"],
        },
        {
            name: "gamma-with-many-paths",
            description: "Third — has 5 paths to test truncation logic in the renderer.",
            paths: ["a", "b", "c", "d", "e"],
        },
    ];
    test("singular vs plural noun agreement", async () => {
        const capOne = { out: "", err: "" };
        await runSlashCommand("/skills", makeCtx(capOne, async () => [fixtures[0]]));
        expect(capOne.out).toContain("1 skill:");
        expect(capOne.out).not.toContain("1 skills:");
        const capMany = { out: "", err: "" };
        await runSlashCommand("/skills", makeCtx(capMany, async () => fixtures));
        expect(capMany.out).toContain("3 skills:");
    });
    test("renders name + first-line description for each row", async () => {
        const cap = { out: "", err: "" };
        await runSlashCommand("/skills", makeCtx(cap, async () => fixtures));
        expect(cap.out).toContain("alpha");
        expect(cap.out).toContain("beta");
        expect(cap.out).toContain("gamma-with-many-paths");
        expect(cap.out).toContain("First skill");
        expect(cap.out).toContain("Second skill triggers");
    });
    test("paths absent ⇒ no [paths: …] tag", async () => {
        const cap = { out: "", err: "" };
        await runSlashCommand("/skills", makeCtx(cap, async () => [fixtures[0]]));
        expect(cap.out).not.toContain("[paths:");
    });
    test("paths ≤3 ⇒ rendered verbatim, no ellipsis", async () => {
        const cap = { out: "", err: "" };
        await runSlashCommand("/skills", makeCtx(cap, async () => [fixtures[1]]));
        expect(cap.out).toContain("[paths: src/**/*.ts, tests/**/*.ts]");
        expect(cap.out).not.toContain("…]");
    });
    test("paths >3 ⇒ first 3 + ellipsis (no leak of remainder)", async () => {
        const cap = { out: "", err: "" };
        await runSlashCommand("/skills", makeCtx(cap, async () => [fixtures[2]]));
        // Extract just the [paths: ...] tag and assert truncation only there
        // (the description string also contains the letter 'd' so a blanket
        // not.toContain("d") would fire false-positive).
        const pathsMatch = /\[paths: ([^\]]+)\]/.exec(cap.out);
        expect(pathsMatch).not.toBeNull();
        const pathsTag = pathsMatch?.[1] ?? "";
        expect(pathsTag).toBe("a, b, c…");
        expect(pathsTag).not.toContain("d");
        expect(pathsTag).not.toContain("e");
    });
});
// ── /skills: description truncation rules ───────────────────────────────
describe("/skills: description truncation invariants", () => {
    test("single-line ≤100 chars ⇒ verbatim, no '...' suffix", async () => {
        const cap = { out: "", err: "" };
        const desc = "A".repeat(50);
        await runSlashCommand("/skills", makeCtx(cap, async () => [{ name: "x", description: desc }]));
        expect(cap.out).toContain(desc);
        expect(cap.out).not.toContain("...");
    });
    test("single-line >100 chars ⇒ truncated at 97 + '...'", async () => {
        const cap = { out: "", err: "" };
        const long = "B".repeat(200);
        await runSlashCommand("/skills", makeCtx(cap, async () => [{ name: "x", description: long }]));
        expect(cap.out).toContain(`${"B".repeat(97)}...`);
        // Total rendered description must be <= 100 chars (97 + 3 dots).
        expect(cap.out).not.toContain("B".repeat(101));
    });
    test("multi-line description ⇒ only first line shown (no body leak)", async () => {
        const cap = { out: "", err: "" };
        const desc = "First line.\nSECRET_BODY should not appear.\nMore body.";
        await runSlashCommand("/skills", makeCtx(cap, async () => [{ name: "x", description: desc }]));
        expect(cap.out).toContain("First line.");
        expect(cap.out).not.toContain("SECRET_BODY");
        expect(cap.out).not.toContain("More body");
    });
    test("empty description ⇒ renders name without crashing", async () => {
        const cap = { out: "", err: "" };
        const code = await runSlashCommand("/skills", makeCtx(cap, async () => [{ name: "x", description: "" }]));
        expect(code).toBe(0);
        expect(cap.out).toContain("x");
    });
});
// ── /skills: defensive — callback throws / rejects ──────────────────────
describe("/skills: callback failure recovery (defensive)", () => {
    test("Error throw ⇒ exit 1 + err message contains the reason", async () => {
        const cap = { out: "", err: "" };
        const code = await runSlashCommand("/skills", makeCtx(cap, async () => {
            throw new Error("simulated disk read failure");
        }));
        expect(code).toBe(1);
        expect(cap.err).toContain("discovery failed");
        expect(cap.err).toContain("simulated disk read failure");
    });
    test("non-Error reject (string) ⇒ still exits 1, no propagation", async () => {
        const cap = { out: "", err: "" };
        let crashed = false;
        try {
            const code = await runSlashCommand("/skills", makeCtx(cap, async () => {
                throw "raw string failure";
            }));
            expect(code).toBe(1);
        }
        catch {
            crashed = true;
        }
        expect(crashed).toBe(false);
    });
    test("/reload-skills uses the SAME defensive recovery (parity contract)", async () => {
        const cap = { out: "", err: "" };
        const code = await runSlashCommand("/reload-skills", makeCtx(cap, async () => {
            throw new Error("boom");
        }));
        expect(code).toBe(1);
        expect(cap.err).toContain("discovery failed");
        expect(cap.err).toContain("boom");
    });
});
// ── /reload-skills: output prefix differs from /skills ──────────────────
describe("/reload-skills: prefix differentiates from /skills", () => {
    test("populated ⇒ 'reloaded:' prefix (not 'skills:')", async () => {
        const cap = { out: "", err: "" };
        await runSlashCommand("/reload-skills", makeCtx(cap, async () => [{ name: "x", description: "y" }]));
        expect(cap.out).toContain("reloaded: 1 skill");
        expect(cap.out).not.toContain("skills: 1");
    });
    test("empty ⇒ 'reloaded: (0 skills found)' (not 'skills: ...')", async () => {
        const cap = { out: "", err: "" };
        await runSlashCommand("/reload-skills", makeCtx(cap, async () => []));
        expect(cap.out).toContain("reloaded:");
        expect(cap.out).toContain("0 skills found");
    });
});
// ── REPL-inside slash routing (the part that's actually new) ────────────
/** Minimal fake readline for runReplLoop. Plays back a pre-set list of inputs
 *  then signals EOF by aborting via the test-supplied controller. */
const makeRl = (lines) => {
    const trace = [];
    let i = 0;
    const rl = {
        question: async (_q) => {
            const line = lines[i++];
            if (line === undefined)
                throw new Error("rl: out of inputs");
            trace.push(line);
            return line;
        },
    };
    return { rl, trace };
};
describe("REPL-inside slash routing: /skills shortcut DOES NOT reach the model", () => {
    test("/skills routed to dispatcher (turn never called) + loop continues", async () => {
        const turnCalls = [];
        const turn = async (t) => {
            turnCalls.push(t);
        };
        // Lines: a slash command, then a plain prompt, then /exit.
        const { rl } = makeRl(["/skills", "real prompt for the model", "/exit"]);
        let skillsCalls = 0;
        const skillsCb = async () => {
            skillsCalls++;
            return [{ name: "alpha", description: "first" }];
        };
        const abort = new AbortController();
        await runReplLoop(rl, abort.signal, turn, { skills: skillsCb });
        // /skills was routed (callback fired); the plain prompt went to turn().
        expect(skillsCalls).toBe(1);
        expect(turnCalls).toEqual(["real prompt for the model"]);
    });
    test("/skills with NO slashCtx (skills callback absent) ⇒ prints 'not wired' + DOES NOT reach turn", async () => {
        const turnCalls = [];
        const turn = async (t) => {
            turnCalls.push(t);
        };
        const { rl } = makeRl(["/skills", "/exit"]);
        const abort = new AbortController();
        // Capture stdout to verify the surface message:
        const originalWrite = process.stdout.write.bind(process.stdout);
        let captured = "";
        process.stdout.write = ((s) => {
            captured += typeof s === "string" ? s : new TextDecoder().decode(s);
            return true;
        });
        try {
            await runReplLoop(rl, abort.signal, turn);
        }
        finally {
            process.stdout.write = originalWrite;
        }
        expect(captured).toContain("not wired");
        expect(turnCalls).toHaveLength(0);
    });
    test("/exit and /quit break the loop BEFORE any slash dispatch (parity)", async () => {
        const turnCalls = [];
        const turn = async (t) => {
            turnCalls.push(t);
        };
        let skillsCalls = 0;
        const skillsCb = async () => {
            skillsCalls++;
            return [];
        };
        // If the slash dispatcher hijacked /exit we'd see skillsCalls > 0 or
        // an "unknown command: /exit" line; loop must break immediately instead.
        const { rl } = makeRl(["/exit"]);
        const abort = new AbortController();
        await runReplLoop(rl, abort.signal, turn, { skills: skillsCb });
        expect(skillsCalls).toBe(0);
        expect(turnCalls).toHaveLength(0);
    });
    test("path-like tokens (e.g. '/tmp/foo') still reach turn (not mistaken for slash command)", async () => {
        // `isSlashCommand` rejects `/path/segment` so legacy file-resume tokens
        // continue to the agent path. Verify this with a path-like first line.
        const turnCalls = [];
        const turn = async (t) => {
            turnCalls.push(t);
        };
        const { rl } = makeRl(["/tmp/some/file", "/exit"]);
        const abort = new AbortController();
        let skillsCalls = 0;
        const skillsCb = async () => {
            skillsCalls++;
            return [];
        };
        await runReplLoop(rl, abort.signal, turn, { skills: skillsCb });
        expect(turnCalls).toEqual(["/tmp/some/file"]);
        expect(skillsCalls).toBe(0);
    });
    test("unknown slash command does NOT reach turn (stays at slash dispatcher)", async () => {
        const turnCalls = [];
        const turn = async (t) => {
            turnCalls.push(t);
        };
        const { rl } = makeRl(["/bogus", "/exit"]);
        const abort = new AbortController();
        // Capture stderr to confirm the dispatcher's unknown-command path fires.
        const originalErr = process.stderr.write.bind(process.stderr);
        let captured = "";
        process.stderr.write = ((s) => {
            captured += typeof s === "string" ? s : new TextDecoder().decode(s);
            return true;
        });
        try {
            await runReplLoop(rl, abort.signal, turn);
        }
        finally {
            process.stderr.write = originalErr;
        }
        expect(captured).toContain("unknown command: /bogus");
        expect(turnCalls).toHaveLength(0);
    });
});
// ── Post-review hardening (critic round 1, 2026-05-23) ──────────────────
describe("/skills + /reload-skills: zero-args contract (parity with Codex forceReloadSkills)", () => {
    test("/skills with extra arg ⇒ exit 1 + clear error message (no silent ignore)", async () => {
        const cap = { out: "", err: "" };
        const code = await runSlashCommand("/skills foo", makeCtx(cap, async () => [{ name: "x", description: "y" }]));
        expect(code).toBe(1);
        expect(cap.err).toContain("takes no arguments");
        expect(cap.err).toContain("got 1");
        // The skills callback must NOT have fired (we reject before reading disk).
        expect(cap.out).not.toContain("skills:");
    });
    test("/reload-skills with extra args ⇒ exit 1 (consistency)", async () => {
        const cap = { out: "", err: "" };
        let cbFired = false;
        const code = await runSlashCommand("/reload-skills foo bar baz", makeCtx(cap, async () => {
            cbFired = true;
            return [];
        }));
        expect(code).toBe(1);
        expect(cap.err).toContain("takes no arguments");
        expect(cap.err).toContain("got 3");
        expect(cbFired).toBe(false);
    });
});
describe("/skills: callback non-Error rejection coerced cleanly (no 'undefined' leak)", () => {
    test("string throw ⇒ err message contains the string verbatim (NOT 'undefined')", async () => {
        const cap = { out: "", err: "" };
        const code = await runSlashCommand("/skills", makeCtx(cap, async () => {
            throw "raw string failure";
        }));
        expect(code).toBe(1);
        expect(cap.err).toContain("raw string failure");
        expect(cap.err).not.toContain("undefined");
    });
    test("number throw ⇒ String() coercion (number reaches the err message)", async () => {
        const cap = { out: "", err: "" };
        const code = await runSlashCommand("/skills", makeCtx(cap, async () => {
            throw 42;
        }));
        expect(code).toBe(1);
        expect(cap.err).toContain("42");
        expect(cap.err).not.toContain("undefined");
    });
    test("null throw ⇒ String(null) === 'null' (defensive)", async () => {
        const cap = { out: "", err: "" };
        const code = await runSlashCommand("/skills", makeCtx(cap, async () => {
            throw null;
        }));
        expect(code).toBe(1);
        expect(cap.err).toContain("null");
    });
});
describe("/skills: grapheme-aware truncation (no emoji / surrogate splitting)", () => {
    test("emoji at the truncation boundary is NOT split mid-codepoint", async () => {
        const cap = { out: "", err: "" };
        // Build a description where the naive `slice(0, 97)` would land in the
        // middle of a high-plane emoji (length 2 UTF-16 units). The emoji `🦄` is
        // U+1F984 (surrogate pair). Position emoji so the truncation point lands
        // INSIDE it.
        const desc = `${"A".repeat(96)}🦄${"B".repeat(50)}`; // length > 100, emoji at index 96-97
        await runSlashCommand("/skills", makeCtx(cap, async () => [{ name: "x", description: desc }]));
        // Extract just the rendered description (before any [paths:] suffix).
        // The render line is `  x<padding> <desc>` so we look for "A...A" and
        // verify NO lone surrogate appears.
        const match = /  x +([^\n]*)/.exec(cap.out);
        expect(match).not.toBeNull();
        const rendered = match?.[1] ?? "";
        // Lone-surrogate detection: scan for unpaired surrogates.
        let hasLoneSurrogate = false;
        for (let i = 0; i < rendered.length; i++) {
            const code = rendered.charCodeAt(i);
            if (code >= 0xd800 && code <= 0xdbff) {
                // high surrogate — must be followed by a low surrogate
                const next = rendered.charCodeAt(i + 1);
                if (!(next >= 0xdc00 && next <= 0xdfff))
                    hasLoneSurrogate = true;
                i++; // skip the low surrogate we just verified
            }
            else if (code >= 0xdc00 && code <= 0xdfff) {
                // low surrogate not preceded by a high surrogate
                hasLoneSurrogate = true;
            }
        }
        expect(hasLoneSurrogate).toBe(false);
        expect(rendered).toContain("...");
    });
    test("ZWJ family sequence not broken mid-cluster (👨‍👩‍👧‍👦 stays intact or is dropped wholesale)", async () => {
        const cap = { out: "", err: "" };
        // Family emoji is a ZWJ cluster (multiple codepoints, single grapheme).
        // Place it near the truncation boundary.
        const family = "👨‍👩‍👧‍👦"; // 11 UTF-16 units = 1 grapheme
        const desc = `${"A".repeat(95)}${family}${"B".repeat(30)}`;
        await runSlashCommand("/skills", makeCtx(cap, async () => [{ name: "y", description: desc }]));
        const match = /  y +([^\n]*)/.exec(cap.out);
        expect(match).not.toBeNull();
        const rendered = match?.[1] ?? "";
        // If the family cluster appears in the output, it must appear in FULL
        // (all 4 component glyphs + ZWJs). The renderer either keeps it whole or
        // drops it entirely — but never a half-cluster.
        const familyIdx = rendered.indexOf("👨");
        if (familyIdx >= 0) {
            // Whole cluster must be present (substring check on the canonical form).
            expect(rendered).toContain(family);
        }
    });
});
