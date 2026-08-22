/**
 * PMX-02 — the OPERATOR TOOL and the RUNTIME cannot disagree.
 *
 * The ticket requires that "the operator command and runtime both import ONE
 * pure sample-manifest implementation; neither reimplements ordering or quota
 * logic", and the same single-owner rule governs the corpus split. A doc comment
 * cannot establish that. What can: run the tool end to end against a bundle on
 * disk, then run the pure library functions in memory over the same bytes, and
 * require the two to produce IDENTICAL digests and identical selections.
 *
 * The bundle here is PMX-00's hermetic fixture — real 170 instance ids with
 * their real language tags (the anti-vacuum anchor for the distribution) and
 * SYNTHETIC bodies for every gold-bearing field. Nothing upstream is in git.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import {
  buildProMaxArtifacts,
  buildProMaxSampleFamily,
  decodeProMaxOfficialCorpus,
  openProMaxGraderBundleDir,
  PROMAX_DEFAULT_SAMPLE_SEED,
  PROMAX_GRADER_BUNDLE_DIR,
  PROMAX_PUBLIC_TASKS_FILE,
  readProMaxPublicTasksFile,
} from "@/apps/bench/promax/corpus"
import {
  prepareProMaxCorpus,
  runPrepareCli,
} from "../../../../../tools/bench-promax/prepare-corpus"
import * as verifyTool from "../../../../../tools/bench-promax/verify-bundle"
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

const BUILT = buildFixtureBundle()
const BUNDLE_ROOT = alloc("pmx02-bundle-")
mkdirSync(join(BUNDLE_ROOT, "hf"), { recursive: true })
const text = (b: string | Uint8Array): string =>
  typeof b === "string" ? b : new TextDecoder().decode(b)
writeFileSync(join(BUNDLE_ROOT, verifyTool.BUNDLE_FILES.manifest), text(BUILT.sources.manifest))
writeFileSync(join(BUNDLE_ROOT, verifyTool.BUNDLE_FILES.dataset), text(BUILT.sources.dataset))
writeFileSync(join(BUNDLE_ROOT, verifyTool.BUNDLE_FILES.evalMeta), text(BUILT.sources.evalMeta))
writeFileSync(join(BUNDLE_ROOT, verifyTool.BUNDLE_FILES.evaluator), text(BUILT.sources.evaluator))

const run = (over: { agentRoot?: string; graderRoot?: string; seed?: string } = {}) => {
  const base = alloc("pmx02-prep-")
  const agentRoot = over.agentRoot ?? join(base, "agent")
  const graderRoot = over.graderRoot ?? join(base, "grader")
  const samplesOut = join(base, "samples")
  const result = prepareProMaxCorpus({
    bundleRoot: BUNDLE_ROOT,
    checkout: { headCommit: BUILT.manifestRecord.upstream_git_commit as string },
    agentRoot,
    graderRoot,
    seed: over.seed ?? PROMAX_DEFAULT_SAMPLE_SEED,
    samplesOut,
    policy: BUILT.policy,
  })
  return { result, agentRoot, graderRoot, samplesOut }
}

describe("PMX-02 — the prepare tool produces the two artifacts and the sample family", () => {
  const { result, agentRoot, graderRoot, samplesOut } = run()

  test("it SUCCEEDS and reports both artifacts plus all four samples", () => {
    expect(result.exitCode, result.output).toBe(0)
    expect(result.output).toContain("PREPARED")
    for (const name of ["PMX-7", "PMX-14", "PMX-40", "PMX-170"]) {
      expect(result.output).toContain(name)
    }
    expect(result.output).toMatch(/PMX-7\s+n=7/)
    expect(result.output).toMatch(/PMX-170\s+n=170/)
  })

  test("the AGENT root holds only the public tasks file, with all 170 rows", () => {
    expect(readdirSync(agentRoot)).toEqual([PROMAX_PUBLIC_TASKS_FILE])
    expect(readProMaxPublicTasksFile(join(agentRoot, PROMAX_PUBLIC_TASKS_FILE))).toHaveLength(170)
  })

  test("the GRADER root holds the bundle, resolvable by instanceId", () => {
    const bundle = openProMaxGraderBundleDir(join(graderRoot, PROMAX_GRADER_BUNDLE_DIR))
    expect(bundle.instanceIds).toHaveLength(170)
    const first = bundle.instanceIds[0]
    if (first === undefined) throw new Error("empty bundle")
    expect(bundle.resolve(first).evalScript).toContain("SYNTHETIC-EVAL")
  })

  test("the sample manifests are written, one file per sample", () => {
    expect(readdirSync(samplesOut).sort()).toEqual([
      "PMX-14.manifest.json",
      "PMX-170.manifest.json",
      "PMX-40.manifest.json",
      "PMX-7.manifest.json",
    ])
  })
})

describe("PMX-02 — the tool reimplements NOTHING (parity with the pure library)", () => {
  const { result, agentRoot, graderRoot, samplesOut } = run()

  const decoded = decodeProMaxOfficialCorpus({
    datasetText: BUILT.datasetJson,
    evalText: BUILT.evalJson,
  })
  if (!decoded.ok) throw new Error("the fixture corpus did not decode")

  test("the artifact content digests match the in-memory library, byte for byte", () => {
    expect(result.exitCode, result.output).toBe(0)
    const library = buildProMaxArtifacts({
      agentTasks: decoded.agentTasks,
      graderTasks: decoded.graderTasks,
      source: {
        manifestSha256: "unused-by-content-digest",
        upstreamGitCommit: "unused",
        hfDatasetRevision: "unused",
        datasetSha256: "unused",
        evalSha256: "unused",
      },
    })
    const onDisk = JSON.parse(readFileSync(join(agentRoot, PROMAX_PUBLIC_TASKS_FILE), "utf8")) as {
      contentSha256: string
    }
    expect(onDisk.contentSha256).toBe(library.publicTasks.contentSha256)
    const graderOnDisk = JSON.parse(
      readFileSync(join(graderRoot, PROMAX_GRADER_BUNDLE_DIR, "tasks.json"), "utf8"),
    ) as { contentSha256: string }
    expect(graderOnDisk.contentSha256).toBe(library.graderBundle.contentSha256)
    // …and the two digests are DIFFERENT, so this is not comparing one value to itself
    expect(library.publicTasks.contentSha256).not.toBe(library.graderBundle.contentSha256)
  })

  test("the sample manifests match the in-memory generator EXACTLY", () => {
    const library = buildProMaxSampleFamily({
      candidates: decoded.agentTasks.map((t) => ({
        instanceId: t.instanceId,
        language: t.language,
      })),
      datasetRevision: BUILT.manifestRecord.hf_dataset_revision as string,
      seed: PROMAX_DEFAULT_SAMPLE_SEED,
    })
    expect(library).toHaveLength(4)
    for (const manifest of library) {
      const onDisk = JSON.parse(
        readFileSync(join(samplesOut, `${manifest.name}.manifest.json`), "utf8"),
      ) as unknown
      expect(onDisk, `${manifest.name} diverged between tool and library`).toEqual(manifest)
    }
  })

  test("the tool's SEED really flows through — a different seed writes a different draw", () => {
    const other = run({ seed: "an-entirely-different-seed" })
    expect(other.result.exitCode, other.result.output).toBe(0)
    const read = (dir: string, name: string) =>
      JSON.parse(readFileSync(join(dir, `${name}.manifest.json`), "utf8")) as {
        sha256: string
        instanceIds: string[]
      }
    const a = read(samplesOut, "PMX-40")
    const b = read(other.samplesOut, "PMX-40")
    expect(a.sha256).not.toBe(b.sha256)
    expect(a.instanceIds).not.toEqual(b.instanceIds)
    // PAIRED CONTROL — the same seed twice is byte-identical.
    const again = run()
    expect(read(again.samplesOut, "PMX-40")).toEqual(a)
  })
})

describe("PMX-02 — the prepare tool is FAIL-CLOSED", () => {
  test("an UNVERIFIED bundle stops before anything is written", () => {
    const base = alloc("pmx02-prep-refuse-")
    const agentRoot = join(base, "agent")
    const result = prepareProMaxCorpus({
      bundleRoot: BUNDLE_ROOT,
      checkout: { headCommit: "0".repeat(40) }, // HEAD is not the manifest commit
      agentRoot,
      graderRoot: join(base, "grader"),
      seed: PROMAX_DEFAULT_SAMPLE_SEED,
      policy: BUILT.policy,
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain("REFUSED")
    expect(result.output).toContain("checkout_commit_mismatch")
    expect(() => readdirSync(agentRoot)).toThrow()
  })

  test("a grader root INSIDE the agent root is refused, and nothing is written", () => {
    const base = alloc("pmx02-prep-nested-")
    const agentRoot = join(base, "agent")
    expect(() =>
      prepareProMaxCorpus({
        bundleRoot: BUNDLE_ROOT,
        checkout: { headCommit: BUILT.manifestRecord.upstream_git_commit as string },
        agentRoot,
        graderRoot: join(agentRoot, "grader"),
        seed: PROMAX_DEFAULT_SAMPLE_SEED,
        policy: BUILT.policy,
      }),
    ).toThrow(/REFUSING/)
    expect(() => readdirSync(agentRoot)).toThrow()
  })

  test("the CLI wrapper requires both roots explicitly (no default that could clobber)", () => {
    expect(() => runPrepareCli(["--bundle-root", BUNDLE_ROOT])).toThrow(/--agent-root is required/)
    expect(() =>
      runPrepareCli(["--bundle-root", BUNDLE_ROOT, "--agent-root", alloc("pmx02-cli-")]),
    ).toThrow(/--grader-root is required/)
    // PAIRED CONTROL — with every root supplied the CLI wrapper reaches the real
    // preparation (and refuses on provenance, since the CLI cannot widen policy).
    const complete = runPrepareCli([
      "--bundle-root",
      BUNDLE_ROOT,
      "--agent-root",
      alloc("pmx02-cli-agent-"),
      "--grader-root",
      alloc("pmx02-cli-grader-"),
    ])
    expect(complete.exitCode).toBe(1)
    expect(complete.output).toContain("REFUSED")
  })
})
