/**
 * HELLGATE — PMX-02: the agent process cannot reach ProMax gold.
 *
 * Packet invariant 3 has two halves and both are asserted here against real
 * filesystem state and real production entry points:
 *
 *  TYPES  — the agent-side task and the runner `Instance` built from it are
 *           closed structs with no gold field and no escape hatch;
 *  ROOTS  — the grader bundle lives outside the agent root, enforced as a
 *           REFUSAL at write time, so nothing that walks the agent root (repo
 *           map, index roots, file tools, a plain `grep`) can reach gold.
 *
 * Non-vacuity is the hard part for a "no X anywhere" claim, so the leak scan is
 * itself proven to have teeth: the SAME scanner is run against an artifact with a
 * gold field deliberately injected into the agent projection, and it must fail.
 * Without that, "found no gold" is indistinguishable from "looked for nothing".
 *
 * ⚠️ LIVE-DATA: nothing here writes a report. All artifacts go to per-test temp
 * dirs and the CLI case is `--dry-run`.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, symlinkSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, relative } from "node:path"
import { DATASET_FAMILIES, type DatasetFamily } from "@/apps/bench/dataset-family-token"
import { readFamilyCorpusText } from "@/apps/bench/profiles/corpus-read"
import { resolveDatasetFamilyProfile } from "@/apps/bench/profiles/registry"
import {
  assertGraderBundleOutsideAgentRoot,
  buildProMaxArtifacts,
  decodeProMaxOfficialCorpus,
  openProMaxGraderBundleDir,
  PROMAX_PUBLIC_TASKS_FILE,
  ProMaxArtifactError,
  readProMaxCorpusRows,
  readProMaxPublicTasksFile,
  serializeProMaxPublicTasks,
  writeProMaxArtifacts,
} from "@/apps/bench/promax/corpus"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance/frozen-snapshot"
import {
  PROMAX_BUNDLE_ROOT_ENV,
  PROMAX_PYTHON_ENV,
  resolveProMaxSettings,
} from "@/apps/bench/promax/settings"
import { shq } from "@/apps/bench/remote/box-session/shell"
import { resolveBenchRunConfig } from "@/apps/bench/run-config"
import { verify } from "@/runner/batch/eval/verdict"
import {
  buildSyntheticProMaxCorpus,
  EVAL_SCRIPT_MARKER,
  GOLD_PATCH_MARKER,
  GOLD_TEST_PATCH_MARKER,
} from "./promax-corpus-fixture"

const TEMP_DIRS: string[] = []
const alloc = (prefix: string): string => {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  TEMP_DIRS.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of TEMP_DIRS) rmSync(dir, { recursive: true, force: true })
})

const GOLD_MARKERS = [GOLD_PATCH_MARKER, GOLD_TEST_PATCH_MARKER, EVAL_SCRIPT_MARKER] as const
/** Grader-only KEY names, in every spelling either artifact could use. */
const GRADER_KEYS = [
  "patch",
  "test_patch",
  "testPatch",
  "eval_script",
  "evalScript",
  "image_name",
  "imageName",
  "working_dir",
  "workingDir",
  "environment_setup_commit",
  "environmentSetupCommit",
  "golden",
] as const

/** Every file under `root`, recursively. */
const filesUnder = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const path = join(root, entry.name)
    return entry.isDirectory() ? filesUnder(path) : [path]
  })

/** THE SCANNER whose teeth are proven below. Returns the offences it found. */
const graderMaterialIn = (label: string, text: string): string[] => {
  const hits: string[] = []
  for (const marker of GOLD_MARKERS)
    if (text.includes(marker)) hits.push(`${label}: body ${marker}`)
  for (const key of GRADER_KEYS) if (text.includes(`"${key}"`)) hits.push(`${label}: key "${key}"`)
  return hits
}

const CORPUS = buildSyntheticProMaxCorpus()
const decoded = decodeProMaxOfficialCorpus(CORPUS)
if (!decoded.ok) throw new Error("fixture corpus was rejected — the test cannot run")
const ARTIFACTS = buildProMaxArtifacts({
  ...decoded,
  source: {
    manifestSha256: "f".repeat(64),
    upstreamGitCommit: "7".repeat(40),
    hfDatasetRevision: "8".repeat(40),
    datasetSha256: "a".repeat(64),
    evalSha256: "b".repeat(64),
  },
})

/** A realistic layout: the agent workspace and a SIBLING grader root. */
const layout = (): { agentRoot: string; graderRoot: string } => {
  const base = alloc("pmx02-layout-")
  return { agentRoot: join(base, "agent"), graderRoot: join(base, "grader") }
}

describe("PMX-02 — the agent ROOT contains no grader material", () => {
  const { agentRoot, graderRoot } = layout()
  const paths = writeProMaxArtifacts({ agentRoot, graderRoot, ...ARTIFACTS })

  test("the agent root holds ONE file and it is the public tasks artifact", () => {
    const files = filesUnder(agentRoot).map((f) => relative(agentRoot, f))
    expect(files).toEqual([PROMAX_PUBLIC_TASKS_FILE])
  })

  test("EVERY byte under the agent root is free of grader material", () => {
    const offences = filesUnder(agentRoot).flatMap((file) =>
      graderMaterialIn(relative(agentRoot, file), readFileSync(file, "utf8")),
    )
    expect(offences).toEqual([])
    // KNOWN-ITEM FLOOR — the file that was scanned really is the 170-row corpus.
    const publicText = readFileSync(paths.publicTasksPath, "utf8")
    expect(publicText).toContain(CORPUS.instanceIds[0] ?? "@@none@@")
    const readBack = readProMaxPublicTasksFile(paths.publicTasksPath)
    expect(readBack).toHaveLength(170)
    // …and EVERY row of the artifact is the closed five-key struct.
    for (const task of readBack) {
      expect(Object.keys(task).sort(), `${task.instanceId} widened the agent view`).toEqual([
        "baseCommit",
        "instanceId",
        "language",
        "problemStatement",
        "repo",
      ])
    }
  })

  test("RED-ON-INJECTION — the SAME scanner fails when a gold field is added to the agent projection", () => {
    // The injection is what a careless widening of the public projection would
    // produce: one grader field appended to each agent row.
    const leaky = {
      ...ARTIFACTS.publicTasks,
      tasks: ARTIFACTS.publicTasks.tasks.map((task, i) => ({
        ...task,
        patch: decoded.graderTasks[i]?.patch ?? "",
      })),
    }
    const offences = graderMaterialIn("injected", serializeProMaxPublicTasks(leaky))
    expect(offences.length).toBeGreaterThan(0)
    expect(offences.join(" | ")).toContain(GOLD_PATCH_MARKER)
    expect(offences.join(" | ")).toContain('key "patch"')
  })

  test("PAIRED — the grader bundle DOES carry the gold (so the split is real, not empty)", () => {
    const graderText = readFileSync(paths.graderTasksPath, "utf8")
    for (const marker of GOLD_MARKERS) expect(graderText).toContain(marker)
    expect(openProMaxGraderBundleDir(paths.graderBundleDir).instanceIds).toHaveLength(170)
  })
})

/** The FIVE fields the ticket names for `PromaxAgentTaskView`. This list is the
 *  contract; a sixth key appearing on a view is a widening of the agent surface
 *  and must be a test failure, not a silently larger struct. */
const AGENT_VIEW_KEYS = [
  "baseCommit",
  "instanceId",
  "language",
  "problemStatement",
  "repo",
] as const

describe("PMX-02 — the READER's agent view is a CLOSED struct, on a GOLD-BEARING corpus", () => {
  // This is the load-bearing one: it reads the RAW official array — every row of
  // which carries `patch` and `test_patch` — straight through the agent-side
  // reader. Anything the projection lets past shows up here.
  const rows = readProMaxCorpusRows(CORPUS.datasetText)

  test("KNOWN-ITEM FLOOR — the input really is the gold-bearing official array", () => {
    expect(CORPUS.datasetText.trimStart().startsWith("[")).toBe(true)
    expect(CORPUS.datasetText).toContain(GOLD_PATCH_MARKER)
    expect(CORPUS.datasetText).toContain(GOLD_TEST_PATCH_MARKER)
    expect(rows).toHaveLength(170)
  })

  test("EVERY view has EXACTLY the five public keys — no sixth field", () => {
    for (const row of rows) {
      const view = row.view
      expect(view, `row ${row.instanceId} produced no view`).toBeDefined()
      expect(
        Object.keys(view ?? {}).sort(),
        `row ${row.instanceId} widened the agent view`,
      ).toEqual([...AGENT_VIEW_KEYS])
    }
  })

  test("the SERIALIZED views, the slice bytes, and every Instance are gold-free", () => {
    expect(graderMaterialIn("views", JSON.stringify(rows.map((r) => r.view)))).toEqual([])
    const familyRows = readFamilyCorpusText(CORPUS.datasetText, "promax")
    expect(familyRows).toHaveLength(170)
    expect(graderMaterialIn("slices", familyRows.map((r) => r.sourceLine).join("\n"))).toEqual([])
    const instances = familyRows.flatMap((r) =>
      r.task !== undefined ? [r.task.toInstance("/tmp/checkout")] : [],
    )
    expect(instances).toHaveLength(170)
    expect(graderMaterialIn("instances", JSON.stringify(instances))).toEqual([])
    // PAIRED CONTROL — the SAME bytes through a JSONL family are not projected at
    // all, so the scanner is demonstrably capable of finding gold in this input.
    const proRows = readFamilyCorpusText(
      CORPUS.rows.map((r) => JSON.stringify(r)).join("\n"),
      "pro",
    )
    expect(
      graderMaterialIn("pro-slices", proRows.map((r) => r.sourceLine).join("\n")).length,
    ).toBeGreaterThan(0)
  })
})

describe("PMX-02 — the grader bundle ROOT cannot be inside the agent root", () => {
  test("a nested grader root is REFUSED — direct, via `..`, and via a SYMLINK", () => {
    const base = alloc("pmx02-nest-")
    const agentRoot = join(base, "agent")
    mkdirSync(agentRoot, { recursive: true })

    // 1 — plainly nested
    expect(() =>
      assertGraderBundleOutsideAgentRoot({ agentRoot, graderRoot: join(agentRoot, "grader") }),
    ).toThrow(ProMaxArtifactError)

    // 2 — nominally outside, actually inside, via `..` traversal
    expect(() =>
      assertGraderBundleOutsideAgentRoot({
        agentRoot,
        graderRoot: join(base, "elsewhere", "..", "agent", "g"),
      }),
    ).toThrow(ProMaxArtifactError)

    // 3 — a SYMLINK inside the agent root pointing at an outside dir is still
    //     inside from the agent's point of view of its own tree… but the check is
    //     on the RESOLVED path, so assert the symmetric hazard that DOES matter:
    //     a grader path that resolves, through a symlink, back into the agent root.
    const real = join(base, "real-grader")
    mkdirSync(real, { recursive: true })
    const linkFromOutside = join(base, "link-to-agent")
    symlinkSync(agentRoot, linkFromOutside)
    expect(() =>
      assertGraderBundleOutsideAgentRoot({ agentRoot, graderRoot: join(linkFromOutside, "g") }),
    ).toThrow(ProMaxArtifactError)

    // PAIRED CONTROL — a genuine sibling is accepted.
    expect(() => assertGraderBundleOutsideAgentRoot({ agentRoot, graderRoot: real })).not.toThrow()
  })

  test("writeProMaxArtifacts refuses a nested layout BEFORE writing anything", () => {
    const base = alloc("pmx02-nest-write-")
    const agentRoot = join(base, "agent")
    expect(() =>
      writeProMaxArtifacts({
        agentRoot,
        graderRoot: join(agentRoot, "inner"),
        ...ARTIFACTS,
      }),
    ).toThrow(ProMaxArtifactError)
    // …and no partial write happened: the agent root does not even exist.
    expect(() => readdirSync(agentRoot)).toThrow()
  })
})

describe("PMX-02 — the agent runtime works with the grader bundle UNAVAILABLE", () => {
  const { agentRoot, graderRoot } = layout()
  const paths = writeProMaxArtifacts({ agentRoot, graderRoot, ...ARTIFACTS })
  // Deliberately destroy the grader side, as a remote transport that defers the
  // bundle until generation is complete would leave it.
  rmSync(graderRoot, { recursive: true, force: true })

  test("reading the corpus and building every Instance still SUCCEEDS", () => {
    const rows = readFamilyCorpusText(readFileSync(paths.publicTasksPath, "utf8"), "promax")
    expect(rows).toHaveLength(170)
    const instances = rows.flatMap((row) =>
      row.task !== undefined ? [row.task.toInstance("/tmp/checkout")] : [],
    )
    expect(instances).toHaveLength(170)
    for (const instance of instances) {
      expect(instance.goldPatch).toBeUndefined()
      expect(graderMaterialIn(instance.id, JSON.stringify(instance))).toEqual([])
    }
  })

  test("…and GRADING is the step that then fails, loudly", () => {
    expect(() => openProMaxGraderBundleDir(paths.graderBundleDir)).toThrow()
  })
})

describe("PMX-02 — the agent cannot LEARN the grader-bundle path", () => {
  const { agentRoot, graderRoot } = layout()
  writeProMaxArtifacts({ agentRoot, graderRoot, ...ARTIFACTS })

  test("the resolved run CONFIG carries no reference to the grader bundle root", () => {
    const cfg = resolveBenchRunConfig({
      argvFamily: "promax",
      env: { QUANTA_PROMAX_BUNDLE_ROOT: "/opt/frozen/promax" },
    })
    // KNOWN-ITEM FLOOR — the config really did resolve promax and did read the knob
    expect(cfg.datasetFamily).toBe("promax")
    expect(cfg.promax.bundleRoot).toBe("/opt/frozen/promax")
    // …and nothing in it names THIS run's grader bundle.
    expect(JSON.stringify(cfg)).not.toContain(graderRoot)
  })

  /**
   * aug-22 residual G2 — the OTHER half of invariant 3, which PMX-02 left open.
   *
   * `onBoxEnvPrefix` is the `KEY=val ` prefix prepended to the ON-BOX BENCH
   * COMMAND, i.e. it is the AGENT phase's environment. ProMax forwarded
   * `QUANTA_PROMAX_BUNDLE_ROOT` there — handing the agent process a path to the
   * frozen bundle, every row of which carries `patch` / `test_patch` / the eval
   * script. A shell tool, a repo-map walk rooted at that path, or a plain `cat`
   * then reaches gold, and no reviewer can prove the negative afterwards.
   *
   * The rule this pins is PHASE-scoped, not ProMax-scoped: NO family's
   * agent-phase env prefix may name a grader-only setting (its value OR its key),
   * so a future family cannot reintroduce the leak in its own spelling.
   */
  const GRADER_ONLY_ENV_KEYS = [PROMAX_BUNDLE_ROOT_ENV, PROMAX_PYTHON_ENV] as const
  const GRADER_ROOT_VALUE = "/opt/frozen/promax-v1-170"
  const GRADER_PYTHON_VALUE = "/opt/frozen/venv/bin/python"
  const graderEnv = (): NodeJS.ProcessEnv => ({
    [PROMAX_BUNDLE_ROOT_ENV]: GRADER_ROOT_VALUE,
    [PROMAX_PYTHON_ENV]: GRADER_PYTHON_VALUE,
  })

  /** THE scanner, used by the live assertion AND proven red-on-injection below. */
  const graderLeaksIn = (prefix: string): string[] => {
    const hits: string[] = []
    if (prefix.includes(GRADER_ROOT_VALUE)) hits.push("value: grader bundle root")
    if (prefix.includes(GRADER_PYTHON_VALUE)) hits.push("value: grader interpreter")
    for (const key of GRADER_ONLY_ENV_KEYS) if (prefix.includes(key)) hits.push(`key: ${key}`)
    return hits
  }

  const agentPhasePrefix = (family: DatasetFamily): string =>
    resolveDatasetFamilyProfile(family).onBoxEnvPrefix({
      datasetPath: "/home/ubuntu/quanta/dataset.jsonl",
      env: graderEnv(),
    })

  test("NO family's AGENT-phase on-box env prefix names a grader-only setting", () => {
    // KNOWN-ITEM FLOOR — every registered family is exercised, promax included.
    expect([...DATASET_FAMILIES]).toContain("promax")
    expect(DATASET_FAMILIES.length).toBeGreaterThanOrEqual(4)
    for (const family of DATASET_FAMILIES) {
      expect(
        graderLeaksIn(agentPhasePrefix(family)),
        `${family} handed grader-only material to the AGENT phase`,
      ).toEqual([])
    }
  })

  test("PAIRED CONTROL — the ProMax prefix is not merely EMPTY (it still pins the evaluator)", () => {
    const prefix = agentPhasePrefix("promax")
    // the frozen upstream COMMIT is an identity pin, not a path to gold, so it
    // stays — which is what makes the assertion above a real exclusion rather
    // than "the port returns nothing".
    expect(prefix).toContain("QUANTA_PROMAX_UPSTREAM_COMMIT=")
    expect(prefix).toContain(PROMAX_V1_SNAPSHOT.upstream_git_commit)
    // …and the settings resolver DOES still see both knobs, so the exclusion is
    // the PREFIX's decision, not an accidentally-unreadable env.
    const settings = resolveProMaxSettings(graderEnv())
    expect(settings.bundleRoot).toBe(GRADER_ROOT_VALUE)
    expect(settings.python).toBe(GRADER_PYTHON_VALUE)
  })

  test("RED-ON-INJECTION — the SAME scanner catches the forward this repair removed", () => {
    // Rebuild the pre-repair prefix from the REAL settings resolver and the REAL
    // shell quoter, i.e. byte-for-byte what `onBoxEnvPrefix` used to emit.
    const settings = resolveProMaxSettings(graderEnv())
    const reintroduced =
      `${agentPhasePrefix("promax")}` +
      `${PROMAX_BUNDLE_ROOT_ENV}=${shq(settings.bundleRoot ?? "")} ` +
      `${PROMAX_PYTHON_ENV}=${shq(settings.python ?? "")} `
    expect(graderLeaksIn(reintroduced).sort()).toEqual([
      `key: ${PROMAX_BUNDLE_ROOT_ENV}`,
      `key: ${PROMAX_PYTHON_ENV}`,
      "value: grader bundle root",
      "value: grader interpreter",
    ])
  })

  test("the agent-visible Instance names only its own checkout root", () => {
    const rows = readFamilyCorpusText(
      readFileSync(join(agentRoot, PROMAX_PUBLIC_TASKS_FILE), "utf8"),
      "promax",
    )
    const instance = rows[0]?.task?.toInstance("/tmp/checkout")
    expect(instance).toBeDefined()
    expect(instance?.repoPath).toBe("/tmp/checkout")
    const serialized = JSON.stringify(instance)
    expect(serialized).not.toContain(graderRoot)
    expect(serialized).not.toContain("grader")
    // the PROMPT the agent receives is the problem statement and nothing else
    expect(instance?.problemStatement).not.toContain(graderRoot)
    expect(instance?.problemStatement).toContain("PROBLEM")
  })
})

describe("PMX-02 — a ProMax instance cannot be FAKE-GREENED by the no-op testCmd", () => {
  test("verify() with no python harness REFUSES rather than passing the `true` no-op", async () => {
    const rows = readFamilyCorpusText(CORPUS.datasetText, "promax")
    const instance = rows[0]?.task?.toInstance("/tmp/checkout")
    if (instance === undefined) throw new Error("no runnable promax task")
    // The public projection deliberately does NOT synthesize a testCmd from hidden
    // eval metadata, so it is the `true` no-op — which would exit 0 if anything
    // ever ran it.
    expect(instance.testCmd).toBe("true")
    const outcome = await verify(instance, "diff --git a/x b/x\n", "/tmp/checkout", {
      timeoutMs: 1_000,
    })
    expect(outcome.passed).toBe(false)
    expect(outcome.error ?? "").toContain("REFUSING to fake-grade")
  })
})
