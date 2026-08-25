/**
 * Hellgate — bench-resume FOUNDATION (identity + config + store factory).
 *
 * These three modules are the CONTRACT consumed by the later producer/consumer
 * agents, so the tests pin the EXACT surface:
 *   - resumeKey: pure, S3-safe `${campaignId}/${instanceId}`.
 *   - resolveResumeConfig: DEFAULT-OFF gate + bucket/region/campaignId resolution.
 *   - resumeActive: fail-CLOSED (enabled-but-no-bucket ⇒ NOT active).
 *   - resumeStore: thin composition (s3Backend → segmentStore → s3ReplayStore)
 *     with an injected fake runAws so it is asserted offline.
 */
import { describe, expect, test } from "bun:test"
import { resolveResumeConfig, resumeActive, resumeKey, resumeStore } from "@/apps/bench/resume"
import type { RunAwsResult } from "@/shared/remote-store"

describe("resumeKey — pure S3-safe identity", () => {
  test("joins campaign/instance with a single slash", () => {
    expect(resumeKey({ campaignId: "camp", instanceId: "django__django-11138" })).toBe(
      "camp/django__django-11138",
    )
  })

  test("collapses unsafe chars to '_' in each component", () => {
    // spaces, colons, slashes-inside-a-component, etc. are unsafe for an S3 key.
    expect(resumeKey({ campaignId: "my camp/v2", instanceId: "a:b c" })).toBe("my_camp_v2/a_b_c")
  })

  test("strips leading/trailing slashes from each sanitized component", () => {
    const k = resumeKey({ campaignId: "/lead/", instanceId: "/trail/" })
    expect(k.startsWith("/")).toBe(false)
    expect(k.endsWith("/")).toBe(false)
    // exactly ONE separator slash between the two components
    expect(k.split("/").filter((s) => s !== "").length).toBe(2)
  })

  test("is pure — same input, same output, no env dependence", () => {
    const p = { campaignId: "c", instanceId: "i" }
    expect(resumeKey(p)).toBe(resumeKey(p))
  })
})

describe("resolveResumeConfig — DEFAULT-OFF + resolution", () => {
  test("empty env ⇒ enabled:false (byte-identical default)", () => {
    const c = resolveResumeConfig({})
    expect(c.enabled).toBe(false)
    expect(c.bucket).toBeUndefined()
    expect(c.region).toBeUndefined()
    expect(c.campaignId).toBe("default-campaign")
  })

  test("a non-truthy gate value stays OFF (0/off/'')", () => {
    expect(resolveResumeConfig({ QUANTA_BENCH_RESUME: "0" }).enabled).toBe(false)
    expect(resolveResumeConfig({ QUANTA_BENCH_RESUME: "off" }).enabled).toBe(false)
    expect(resolveResumeConfig({ QUANTA_BENCH_RESUME: "" }).enabled).toBe(false)
  })

  test("the gate flips ON only for a truthy token", () => {
    expect(resolveResumeConfig({ QUANTA_BENCH_RESUME: "1" }).enabled).toBe(true)
    expect(resolveResumeConfig({ QUANTA_BENCH_RESUME: "on" }).enabled).toBe(true)
    expect(resolveResumeConfig({ QUANTA_BENCH_RESUME: "true" }).enabled).toBe(true)
  })

  test("bucket comes from QUANTA_BENCH_RESUME_S3_BUCKET (undefined if unset)", () => {
    expect(resolveResumeConfig({ QUANTA_BENCH_RESUME_S3_BUCKET: "my-bucket" }).bucket).toBe(
      "my-bucket",
    )
    expect(resolveResumeConfig({}).bucket).toBeUndefined()
  })

  test("region prefers AWS_REGION, then QUANTA_FULL_REMOTE_REGION", () => {
    expect(resolveResumeConfig({ AWS_REGION: "us-east-1" }).region).toBe("us-east-1")
    expect(resolveResumeConfig({ QUANTA_FULL_REMOTE_REGION: "ap-northeast-2" }).region).toBe(
      "ap-northeast-2",
    )
    // AWS_REGION wins when both are present
    expect(
      resolveResumeConfig({
        AWS_REGION: "us-east-1",
        QUANTA_FULL_REMOTE_REGION: "ap-northeast-2",
      }).region,
    ).toBe("us-east-1")
    expect(resolveResumeConfig({}).region).toBeUndefined()
  })

  test("campaignId comes from QUANTA_BENCH_CAMPAIGN_ID, else 'default-campaign'", () => {
    expect(resolveResumeConfig({ QUANTA_BENCH_CAMPAIGN_ID: "jun-27" }).campaignId).toBe("jun-27")
    expect(resolveResumeConfig({}).campaignId).toBe("default-campaign")
  })
})

describe("resumeActive — fail-CLOSED activation predicate", () => {
  test("enabled + complete security config ⇒ active (narrows required fields)", () => {
    const c = resolveResumeConfig({
      QUANTA_BENCH_RESUME: "1",
      QUANTA_BENCH_RESUME_S3_BUCKET: "b",
      QUANTA_BENCH_RESUME_KMS_KEY_ARN: "arn:aws:kms:us-east-1:123:key/k",
      QUANTA_BENCH_RESUME_PRINCIPAL_ARN: "arn:aws:iam::123:role/resume",
      QUANTA_BENCH_RESUME_MAX_RETENTION_DAYS: "7",
    })
    expect(resumeActive(c)).toBe(true)
    if (resumeActive(c)) {
      // type-narrowing guard: bucket is now a concrete string
      const s: string = c.bucket
      expect(s).toBe("b")
    }
  })

  test("enabled + bucket but missing security config ⇒ NOT active", () => {
    expect(
      resumeActive(
        resolveResumeConfig({
          QUANTA_BENCH_RESUME: "1",
          QUANTA_BENCH_RESUME_S3_BUCKET: "b",
        }),
      ),
    ).toBe(false)
  })

  test("enabled but NO bucket ⇒ NOT active (fail-closed, never invent a bucket)", () => {
    const c = resolveResumeConfig({ QUANTA_BENCH_RESUME: "1" })
    expect(c.enabled).toBe(true)
    expect(c.bucket).toBeUndefined()
    expect(resumeActive(c)).toBe(false)
  })

  test("disabled + bucket ⇒ NOT active", () => {
    const c = resolveResumeConfig({ QUANTA_BENCH_RESUME_S3_BUCKET: "b" })
    expect(c.enabled).toBe(false)
    expect(resumeActive(c)).toBe(false)
  })
})

describe("resumeStore — thin composition over s3Backend/segmentStore/replayStore", () => {
  test("wires segmentStore key + replayStore using the injected runAws", async () => {
    // Capture every aws invocation so we can prove the key threads into the
    // S3 paths (segmentStore writes `<key>/events/<seq>.json`).
    const calls: string[][] = []
    const runAws = async (args: readonly string[]): Promise<RunAwsResult> => {
      calls.push([...args])
      // `s3 ls` (list) → empty listing; `s3 cp ... -` (get) → not-found.
      if (args.includes("ls")) return { stdout: "", exitCode: 0 }
      if (args.includes("cp") && args[args.length - 1] === "-") {
        return { stdout: "", exitCode: 1, stderr: "NoSuchKey" }
      }
      return { stdout: "", exitCode: 0 }
    }

    const key = resumeKey({ campaignId: "camp", instanceId: "iid-1" })
    const rs = resumeStore({ bucket: "bucket-x", region: "us-east-1", runAws }, key)

    expect(typeof rs.backend.put).toBe("function")
    expect(typeof rs.segments.putSegment).toBe("function")
    expect(typeof rs.replayStore.append).toBe("function")
    expect(typeof rs.writeReceipt).toBe("function")
    expect(typeof rs.readReceipt).toBe("function")

    // Exercise a real write through the replay store: it must put exactly the
    // segmentStore path under `<key>/events/`.
    await rs.replayStore.append({
      id: "h",
      request: { messages: [] } as never,
      events: [],
      metadata: { recordedAt: 0, model: "test", durationMs: 0 },
    })

    const putCall = calls.find((c) => c.includes("cp") && c[c.indexOf("cp") + 1] === "-")
    expect(putCall).toBeDefined()
    const target = putCall?.[putCall.indexOf("cp") + 2] ?? ""
    expect(target).toBe(`s3://bucket-x/${key}/events/000000.json`)

    // Receipt helpers bind (backend, key): a read with no object ⇒ undefined.
    const receipt = await rs.readReceipt()
    expect(receipt).toBeUndefined()

    // A receipt write puts to `<key>/resume-state.json`.
    await rs.writeReceipt({
      key,
      campaignId: "camp",
      instanceId: "iid-1",
      latestSeq: 0,
      degraded: false,
      updatedAt: new Date().toISOString(),
    })
    const receiptPut = calls.find(
      (c) =>
        c.includes("cp") && (c[c.indexOf("cp") + 2] ?? "").endsWith(`${key}/resume-state.json`),
    )
    expect(receiptPut).toBeDefined()
  })

  test("region flows into the aws --region argument", async () => {
    const calls: string[][] = []
    const runAws = async (args: readonly string[]): Promise<RunAwsResult> => {
      calls.push([...args])
      if (args.includes("ls")) return { stdout: "", exitCode: 0 }
      return { stdout: "", exitCode: 1, stderr: "NoSuchKey" }
    }
    const rs = resumeStore(
      { bucket: "b", region: "ap-northeast-2", runAws },
      resumeKey({ campaignId: "c", instanceId: "i" }),
    )
    await rs.readReceipt()
    const withRegion = calls.find((c) => c.includes("--region"))
    expect(withRegion).toBeDefined()
    expect(withRegion?.[(withRegion?.indexOf("--region") ?? 0) + 1]).toBe("ap-northeast-2")
  })
})
