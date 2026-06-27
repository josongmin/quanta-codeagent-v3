#!/usr/bin/env bun
/**
 * Regenerate `src/runner/batch/corpus/repo-version-specs.ts` from the official
 * SWE-bench `MAP_REPO_VERSION_TO_SPECS` (the per-(repo,version) env/test recipe
 * SSOT). Run from the repo root:
 *
 *   bun tools/dev/regen-repo-version-specs.ts
 *
 * Requires `uvx` on PATH (downloads swebench into an ephemeral env). Step 1 dumps
 * the spec to JSON; step 2 emits the TS table. Only the gold-free env/runner
 * fields are kept (test_cmd / install / pre_install / eval_commands); per-instance
 * FAIL_TO_PASS (the answer key) is NEVER included. Multi-command test_cmd/install
 * (go/js/rust repos) are joined with " && ".
 */
import { writeFileSync } from "node:fs"
import { join } from "node:path"

const OUT = join(import.meta.dir, "..", "..", "src/runner/batch/corpus/repo-version-specs.ts")

// ── step 1: dump MAP_REPO_VERSION_TO_SPECS → JSON via uvx swebench ────────────
const PY = [
  "import json",
  "from swebench.harness.constants import MAP_REPO_VERSION_TO_SPECS as M",
  "out={r:{v:{k:s[k] for k in ('test_cmd','install','pre_install','eval_commands') if s.get(k)}",
  "  for v,s in vs.items()} for r,vs in M.items()}",
  "print(json.dumps(out))",
].join("\n")
const proc = Bun.spawn(["uvx", "--with", "swebench", "python", "-c", PY], {
  stdout: "pipe",
  stderr: "pipe",
})
const raw = await new Response(proc.stdout).text()
if ((await proc.exited) !== 0) {
  process.stderr.write(await new Response(proc.stderr).text())
  throw new Error("uvx swebench dump failed")
}
const M = JSON.parse(raw.trim()) as Record<string, Record<string, Record<string, unknown>>>

// ── step 2: emit the TS table ────────────────────────────────────────────────
const q = (x: unknown): string => JSON.stringify(x)
const str = (x: unknown): string => (Array.isArray(x) ? x.join(" && ") : String(x))
const arr = (x: unknown): readonly string[] => (Array.isArray(x) ? x : [String(x)])

let body = ""
for (const repo of Object.keys(M).sort()) {
  body += `  ${q(repo)}: {\n`
  for (const v of Object.keys(M[repo] ?? {}).sort()) {
    const e = M[repo]?.[v] ?? {}
    const parts: string[] = []
    if (e.test_cmd !== undefined) parts.push(`testCmd: ${q(str(e.test_cmd))}`)
    if (e.install !== undefined) parts.push(`install: ${q(str(e.install))}`)
    if (e.pre_install !== undefined) parts.push(`preInstall: ${q(arr(e.pre_install))}`)
    if (e.eval_commands !== undefined) parts.push(`evalCommands: ${q(arr(e.eval_commands))}`)
    body += `    ${q(v)}: { ${parts.join(", ")} },\n`
  }
  body += "  },\n"
}

const header = `/**
 * (repo, version) -> SWE-bench ENVIRONMENT/test recipe. GENERATED from the official
 * \`MAP_REPO_VERSION_TO_SPECS[repo][v]\` (swebench PyPI) -- GROUND TRUTH, not guessed,
 * and the SAME source \`repo-version-python.ts\` derives \`.python\` from.
 *
 * Why (jun-27): per-framework repro/test execution was hand-ported inline
 * (\`if repo === "django/django"\` -> \`runtests.py --settings=test_sqlite\`), a
 * heuristic that ALSO ignored version (django 1.9 has NO --settings=test_sqlite,
 * 1.10 does) and duplicated a value the spec already owns. Competitors (agentless,
 * trae) run repro INSIDE this spec env, never an inline branch. This table is that
 * env, derived once from the SSOT so every repo/version is covered, zero inline
 * framework branches.
 *
 * GOLD-FREE: testCmd is the BARE runner template (no instance test names). The
 * per-instance FAIL_TO_PASS directives are the ANSWER KEY and live ONLY in the
 * grading oracle -- NEVER append them on an agent path. Multi-command test_cmd/
 * install (go/js/rust repos) are joined with " && " at generation time.
 *
 * DO NOT EDIT BY HAND. Regenerate: \`bun tools/dev/regen-repo-version-specs.ts\`
 */

export interface RepoVersionSpec {
  readonly testCmd?: string
  readonly install?: string
  readonly preInstall?: readonly string[]
  readonly evalCommands?: readonly string[]
}

const REPO_VERSION_SPECS: Readonly<Record<string, Readonly<Record<string, RepoVersionSpec>>>> = {
`

const footer = `}

/** Bare test-runner command for (repo, version) from the SWE-bench spec, or
 *  undefined when unknown. GOLD-FREE: no instance test names. */
export const specTestCmd = (repo: string, version: string | undefined): string | undefined =>
  version === undefined ? undefined : REPO_VERSION_SPECS[repo]?.[version]?.testCmd

/** Spec env-setup command list (export LANG=..., etc.) for (repo, version). */
export const specEvalCommands = (repo: string, version: string | undefined): readonly string[] =>
  (version === undefined ? undefined : REPO_VERSION_SPECS[repo]?.[version]?.evalCommands) ?? []

/** Spec install command for (repo, version). */
export const specInstall = (repo: string, version: string | undefined): string | undefined =>
  version === undefined ? undefined : REPO_VERSION_SPECS[repo]?.[version]?.install

/** Spec pre-install command list for (repo, version). */
export const specPreInstall = (repo: string, version: string | undefined): readonly string[] =>
  (version === undefined ? undefined : REPO_VERSION_SPECS[repo]?.[version]?.preInstall) ?? []

/** Whether the spec knows this (repo, version). */
export const hasRepoVersionSpec = (repo: string, version: string | undefined): boolean =>
  version !== undefined && REPO_VERSION_SPECS[repo]?.[version] !== undefined

/** Whether the spec knows this repo at ALL (any version). Lets a caller tell a
 *  genuinely-unknown repo apart from a known repo on a DRIFTED (unmapped) version
 *  — the latter is a spec-coverage gap to surface, not a silent fallback. */
export const specHasRepo = (repo: string): boolean => REPO_VERSION_SPECS[repo] !== undefined

/** Resolve the test-runner for (repo, version): the EXACT spec runner, or — when
 *  that version is unmapped (drift) — the repo's most-recent mapped version's
 *  runner. A repo's runner is stable across versions, so this degrades version
 *  drift gracefully WITHOUT a repo-name branch (and keeps a runtests repo from
 *  silently mis-resolving). \`specTestCmd\` stays strictly exact for callers that
 *  need precision. */
export const specResolvedRunner = (
  repo: string,
  version: string | undefined,
): string | undefined => {
  const exact = specTestCmd(repo, version)
  if (exact !== undefined) return exact
  const vers = REPO_VERSION_SPECS[repo]
  if (vers === undefined) return undefined
  const keys = Object.keys(vers).sort()
  const last = keys[keys.length - 1]
  return last === undefined ? undefined : vers[last]?.testCmd
}

/** Classify the in-loop test runner for (repo, version). "runtests" repos (django)
 *  genuinely CANNOT run under plain pytest — their tests need the project test
 *  harness + settings (the engage=0 RCA: pytest collection dies on
 *  ImproperlyConfigured), so the oracle invokes their spec runner. Everything
 *  else is pytest-compatible and uses the uniform pytest oracle (the spec runners
 *  for those — pytest / tox-wrapping-pytest / sympy bin-test — are all
 *  pytest-collectable in-loop; their native wrappers like tox aren't on the uv
 *  env anyway). Derived from the spec runner (drift-resilient via
 *  \`specResolvedRunner\`): this is the ONE place runner-name knowledge lives,
 *  so no logic file needs a per-framework literal, and an unmapped version of a
 *  runtests repo still classifies "runtests" rather than silently mis-routing. */
export const specRunnerKind = (
  repo: string,
  version: string | undefined,
): "runtests" | "pytest" => {
  const t = specResolvedRunner(repo, version)
  return t !== undefined && t.includes("runtests.py") ? "runtests" : "pytest"
}
`

writeFileSync(OUT, header + body + footer)
process.stdout.write(`wrote ${OUT} (${Object.keys(M).length} repos)\n`)
