/**
 * Git snapshot helpers — pre-image checkout + post-image cumulative diff.
 *
 * Owns: `withGitSnapshot`, `gitStageAndDiffCached`, `GIT_ARGV`, `sourceOnlyDiff`,
 * and the `ENV_POLICY_VERSION` + `gatherSandbox` snapshot probe. Pulled
 * verbatim from runner.ts (T2 prune-at-source pathspec exclusion already wired
 * via `getCachePathspecs`).
 */
import { getCachePathspecs } from "../corpus/cache-pathspecs";
import { exec, execArgv, trimOut } from "./exec";
/**
 * Common git argv prefix for bench-internal commits — matches the `${G}`
 * shell-string form used elsewhere but as an array so pathspec args stay
 * intact (no shell word-splitting). The `-c` overrides also bypass any user
 * `commit.gpgsign` config that would prompt for a signing key.
 */
export const GIT_ARGV = [
    "git",
    "-c",
    "user.email=b@b",
    "-c",
    "user.name=b",
    "-c",
    "commit.gpgsign=false",
];
/** SWE-bench predictions must be SOURCE-only: the official harness applies its
 *  own gold `test_patch`, so any test-file hunk a model emits is at best
 *  discarded and at worst conflicts with / skews grading (observed: agents
 *  editing `tests/` produced large diffs that failed PASS_TO_PASS). Drop the
 *  per-file sections of a unified `git diff` whose path is a test file/dir.
 *  Pure, order-preserving; non-test (source) hunks pass through verbatim. */
const TEST_PATH_RE = /(^|\/)tests?\//i;
const TEST_FILE_RE = /(^|\/)(test_[^/]+|[^/]+_test|conftest)\.(py|js|ts|tsx)$/i;
export const sourceOnlyDiff = (diff) => {
    if (diff.trim() === "")
        return diff;
    const out = [];
    let skip = false;
    for (const line of diff.split("\n")) {
        const m = line.match(/^diff --git a\/\S+ b\/(\S+)/);
        if (m) {
            const p = m[1] ?? "";
            skip = TEST_PATH_RE.test(p) || TEST_FILE_RE.test(p);
        }
        if (!skip)
            out.push(line);
    }
    return out.join("\n");
};
/**
 * Stage everything in the worktree and capture the unified index diff with
 * cache-shaped paths pruned AT SOURCE (T2 — patch sanitizer prune-at-source).
 * Two steps because `git add -A` cannot share the same argv invocation as
 * `git diff --cached` without a shell `&&`, and a shell would re-process the
 * pathspec magic chars; here both steps run via argv-form `execArgv` so the
 * pathspecs reach git verbatim.
 *
 * Returns "" on any git failure (opportunistic, matches surrounding policy).
 */
export const gitStageAndDiffCached = async (cwd, timeoutMs) => {
    const add = await execArgv([...GIT_ARGV, "add", "-A"], cwd, timeoutMs);
    if (add.code !== 0)
        return "";
    const diff = await execArgv([...GIT_ARGV, "diff", "--cached", "--no-color", "--", ".", ...getCachePathspecs()], cwd, timeoutMs);
    return diff.code === 0 ? sourceOnlyDiff(diff.stdout) : "";
};
/**
 * Snapshot helper: take a pre-image, run the agent, then diff.
 *
 * If the sandbox already contains a `.git` (real swebench cache repos do) and
 * `baseCommit` is supplied, we hard-checkout that commit FIRST so the agent
 * starts from the canonical buggy tree, then commit it as the pristine base.
 * Otherwise we `git init` a fresh repo over the copied files. After the agent
 * runs, `git add -A && git diff --cached` yields a proper unified
 * `diff --git a/… b/…` patch — exactly the SWE-bench prediction format. `git`
 * is opportunistic; absence/failure ⇒ "" rather than throwing.
 */
export const withGitSnapshot = async (sandbox, timeoutMs, baseCommit, body) => {
    const G = "git -c user.email=b@b -c user.name=b -c commit.gpgsign=false";
    const hasGit = (await exec("git rev-parse --git-dir", sandbox, timeoutMs)).code === 0;
    const prep = hasGit && baseCommit
        ? `${G} checkout -q -f ${baseCommit} && ${G} reset -q --hard ${baseCommit} && ${G} clean -qfdx`
        : `git init -q . && ${G} add -A && ${G} commit -q -m base --allow-empty`;
    const init = await exec(prep, sandbox, timeoutMs);
    await body();
    if (init.code !== 0)
        return "";
    // T2: exclude cache/build paths at the git layer via pathspec — pruning at
    // source is structural, where the prior post-hoc filter let mixed
    // source+cache patches (django leak, 2026-05-21) through.
    return gitStageAndDiffCached(sandbox, timeoutMs);
};
/**
 * Env-scrub policy version tied to the sandbox allowlist. Bumped only when the
 * scrub allowlist changes; stamped into every `sandbox` event so a trajectory
 * records which policy governed the run. `sandbox.v2` (Group A coordinated):
 * the allowlist no longer carries NODE_OPTIONS/NODE_EXTRA_CA_CERTS, and bench
 * `exec()` now spawns children with `scrubEnv()` — so the stamp is truthful.
 */
const ENV_POLICY_VERSION = "sandbox.v2";
/** Best-effort `<bin> --version` → first line, or undefined. */
const probeVersion = async (bin, sandbox, timeoutMs) => {
    const r = await exec(`${bin} --version 2>&1 | head -n1`, sandbox, timeoutMs);
    return trimOut(r);
};
/**
 * One-shot sandbox snapshot (RFC §5.2 `sandbox`). Gathered AFTER the repo is
 * copied + base-checked-out and BEFORE the agent runs, so `repoCommit` is the
 * pristine pre-agent HEAD. `git` is opportunistic — absence ⇒ empty commits,
 * never throws. `python` is best-effort/optional.
 */
export const gatherSandbox = async (sandbox, baseCommit, timeoutMs) => {
    const head = await exec("git rev-parse HEAD", sandbox, timeoutMs);
    const status = await exec("git status --porcelain", sandbox, timeoutMs);
    const [bun, node, python] = await Promise.all([
        probeVersion("bun", sandbox, timeoutMs),
        probeVersion("node", sandbox, timeoutMs),
        probeVersion("python3", sandbox, timeoutMs),
    ]);
    const runtime = {
        ...(bun !== "" ? { bun } : {}),
        ...(node !== "" ? { node } : {}),
        ...(python !== "" ? { python } : {}),
    };
    return {
        repoCommit: trimOut(head),
        baseCommit: baseCommit ?? trimOut(head),
        worktreeDirty: status.code === 0 && status.stdout.trim() !== "",
        runtime,
        envPolicyVersion: ENV_POLICY_VERSION,
    };
};
