/**
 * PMX-04 image-provenance GATES — the four defects an adversarial audit found in
 * the gates themselves (aug-22).
 *
 * Every test here is about a gate that returned CLEAN on input it exists to
 * refuse. The shape of each proof is therefore the same: build the exact
 * artefact the ticket forbids, run the REAL gate, and require a refusal that
 * NAMES the offending value — never a bare `toThrow()`, which a gate that
 * refuses everything would also satisfy. Each block carries a PAIRED CONTROL (a
 * legal artefact the same gate must accept) so "refuses everything" fails too.
 *
 * ⚠️ SPEND SAFETY. The Docker boundary is an injected recording fake; nothing
 * here can reach a daemon, a registry, or EC2.
 */
import { describe, expect, test } from "bun:test"
import {
  assertGoldenDerivationIsImageOnly,
  assertImageFreezeReadyForModelLaunch,
  type CampaignGoldenPin,
  type DockerPort,
  deriveCampaignGolden,
  diffGoldenDocuments,
  PROMAX_REQUIRED_ARCHITECTURE,
  PROMAX_REQUIRED_OS,
  type ProMaxImageFaultCode,
  type ProMaxImageFreezeReceipt,
  type ProMaxImageTarget,
  type ProMaxPreflightStage,
  runProMaxImagePreflight,
} from "@/apps/bench/harness/promax"

const REPO = "key4127/refactor-dockerhub"
const DIGEST_A = `${REPO}@sha256:${"a".repeat(64)}`
const DIGEST_B = `${REPO}@sha256:${"b".repeat(64)}`
const LOCAL_ID = `sha256:${"1".repeat(64)}`
const ALPHA = "promax__alpha-1"
const BETA = "promax__beta-2"

// ---------------------------------------------------------------------------
// golden-document fixtures
// ---------------------------------------------------------------------------

const SOURCE_ROWS: readonly Record<string, unknown>[] = [
  {
    instance_id: ALPHA,
    repo: "acme/alpha",
    image_name: `${REPO}:${ALPHA}`,
    patch: "diff --git a/x b/x\n",
    language: "python",
  },
  {
    instance_id: BETA,
    repo: "acme/beta",
    image_name: `${REPO}:${BETA}`,
    patch: "diff --git a/y b/y\n",
    language: "go",
  },
]

const sourceText = JSON.stringify(SOURCE_ROWS, null, 2)

const PINS: readonly CampaignGoldenPin[] = [
  { instanceId: ALPHA, pinnedReference: DIGEST_A },
  { instanceId: BETA, pinnedReference: DIGEST_B },
]

const derivedText = (): string => {
  const r = deriveCampaignGolden({ sourceText, pins: PINS })
  if (!r.ok) throw new Error(`derivation refused: ${JSON.stringify(r.failures)}`)
  return r.json
}

/** Re-author the derived document by hand — what a drifted producer would ship. */
const rewriteDerived = (edit: (rows: Record<string, unknown>[]) => void): string => {
  const rows = JSON.parse(derivedText()) as Record<string, unknown>[]
  edit(rows)
  return JSON.stringify(rows, null, 2)
}

const gateProblems = (derived: string, pins: readonly CampaignGoldenPin[] = PINS): string[] => [
  ...assertGoldenDerivationIsImageOnly(diffGoldenDocuments(sourceText, derived), pins),
]

// ---------------------------------------------------------------------------
// P2 — "image-only" must also mean "digest-pinned, and the SAME digest"
// ---------------------------------------------------------------------------

describe("P2 — the image-only gate refuses a MUTABLE TAG in the derived golden", () => {
  test("PAIRED CONTROL: the real, legally derived document is clean", () => {
    // Known-item floor: a gate that refuses everything would fail here.
    expect(gateProblems(derivedText())).toEqual([])
  })

  test("a tag → tag swap is REFUSED (the defect: any image_name delta was permitted)", () => {
    const swapped = rewriteDerived((rows) => {
      // The exact regression: someone "pins" the image by pointing at another
      // mutable tag. `docker pull <tag>` inside the pinned evaluator can still
      // serve different bytes on the next run.
      if (rows[0] !== undefined) rows[0].image_name = `${REPO}:frozen-2026-08-22`
    })
    const problems = gateProblems(swapped)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join("\n")).toContain(`${REPO}:frozen-2026-08-22`)
    expect(problems.join("\n")).toContain(ALPHA)
    // and it says WHY, so an operator is not left guessing
    expect(problems.join("\n")).toMatch(/digest/i)
  })

  test("a digest-shaped but WRONG digest is refused (it must equal the freeze's pin)", () => {
    const crossed = rewriteDerived((rows) => {
      // alpha pinned to BETA's digest — structurally a perfect digest reference.
      if (rows[0] !== undefined) rows[0].image_name = DIGEST_B
    })
    const problems = gateProblems(crossed)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join("\n")).toContain(DIGEST_A)
    expect(problems.join("\n")).toContain(DIGEST_B)
  })

  test("a row the freeze resolved NO digest for is refused (silent partial pinning)", () => {
    // The freeze covered alpha only; beta keeps whatever the source said.
    const problems = gateProblems(derivedText(), [PINS[0] as CampaignGoldenPin])
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join("\n")).toContain(BETA)
  })

  test("an UNCHANGED mutable tag is refused even though the diff has no delta", () => {
    // The subtle half of the defect: the structural diff only reports DELTAS, so
    // a derived document that simply forgot to replace a tag produced neither a
    // change nor a violation.
    const untouched = rewriteDerived((rows) => {
      if (rows[0] !== undefined) rows[0].image_name = `${REPO}:${ALPHA}`
    })
    expect(diffGoldenDocuments(sourceText, untouched).ok).toBe(true)
    const problems = gateProblems(untouched)
    expect(problems.length).toBeGreaterThan(0)
    expect(problems.join("\n")).toContain(ALPHA)
  })
})

// ---------------------------------------------------------------------------
// P4 — prototype-walking in the structural diff
// ---------------------------------------------------------------------------

describe("P4 — the structural diff uses OWN-property checks, not `in`", () => {
  const PROTO_KEYS = ["constructor", "toString", "hasOwnProperty", "valueOf"] as const

  test("a derived row that ADDS a prototype-named key is caught", () => {
    for (const key of PROTO_KEYS) {
      const added = rewriteDerived((rows) => {
        // `Record<string, unknown>` still resolves `constructor`/`toString` to
        // their PROTOTYPE types, which is the same confusion the defect was
        // made of — the cast asserts "a JSON key that happens to be spelled
        // like a prototype member".
        if (rows[0] !== undefined) (rows[0] as Record<string, string>)[key] = "smuggled"
      })
      const diff = diffGoldenDocuments(sourceText, added)
      if (!diff.ok) throw new Error("diff refused")
      expect(diff.violations.map((v) => [v.code, v.field])).toEqual([["field_added", key]])
      expect(gateProblems(added).join("\n")).toContain(key)
    }
  })

  test("a derived row that DROPS a prototype-named key the source has is caught", () => {
    for (const key of PROTO_KEYS) {
      const withKey = JSON.parse(sourceText) as Record<string, unknown>[]
      if (withKey[0] !== undefined) (withKey[0] as Record<string, string>)[key] = "present upstream"
      const src = JSON.stringify(withKey, null, 2)
      const derived = deriveCampaignGolden({ sourceText: src, pins: PINS })
      if (!derived.ok) throw new Error("derivation refused")
      const dropped = JSON.parse(derived.json) as Record<string, unknown>[]
      if (dropped[0] !== undefined) delete dropped[0][key]
      const diff = diffGoldenDocuments(src, JSON.stringify(dropped, null, 2))
      if (!diff.ok) throw new Error("diff refused")
      expect(diff.violations.map((v) => [v.code, v.field])).toEqual([["field_removed", key]])
    }
  })

  test("PAIRED CONTROL: a legal derivation of the same rows stays clean", () => {
    const withKey = JSON.parse(sourceText) as Record<string, unknown>[]
    const protoKey: string = "constructor"
    if (withKey[0] !== undefined) (withKey[0] as Record<string, string>)[protoKey] = "upstream"
    const src = JSON.stringify(withKey, null, 2)
    const derived = deriveCampaignGolden({ sourceText: src, pins: PINS })
    if (!derived.ok) throw new Error("derivation refused")
    const diff = diffGoldenDocuments(src, derived.json)
    if (!diff.ok) throw new Error("diff refused")
    expect(diff.violations).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// P3 — the pre-token-spend gate
// ---------------------------------------------------------------------------

const record = (over: Partial<ProMaxImageFreezeReceipt["images"][number]> = {}) => ({
  instance_id: ALPHA,
  source_image_name: `${REPO}:${ALPHA}`,
  registry_repo_digest: DIGEST_A,
  local_image_id: LOCAL_ID,
  os: PROMAX_REQUIRED_OS,
  architecture: PROMAX_REQUIRED_ARCHITECTURE,
  resolved_at: "2026-08-22T12:00:00.000Z",
  ...over,
})

const receiptWith = (over: Partial<ProMaxImageFreezeReceipt> = {}): ProMaxImageFreezeReceipt => ({
  receipt_version: 1,
  campaign_id: "PMX-7@abc123",
  upstream_git_commit: "77041028bc4e2135644b63b504aa961a68aafbb6",
  required_platform: { os: PROMAX_REQUIRED_OS, architecture: PROMAX_REQUIRED_ARCHITECTURE },
  golden_source: { path: "/c/source-golden.json", sha256: "e".repeat(64) },
  golden_derived: { path: "/c/campaign-golden.json", sha256: "f".repeat(64) },
  images: [record()],
  faults: [],
  ok: true,
  ...over,
})

describe("P3 — assertImageFreezeReadyForModelLaunch, clause by clause", () => {
  test("PAIRED CONTROL: a fully digest-pinned, fully covering receipt passes", () => {
    expect(() => assertImageFreezeReadyForModelLaunch(receiptWith(), [ALPHA])).not.toThrow()
  })

  test("clause: an all-MUTABLE-TAG image set is refused", () => {
    const tags = receiptWith({
      images: [record({ registry_repo_digest: `${REPO}:${ALPHA}` })],
    })
    expect(() => assertImageFreezeReadyForModelLaunch(tags, [ALPHA])).toThrow(
      new RegExp(`${REPO}:${ALPHA}`),
    )
    expect(() => assertImageFreezeReadyForModelLaunch(tags, [ALPHA])).toThrow(/mutable tag/i)
  })

  test("clause: a per-image platform CONTRADICTING the receipt's requirement is refused", () => {
    const contradiction = receiptWith({ images: [record({ architecture: "arm64" })] })
    expect(() => assertImageFreezeReadyForModelLaunch(contradiction, [ALPHA])).toThrow(/arm64/)
    const osContradiction = receiptWith({ images: [record({ os: "windows" })] })
    expect(() => assertImageFreezeReadyForModelLaunch(osContradiction, [ALPHA])).toThrow(/windows/)
  })

  test("clause: a receipt that LOWERED its own required_platform is refused", () => {
    // Otherwise the contradiction check above is defeated by editing the
    // requirement rather than the records.
    const lowered = receiptWith({
      required_platform: { os: "windows", architecture: "arm64" },
      images: [record({ os: "windows", architecture: "arm64" })],
    })
    expect(() => assertImageFreezeReadyForModelLaunch(lowered, [ALPHA])).toThrow(
      /windows\/arm64|required_platform/,
    )
  })

  test("clause: coverage must EQUAL the assigned set — missing AND extra both refuse", () => {
    const clean = receiptWith()
    expect(() => assertImageFreezeReadyForModelLaunch(clean, [ALPHA, BETA])).toThrow(
      new RegExp(BETA),
    )
    const extra = receiptWith({ images: [record(), record({ instance_id: "promax__gamma-3" })] })
    expect(() => assertImageFreezeReadyForModelLaunch(extra, [ALPHA])).toThrow(/promax__gamma-3/)
  })

  test("clause: a duplicated image record is refused", () => {
    const dup = receiptWith({ images: [record(), record()] })
    expect(() => assertImageFreezeReadyForModelLaunch(dup, [ALPHA])).toThrow(/more than one/i)
  })

  test("faults still refuse FIRST, before any of the above", () => {
    const faulted = receiptWith({
      faults: [
        {
          instance_id: ALPHA,
          code: "pull_failed",
          stage: "pull",
          message: "boom",
          argv: ["pull", "--platform", "linux/amd64", DIGEST_A],
          exit_code: 1,
        },
      ],
      ok: false,
    })
    expect(() => assertImageFreezeReadyForModelLaunch(faulted, [ALPHA])).toThrow(/pull_failed/)
  })
})

// ---------------------------------------------------------------------------
// P5 — start faults must arrive ALONE
// ---------------------------------------------------------------------------

interface Recorded {
  readonly argv: readonly string[]
}

const inspectDefault = {
  Id: LOCAL_ID,
  Os: PROMAX_REQUIRED_OS,
  Architecture: PROMAX_REQUIRED_ARCHITECTURE,
  RepoDigests: [DIGEST_A],
}

const TARGETS: readonly ProMaxImageTarget[] = [
  { instanceId: ALPHA, sourceImageName: `${REPO}:${ALPHA}`, registryRepoDigest: DIGEST_A },
]

interface FakeOpts {
  readonly faults?: ReadonlyMap<string, { code: number; stdout?: string; stderr?: string }>
  /** Does a container with the preflight's name exist on the fake daemon? */
  readonly containerExists?: boolean
}

const makeDocker = (calls: Recorded[], opts: FakeOpts = {}): DockerPort => {
  // Models the daemon's actual bookkeeping, which is the whole point of P5: a
  // container exists only after a SUCCESSFUL `run -d` (or because the caller said
  // a half-created one was left behind), and `rm -f` against one that does not
  // exist EXITS NON-ZERO — the real behavior that turned every `start_failed`
  // into a `start_failed` + `cleanup_failed` pair.
  let exists = opts.containerExists === true
  return async (argv) => {
    calls.push({ argv: [...argv] })
    const joined = argv.join(" ")
    for (const [needle, outcome] of opts.faults ?? new Map()) {
      if (joined.includes(needle)) {
        return { code: outcome.code, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" }
      }
    }
    if (argv[0] === "run") {
      exists = true
      return { code: 0, stdout: "", stderr: "" }
    }
    if (argv[0] === "container" && argv[1] === "inspect") {
      return exists
        ? { code: 0, stdout: `${LOCAL_ID}\n`, stderr: "" }
        : { code: 1, stdout: "", stderr: "Error: No such container" }
    }
    if (argv[0] === "rm") {
      return exists
        ? { code: 0, stdout: "", stderr: "" }
        : { code: 1, stdout: "", stderr: "Error: No such container: qpmx_…" }
    }
    if (argv[0] === "image" && argv[1] === "inspect") {
      return { code: 0, stdout: `${JSON.stringify(inspectDefault)}\n`, stderr: "" }
    }
    if (argv[0] === "exec") {
      return { code: 0, stdout: "__QPMX_SENTINEL__=ABSENT\n__QPMX_CP__=OK\n", stderr: "" }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
}

const preflight = async (opts: FakeOpts = {}) => {
  const calls: Recorded[] = []
  const receipt = await runProMaxImagePreflight({
    campaignId: "PMX-7@abc123",
    upstreamGitCommit: "77041028bc4e2135644b63b504aa961a68aafbb6",
    targets: TARGETS,
    docker: makeDocker(calls, opts),
    now: () => new Date("2026-08-22T12:00:00.000Z"),
    probeFilePath: "/campaign/probe.txt",
    goldenSource: { path: "/c/source-golden.json", sha256: "e".repeat(64) },
    goldenDerived: { path: "/c/campaign-golden.json", sha256: "f".repeat(64) },
  })
  return { receipt, calls }
}

describe("P5 — each Docker fault class is distinguishable", () => {
  test("pull / start / cp / exec map to DISTINCT reasons, each ALONE", async () => {
    // `docker rm -f` on a container `docker run` never created exits non-zero on
    // a real daemon, which is what made `start_failed` arrive with a second,
    // spurious `cleanup_failed` beside it.
    const cases: readonly [
      ProMaxImageFaultCode,
      Map<string, { code: number; stderr?: string }>,
      ProMaxPreflightStage,
    ][] = [
      ["pull_failed", new Map([["pull ", { code: 1, stderr: "manifest unknown" }]]), "pull"],
      ["start_failed", new Map([["run -d", { code: 125, stderr: "no space left" }]]), "start"],
      [
        "cp_failed",
        new Map([["cp /campaign/probe.txt", { code: 1, stderr: "no such file" }]]),
        "cp",
      ],
      ["exec_failed", new Map([["exec -u root", { code: 126, stderr: "no bash" }]]), "exec"],
    ]
    const seen = new Set<string>()
    for (const [code, faults, stage] of cases) {
      const { receipt } = await preflight({ faults, containerExists: false })
      expect(receipt.faults.map((f) => f.code)).toEqual([code])
      expect(receipt.faults[0]?.stage).toBe(stage)
      expect(receipt.images).toEqual([])
      seen.add(code)
    }
    // Known-item floor + distinctness: four inputs, four DIFFERENT codes.
    expect(seen.size).toBe(4)
  })

  test("a failed start does NOT `rm` a container that was never created", async () => {
    const { receipt, calls } = await preflight({
      faults: new Map([["run -d", { code: 125, stderr: "no space left" }]]),
      containerExists: false,
    })
    expect(receipt.faults.map((f) => f.code)).toEqual(["start_failed"])
    expect(calls.map((c) => c.argv[0])).toEqual(["pull", "image", "run", "container"])
    expect(calls.some((c) => c.argv[0] === "rm")).toBe(false)
  })

  test("a failed start that DID leave a container still cleans it, and a failed clean is reported", async () => {
    const { receipt, calls } = await preflight({
      faults: new Map([
        ["run -d", { code: 125, stderr: "entrypoint died" }],
        ["rm -f", { code: 1, stderr: "device busy" }],
      ]),
      containerExists: true,
    })
    expect(receipt.faults.map((f) => f.code)).toEqual(["start_failed", "cleanup_failed"])
    expect(calls.map((c) => c.argv[0])).toEqual(["pull", "image", "run", "container", "rm"])
  })

  test("PAIRED CONTROL: the happy path is unchanged — one rm, no existence probe", async () => {
    const { receipt, calls } = await preflight()
    expect(receipt.faults).toEqual([])
    expect(receipt.images.map((i) => i.instance_id)).toEqual([ALPHA])
    expect(calls.map((c) => c.argv[0])).toEqual(["pull", "image", "run", "cp", "exec", "rm"])
  })
})
