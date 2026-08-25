import type { RemoteBackend, ResumeSecurityReceipt, RunAws } from "@/shared/remote-store"

export interface ResumeSecurityConfig {
  readonly bucket: string
  readonly keyPrefix: string
  readonly kmsKeyArn: string
  readonly principalArn: string
  readonly maxRetentionDays: number
  readonly region?: string
}

const parseJson = (label: string, raw: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(raw) as unknown
    if (parsed === null || typeof parsed !== "object") throw new Error("expected object")
    return parsed as Record<string, unknown>
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new Error(`[resume-security] ${label}: invalid JSON (${message})`)
  }
}

const runJson = async (
  runAws: RunAws,
  regionArgs: readonly string[],
  label: string,
  args: readonly string[],
): Promise<Record<string, unknown>> => {
  const result = await runAws([...regionArgs, ...args])
  if (result.exitCode !== 0) {
    throw new Error(
      `[resume-security] ${label} failed (exit ${result.exitCode}): ${result.stderr ?? ""}`,
    )
  }
  return parseJson(label, result.stdout)
}

const decisionAllowed = (result: Record<string, unknown>): boolean => {
  const rows = result.EvaluationResults
  return (
    Array.isArray(rows) &&
    rows.length > 0 &&
    rows.every(
      (row) =>
        row !== null &&
        typeof row === "object" &&
        (row as Record<string, unknown>).EvalDecision === "allowed",
    )
  )
}

const assertEncryption = (doc: Record<string, unknown>, kmsKeyArn: string): void => {
  const config = doc.ServerSideEncryptionConfiguration as Record<string, unknown> | undefined
  const rules = config?.Rules
  const matched =
    Array.isArray(rules) &&
    rules.some((rule) => {
      if (rule === null || typeof rule !== "object") return false
      const defaults = (rule as Record<string, unknown>).ApplyServerSideEncryptionByDefault
      if (defaults === null || typeof defaults !== "object") return false
      const value = defaults as Record<string, unknown>
      return value.SSEAlgorithm === "aws:kms" && value.KMSMasterKeyID === kmsKeyArn
    })
  if (!matched) {
    throw new Error("[resume-security] bucket encryption is not pinned to the configured KMS key")
  }
}

const assertPublicAccessBlocked = (doc: Record<string, unknown>): void => {
  const config = doc.PublicAccessBlockConfiguration as Record<string, unknown> | undefined
  const keys = ["BlockPublicAcls", "IgnorePublicAcls", "BlockPublicPolicy", "RestrictPublicBuckets"]
  if (config === undefined || !keys.every((key) => config[key] === true)) {
    throw new Error("[resume-security] S3 public-access block is incomplete")
  }
}

const lifecyclePrefix = (rule: Record<string, unknown>): string => {
  if (typeof rule.Prefix === "string") return rule.Prefix
  const filter = rule.Filter
  if (filter !== null && typeof filter === "object") {
    const prefix = (filter as Record<string, unknown>).Prefix
    if (typeof prefix === "string") return prefix
  }
  return ""
}

const assertLifecycle = (
  doc: Record<string, unknown>,
  keyPrefix: string,
  maxRetentionDays: number,
): number => {
  const rules = doc.Rules
  if (!Array.isArray(rules)) throw new Error("[resume-security] lifecycle has no rules")
  for (const raw of rules) {
    if (raw === null || typeof raw !== "object") continue
    const rule = raw as Record<string, unknown>
    if (rule.Status !== "Enabled") continue
    const prefix = lifecyclePrefix(rule)
    if (!keyPrefix.startsWith(prefix)) continue
    const expiration = rule.Expiration
    if (expiration === null || typeof expiration !== "object") continue
    const days = (expiration as Record<string, unknown>).Days
    if (Number.isInteger(days) && (days as number) > 0 && (days as number) <= maxRetentionDays) {
      return days as number
    }
  }
  throw new Error(
    `[resume-security] no enabled lifecycle rule expires ${keyPrefix} within ${maxRetentionDays} days`,
  )
}

const simulate = async (
  runAws: RunAws,
  regionArgs: readonly string[],
  cfg: ResumeSecurityConfig,
  actions: readonly string[],
  resources: readonly string[],
  context?: string,
): Promise<boolean> => {
  const doc = await runJson(runAws, regionArgs, "IAM simulation", [
    "iam",
    "simulate-principal-policy",
    "--policy-source-arn",
    cfg.principalArn,
    "--action-names",
    ...actions,
    "--resource-arns",
    ...resources,
    ...(context !== undefined ? ["--context-entries", context] : []),
    "--output",
    "json",
  ])
  return decisionAllowed(doc)
}

/** Live, fail-closed admission receipt for one exact resume prefix. */
export const attestResumeSecurity = async (
  cfg: ResumeSecurityConfig,
  runAws: RunAws,
  now: () => Date = () => new Date(),
): Promise<ResumeSecurityReceipt> => {
  const regionArgs = cfg.region !== undefined ? ["--region", cfg.region] : []
  const encryption = await runJson(runAws, regionArgs, "bucket encryption", [
    "s3api",
    "get-bucket-encryption",
    "--bucket",
    cfg.bucket,
    "--output",
    "json",
  ])
  assertEncryption(encryption, cfg.kmsKeyArn)
  const publicAccess = await runJson(runAws, regionArgs, "public access block", [
    "s3api",
    "get-public-access-block",
    "--bucket",
    cfg.bucket,
    "--output",
    "json",
  ])
  assertPublicAccessBlocked(publicAccess)
  const lifecycle = await runJson(runAws, regionArgs, "bucket lifecycle", [
    "s3api",
    "get-bucket-lifecycle-configuration",
    "--bucket",
    cfg.bucket,
    "--output",
    "json",
  ])
  const retentionDays = assertLifecycle(lifecycle, cfg.keyPrefix, cfg.maxRetentionDays)

  const inside = `arn:aws:s3:::${cfg.bucket}/${cfg.keyPrefix}/*`
  const outsidePrefix = "__quanta_resume_scope_probe_outside__"
  const outside = `arn:aws:s3:::${cfg.bucket}/${outsidePrefix}/*`
  const bucketArn = `arn:aws:s3:::${cfg.bucket}`
  const objectActions = ["s3:GetObject", "s3:PutObject"]
  if (!(await simulate(runAws, regionArgs, cfg, objectActions, [inside]))) {
    throw new Error("[resume-security] principal lacks required object access inside resume prefix")
  }
  if (await simulate(runAws, regionArgs, cfg, objectActions, [outside])) {
    throw new Error("[resume-security] principal object access is not prefix-scoped")
  }
  if (
    !(await simulate(
      runAws,
      regionArgs,
      cfg,
      ["s3:ListBucket"],
      [bucketArn],
      `ContextKeyName=s3:prefix,ContextKeyValues=${cfg.keyPrefix}/*,ContextKeyType=string`,
    ))
  ) {
    throw new Error("[resume-security] principal cannot list the resume prefix")
  }
  if (
    await simulate(
      runAws,
      regionArgs,
      cfg,
      ["s3:ListBucket"],
      [bucketArn],
      `ContextKeyName=s3:prefix,ContextKeyValues=${outsidePrefix}/*,ContextKeyType=string`,
    )
  ) {
    throw new Error("[resume-security] principal list access is not prefix-scoped")
  }
  if (
    !(await simulate(
      runAws,
      regionArgs,
      cfg,
      ["kms:Encrypt", "kms:Decrypt", "kms:GenerateDataKey"],
      [cfg.kmsKeyArn],
    ))
  ) {
    throw new Error("[resume-security] principal lacks required KMS access")
  }

  return {
    schema: "quanta.resume-security.v1",
    bucket: cfg.bucket,
    keyPrefix: cfg.keyPrefix,
    kmsKeyArn: cfg.kmsKeyArn,
    principalArn: cfg.principalArn,
    retentionDays,
    prefixLeastPrivilege: true,
    publicAccessBlocked: true,
    verifiedAt: now().toISOString(),
  }
}

/** Gate every remote operation behind one cached live attestation. */
export const attestedBackend = (
  backend: RemoteBackend,
  ensure: () => Promise<ResumeSecurityReceipt>,
): RemoteBackend => ({
  async put(path, body) {
    await ensure()
    await backend.put(path, body)
  },
  async get(path) {
    await ensure()
    return backend.get(path)
  },
  async list(prefix) {
    await ensure()
    return backend.list(prefix)
  },
})
