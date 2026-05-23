/**
 * `ci-bot` mode preset wiring — RFC may-22 Phase 5.
 *
 * Bridges the data-only `MODE_PRESETS["ci-bot"]` into a runnable AgentConfig:
 *
 *   - toolSurface  ⇒ ci-safe tool set = defaultTools (read/edit/grep/bash/
 *                    test_runner) + gitTools + ghTools. NO MCP, NO hooks,
 *                    NO write-to-host-fs outside workspace.
 *   - promptPack   ⇒ pr-agent rules already wired via prompt.ts opt.
 *   - gitWrite     ⇒ branch-only — exposed for the dispatch seam to consult
 *                    when bash invokes git.
 *   - network      ⇒ allowlist — same.
 *   - secrets      ⇒ CI-scoped — `scrubEnv` with CI-only allowlist.
 *
 * This file is the SINGLE place that knows ci-bot's concrete wiring. New
 * lever implementations land here (e.g. when ci-bot adds a webhook hook).
 */
import { DEFAULT_PROTECTED_BRANCHES, decideBranchOnly } from "@/permission/branch-only";
import { CI_BOT_DEFAULT_ALLOWLIST } from "@/runtime/network-allowlist";
import { defaultGitRunner, gitTools } from "@/tool";
import { defaultGhRunner, ghTools } from "@/tool/gh";
/** CI-scoped env var allowlist. Excludes user secrets (OPENAI_API_KEY etc).
 *  Includes only what `gh` and the test runners need. */
export const CI_ENV_ALLOWLIST = Object.freeze([
    // runtime essentials
    "PATH",
    "HOME",
    "TMPDIR",
    "LANG",
    "LC_ALL",
    // GitHub auth
    "GH_TOKEN",
    "GITHUB_TOKEN",
    "GITHUB_REPOSITORY",
    "GITHUB_REF",
    "GITHUB_SHA",
    "GITHUB_ACTIONS",
    "GITHUB_RUN_ID",
    "GITHUB_RUN_NUMBER",
    "GITHUB_WORKFLOW",
    // git config
    "GIT_AUTHOR_NAME",
    "GIT_AUTHOR_EMAIL",
    "GIT_COMMITTER_NAME",
    "GIT_COMMITTER_EMAIL",
]);
const dedupe = (a, b) => {
    const seen = new Set();
    const out = [];
    for (const x of [...a, ...b]) {
        if (!seen.has(x)) {
            seen.add(x);
            out.push(x);
        }
    }
    return Object.freeze(out);
};
/** Build the ci-bot wiring bundle. Pure: returns a frozen plan; the caller
 *  feeds the tool list into `apps/agent/assemble.ts` and the helpers into
 *  the dispatch seam. */
export const buildCiBotWiring = (opts = {}) => {
    const allowlist = dedupe(CI_BOT_DEFAULT_ALLOWLIST, opts.extraAllowedHosts ?? []);
    const branches = dedupe(DEFAULT_PROTECTED_BRANCHES, opts.extraProtectedBranches ?? []);
    const tools = [
        ...gitTools(defaultGitRunner),
        ...ghTools(opts.ghRunner ?? defaultGhRunner),
    ];
    return Object.freeze({
        tools,
        networkAllowlist: allowlist,
        protectedBranches: branches,
        envAllowlist: CI_ENV_ALLOWLIST,
        isGitWriteAllowed: (command, currentBranch) => decideBranchOnly(command, branches, currentBranch).allowed,
        branchOnlyReason: (command, currentBranch) => {
            const v = decideBranchOnly(command, branches, currentBranch);
            return v.allowed ? undefined : v.reason;
        },
    });
};
