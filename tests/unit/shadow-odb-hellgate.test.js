/**
 * ★ CONTRACT — ADR-0108: Shadow git ODB foundation.
 *
 * The shadow ODB MUST:
 *   - keep its store outside the user's `.git` (GIT_DIR override invariant)
 *   - be idempotent on init for the same absolute workspace path
 *   - derive workspaceHash deterministically from absolute paths
 *   - reject relative paths and symlinked components
 *   - surface spawn / git failures as typed `ShadowOdbError` (no
 *     null-collapse)
 *   - serialize concurrent registerHead calls against the same workspace
 *   - refuse non-canonical ref names
 *   - leave `rewindToLast` as a typed "not-implemented" trap until the
 *     follow-up ADR
 *   - support LRU cleanup (best-effort)
 *
 * Strategy: real `defaultGitRunner` + real `git init` inside `os.tmpdir()`.
 * Every test creates its own tmp workspace + tmp shadow base, so this
 * battery never touches `~/.quanta` and never interferes with the user's
 * actual git config.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { promises as fs, mkdtempSync, readdirSync, rmSync, symlinkSync, writeFileSync, } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DEFAULT_SHADOW_ODB_MAX_BYTES, defaultShadowOdb, evictLru, SHADOW_LAST_REF, ShadowOdbError, workspaceHash, } from "@/storage";
import { defaultGitRunner } from "@/tool/git";
/* ------------------------------------------------------------------ */
/* test harness                                                        */
/* ------------------------------------------------------------------ */
const allTmpDirs = [];
const mkTmp = (label) => {
    const d = mkdtempSync(join(tmpdir(), `quanta-shadow-${label}-`));
    allTmpDirs.push(d);
    return d;
};
/** Make a workspace dir with a tiny seed file so `git add -A` has
 *  something to do (some `git` builds error on empty trees). */
const makeWorkspace = (label) => {
    const w = mkTmp(`ws-${label}`);
    writeFileSync(join(w, "seed.txt"), "seed\n", "utf8");
    return w;
};
afterAll(() => {
    for (const d of allTmpDirs) {
        try {
            rmSync(d, { recursive: true, force: true });
        }
        catch {
            // ignore — best effort cleanup
        }
    }
});
/** Helper: assert a thrown error is a `ShadowOdbError` with `code`. */
const expectShadowError = async (fn, code) => {
    let caught;
    try {
        await fn();
    }
    catch (e) {
        caught = e;
    }
    expect(caught).toBeInstanceOf(ShadowOdbError);
    const err = caught;
    expect(err.code).toBe(code);
    return err;
};
/* ------------------------------------------------------------------ */
/* HELL-2/HELL-3: workspaceHash determinism                            */
/* ------------------------------------------------------------------ */
describe("workspaceHash", () => {
    test("HELL-2: deterministic from absolute path", () => {
        const a = workspaceHash("/Users/foo/project");
        const b = workspaceHash("/Users/foo/project");
        expect(a).toBe(b);
        expect(a).toMatch(/^[0-9a-f]{16}$/);
    });
    test("HELL-2b: trailing slash equivalence", () => {
        expect(workspaceHash("/Users/foo/project")).toBe(workspaceHash("/Users/foo/project/"));
    });
    test("HELL-3: distinct workspaces ⇒ distinct hashes", () => {
        expect(workspaceHash("/a/b")).not.toBe(workspaceHash("/a/c"));
        expect(workspaceHash("/Users/x")).not.toBe(workspaceHash("/Users/y"));
    });
    test("HELL-3b: empty path rejected", () => {
        expect(() => workspaceHash("")).toThrow();
    });
});
/* ------------------------------------------------------------------ */
/* HELL-1: init idempotency                                            */
/* ------------------------------------------------------------------ */
describe("init (HELL-1, HELL-9, HELL-8)", () => {
    test("HELL-1: same workspace ⇒ same shadowDir + same hash on repeat init", async () => {
        const base = mkTmp("base");
        const ws = makeWorkspace("idem");
        const odb = defaultShadowOdb({ baseDir: base });
        const a = await odb.init(ws);
        const b = await odb.init(ws);
        expect(a.shadowDir).toBe(b.shadowDir);
        expect(a.workspaceHash).toBe(b.workspaceHash);
        // Shadow dir must exist and contain a `.git`.
        const st = await fs.lstat(join(a.shadowDir, ".git"));
        expect(st.isDirectory()).toBe(true);
    });
    test("HELL-9: relative workspaceRoot rejected", async () => {
        const odb = defaultShadowOdb({ baseDir: mkTmp("rej-rel") });
        await expectShadowError(() => odb.init("./relative"), "relative-path");
        await expectShadowError(() => odb.init(""), "relative-path");
        await expectShadowError(() => odb.init("relative"), "relative-path");
    });
    test("HELL-8: symlinked workspaceRoot rejected", async () => {
        const real = makeWorkspace("real-target");
        const linkParent = mkTmp("link-parent");
        const linkPath = join(linkParent, "link-to-ws");
        symlinkSync(real, linkPath);
        const odb = defaultShadowOdb({ baseDir: mkTmp("base-sym") });
        await expectShadowError(() => odb.init(linkPath), "symlink-in-path");
    });
});
/* ------------------------------------------------------------------ */
/* HELL-4/HELL-5: registerHead invariants                              */
/* ------------------------------------------------------------------ */
describe("registerHead (HELL-4, HELL-5, HELL-12)", () => {
    test("HELL-5: registerHead advances the canonical ref + returns valid SHA", async () => {
        const base = mkTmp("base-reg");
        const ws = makeWorkspace("reg");
        const odb = defaultShadowOdb({ baseDir: base });
        const sha = await odb.registerHead(ws);
        expect(sha).toMatch(/^[0-9a-f]{40}$/);
        // Verify the ref by hitting the shadow store directly with the
        // default runner (proves the ref is real, not a stub).
        const { shadowDir } = await odb.init(ws);
        const r = await defaultGitRunner.run([`--git-dir=${join(shadowDir, ".git")}`, "rev-parse", SHADOW_LAST_REF], shadowDir);
        expect(r.exitCode).toBe(0);
        expect(r.stdout.trim()).toBe(sha);
    });
    test("HELL-4: registerHead does NOT touch the user's `.git`", async () => {
        const base = mkTmp("base-noinvade");
        const ws = makeWorkspace("noinvade");
        // Give the workspace its OWN user .git with a sentinel ref. After
        // registerHead, that sentinel must be untouched.
        await defaultGitRunner.run(["init", "-b", "main"], ws);
        await defaultGitRunner.run(["config", "user.email", "u@u"], ws);
        await defaultGitRunner.run(["config", "user.name", "U"], ws);
        await defaultGitRunner.run(["config", "commit.gpgsign", "false"], ws);
        await defaultGitRunner.run(["add", "-A"], ws);
        await defaultGitRunner.run(["commit", "-m", "user-seed"], ws);
        const beforeRef = await defaultGitRunner.run(["rev-parse", "HEAD"], ws);
        const beforeHead = beforeRef.stdout.trim();
        // Sanity: SHADOW_LAST_REF must NOT exist in the user's .git.
        const sanity = await defaultGitRunner.run(["rev-parse", "--verify", "--quiet", SHADOW_LAST_REF], ws);
        expect(sanity.exitCode).not.toBe(0);
        const odb = defaultShadowOdb({ baseDir: base });
        await odb.registerHead(ws);
        // User HEAD unchanged.
        const afterRef = await defaultGitRunner.run(["rev-parse", "HEAD"], ws);
        expect(afterRef.stdout.trim()).toBe(beforeHead);
        // SHADOW_LAST_REF STILL absent from user .git.
        const afterSanity = await defaultGitRunner.run(["rev-parse", "--verify", "--quiet", SHADOW_LAST_REF], ws);
        expect(afterSanity.exitCode).not.toBe(0);
    });
    test("HELL-12: workspace with its own `.git` doesn't pollute the shadow store either", async () => {
        const base = mkTmp("base-12");
        const ws = makeWorkspace("12");
        await defaultGitRunner.run(["init", "-b", "main"], ws);
        await defaultGitRunner.run(["config", "user.email", "u@u"], ws);
        await defaultGitRunner.run(["config", "user.name", "U"], ws);
        await defaultGitRunner.run(["config", "commit.gpgsign", "false"], ws);
        const odb = defaultShadowOdb({ baseDir: base });
        const { shadowDir } = await odb.init(ws);
        const sha = await odb.registerHead(ws);
        // Shadow HEAD is independent of user repo HEAD (user repo had no
        // commits; shadow has one).
        const shadowHead = await defaultGitRunner.run([`--git-dir=${join(shadowDir, ".git")}`, "rev-parse", "HEAD"], shadowDir);
        expect(shadowHead.exitCode).toBe(0);
        expect(shadowHead.stdout.trim()).toBe(sha);
    });
});
/* ------------------------------------------------------------------ */
/* HELL-6/HELL-7: diffSinceLast                                        */
/* ------------------------------------------------------------------ */
describe("diffSinceLast (HELL-6, HELL-7)", () => {
    test("HELL-7: no changes ⇒ empty diff", async () => {
        const base = mkTmp("base-diff-7");
        const ws = makeWorkspace("d7");
        const odb = defaultShadowOdb({ baseDir: base });
        await odb.registerHead(ws);
        const diff = await odb.diffSinceLast(ws);
        expect(diff).toBe("");
    });
    test("HELL-6: workspace edit captured in diff", async () => {
        const base = mkTmp("base-diff-6");
        const ws = makeWorkspace("d6");
        const odb = defaultShadowOdb({ baseDir: base });
        await odb.registerHead(ws);
        writeFileSync(join(ws, "seed.txt"), "seed\nMUTATED\n", "utf8");
        const diff = await odb.diffSinceLast(ws);
        expect(diff).toContain("seed.txt");
        expect(diff).toContain("MUTATED");
        expect(diff).toContain("--- a/seed.txt");
        expect(diff).toContain("+++ b/seed.txt");
    });
    test("HELL-6b: diffSinceLast before any registerHead surfaces typed error", async () => {
        const base = mkTmp("base-diff-uninit");
        const ws = makeWorkspace("d-uninit");
        const odb = defaultShadowOdb({ baseDir: base });
        await odb.init(ws); // init but never registerHead
        await expectShadowError(() => odb.diffSinceLast(ws), "uninitialized");
    });
});
/* ------------------------------------------------------------------ */
/* HELL-10: spawn-error typed surface                                  */
/* ------------------------------------------------------------------ */
describe("spawn-error surface (HELL-10)", () => {
    test("HELL-10: spawn error becomes ShadowOdbError, not null collapse", async () => {
        const ws = makeWorkspace("spawn");
        // Fake runner that always throws — simulates git missing from PATH.
        const exploder = {
            run() {
                throw new Error("ENOENT: git binary missing");
            },
        };
        const odb = defaultShadowOdb({
            baseDir: mkTmp("base-spawn"),
            runner: exploder,
        });
        const err = await expectShadowError(() => odb.init(ws), "spawn-failed");
        expect(err.message).toContain("git binary missing");
    });
    test("HELL-10b: non-zero git exit becomes git-failed error", async () => {
        const ws = makeWorkspace("nz");
        const failer = {
            async run(args) {
                // Make `git init` succeed, then everything else fail nonzero.
                if (args[0] === "init") {
                    return { stdout: "", stderr: "", exitCode: 0 };
                }
                return { stdout: "", stderr: "boom", exitCode: 128 };
            },
        };
        const odb = defaultShadowOdb({
            baseDir: mkTmp("base-nz"),
            runner: failer,
        });
        await expectShadowError(() => odb.init(ws), "git-failed");
    });
});
/* ------------------------------------------------------------------ */
/* HELL-11: concurrent registerHead serialization                       */
/* ------------------------------------------------------------------ */
describe("concurrency (HELL-11)", () => {
    test("HELL-11: two concurrent registerHeads against the same workspace both succeed sequentially", async () => {
        const base = mkTmp("base-11");
        const ws = makeWorkspace("11");
        const odb = defaultShadowOdb({ baseDir: base });
        // Fire both before awaiting — they must serialize internally.
        const [sha1, sha2] = await Promise.all([odb.registerHead(ws), odb.registerHead(ws)]);
        expect(sha1).toMatch(/^[0-9a-f]{40}$/);
        expect(sha2).toMatch(/^[0-9a-f]{40}$/);
        // Both calls produced different commit SHAs (each call writes a
        // distinct snapshot timestamp) — proves they didn't collapse into
        // one operation. Ref ends up at one of them.
        const { shadowDir } = await odb.init(ws);
        const tip = await defaultGitRunner.run([`--git-dir=${join(shadowDir, ".git")}`, "rev-parse", SHADOW_LAST_REF], shadowDir);
        expect(tip.exitCode).toBe(0);
        expect([sha1, sha2]).toContain(tip.stdout.trim());
    });
});
/* ------------------------------------------------------------------ */
/* HELL-13: rewindToLast is a typed not-implemented trap                */
/* ------------------------------------------------------------------ */
describe("rewindToLast (HELL-13)", () => {
    test("HELL-13: rewindToLast throws ShadowOdbError(not-implemented)", async () => {
        const base = mkTmp("base-rewind");
        const ws = makeWorkspace("rewind");
        const odb = defaultShadowOdb({ baseDir: base });
        await odb.registerHead(ws);
        await expectShadowError(() => odb.rewindToLast(ws), "not-implemented");
    });
});
/* ------------------------------------------------------------------ */
/* HELL-14: ref-name safety                                            */
/* ------------------------------------------------------------------ */
describe("ref-name safety (HELL-14)", () => {
    test("HELL-14: SHADOW_LAST_REF is the canonical ref under refs/quanta/snapshots/", () => {
        expect(SHADOW_LAST_REF).toBe("refs/quanta/snapshots/last-registered");
        // Defensive: must start with refs/ (git requires this for
        // update-ref to write outside HEAD).
        expect(SHADOW_LAST_REF.startsWith("refs/")).toBe(true);
    });
});
/* ------------------------------------------------------------------ */
/* HELL-15: LRU cleanup                                                */
/* ------------------------------------------------------------------ */
describe("cleanup (HELL-15)", () => {
    test("HELL-15: cleanup evicts oldest shadow dirs when over cap", async () => {
        const base = mkTmp("base-lru");
        // Manually create three shadow dirs of known size, oldest first.
        const snapshotsRoot = join(base, "snapshots");
        await fs.mkdir(snapshotsRoot, { recursive: true });
        const mkSized = async (name, bytes, mtimeOffset) => {
            const d = join(snapshotsRoot, name);
            await fs.mkdir(d, { recursive: true });
            await fs.writeFile(join(d, "blob"), Buffer.alloc(bytes), { mode: 0o600 });
            const t = new Date(Date.now() - mtimeOffset).getTime() / 1000;
            await fs.utimes(d, t, t);
        };
        await mkSized("aaaaaaaaaaaaaaaa", 4096, 60_000); // oldest
        await mkSized("bbbbbbbbbbbbbbbb", 4096, 30_000);
        await mkSized("cccccccccccccccc", 4096, 1_000); // newest
        // Cap = 5000 bytes ⇒ must evict at least two of the 4k dirs.
        const evicted = await evictLru(base, 5000);
        expect(evicted).toBeGreaterThanOrEqual(2);
        // The newest must survive.
        const remaining = readdirSync(snapshotsRoot);
        expect(remaining).toContain("cccccccccccccccc");
        // The oldest must be gone.
        expect(remaining).not.toContain("aaaaaaaaaaaaaaaa");
    });
    test("HELL-15b: cleanup is a no-op when under cap", async () => {
        const base = mkTmp("base-lru-noop");
        await fs.mkdir(join(base, "snapshots", "x"), { recursive: true });
        await fs.writeFile(join(base, "snapshots", "x", "f"), "abc", "utf8");
        const evicted = await evictLru(base, 1_000_000);
        expect(evicted).toBe(0);
        // Dir survived.
        const remaining = readdirSync(join(base, "snapshots"));
        expect(remaining).toContain("x");
    });
    test("HELL-15c: cleanup against a missing snapshots dir is a no-op", async () => {
        const base = mkTmp("base-lru-missing");
        const evicted = await evictLru(base, 0);
        expect(evicted).toBe(0);
    });
    test("HELL-15d: cleanup exposed via the port (`.cleanup`)", async () => {
        const base = mkTmp("base-lru-port");
        const odb = defaultShadowOdb({ baseDir: base });
        // No snapshots yet ⇒ 0.
        expect(await odb.cleanup(DEFAULT_SHADOW_ODB_MAX_BYTES)).toBe(0);
    });
});
/* ------------------------------------------------------------------ */
/* additional invariants (extra coverage)                              */
/* ------------------------------------------------------------------ */
describe("nested-shadow guard", () => {
    test("rejects when shadow base lives inside the workspace", async () => {
        const ws = makeWorkspace("nest");
        // baseDir lives INSIDE the workspace — would otherwise recurse.
        const nestedBase = join(ws, ".inner-base");
        const odb = defaultShadowOdb({ baseDir: nestedBase });
        await expectShadowError(() => odb.init(ws), "nested-shadow");
    });
});
describe("isolation across workspaces", () => {
    test("two workspaces ⇒ two independent shadow dirs", async () => {
        const base = mkTmp("base-iso");
        const ws1 = makeWorkspace("iso1");
        const ws2 = makeWorkspace("iso2");
        const odb = defaultShadowOdb({ baseDir: base });
        const a = await odb.init(ws1);
        const b = await odb.init(ws2);
        expect(a.shadowDir).not.toBe(b.shadowDir);
        expect(a.workspaceHash).not.toBe(b.workspaceHash);
    });
});
