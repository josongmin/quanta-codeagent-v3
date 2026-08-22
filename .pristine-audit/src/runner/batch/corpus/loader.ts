/**
 * SWE-bench corpus adapter.
 *
 * ── REAL corpus layout (discovered, primary) ──────────────────────────────
 * The `quanta-benchmark-corpus` directory pointed at by
 * `QUANTA_SWEBENCH_CORPUS_ROOT` is NOT a flat manifest. Its `swebench.verified`
 * corpus is laid out as:
 *
 *   tasks/repo/swebench/<task_id>.yaml          one task per file. Fields used:
 *       task_id            e.g. py.repo.swebench_astropy.001
 *       repo_ref           a repo_id, e.g. swebench.python.astropy.astropy
 *       objective.statement  natural-language problem (handed to the agent)
 *       oracle.visible_checks[].cmd            agent-visible smoke command(s)
 *       swebench_meta.{instance_id,repo,base_commit,environment_setup_commit}
 *   external/swebench/verified/repos/repo_manifest.yaml
 *       repos[].{repo_id, local_cache_path}    repo_id → a checked-out git repo
 *       (the cache repo CONTAINS swebench_meta.base_commit)
 *   manifests/swebench.repos.yaml               repo intake metadata (unused here)
 *
 * Each task → one `Instance`: `repoPath` is the cached git checkout (read-
 * only; the runner copies it and `git checkout`s base_commit per swebench_meta
 * inside the sandbox), `problemStatement` is objective.statement, `testCmd` is
 * the visible_checks command(s), and `swebench` carries the upstream metadata
 * so the optional Python harness (python-swebench.ts) can grade officially.
 *
 * Detection: a `tasks/repo/swebench` directory under `root` ⇒ real corpus.
 *
 * ── Synthetic / hand-authored layout (kept for tests, secondary) ──────────
 *   (A) `manifest.jsonl` — one Instance-shaped JSON object per line.
 *   (B) one sub-dir per instance containing `instance.json` (+ a `repo/`).
 * `writeSyntheticCorpus` emits layout (B). Missing/empty/invalid `root`
 * ⇒ `[]` (never throws) so the CLI degrades gracefully offline.
 *
 * ── Python SWE-bench seam ─────────────────────────────────────────────────
 * Real SWE-bench Verified resolution runs the official Python harness; that is
 * now implemented in `python-swebench.ts` and selected from runner.ts when
 * `QUANTA_SWEBENCH_PYTHON=1` and the harness is importable. Default-off: the
 * local `testCmd` path is unchanged.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import { byteCompare } from "@/shared"
import type { Instance } from "../types"

const exists = async (p: string): Promise<boolean> => {
  try {
    await stat(p)
    return true
  } catch {
    return false
  }
}

const resolveRepo = (root: string, raw: string | undefined, fallback: string): string => {
  if (raw === undefined) return fallback
  return isAbsolute(raw) ? raw : resolve(root, raw)
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

const asRecord = (v: unknown): Record<string, unknown> | undefined =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined

// ── Synthetic / hand-authored layouts (A) + (B) ────────────────────────────

interface RawInstance {
  id?: unknown
  repoPath?: unknown
  problemStatement?: unknown
  setupCmd?: unknown
  testCmd?: unknown
  goldPatch?: unknown
}

/** Coerce one raw record into an Instance, or null if required fields are
 *  missing/ill-typed (skipped, never throws). */
const toInstance = (root: string, raw: RawInstance, fallbackRepo: string): Instance | null => {
  const id = str(raw.id)
  const problemStatement = str(raw.problemStatement)
  const testCmd = str(raw.testCmd)
  if (!id || !problemStatement || !testCmd) return null
  const setupCmd = str(raw.setupCmd)
  const goldPatch = str(raw.goldPatch)
  return {
    id,
    repoPath: resolveRepo(root, str(raw.repoPath), fallbackRepo),
    problemStatement,
    testCmd,
    ...(setupCmd !== undefined ? { setupCmd } : {}),
    ...(goldPatch !== undefined ? { goldPatch } : {}),
  }
}

const loadManifest = async (root: string, file: string): Promise<Instance[]> => {
  const text = await readFile(file, "utf8")
  const out: Instance[] = []
  for (const line of text.split("\n")) {
    const trimmed = line.trim()
    if (trimmed === "") continue
    try {
      const inst = toInstance(root, JSON.parse(trimmed) as RawInstance, root)
      if (inst) out.push(inst)
    } catch {
      // skip malformed line
    }
  }
  return out
}

const loadDirInstance = async (root: string, dir: string): Promise<Instance | null> => {
  const metaPath = join(dir, "instance.json")
  if (!(await exists(metaPath))) return null
  try {
    const raw = JSON.parse(await readFile(metaPath, "utf8")) as RawInstance
    return toInstance(root, raw, join(dir, "repo"))
  } catch {
    return null
  }
}

const loadDirCorpus = async (root: string): Promise<Instance[]> => {
  const entries = await readdir(root, { withFileTypes: true })
  const out: Instance[] = []
  for (const e of entries) {
    if (!e.isDirectory()) continue
    const inst = await loadDirInstance(root, join(root, e.name))
    if (inst) out.push(inst)
  }
  return out.sort((a, b) => byteCompare(a.id, b.id))
}

// ── Real `swebench.verified` corpus (primary) ──────────────────────────────

const SWEBENCH_TASK_DIR = join("tasks", "repo", "swebench")
const REPO_MANIFEST = join("external", "swebench", "verified", "repos", "repo_manifest.yaml")

/** repo_id → resolved absolute cache path, from repo_manifest.yaml. Empty map
 *  on any read/parse failure (callers then skip those instances). */
const loadRepoCacheMap = async (root: string): Promise<Map<string, string>> => {
  const map = new Map<string, string>()
  const file = join(root, REPO_MANIFEST)
  if (!(await exists(file))) return map
  try {
    const doc = asRecord(Bun.YAML.parse(await readFile(file, "utf8")))
    const repos = doc?.repos
    if (!Array.isArray(repos)) return map
    for (const entry of repos) {
      const rec = asRecord(entry)
      const repoId = str(rec?.repo_id)
      const cachePath = str(rec?.local_cache_path)
      if (repoId && cachePath) map.set(repoId, resolve(root, cachePath))
    }
  } catch {
    // unreadable/malformed manifest → no mappings
  }
  return map
}

/** Join all visible_checks `cmd`s with `&&` so every smoke check must pass.
 *  Returns "" when none are present (instance is then skipped). */
const visibleChecksCmd = (oracle: Record<string, unknown> | undefined): string => {
  const checks = oracle?.visible_checks
  if (!Array.isArray(checks)) return ""
  const cmds: string[] = []
  for (const c of checks) {
    const cmd = str(asRecord(c)?.cmd)
    if (cmd && cmd.trim() !== "") cmds.push(cmd.trim())
  }
  return cmds.join(" && ")
}

/** Pull the optional upstream SWE-bench metadata block off a task doc. */
const readSwebenchMeta = (doc: Record<string, unknown>): Instance["swebench"] => {
  const meta = asRecord(doc.swebench_meta)
  const instanceId = str(meta?.instance_id)
  const repo = str(meta?.repo)
  const baseCommit = str(meta?.base_commit)
  if (!instanceId || !repo || !baseCommit) return undefined
  const env = str(meta?.environment_setup_commit)
  return {
    instanceId,
    repo,
    baseCommit,
    ...(env !== undefined ? { environmentSetupCommit: env } : {}),
  }
}

/** Parse one real task YAML into an Instance, or null when a required field
 *  is missing / its repo_ref has no cached checkout (skipped, never throws). */
const parseTaskYaml = (text: string, repoCache: Map<string, string>): Instance | null => {
  let doc: Record<string, unknown> | undefined
  try {
    doc = asRecord(Bun.YAML.parse(text))
  } catch {
    return null
  }
  if (!doc) return null
  const id = str(doc.task_id)
  const repoRef = str(doc.repo_ref)
  const statement = str(asRecord(doc.objective)?.statement)
  const testCmd = visibleChecksCmd(asRecord(doc.oracle))
  if (!id || !repoRef || !statement || testCmd === "") return null
  const repoPath = repoCache.get(repoRef)
  if (!repoPath) return null
  const meta = readSwebenchMeta(doc)
  return {
    id,
    repoPath,
    problemStatement: statement,
    testCmd,
    ...(meta !== undefined ? { swebench: meta } : {}),
  }
}

const loadRealCorpus = async (root: string, taskDir: string): Promise<Instance[]> => {
  const repoCache = await loadRepoCacheMap(root)
  const entries = await readdir(taskDir, { withFileTypes: true })
  const out: Instance[] = []
  for (const e of entries) {
    if (!e.isFile() || !e.name.endsWith(".yaml")) continue
    try {
      const inst = parseTaskYaml(await readFile(join(taskDir, e.name), "utf8"), repoCache)
      if (inst) out.push(inst)
    } catch {
      // skip unreadable task file
    }
  }
  return out.sort((a, b) => byteCompare(a.id, b.id))
}

/**
 * Load a SWE-bench corpus. Resolution order:
 *   1. `tasks/repo/swebench/` present  → REAL swebench.verified corpus.
 *   2. `manifest.jsonl` present        → synthetic layout (A).
 *   3. otherwise                       → synthetic per-dir layout (B).
 * Missing/empty/invalid `root` → [] (never throws).
 */
export const loadCorpus = async (root: string): Promise<Instance[]> => {
  if (!root || !(await exists(root))) return []
  const taskDir = join(root, SWEBENCH_TASK_DIR)
  if (await exists(taskDir)) return loadRealCorpus(root, taskDir)
  const manifest = join(root, "manifest.jsonl")
  if (await exists(manifest)) return loadManifest(root, manifest)
  return loadDirCorpus(root)
}

/**
 * Test helper: write 2 tiny, self-contained instances under `dir` using layout
 * (B). Each is a one-file JS repo with a planted bug whose `testCmd` is a pure
 * `bash`/`node -e` assertion — no Python, no network, hermetic. The intended
 * fix is a single-line edit the agent (or a scripted FakeLLM) can apply.
 */
export const writeSyntheticCorpus = async (dir: string): Promise<void> => {
  await mkdir(dir, { recursive: true })

  // Instance 1: add() returns a - b, should be a + b.
  const r1 = join(dir, "inst-add", "repo")
  await mkdir(r1, { recursive: true })
  await writeFile(
    join(r1, "math.js"),
    "function add(a, b) {\n  return a - b\n}\nmodule.exports = { add }\n",
  )
  await writeFile(
    join(dir, "inst-add", "instance.json"),
    `${JSON.stringify(
      {
        id: "inst-add",
        problemStatement:
          "The add(a, b) function in math.js returns a - b but must return a + b. Fix it.",
        testCmd: `node -e "const {add}=require('./math.js'); if(add(2,3)!==5) process.exit(1)"`,
        goldPatch: "fix: return a + b in math.js",
      },
      null,
      2,
    )}\n`,
  )

  // Instance 2: greet() missing exclamation, test expects "Hello, world!".
  const r2 = join(dir, "inst-greet", "repo")
  await mkdir(r2, { recursive: true })
  await writeFile(
    join(r2, "greet.js"),
    'function greet(n) {\n  return "Hello, " + n\n}\nmodule.exports = { greet }\n',
  )
  await writeFile(
    join(dir, "inst-greet", "instance.json"),
    `${JSON.stringify(
      {
        id: "inst-greet",
        problemStatement:
          'greet(name) in greet.js returns "Hello, <name>" but must return "Hello, <name>!" (trailing exclamation). Fix it.',
        testCmd: `node -e "const {greet}=require('./greet.js'); if(greet('world')!=='Hello, world!') process.exit(1)"`,
        goldPatch: 'fix: append "!" in greet.js',
      },
      null,
      2,
    )}\n`,
  )
}

/**
 * Test helper: write a minimal corpus in the REAL discovered layout under
 * `root` — a `tasks/repo/swebench/<id>.yaml` plus a `repo_manifest.yaml`
 * mapping its `repo_ref` to a (caller-created) cache dir. Hermetic: no
 * network, no Python. Used by bench-eval.test.ts to exercise loadRealCorpus.
 */
export const writeSyntheticRealCorpus = async (
  root: string,
  repoCacheDir: string,
): Promise<void> => {
  const taskDir = join(root, SWEBENCH_TASK_DIR)
  const manifestDir = join(root, "external", "swebench", "verified", "repos")
  await mkdir(taskDir, { recursive: true })
  await mkdir(manifestDir, { recursive: true })
  await mkdir(repoCacheDir, { recursive: true })

  const repoId = "swebench.python.demo.demo"
  await writeFile(
    join(manifestDir, "repo_manifest.yaml"),
    Bun.YAML.stringify({
      repos: [{ repo_id: repoId, mirror_policy: "cache_only", local_cache_path: repoCacheDir }],
    }),
  )
  await writeFile(
    join(taskDir, "py.repo.swebench_demo.001.yaml"),
    Bun.YAML.stringify({
      $schema: "quanta-benchmark-corpus/task/v1",
      task_id: "py.repo.swebench_demo.001",
      language: "python",
      family: "repo",
      repo_ref: repoId,
      objective: { kind: "bugfix", statement: "Fix the demo bug in mod.py." },
      oracle: {
        kind: "hidden_tests",
        visible_checks: [{ cmd: "python -m pytest -q test_mod.py", expect: "exit_code 0" }],
      },
      swebench_meta: {
        instance_id: "demo__demo-1",
        repo: "demo/demo",
        base_commit: "0".repeat(40),
        environment_setup_commit: "1".repeat(40),
      },
    }),
  )
}
