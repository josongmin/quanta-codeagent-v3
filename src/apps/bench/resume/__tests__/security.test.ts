import { describe, expect, test } from "bun:test"
import type { ResumeSecurityConfig } from "../security"
import { attestedBackend, attestResumeSecurity } from "../security"

const CFG: ResumeSecurityConfig = {
  bucket: "resume-bucket",
  keyPrefix: "campaign/instance",
  kmsKeyArn: "arn:aws:kms:us-east-1:123:key/key-id",
  principalArn: "arn:aws:iam::123:role/resume",
  maxRetentionDays: 7,
  region: "us-east-1",
}

const allowed = (decision = "allowed"): string =>
  JSON.stringify({ EvaluationResults: [{ EvalDecision: decision }] })

const awsFixture =
  (over: { outsideAllowed?: boolean; lifecycleDays?: number } = {}) =>
  async (args: readonly string[]) => {
    if (args.includes("get-bucket-encryption")) {
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
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
        }),
      }
    }
    if (args.includes("get-public-access-block")) {
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          PublicAccessBlockConfiguration: {
            BlockPublicAcls: true,
            IgnorePublicAcls: true,
            BlockPublicPolicy: true,
            RestrictPublicBuckets: true,
          },
        }),
      }
    }
    if (args.includes("get-bucket-lifecycle-configuration")) {
      return {
        exitCode: 0,
        stderr: "",
        stdout: JSON.stringify({
          Rules: [
            {
              Status: "Enabled",
              Filter: { Prefix: "campaign/" },
              Expiration: { Days: over.lifecycleDays ?? 7 },
            },
          ],
        }),
      }
    }
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
      schema: "quanta.resume-security.v1",
      bucket: CFG.bucket,
      keyPrefix: CFG.keyPrefix,
      kmsKeyArn: CFG.kmsKeyArn,
      principalArn: CFG.principalArn,
      retentionDays: 7,
      prefixLeastPrivilege: true,
      publicAccessBlocked: true,
      verifiedAt: "2026-08-25T00:00:00.000Z",
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
