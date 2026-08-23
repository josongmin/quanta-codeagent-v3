/**
 * PMX-00 — the FETCH -> ASSEMBLE -> VERIFY chain has no hand step in it.
 *
 * PMX-00's fetch writes `gh/{swe-bench-promax.json,eval.json,test_run.py}` +
 * `hf/{swe-bench-promax.json,eval.json}`. `verify-bundle` consumes a DIFFERENT
 * layout (`manifest.json`, `dataset.json`, `eval.json`, `evaluator.py`,
 * `hf/dataset.json`, `hf/eval.json`) with the manifest coming from git. Before
 * this suite the only bridge was an operator copying six files by hand, which is
 * the one place a wrong file can enter a "verified" bundle.
 *
 * What this proves, in order:
 *  1. the assembler turns a fetched tree into a bundle that `verify-bundle`
 *     VERIFIES with the PRODUCTION policy — no test seam widened;
 *  2. every copied byte was hashed against the manifest BEFORE it landed: a
 *     one-byte flip leaves the destination EMPTY, not partially populated;
 *  3. a missing upstream file is REFUSED by name, not silently skipped
 *     (silently skipping `hf/eval.json` would also silently disable the
 *     GitHub/HF cross-source check inside the verifier);
 *  4. assembling over an existing bundle REFUSES and does not mix bytes.
 *
 * Both the hermetic fixture (runs anywhere, CI included) and the REAL fetched
 * tree (visible skip when the operator artifact is absent) drive the same CLI
 * entrypoint `runAssembleCli`, which is what `import.meta.main` runs.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs"
import { homedir, tmpdir } from "node:os"
import { basename, join } from "node:path"
import {
  PROMAX_ASSEMBLY_FAILURE_CODES,
  PROMAX_ASSEMBLY_FAILURE_REASONS,
  PROMAX_BUNDLE_FILES,
  PROMAX_BUNDLE_SOURCES,
  PROMAX_V1_SNAPSHOT,
  type ProMaxManifest,
} from "@/apps/bench/promax/provenance"
import {
  assembleProMaxBundleDir,
  DEFAULT_MANIFEST_PATH,
  runAssembleCli,
} from "../../../../../tools/bench-promax/assemble-bundle"
import { verifyBundleDir } from "../../../../../tools/bench-promax/verify-bundle"
import { buildFixtureBundle } from "./promax-bundle-fixture"

const DIRS: string[] = []
const alloc = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  DIRS.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of DIRS) rmSync(dir, { recursive: true, force: true })
})

const sha256File = (path: string): string =>
  createHash("sha256").update(readFileSync(path)).digest("hex")

/** every relative path under `dir`, sorted; `[]` when the dir does not exist. */
const listTree = (dir: string): string[] =>
  existsSync(dir)
    ? readdirSync(dir, { recursive: true })
        .map((e) => String(e))
        .sort()
    : []

// ---------------------------------------------------------------- hermetic ---

const BUILT = buildFixtureBundle()
/** The fixture manifest, typed as the schema so field access is not an index. */
const MANIFEST = BUILT.manifestRecord as unknown as ProMaxManifest

/** Write a fetched-upstream tree in the exact shape PMX-00's fetch produces. */
const writeFetchTree = (files: Partial<Record<string, string>> = {}): string => {
  const root = alloc("pmx00-fetch-")
  mkdirSync(join(root, "gh"), { recursive: true })
  mkdirSync(join(root, "hf"), { recursive: true })
  const dataset = basename(MANIFEST.dataset_path)
  const evalMeta = basename(MANIFEST.eval_path)
  const evaluator = basename(MANIFEST.evaluator_path)
  const plan: Record<string, string | undefined> = {
    [join("gh", dataset)]: BUILT.datasetJson,
    [join("gh", evalMeta)]: BUILT.evalJson,
    [join("gh", evaluator)]: BUILT.evaluatorSource,
    [join("hf", dataset)]: BUILT.datasetJson,
    [join("hf", evalMeta)]: BUILT.evalJson,
    ...files,
  }
  for (const [rel, body] of Object.entries(plan)) {
    if (body === undefined) continue
    writeFileSync(join(root, rel), body)
  }
  return root
}

const MANIFEST_PATH = (() => {
  const dir = alloc("pmx00-manifest-")
  const path = join(dir, "promax-fixture.manifest.json")
  writeFileSync(path, BUILT.manifestJson)
  return path
})()

const assemble = (
  upstreamRoot: string,
  bundleRoot: string,
  manifestPath: string = MANIFEST_PATH,
): { exitCode: number; output: string } =>
  runAssembleCli([
    "--upstream-root",
    upstreamRoot,
    "--bundle-root",
    bundleRoot,
    "--manifest",
    manifestPath,
  ])

describe("PMX-00 — assembly turns a fetched tree into a bundle the validator accepts", () => {
  const upstream = writeFetchTree()
  const bundle = join(alloc("pmx00-out-"), "bundle")
  const result = assemble(upstream, bundle)

  test("it ASSEMBLES and reports every file it copied", () => {
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain("ASSEMBLED")
    for (const rel of Object.values(PROMAX_BUNDLE_FILES)) {
      expect(result.output).toContain(rel)
    }
  })

  test("the bundle dir holds EXACTLY the six files the validator reads", () => {
    expect(listTree(bundle)).toEqual(
      ["hf", ...Object.values(PROMAX_BUNDLE_FILES)].sort((a, b) => a.localeCompare(b)),
    )
  })

  test("each copied file hashes to the manifest's declared sha256", () => {
    expect(sha256File(join(bundle, PROMAX_BUNDLE_FILES.dataset))).toBe(MANIFEST.dataset_sha256)
    expect(sha256File(join(bundle, PROMAX_BUNDLE_FILES.evalMeta))).toBe(MANIFEST.eval_sha256)
    expect(sha256File(join(bundle, PROMAX_BUNDLE_FILES.evaluator))).toBe(MANIFEST.evaluator_sha256)
    // the HF copies are checked against the SAME declared hash — that is what
    // makes the verifier's cross-source check meet a real second copy.
    expect(sha256File(join(bundle, PROMAX_BUNDLE_FILES.hfDataset))).toBe(MANIFEST.dataset_sha256)
    expect(sha256File(join(bundle, PROMAX_BUNDLE_FILES.hfEvalMeta))).toBe(MANIFEST.eval_sha256)
  })

  test("the manifest lands byte-identical to the in-repo one", () => {
    expect(sha256File(join(bundle, PROMAX_BUNDLE_FILES.manifest))).toBe(sha256File(MANIFEST_PATH))
  })

  test("THE CHAIN — verify-bundle VERIFIES the assembled dir, unchanged", () => {
    const verdict = verifyBundleDir(
      bundle,
      { headCommit: MANIFEST.upstream_git_commit },
      BUILT.policy,
    )
    expect(
      verdict.ok ? "" : verdict.failures.map((f) => `${f.code}: ${f.message}`).join("\n"),
    ).toBe("")
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.instanceIds).toHaveLength(170)
  })
})

describe("PMX-00 — assembly REFUSES rather than producing a wrong-by-copy bundle", () => {
  test("a ONE-BYTE flip in an upstream file is refused and NOTHING lands", () => {
    const flipped = `${BUILT.evaluatorSource.slice(0, -1)}#`
    expect(flipped).not.toBe(BUILT.evaluatorSource)
    expect(flipped.length).toBe(BUILT.evaluatorSource.length)
    const upstream = writeFetchTree({
      [join("gh", basename(MANIFEST.evaluator_path))]: flipped,
    })
    const bundle = join(alloc("pmx00-out-"), "bundle")
    const r = assemble(upstream, bundle)
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain("REFUSED")
    expect(r.output).toContain("source_hash_mismatch")
    expect(r.output).toContain(MANIFEST.evaluator_sha256)
    expect(r.output).toContain(join("gh", basename(MANIFEST.evaluator_path)))
    // the whole point: verification happens BEFORE anything lands.
    expect(listTree(bundle)).toEqual([])
  })

  test("a MISSING upstream file is refused BY NAME, never silently skipped", () => {
    const upstream = writeFetchTree()
    rmSync(join(upstream, "hf", basename(MANIFEST.eval_path)))
    const bundle = join(alloc("pmx00-out-"), "bundle")
    const r = assemble(upstream, bundle)
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain("source_absent")
    expect(r.output).toContain(join("hf", basename(MANIFEST.eval_path)))
    expect(listTree(bundle)).toEqual([])
  })

  test("assembling OVER an existing bundle refuses and leaves the old bytes intact", () => {
    const upstream = writeFetchTree()
    const bundle = join(alloc("pmx00-out-"), "bundle")
    mkdirSync(bundle, { recursive: true })
    const stale = join(bundle, PROMAX_BUNDLE_FILES.dataset)
    writeFileSync(stale, "STALE-FROM-A-PREVIOUS-BUNDLE")
    const r = assemble(upstream, bundle)
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain("destination_not_empty")
    expect(r.output).toContain(PROMAX_BUNDLE_FILES.dataset)
    expect(readFileSync(stale, "utf8")).toBe("STALE-FROM-A-PREVIOUS-BUNDLE")
    expect(listTree(bundle)).toEqual([PROMAX_BUNDLE_FILES.dataset])
  })

  test("a manifest missing a required field is refused before any read", () => {
    const dir = alloc("pmx00-badmanifest-")
    const path = join(dir, "manifest.json")
    const broken = { ...BUILT.manifestRecord }
    delete broken.evaluator_sha256
    writeFileSync(path, JSON.stringify(broken))
    const bundle = join(alloc("pmx00-out-"), "bundle")
    const r = assemble(writeFetchTree(), bundle, path)
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain("manifest_invalid")
    expect(r.output).toContain("evaluator_sha256")
    expect(listTree(bundle)).toEqual([])
  })
})

describe("PMX-00 — the assembly source table is CLOSED over the bundle layout", () => {
  test("every bundle file the validator reads has exactly one declared source", () => {
    expect(Object.keys(PROMAX_BUNDLE_SOURCES).sort()).toEqual(
      Object.keys(PROMAX_BUNDLE_FILES).sort(),
    )
    expect(Object.keys(PROMAX_BUNDLE_FILES)).toHaveLength(6)
  })

  test("the failure vocabulary is classified in both directions", () => {
    expect(PROMAX_ASSEMBLY_FAILURE_CODES.length).toBe(
      Object.keys(PROMAX_ASSEMBLY_FAILURE_REASONS).length,
    )
    expect([...PROMAX_ASSEMBLY_FAILURE_CODES].sort()).toEqual([
      "destination_not_empty",
      "manifest_invalid",
      "source_absent",
      "source_hash_mismatch",
    ])
  })

  test("the default manifest path is the in-repo v1 manifest, and it parses", () => {
    expect(existsSync(DEFAULT_MANIFEST_PATH)).toBe(true)
    const m = JSON.parse(readFileSync(DEFAULT_MANIFEST_PATH, "utf8")) as Record<string, unknown>
    expect(m.upstream_git_commit).toBe(PROMAX_V1_SNAPSHOT.upstream_git_commit)
    expect(m.dataset_sha256).toBe(PROMAX_V1_SNAPSHOT.dataset_sha256)
  })
})

// ------------------------------------------------------------- REAL FETCH ---

const REAL_FETCH = join(
  homedir(),
  ".quanta/bench/promax-upstream",
  PROMAX_V1_SNAPSHOT.upstream_git_commit,
)
const REAL_BUNDLE = join(homedir(), ".quanta/bench/promax-bundle/v1-170")

describe("PMX-00 — the REAL fetched tree assembles into a bundle that VERIFIES", () => {
  const present = existsSync(join(REAL_FETCH, "gh", "test_run.py"))
  if (!present) {
    // VISIBLE skip: the fetched upstream tree is an operator artifact (26MB of
    // gold-bearing bytes) and is deliberately not in git.
    test.skip(`real fetched tree absent at ${REAL_FETCH}`, () => {
      expect(existsSync(join(REAL_FETCH, "gh", "test_run.py"))).toBe(true)
    })
    return
  }

  /**
   * A fetched tree made of SYMLINKS to the real 26MB files, so a refusal case
   * costs bytes only for the file it corrupts. `readFileSync` follows them, so
   * the assembler sees the real bytes.
   */
  const linkTree = (o: { omit?: string; replace?: { rel: string; body: Uint8Array } } = {}) => {
    const root = alloc("pmx00-realfetch-")
    for (const dir of ["gh", "hf"]) mkdirSync(join(root, dir), { recursive: true })
    for (const rel of [
      join("gh", "swe-bench-promax.json"),
      join("gh", "eval.json"),
      join("gh", "test_run.py"),
      join("hf", "swe-bench-promax.json"),
      join("hf", "eval.json"),
    ]) {
      if (o.omit === rel) continue
      if (o.replace?.rel === rel) {
        writeFileSync(join(root, rel), o.replace.body)
        continue
      }
      symlinkSync(join(REAL_FETCH, rel), join(root, rel))
    }
    return root
  }

  const bundle = join(alloc("pmx00-realout-"), "bundle")
  const result = assembleProMaxBundleDir({
    upstreamRoot: linkTree(),
    bundleRoot: bundle,
    manifestPath: DEFAULT_MANIFEST_PATH,
  })

  test("it ASSEMBLES the real bytes against the in-repo v1 manifest", () => {
    expect(result.exitCode, result.output).toBe(0)
  })

  test("verify-bundle VERIFIES it under the PRODUCTION approval policy", () => {
    const verdict = verifyBundleDir(bundle, {
      headCommit: PROMAX_V1_SNAPSHOT.upstream_git_commit,
    })
    expect(
      verdict.ok ? "" : verdict.failures.map((f) => `${f.code}: ${f.message}`).join("\n"),
    ).toBe("")
    expect(verdict.ok).toBe(true)
    if (!verdict.ok) return
    expect(verdict.instanceIds).toHaveLength(PROMAX_V1_SNAPSHOT.dataset_count)
    expect(verdict.manifest.dataset_sha256).toBe(PROMAX_V1_SNAPSHOT.dataset_sha256)
  })

  test("it reproduces the hand-assembled verified bundle BYTE FOR BYTE", () => {
    if (!existsSync(REAL_BUNDLE)) return
    for (const rel of Object.values(PROMAX_BUNDLE_FILES)) {
      expect(`${rel}=${sha256File(join(bundle, rel))}`).toBe(
        `${rel}=${sha256File(join(REAL_BUNDLE, rel))}`,
      )
    }
  })

  test("REAL corrupted copy — one byte flipped in test_run.py refuses, nothing lands", () => {
    const real = readFileSync(join(REAL_FETCH, "gh", "test_run.py"))
    const flipped = Uint8Array.from(real)
    const last = flipped.length - 1
    flipped[last] = (flipped[last] ?? 0) ^ 0x01
    expect(flipped.length).toBe(real.length)
    const out = join(alloc("pmx00-realout-"), "bundle")
    const r = assembleProMaxBundleDir({
      upstreamRoot: linkTree({ replace: { rel: join("gh", "test_run.py"), body: flipped } }),
      bundleRoot: out,
      manifestPath: DEFAULT_MANIFEST_PATH,
    })
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain("source_hash_mismatch")
    expect(r.output).toContain(PROMAX_V1_SNAPSHOT.evaluator_sha256)
    expect(listTree(out)).toEqual([])
  })

  test("REAL missing file — no hf/eval.json refuses by name, nothing lands", () => {
    const out = join(alloc("pmx00-realout-"), "bundle")
    const r = assembleProMaxBundleDir({
      upstreamRoot: linkTree({ omit: join("hf", "eval.json") }),
      bundleRoot: out,
      manifestPath: DEFAULT_MANIFEST_PATH,
    })
    expect(r.exitCode).toBe(1)
    expect(r.output).toContain("source_absent")
    expect(r.output).toContain(join("hf", "eval.json"))
    expect(listTree(out)).toEqual([])
  })

  test("the VERIFIED operator bundle was not touched by any of this", () => {
    if (!existsSync(REAL_BUNDLE)) return
    expect(sha256File(join(REAL_BUNDLE, PROMAX_BUNDLE_FILES.evaluator))).toBe(
      PROMAX_V1_SNAPSHOT.evaluator_sha256,
    )
    expect(sha256File(join(REAL_BUNDLE, PROMAX_BUNDLE_FILES.dataset))).toBe(
      PROMAX_V1_SNAPSHOT.dataset_sha256,
    )
  })
})
