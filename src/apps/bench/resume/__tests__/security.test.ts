import { describe, expect, test } from "bun:test"
import type { ResumeSecurityConfig } from "../security"
import { attestedBackend, attestResumeSecurity } from "../security"
import { resumeStore } from "../store"

const CFG: ResumeSecurityConfig = {
  bucket: "resume-bucket",
  keyPrefix: "campaign/instance",
  kmsKeyArn: "arn:aws:kms:us-east-1:123456789012:key/key-id",
  principalArn: "arn:aws:iam::123456789012:role/resume",
  maxRetentionDays: 7,
  region: "us-east-1",
}

const allowed = (decision = "allowed"): string =>
  JSON.stringify({ EvaluationResults: [{ EvalDecision: decision }] })

interface AwsFixtureOptions {
  readonly outsideAllowed?: boolean
  readonly lifecycleDays?: number
  readonly lifecycleFilter?: Record<string, unknown>
  readonly callerArn?: string
}

const fixtureDocument = (
  args: readonly string[],
  over: AwsFixtureOptions,
): Record<string, unknown> | undefined => {
  if (args.includes("get-caller-identity")) {
    return {
      Arn: over.callerArn ?? "arn:aws:sts::123456789012:assumed-role/resume/bench-session",
    }
  }
  if (args.includes("get-bucket-encryption")) {
    return {
      ServerSideEncryptionConfiguration: {
        Rules: [
          {
            ApplyServerSideEncryptionByDefault: {
              SSEAlgorithm: "aws:kms",
              KMSMasterKeyID: CFG.kmsKeyArn,
            },
          },
        ],
      },
    }
  }
  if (args.includes("get-public-access-block")) {
    return {
      PublicAccessBlockConfiguration: {
        BlockPublicAcls: true,
        IgnorePublicAcls: true,
        BlockPublicPolicy: true,
        RestrictPublicBuckets: true,
      },
    }
  }
  if (args.includes("get-bucket-lifecycle-configuration")) {
    return {
      Rules: [
        {
          Status: "Enabled",
          Filter: over.lifecycleFilter ?? { Prefix: "campaign/" },
          Expiration: { Days: over.lifecycleDays ?? 7 },
        },
      ],
    }
  }
  return undefined
}

const awsFixture =
  (over: AwsFixtureOptions = {}) =>
  async (args: readonly string[]) => {
    const document = fixtureDocument(args, over)
    if (document !== undefined) return { exitCode: 0, stderr: "", stdout: JSON.stringify(document) }
    const joined = args.join(" ")
    const outside = joined.includes("__quanta_resume_scope_probe_outside__")
    return {
      exitCode: 0,
      stderr: "",
      stdout: outside
        ? allowed(over.outsideAllowed === true ? "allowed" : "implicitDeny")
        : allowed(),
    }
  }

describe("resume security live attestation", () => {
  test("admits only KMS-pinned, public-blocked, retained, prefix-scoped access", async () => {
    const receipt = await attestResumeSecurity(
      CFG,
      awsFixture(),
      () => new Date("2026-08-25T00:00:00Z"),
    )
    expect(receipt).toEqual({
      schema: "quanta.resume-security.v2",
      bucket: CFG.bucket,
      keyPrefix: CFG.keyPrefix,
      kmsKeyArn: CFG.kmsKeyArn,
      principalArn: CFG.principalArn,
      retentionDays: 7,
      iamScopeProbePassed: true,
      publicAccessBlocked: true,
      verifiedAt: "2026-08-25T00:00:00.000Z",
    })
  })

  test("application-prefix claim is minted only by the store that installs the wrapper", async () => {
    const preflight = await attestResumeSecurity(CFG, awsFixture())
    expect(preflight).not.toHaveProperty("applicationPrefixEnforced")

    const store = resumeStore(
      {
        bucket: CFG.bucket,
        ...(CFG.region !== undefined ? { region: CFG.region } : {}),
        runAws: awsFixture(),
        security: {
          kmsKeyArn: CFG.kmsKeyArn,
          principalArn: CFG.principalArn,
          maxRetentionDays: CFG.maxRetentionDays,
        },
      },
      CFG.keyPrefix,
    )
    await expect(store.securityReceipt()).resolves.toMatchObject({
      keyPrefix: CFG.keyPrefix,
      applicationPrefixEnforced: true,
    })
  })

  test("red-on-injection: outside-prefix allow rejects activation", async () => {
    await expect(attestResumeSecurity(CFG, awsFixture({ outsideAllowed: true }))).rejects.toThrow(
      /not prefix-scoped/,
    )
  })

  test("red-on-injection: lifecycle longer than the configured maximum rejects activation", async () => {
    await expect(attestResumeSecurity(CFG, awsFixture({ lifecycleDays: 30 }))).rejects.toThrow(
      /no enabled lifecycle rule/,
    )
  })

  test("tag/And lifecycle filters do not prove expiration for untagged resume objects", async () => {
    await expect(
      attestResumeSecurity(
        CFG,
        awsFixture({ lifecycleFilter: { Tag: { Key: "ttl", Value: "7" } } }),
      ),
    ).rejects.toThrow(/no enabled lifecycle rule/)
    await expect(
      attestResumeSecurity(
        CFG,
        awsFixture({
          lifecycleFilter: {
            And: { Prefix: "campaign/", Tags: [{ Key: "ttl", Value: "7" }] },
          },
        }),
      ),
    ).rejects.toThrow(/no enabled lifecycle rule/)
  })

  test("the credentials performing I/O must be the configured IAM principal", async () => {
    await expect(
      attestResumeSecurity(
        CFG,
        awsFixture({ callerArn: "arn:aws:sts::123456789012:assumed-role/admin/other-session" }),
      ),
    ).rejects.toThrow(/does not match configured principal/)
  })

  test("remote put/get/list are blocked behind one cached attestation", async () => {
    let attestations = 0
    const touched: string[] = []
    let cached: ReturnType<typeof attestResumeSecurity> | undefined
    const backend = attestedBackend(
      {
        async put(path) {
          touched.push(`put:${path}`)
        },
        async get(path) {
          touched.push(`get:${path}`)
          return "body"
        },
        async list(prefix) {
          touched.push(`list:${prefix}`)
          return []
        },
      },
      () => {
        cached ??= (() => {
          attestations++
          return attestResumeSecurity(CFG, awsFixture())
        })()
        return cached
      },
    )
    await backend.put("campaign/instance/events/1", "body")
    await backend.get("campaign/instance/resume-state.json")
    await backend.list("campaign/instance/events/")
    expect(attestations).toBe(1)
    expect(touched).toEqual([
      "put:campaign/instance/events/1",
      "get:campaign/instance/resume-state.json",
      "list:campaign/instance/events/",
    ])
  })

  test("remote operations reject paths outside the attested prefix before backend I/O", async () => {
    const touched: string[] = []
    const backend = attestedBackend(
      {
        async put(path) {
          touched.push(`put:${path}`)
        },
        async get(path) {
          touched.push(`get:${path}`)
          return undefined
        },
        async list(path) {
          touched.push(`list:${path}`)
          return []
        },
      },
      () => attestResumeSecurity(CFG, awsFixture()),
    )
    await expect(backend.put("campaign/other/events/0", "body")).rejects.toThrow(
      /outside attested prefix/,
    )
    await expect(backend.get("campaign/instance-other/resume-state.json")).rejects.toThrow(
      /outside attested prefix/,
    )
    await expect(backend.list("campaign/")).rejects.toThrow(/outside attested prefix/)
    await expect(backend.put("campaign/instance", "body")).rejects.toThrow(
      /outside attested prefix/,
    )
    await expect(backend.get("campaign/instance")).rejects.toThrow(/outside attested prefix/)
    expect(touched).toEqual([])
  })

  test("list may inspect the attested root but object I/O must remain below it", async () => {
    const touched: string[] = []
    const backend = attestedBackend(
      {
        async put(path) {
          touched.push(`put:${path}`)
        },
        async get(path) {
          touched.push(`get:${path}`)
          return undefined
        },
        async list(path) {
          touched.push(`list:${path}`)
          return []
        },
      },
      () => attestResumeSecurity(CFG, awsFixture()),
    )
    await backend.list("campaign/instance")
    expect(touched).toEqual(["list:campaign/instance"])
  })

  test("failed attestation prevents the underlying remote operation", async () => {
    let touched = false
    const backend = attestedBackend(
      {
        async put() {
          touched = true
        },
        async get() {
          touched = true
          return undefined
        },
        async list() {
          touched = true
          return []
        },
      },
      async () => Promise.reject(new Error("attestation failed")),
    )
    await expect(backend.put("k", "v")).rejects.toThrow(/attestation failed/)
    expect(touched).toBe(false)
  })
})
