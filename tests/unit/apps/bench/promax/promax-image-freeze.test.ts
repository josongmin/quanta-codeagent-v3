/**
 * PMX-04 — per-instance image provenance and the ONE Docker preflight.
 *
 * Packet invariant 6: *"Every instance records source image reference, registry
 * digest, local image ID, and platform. Mutable tags alone are not replay
 * evidence."* This file proves that record is produced by an actual sequence of
 * Docker commands (argv asserted token-for-token) and that every distinguishable
 * way the sequence can fail lands in a DISTINCT typed reason.
 *
 * ⚠️ SPEND SAFETY. Nothing here touches a real daemon, a registry, or EC2. The
 * `DockerPort` is INJECTED as a recording fake and the fake is the only process
 * boundary in the module under test, so a regression cannot start pulling
 * multi-gigabyte images from a unit test. Real `docker pull` is deferred-live.
 */
import { describe, expect, test } from "bun:test"
import {
  assertImageFreezeReadyForModelLaunch,
  type DockerPort,
  goldSentinelPath,
  PROMAX_IMAGE_FAULT_CODES,
  PROMAX_IMAGE_FAULT_REASONS,
  type ProMaxImageFaultCode,
  type ProMaxImageTarget,
  parseProMaxImageFreezeReceipt,
  proMaxPreflightContainerName,
  runProMaxImagePreflight,
  serializeProMaxImageFreezeReceipt,
} from "@/apps/bench/harness/promax"

const CAMPAIGN = "PMX-7@abc123"
const DIGEST_A = `key4127/refactor-dockerhub@sha256:${"a".repeat(64)}`
const DIGEST_B = `key4127/refactor-dockerhub@sha256:${"b".repeat(64)}`
const LOCAL_ID = `sha256:${"1".repeat(64)}`

const TARGETS: readonly ProMaxImageTarget[] = [
  {
    instanceId: "promax__alpha-1",
    sourceImageName: "key4127/refactor-dockerhub:promax__alpha-1",
    registryRepoDigest: DIGEST_A,
  },
]

interface Recorded {
  readonly argv: readonly string[]
}

interface FakeOpts {
  /** Override the outcome for the FIRST argv whose joined form contains `match`. */
  readonly faults?: ReadonlyMap<string, { code: number; stdout?: string; stderr?: string }>
  readonly inspectJson?: Record<string, unknown>
  readonly execStdout?: string
}

const inspectDefault = {
  Id: LOCAL_ID,
  Os: "linux",
  Architecture: "amd64",
  RepoDigests: [DIGEST_A],
}

const makeDocker = (calls: Recorded[], opts: FakeOpts = {}): DockerPort => {
  return async (argv) => {
    calls.push({ argv: [...argv] })
    const joined = argv.join(" ")
    for (const [needle, outcome] of opts.faults ?? new Map()) {
      if (joined.includes(needle)) {
        return { code: outcome.code, stdout: outcome.stdout ?? "", stderr: outcome.stderr ?? "" }
      }
    }
    if (argv[0] === "image" && argv[1] === "inspect") {
      return {
        code: 0,
        stdout: `${JSON.stringify(opts.inspectJson ?? inspectDefault)}\n`,
        stderr: "",
      }
    }
    if (argv[0] === "exec") {
      return {
        code: 0,
        stdout: opts.execStdout ?? "__QPMX_SENTINEL__=ABSENT\n__QPMX_CP__=OK\n",
        stderr: "",
      }
    }
    return { code: 0, stdout: "", stderr: "" }
  }
}

const GOLDEN_SOURCE = { path: "/campaign/source-golden.json", sha256: "e".repeat(64) }
const GOLDEN_DERIVED = { path: "/campaign/campaign-golden.json", sha256: "f".repeat(64) }

const runPreflight = async (opts: FakeOpts = {}, targets = TARGETS) => {
  const calls: Recorded[] = []
  const receipt = await runProMaxImagePreflight({
    campaignId: CAMPAIGN,
    upstreamGitCommit: "77041028bc4e2135644b63b504aa961a68aafbb6",
    targets,
    docker: makeDocker(calls, opts),
    now: () => new Date("2026-08-22T12:00:00.000Z"),
    probeFilePath: "/campaign/preflight-probe.txt",
    goldenSource: GOLDEN_SOURCE,
    goldenDerived: GOLDEN_DERIVED,
  })
  return { receipt, calls }
}

describe("PMX-04 image preflight — the exact Docker argv, in order", () => {
  test("pull → inspect → run → cp → exec → rm, with the container cleaned and the IMAGE kept", async () => {
    const { receipt, calls } = await runPreflight()
    const container = proMaxPreflightContainerName(CAMPAIGN, "promax__alpha-1")
    expect(calls.map((c) => c.argv)).toEqual([
      ["pull", DIGEST_A],
      ["image", "inspect", "--format", "{{json .}}", DIGEST_A],
      ["run", "-d", "--name", container, DIGEST_A, "tail", "-f", "/dev/null"],
      ["cp", "/campaign/preflight-probe.txt", `${container}:/tmp/quanta-preflight-probe.txt`],
      [
        "exec",
        "-u",
        "root",
        container,
        "bash",
        "-c",
        calls[4]?.argv[6] ?? "<unset>", // shape asserted separately below
      ],
      ["rm", "-f", container],
    ])
    expect(receipt.ok).toBe(true)

    // The cached IMAGE is campaign evidence — the cleanup must never remove it.
    const flat = calls.map((c) => c.argv.join(" "))
    expect(flat.some((c) => c.startsWith("rmi "))).toBe(false)
    expect(flat.some((c) => c.startsWith("image rm"))).toBe(false)
    expect(flat.some((c) => c.startsWith("system prune"))).toBe(false)
  })

  test("the exec probe checks the CAMPAIGN-UNIQUE sentinel path under /testbed and the cp landing", async () => {
    const { calls } = await runPreflight()
    const script = calls[4]?.argv[6] ?? ""
    expect(script).toContain(`/testbed/${goldSentinelPath(CAMPAIGN)}`)
    expect(script).toContain("__QPMX_SENTINEL__")
    expect(script).toContain("__QPMX_CP__")
    // Campaign-unique by construction: a different campaign probes a different path.
    expect(script).not.toContain(goldSentinelPath("some-other-campaign"))
  })

  test("resolves the full invariant-6 record for every assigned instance", async () => {
    const { receipt } = await runPreflight()
    expect(receipt.images).toEqual([
      {
        instance_id: "promax__alpha-1",
        source_image_name: "key4127/refactor-dockerhub:promax__alpha-1",
        registry_repo_digest: DIGEST_A,
        local_image_id: LOCAL_ID,
        os: "linux",
        architecture: "amd64",
        resolved_at: "2026-08-22T12:00:00.000Z",
      },
    ])
    expect(receipt.faults).toEqual([])
    expect(receipt.golden_source).toEqual(GOLDEN_SOURCE)
    expect(receipt.golden_derived).toEqual(GOLDEN_DERIVED)
  })
})

describe("PMX-04 image preflight — every fault class maps to a DISTINCT reason", () => {
  const faultCodesFor = async (opts: FakeOpts): Promise<readonly ProMaxImageFaultCode[]> => {
    const { receipt } = await runPreflight(opts)
    return receipt.faults.map((f) => f.code)
  }

  test("pull failure ⇒ pull_failed, and NOTHING downstream is attempted", async () => {
    const { receipt, calls } = await runPreflight({
      faults: new Map([["pull ", { code: 1, stderr: "manifest unknown" }]]),
    })
    expect(receipt.faults.map((f) => f.code)).toEqual(["pull_failed"])
    expect(receipt.images).toEqual([])
    expect(calls.map((c) => c.argv[0])).toEqual(["pull"])
    expect(receipt.faults[0]?.argv).toEqual(["pull", DIGEST_A])
    expect(receipt.faults[0]?.exit_code).toBe(1)
  })

  test("inspect failure ⇒ inspect_failed", async () => {
    expect(await faultCodesFor({ faults: new Map([["image inspect", { code: 1 }]]) })).toEqual([
      "inspect_failed",
    ])
  })

  test("unparseable inspect output ⇒ inspect_unparseable (never a fabricated record)", async () => {
    const { receipt } = await runPreflight({
      faults: new Map([["image inspect", { code: 0, stdout: "not json" }]]),
    })
    expect(receipt.faults.map((f) => f.code)).toEqual(["inspect_unparseable"])
    expect(receipt.images).toEqual([])
  })

  test("an image reference resolving to a DIFFERENT digest ⇒ digest_mismatch", async () => {
    const { receipt, calls } = await runPreflight({
      inspectJson: { ...inspectDefault, RepoDigests: [DIGEST_B] },
    })
    expect(receipt.faults.map((f) => f.code)).toEqual(["digest_mismatch"])
    expect(receipt.faults[0]?.message).toContain(DIGEST_A)
    expect(receipt.faults[0]?.message).toContain(DIGEST_B)
    // Refused BEFORE any container was started — no model tokens, no run.
    expect(calls.map((c) => c.argv[0])).toEqual(["pull", "image"])
  })

  test("a non-amd64 platform ⇒ platform_unsupported, refused BEFORE any container starts", async () => {
    const { receipt, calls } = await runPreflight({
      inspectJson: { ...inspectDefault, Architecture: "arm64" },
    })
    expect(receipt.faults.map((f) => f.code)).toEqual(["platform_unsupported"])
    expect(receipt.faults[0]?.message).toContain("arm64")
    expect(calls.map((c) => c.argv[0])).toEqual(["pull", "image"])
    expect(receipt.ok).toBe(false)
    // and the gate a model launch passes through refuses on it
    expect(() => assertImageFreezeReadyForModelLaunch(receipt, ["promax__alpha-1"])).toThrow(
      /platform_unsupported/,
    )
  })

  test("a non-linux OS ⇒ platform_unsupported", async () => {
    expect(await faultCodesFor({ inspectJson: { ...inspectDefault, Os: "windows" } })).toEqual([
      "platform_unsupported",
    ])
  })

  test("container start failure ⇒ start_failed (distinct from pull)", async () => {
    const { receipt, calls } = await runPreflight({
      faults: new Map([["run -d", { code: 125, stderr: "no space left" }]]),
    })
    expect(receipt.faults.map((f) => f.code)).toEqual(["start_failed"])
    // Still cleans up the (possibly half-created) container, never the image —
    // but ASKS the daemon whether there is one first (`container inspect`), so a
    // `rm -f` against a container `run -d` never created cannot manufacture a
    // second `cleanup_failed` fault beside the start fault. This fake's default
    // `container inspect` exits 0 ⇒ the container exists ⇒ it is removed.
    // Absence is covered in promax-image-provenance-gates.test.ts (P5).
    expect(calls.map((c) => c.argv[0])).toEqual(["pull", "image", "run", "container", "rm"])
  })

  test("docker cp failure ⇒ cp_failed (distinct from start and exec)", async () => {
    expect(await faultCodesFor({ faults: new Map([["cp /campaign", { code: 1 }]]) })).toEqual([
      "cp_failed",
    ])
  })

  test("a cp that exits 0 but did not land the file ⇒ cp_failed, proven IN the container", async () => {
    expect(
      await faultCodesFor({ execStdout: "__QPMX_SENTINEL__=ABSENT\n__QPMX_CP__=MISSING\n" }),
    ).toEqual(["cp_failed"])
  })

  test("docker exec failure ⇒ exec_failed (distinct from cp)", async () => {
    expect(await faultCodesFor({ faults: new Map([["exec -u root", { code: 126 }]]) })).toEqual([
      "exec_failed",
    ])
  })

  test("exec output missing its markers ⇒ exec_failed, never a silent pass", async () => {
    expect(await faultCodesFor({ execStdout: "" })).toEqual(["exec_failed"])
  })

  test("the gold-sentinel target path PRESENT in the image ⇒ sentinel_present", async () => {
    const { receipt } = await runPreflight({
      execStdout: "__QPMX_SENTINEL__=PRESENT\n__QPMX_CP__=OK\n",
    })
    expect(receipt.faults.map((f) => f.code)).toEqual(["sentinel_present"])
    expect(receipt.faults[0]?.message).toContain(goldSentinelPath(CAMPAIGN))
  })

  test("container cleanup failure ⇒ cleanup_failed and does NOT invalidate the image record", async () => {
    const { receipt } = await runPreflight({ faults: new Map([["rm -f", { code: 1 }]]) })
    expect(receipt.faults.map((f) => f.code)).toEqual(["cleanup_failed"])
    expect(receipt.images).toHaveLength(1)
  })

  test("the fault codes are pairwise DISTINCT across the fault classes above", async () => {
    const observed = [
      await faultCodesFor({ faults: new Map([["pull ", { code: 1 }]]) }),
      await faultCodesFor({ faults: new Map([["image inspect", { code: 1 }]]) }),
      await faultCodesFor({ faults: new Map([["run -d", { code: 1 }]]) }),
      await faultCodesFor({ faults: new Map([["cp /campaign", { code: 1 }]]) }),
      await faultCodesFor({ faults: new Map([["exec -u root", { code: 1 }]]) }),
    ].flat()
    expect(new Set(observed).size).toBe(observed.length)
    expect(observed).toEqual([
      "pull_failed",
      "inspect_failed",
      "start_failed",
      "cp_failed",
      "exec_failed",
    ])
  })

  test("every fault code has a reason (exhaustive Record + runtime drift guard)", () => {
    expect([...PROMAX_IMAGE_FAULT_CODES].sort()).toEqual(
      (Object.keys(PROMAX_IMAGE_FAULT_REASONS) as ProMaxImageFaultCode[]).sort(),
    )
    for (const code of PROMAX_IMAGE_FAULT_CODES) {
      expect(PROMAX_IMAGE_FAULT_REASONS[code].length).toBeGreaterThan(0)
    }
  })
})

describe("PMX-04 image preflight — multi-instance coverage", () => {
  test("one bad instance does not hide the others, and every assigned id is accounted for", async () => {
    const targets: readonly ProMaxImageTarget[] = [
      ...TARGETS,
      {
        instanceId: "promax__beta-2",
        sourceImageName: "key4127/refactor-dockerhub:promax__beta-2",
        registryRepoDigest: DIGEST_B,
      },
    ]
    const calls: Recorded[] = []
    const docker: DockerPort = async (argv) => {
      calls.push({ argv: [...argv] })
      if (argv[0] === "pull" && argv[1] === DIGEST_B) {
        return { code: 1, stdout: "", stderr: "denied" }
      }
      if (argv[0] === "image" && argv[1] === "inspect") {
        return { code: 0, stdout: `${JSON.stringify(inspectDefault)}\n`, stderr: "" }
      }
      if (argv[0] === "exec") {
        return { code: 0, stdout: "__QPMX_SENTINEL__=ABSENT\n__QPMX_CP__=OK\n", stderr: "" }
      }
      return { code: 0, stdout: "", stderr: "" }
    }
    const receipt = await runProMaxImagePreflight({
      campaignId: CAMPAIGN,
      upstreamGitCommit: "77041028bc4e2135644b63b504aa961a68aafbb6",
      targets,
      docker,
      now: () => new Date("2026-08-22T12:00:00.000Z"),
      probeFilePath: "/campaign/preflight-probe.txt",
      goldenSource: GOLDEN_SOURCE,
      goldenDerived: GOLDEN_DERIVED,
    })
    expect(receipt.images.map((i) => i.instance_id)).toEqual(["promax__alpha-1"])
    expect(receipt.faults.map((f) => [f.instance_id, f.code])).toEqual([
      ["promax__beta-2", "pull_failed"],
    ])
    expect(receipt.ok).toBe(false)
  })
})

describe("PMX-04 image freeze receipt — one schema, fail-closed on read", () => {
  test("serialize → parse round-trips the exact typed receipt", async () => {
    const { receipt } = await runPreflight()
    const parsed = parseProMaxImageFreezeReceipt(serializeProMaxImageFreezeReceipt(receipt))
    if (!parsed.ok) throw new Error(`parse refused: ${JSON.stringify(parsed.failures)}`)
    expect(parsed.receipt).toEqual(receipt)
  })

  test("raw Docker output is REFUSED, never coerced into a receipt", () => {
    const parsed = parseProMaxImageFreezeReceipt(
      "Error response from daemon: manifest for x:latest not found",
    )
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("unreachable")
    expect(parsed.failures.map((f) => f.code)).toEqual(["receipt_unparseable"])
  })

  test("an UNKNOWN fault code is refused — a consumer cannot invent a reason", async () => {
    const { receipt } = await runPreflight({ faults: new Map([["pull ", { code: 1 }]]) })
    const doc = JSON.parse(serializeProMaxImageFreezeReceipt(receipt)) as {
      faults: { code: string }[]
    }
    const fault = doc.faults[0]
    if (fault === undefined) throw new Error("expected a fault to tamper with")
    fault.code = "network_was_slow"
    const parsed = parseProMaxImageFreezeReceipt(JSON.stringify(doc))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("unreachable")
    expect(parsed.failures.map((f) => f.code)).toEqual(["fault_code_unknown"])
  })

  test("an `ok:true` receipt that carries faults is refused (ok is derived, not trusted)", async () => {
    const { receipt } = await runPreflight({ faults: new Map([["pull ", { code: 1 }]]) })
    const doc = JSON.parse(serializeProMaxImageFreezeReceipt(receipt)) as { ok: boolean }
    doc.ok = true
    const parsed = parseProMaxImageFreezeReceipt(JSON.stringify(doc))
    expect(parsed.ok).toBe(false)
    if (parsed.ok) throw new Error("unreachable")
    expect(parsed.failures.map((f) => f.code)).toEqual(["ok_inconsistent"])
  })

  test("a record missing an invariant-6 field is refused", async () => {
    const { receipt } = await runPreflight()
    const doc = JSON.parse(serializeProMaxImageFreezeReceipt(receipt)) as {
      images: Record<string, unknown>[]
    }
    for (const field of [
      "instance_id",
      "source_image_name",
      "registry_repo_digest",
      "local_image_id",
      "os",
      "architecture",
      "resolved_at",
    ]) {
      const copy = JSON.parse(JSON.stringify(doc)) as { images: Record<string, unknown>[] }
      delete (copy.images[0] as Record<string, unknown>)[field]
      const parsed = parseProMaxImageFreezeReceipt(JSON.stringify(copy))
      expect(parsed.ok).toBe(false)
      if (parsed.ok) throw new Error("unreachable")
      expect(parsed.failures[0]?.message).toContain(field)
    }
  })

  test("the launch gate passes a clean receipt and refuses a faulted one", async () => {
    const clean = (await runPreflight()).receipt
    expect(() => assertImageFreezeReadyForModelLaunch(clean, ["promax__alpha-1"])).not.toThrow()
    const faulted = (await runPreflight({ faults: new Map([["pull ", { code: 1 }]]) })).receipt
    // `assignedInstanceIds` is REQUIRED — a caller can no longer opt out of the
    // coverage half by omitting it (see P3 in promax-image-provenance-gates).
    expect(() => assertImageFreezeReadyForModelLaunch(faulted, ["promax__alpha-1"])).toThrow(
      /pull_failed/,
    )
  })

  test("the launch gate refuses a receipt that is MISSING an assigned instance", async () => {
    const clean = (await runPreflight()).receipt
    expect(() =>
      assertImageFreezeReadyForModelLaunch(clean, ["promax__alpha-1", "promax__gamma-3"]),
    ).toThrow(/promax__gamma-3/)
    expect(() => assertImageFreezeReadyForModelLaunch(clean, ["promax__alpha-1"])).not.toThrow()
  })
})
