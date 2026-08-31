/**
 * PMX-04 — the image-provenance chain has a PRODUCTION CALLER, and its gates
 * BITE.
 *
 * Before this file, `deriveCampaignGolden`, `diffGoldenDocuments`,
 * `assertGoldenDerivationIsImageOnly`, `runProMaxImagePreflight` and
 * `assertImageFreezeReadyForModelLaunch` were reachable only from their own unit
 * tests: the composition that turns a resolved selection into
 * `ProMaxImageTarget[]` did not exist. Everything below drives the REAL operator
 * command (`tools/bench-promax/freeze-images.ts`) over a REAL verified bundle
 * fixture on disk, so the assertions are about the shipped path, not about a
 * re-assembled one.
 *
 * ⚠️ SPEND SAFETY. The Docker boundary is an injected recording fake that
 * THROWS on any argv it was not written for — so a regression that reaches a
 * real `docker run`, `run-instances`, or an upload fails the test instead of
 * billing. No network, no daemon, no EC2. Artefacts are written to an OS temp
 * directory, never to `~/.quanta`.
 */
import { afterAll, describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { DockerSpawn } from "@/apps/bench/harness/images"
import { parseProMaxImageFreezeReceipt } from "@/apps/bench/harness/promax"
import { proMaxContentDigest } from "@/apps/bench/promax/corpus"
import {
  FREEZE_FILES,
  freezeProMaxCampaign,
  verifyFrozenProMaxCampaign,
} from "../../../../../tools/bench-promax/freeze-images"
import { prepareProMaxCorpus } from "../../../../../tools/bench-promax/prepare-corpus"
import { buildFixtureBundle } from "./promax-bundle-fixture"

const ROOTS: string[] = []
const newRoot = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "quanta-promax-freeze-"))
  ROOTS.push(dir)
  return dir
}
afterAll(() => {
  for (const dir of ROOTS) rmSync(dir, { recursive: true, force: true })
})

const FIXTURE = buildFixtureBundle()
const CHECKOUT = { headCommit: FIXTURE.manifestRecord.upstream_git_commit as string }

/** The two instances this campaign claims to run. */
const ASSIGNED = [FIXTURE.datasetIds[0] as string, FIXTURE.datasetIds[1] as string]

const digestFor = (tag: string): string => {
  const repo = tag.slice(0, tag.lastIndexOf(":"))
  // Deterministic per-tag digest so a test can predict what the freeze pins to.
  const seed = tag.split("").reduce((a, c) => (a * 31 + c.charCodeAt(0)) % 16, 7)
  return `${repo}@sha256:${seed.toString(16).repeat(64)}`
}

interface Recorded {
  readonly argv: readonly string[]
}

interface DockerOpts {
  /** Override the inspect facts for one reference. */
  readonly inspectOverride?: ReadonlyMap<string, Record<string, unknown>>
}

type DockerResult = { code: number; stdout: string; stderr: string }

const dockerOk = (): DockerResult => ({ code: 0, stdout: "", stderr: "" })

const inspectFacts = (ref: string, opts: DockerOpts): DockerResult => {
  const digest = ref.includes("@sha256:") ? ref : digestFor(ref)
  const facts = opts.inspectOverride?.get(ref) ?? {
    Id: `sha256:${"1".repeat(64)}`,
    Os: "linux",
    Architecture: "amd64",
    RepoDigests: [digest],
  }
  return { code: 0, stdout: `${JSON.stringify(facts)}\n`, stderr: "" }
}

const standardDockerResponse = (argv: readonly string[], opts: DockerOpts): DockerResult | null => {
  if (["pull", "run", "cp", "rm"].includes(argv[0] ?? "")) return dockerOk()
  if (argv[0] === "image" && argv[1] === "inspect") {
    return inspectFacts(argv[argv.length - 1] as string, opts)
  }
  if (argv[0] === "exec") {
    return { code: 0, stdout: "__QPMX_SENTINEL__=ABSENT\n__QPMX_CP__=OK\n", stderr: "" }
  }
  if (argv[0] === "container" && argv[1] === "inspect") {
    return { code: 1, stdout: "", stderr: "No such container" }
  }
  return null
}

/**
 * A recording Docker fake. Anything outside the four verbs this chain is allowed
 * to use THROWS — the spend-safety assertion is structural, not a comment.
 */
const makeDocker = (calls: Recorded[], opts: DockerOpts = {}): DockerSpawn => {
  return async (argv) => {
    calls.push({ argv: [...argv] })
    const response = standardDockerResponse(argv, opts)
    if (response) return response
    throw new Error(`SPEND SAFETY: the freeze reached an unexpected docker verb: ${argv.join(" ")}`)
  }
}

/** A verified bundle + a prepared grader bundle, on disk. */
const preparedCampaign = (): { bundleRoot: string; graderRoot: string; outRoot: string } => {
  const root = newRoot()
  const bundleRoot = join(root, "bundle")
  mkdirSync(join(bundleRoot, "hf"), { recursive: true })
  writeFileSync(join(bundleRoot, "manifest.json"), FIXTURE.manifestJson)
  writeFileSync(join(bundleRoot, "dataset.json"), FIXTURE.datasetJson)
  writeFileSync(join(bundleRoot, "eval.json"), FIXTURE.evalJson)
  writeFileSync(join(bundleRoot, "evaluator.py"), FIXTURE.evaluatorSource)

  const agentRoot = join(root, "agent")
  const graderRoot = join(root, "grader")
  const prepared = prepareProMaxCorpus({
    bundleRoot,
    checkout: CHECKOUT,
    agentRoot,
    graderRoot,
    seed: "wiring-fixture",
    policy: FIXTURE.policy,
  })
  if (prepared.exitCode !== 0) throw new Error(`fixture preparation failed:\n${prepared.output}`)
  return { bundleRoot, graderRoot, outRoot: join(root, "campaign") }
}

const freeze = async (
  over: { readonly assigned?: readonly string[]; readonly docker?: DockerOpts } = {},
) => {
  const { bundleRoot, graderRoot, outRoot } = preparedCampaign()
  const calls: Recorded[] = []
  const result = await freezeProMaxCampaign({
    bundleRoot,
    checkout: CHECKOUT,
    graderRoot,
    outRoot,
    campaignId: "PMX-wiring@1",
    instanceIds: over.assigned ?? ASSIGNED,
    docker: makeDocker(calls, over.docker ?? {}),
    now: () => new Date("2026-08-22T12:00:00.000Z"),
    policy: FIXTURE.policy,
  })
  return { result, calls, outRoot }
}

describe("PMX-04 — the freeze composition runs on the real operator path", () => {
  test("REACHABILITY: the command resolves digests, preflights, and writes three artefacts", async () => {
    const { result, calls, outRoot } = await freeze()
    expect(result.output).toContain("FROZEN")
    expect(result.exitCode).toBe(0)

    // NON-VACUOUS: the chain actually issued Docker commands.
    expect(calls.length).toBeGreaterThan(0)

    // The resolution pair, per assigned instance, on the TAG…
    const tags = ASSIGNED.map((_, i) => `synthetic.invalid/promax:${i}`)
    for (const tag of tags) {
      // the tag→digest RESOLVE pull names the platform too — same reason as the
      // preflight pull: a host-resolved manifest list fails on non-amd64.
      expect(calls.some((c) => c.argv.join(" ") === `pull --platform linux/amd64 ${tag}`)).toBe(
        true,
      )
      expect(
        calls.some((c) => c.argv.join(" ") === `image inspect --format {{json .}} ${tag}`),
      ).toBe(true)
      // …and the full preflight on the resolved DIGEST.
      const digest = digestFor(tag)
      // The pull NAMES the platform the evaluator requires — without it `docker
      // pull` resolves the manifest list against the HOST and every ProMax image
      // fails on a non-amd64 machine (measured: 7/7 of PMX-7 on Apple Silicon).
      expect(calls.some((c) => c.argv.join(" ") === `pull --platform linux/amd64 ${digest}`)).toBe(
        true,
      )
      expect(calls.some((c) => c.argv[0] === "run" && c.argv.includes(digest))).toBe(true)
    }
    expect(calls.filter((c) => c.argv[0] === "exec")).toHaveLength(ASSIGNED.length)
    expect(calls.filter((c) => c.argv[0] === "rm")).toHaveLength(ASSIGNED.length)

    // The three artefacts, and what is IN them.
    const parsed = parseProMaxImageFreezeReceipt(
      readFileSync(join(outRoot, FREEZE_FILES.receipt), "utf8"),
    )
    if (!parsed.ok) throw new Error(`receipt refused: ${JSON.stringify(parsed.failures)}`)
    expect(parsed.receipt.images.map((i) => i.instance_id)).toEqual(ASSIGNED)
    for (const image of parsed.receipt.images) {
      expect(image.registry_repo_digest).toMatch(/@sha256:[0-9a-f]{64}$/)
    }
    const derivedRows = JSON.parse(
      readFileSync(join(outRoot, FREEZE_FILES.campaignGolden), "utf8"),
    ) as Record<string, unknown>[]
    expect(derivedRows.map((r) => r.instance_id)).toEqual(ASSIGNED)
    expect(derivedRows.map((r) => r.image_name)).toEqual(
      parsed.receipt.images.map((i) => i.registry_repo_digest),
    )
    // The source slice keeps the MUTABLE tag — only the derived document is pinned.
    const sourceRows = JSON.parse(
      readFileSync(join(outRoot, FREEZE_FILES.campaignGoldenSource), "utf8"),
    ) as Record<string, unknown>[]
    expect(sourceRows.map((r) => r.image_name)).toEqual([
      "synthetic.invalid/promax:0",
      "synthetic.invalid/promax:1",
    ])
    // …and gold survives the derivation untouched (it is the ground truth).
    expect(sourceRows.map((r) => r.patch)).toEqual(derivedRows.map((r) => r.patch))
  })

  test("GATE FIRES — an assigned instance the corpus has no row for is REFUSED", async () => {
    // The launch gate is the ONE owner of "the freeze covers exactly the assigned
    // set", so an instance that produced no image record must stop the campaign.
    const { result } = await freeze({ assigned: [...ASSIGNED, "promax__not-in-corpus-9"] })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('stage "launch_gate"')
    expect(result.output).toContain("promax__not-in-corpus-9")
  })

  test("GATE FIRES — a non-amd64 image stops the freeze before any launch", async () => {
    const tag = "synthetic.invalid/promax:0"
    const { result, outRoot } = await freeze({
      docker: {
        inspectOverride: new Map([
          [
            digestFor(tag),
            {
              Id: `sha256:${"1".repeat(64)}`,
              Os: "linux",
              Architecture: "arm64",
              RepoDigests: [digestFor(tag)],
            },
          ],
        ]),
      },
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('stage "preflight"')
    expect(result.output).toContain("platform_unsupported")
    // The receipt is EVIDENCE and survives the refusal…
    const parsed = parseProMaxImageFreezeReceipt(
      readFileSync(join(outRoot, FREEZE_FILES.receipt), "utf8"),
    )
    if (!parsed.ok) throw new Error("receipt refused")
    expect(parsed.receipt.faults.map((f) => f.code)).toEqual(["platform_unsupported"])
    // …and no campaign golden was published for an unreproducible image set.
    expect(() => readFileSync(join(outRoot, FREEZE_FILES.campaignGolden), "utf8")).toThrow()
  })

  test("GATE FIRES — the grader bundle and the golden disagreeing about image_name is REFUSED", async () => {
    const { bundleRoot, graderRoot, outRoot } = preparedCampaign()
    // Model an edited grader bundle: one instance's image name no longer matches
    // the golden row it was projected from.
    const tasksPath = join(graderRoot, "grader-bundle", "tasks.json")
    const bundleDoc = JSON.parse(readFileSync(tasksPath, "utf8")) as {
      tasks: Record<string, unknown>[]
      contentSha256: string
    }
    const target = bundleDoc.tasks.find((t) => t.instanceId === ASSIGNED[0])
    if (target === undefined) throw new Error("fixture: assigned instance missing from bundle")
    target.imageName = "synthetic.invalid/promax:tampered"
    // The bundle's own integrity seal would refuse this first, so re-seal it —
    // the point under test is the freeze's CROSS-CHECK, not the seal.
    bundleDoc.contentSha256 = proMaxContentDigest(bundleDoc.tasks)
    writeFileSync(tasksPath, JSON.stringify(bundleDoc, null, 2))

    const result = await freezeProMaxCampaign({
      bundleRoot,
      checkout: CHECKOUT,
      graderRoot,
      outRoot,
      campaignId: "PMX-wiring@1",
      instanceIds: ASSIGNED,
      docker: makeDocker([]),
      now: () => new Date("2026-08-22T12:00:00.000Z"),
      policy: FIXTURE.policy,
    })
    expect(result.exitCode).toBe(1)
    expect(result.output).toContain('stage "select"')
    expect(result.output).toContain("synthetic.invalid/promax:tampered")
  })
})

describe("PMX-04 — re-proving a frozen campaign from its artefacts alone", () => {
  test("PAIRED CONTROL: a freshly frozen campaign is ADMITTED", async () => {
    const { outRoot } = await freeze()
    const verdict = verifyFrozenProMaxCampaign({ outRoot, assignedInstanceIds: ASSIGNED })
    expect(verdict.exitCode).toBe(0)
    expect(verdict.output).toContain("ADMITTED")
  })

  test("GATE FIRES — a digest swapped BACK to a mutable tag is refused", async () => {
    const { outRoot } = await freeze()
    const path = join(outRoot, FREEZE_FILES.campaignGolden)
    const rows = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[]
    if (rows[0] !== undefined) rows[0].image_name = "synthetic.invalid/promax:frozen-2026"
    writeFileSync(path, JSON.stringify(rows, null, 2))

    const verdict = verifyFrozenProMaxCampaign({ outRoot, assignedInstanceIds: ASSIGNED })
    expect(verdict.exitCode).toBe(1)
    expect(verdict.output).toContain('stage "golden_proof"')
    expect(verdict.output).toContain("synthetic.invalid/promax:frozen-2026")
    expect(verdict.output).toMatch(/MUTABLE TAG/)
  })

  test("GATE FIRES — an edited gold `patch` is refused (the golden IS the ground truth)", async () => {
    const { outRoot } = await freeze()
    const path = join(outRoot, FREEZE_FILES.campaignGolden)
    const rows = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[]
    if (rows[0] !== undefined) rows[0].patch = "diff --git a/helpful b/helpful\n"
    writeFileSync(path, JSON.stringify(rows, null, 2))

    const verdict = verifyFrozenProMaxCampaign({ outRoot, assignedInstanceIds: ASSIGNED })
    expect(verdict.exitCode).toBe(1)
    expect(verdict.output).toContain("field_changed")
    expect(verdict.output).toContain("patch")
  })

  test("GATE FIRES — a receipt that does not cover the assigned set is refused", async () => {
    const { outRoot } = await freeze()
    const path = join(outRoot, FREEZE_FILES.receipt)
    const doc = JSON.parse(readFileSync(path, "utf8")) as { images: Record<string, unknown>[] }
    doc.images = doc.images.slice(0, 1)
    writeFileSync(path, JSON.stringify(doc, null, 2))

    const verdict = verifyFrozenProMaxCampaign({ outRoot, assignedInstanceIds: ASSIGNED })
    expect(verdict.exitCode).toBe(1)
    expect(verdict.output).toContain('stage "launch_gate"')
    expect(verdict.output).toContain(ASSIGNED[1] as string)
  })

  test("GATE FIRES — the receipt's digest BINDING catches an artefact edited around it", async () => {
    const { outRoot } = await freeze()
    const path = join(outRoot, FREEZE_FILES.campaignGoldenSource)
    // Edit the SOURCE slice only: the derived document and the receipt are both
    // untouched, so only the recorded sha256 can notice.
    const rows = JSON.parse(readFileSync(path, "utf8")) as Record<string, unknown>[]
    if (rows[0] !== undefined) rows[0].problem_statement = "rewritten after the freeze"
    writeFileSync(path, JSON.stringify(rows, null, 2))

    const verdict = verifyFrozenProMaxCampaign({ outRoot, assignedInstanceIds: ASSIGNED })
    expect(verdict.exitCode).toBe(1)
    expect(verdict.output).toContain("the document and its receipt disagree")
  })
})
