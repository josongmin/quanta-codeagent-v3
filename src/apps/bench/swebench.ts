/**
 * SWE-bench-style corpus adapter.
 *
 * ── Expected corpus layout (documented contract) ──────────────────────────
 * `root/` is a directory containing ONE of:
 *   (A) `manifest.jsonl` — one JSON object per line, each an Instance-shaped
 *       record: { id, repoPath, problemStatement, testCmd, setupCmd?,
 *       goldPatch? }. `repoPath` is resolved relative to `root` when not
 *       absolute. This is the primary, scalable layout.
 *   (B) one sub-directory per instance, each containing `instance.json`
 *       (same fields; `repoPath` defaults to a sibling `repo/` dir when
 *       omitted). Convenient for hand-authored / synthetic fixtures.
 * If `root` does not exist, is empty, or contains neither, `loadCorpus`
 * returns [] (never throws) so the CLI degrades gracefully offline.
 *
 * ── Python SWE-bench seam (documented, out of scope here) ─────────────────
 * Real SWE-bench Verified resolution runs the official Python harness
 * (`swebench.harness.run_evaluation`) per RFC §11. That belongs behind a
 * future `evaluateWithPythonSwebench(instance, sandbox)` adapter invoked from
 * runner.ts in place of the local `testCmd` exec when an env flag
 * (`QUANTA_SWEBENCH_PYTHON=1`) is set. The TS harness here is the structural
 * skeleton (RFC §1.1 50%→70% target); the seam is the single function the
 * Python integration will implement — nothing else in bench changes. Left
 * unimplemented deliberately: the deliverable is the runnable TS harness.
 */
import { mkdir, readdir, readFile, stat, writeFile } from "node:fs/promises"
import { isAbsolute, join, resolve } from "node:path"
import type { Instance } from "./types"

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

interface RawInstance {
  id?: unknown
  repoPath?: unknown
  problemStatement?: unknown
  setupCmd?: unknown
  testCmd?: unknown
  goldPatch?: unknown
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined)

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
  return out.sort((a, b) => a.id.localeCompare(b.id))
}

/** Load a SWE-bench-style corpus. Missing/empty/invalid → [] (never throws). */
export const loadCorpus = async (root: string): Promise<Instance[]> => {
  if (!root || !(await exists(root))) return []
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
