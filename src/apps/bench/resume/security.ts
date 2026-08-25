import type { RemoteBackend, ResumeSecurityReceipt, RunAws } from "@/shared/remote-store"

export type ResumeSecurityAttestation = Omit<ResumeSecurityReceipt, "applicationPrefixEnforced">

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

const lifecycleCoversKeyPrefix = (rule: Record<string, unknown>, keyPrefix: string): boolean => {
  // Legacy lifecycle shape. If present, it is the complete filter.
  if (Object.hasOwn(rule, "Prefix")) {
    return typeof rule.Prefix === "string" && keyPrefix.startsWith(rule.Prefix)
  }
  const filter = rule.Filter
  if (filter === undefined) return true
  if (filter === null || typeof filter !== "object" || Array.isArray(filter)) return false
  const object = filter as Record<string, unknown>
  const keys = Object.keys(object)
  if (keys.length === 0) return true
  // A tag, object-size predicate, or And filter may exclude the actual resume
  // objects. The producer does not apply matching tags and cannot prove object
  // sizes, so only a plain prefix filter is admissible.
  return (
    keys.length === 1 && typeof object.Prefix === "string" && keyPrefix.startsWith(object.Prefix)
  )
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
    if (!lifecycleCoversKeyPrefix(rule, keyPrefix)) continue
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

const callerMatchesPrincipal = (callerArn: string, principalArn: string): boolean => {
  if (callerArn === principalArn) return true
  const principal = /^arn:([^:]+):iam::(\d{12}):role\/(.+)$/.exec(principalArn)
  const caller = /^arn:([^:]+):sts::(\d{12}):assumed-role\/(.+)\/[^/]+$/.exec(callerArn)
  return (
    principal !== null &&
    caller !== null &&
    principal[1] === caller[1] &&
    principal[2] === caller[2] &&
    principal[3] === caller[3]
  )
}

const assertCallerIdentity = (doc: Record<string, unknown>, principalArn: string): void => {
  const callerArn = doc.Arn
  if (typeof callerArn !== "string" || !callerMatchesPrincipal(callerArn, principalArn)) {
    throw new Error(
      `[resume-security] active AWS caller ${String(callerArn)} does not match configured principal ${principalArn}`,
    )
  }
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
): Promise<ResumeSecurityAttestation> => {
  const regionArgs = cfg.region !== undefined ? ["--region", cfg.region] : []
  const caller = await runJson(runAws, regionArgs, "caller identity", [
    "sts",
    "get-caller-identity",
    "--output",
    "json",
  ])
  assertCallerIdentity(caller, cfg.principalArn)
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
    schema: "quanta.resume-security.v2",
    bucket: cfg.bucket,
    keyPrefix: cfg.keyPrefix,
    kmsKeyArn: cfg.kmsKeyArn,
    principalArn: cfg.principalArn,
    retentionDays,
    iamScopeProbePassed: true,
    publicAccessBlocked: true,
    verifiedAt: now().toISOString(),
  }
}

/** Gate every remote operation behind one cached live attestation. */
export const attestedBackend = (
  backend: RemoteBackend,
  ensure: () => Promise<ResumeSecurityAttestation>,
): RemoteBackend => {
  const authorize = async (path: string, allowPrefixRoot: boolean): Promise<void> => {
    const receipt = await ensure()
    const prefix = receipt.keyPrefix.endsWith("/") ? receipt.keyPrefix : `${receipt.keyPrefix}/`
    const atPrefixRoot = path === receipt.keyPrefix
    if ((!allowPrefixRoot && atPrefixRoot) || (!atPrefixRoot && !path.startsWith(prefix))) {
      throw new Error(`[resume-security] remote path is outside attested prefix: ${path}`)
    }
  }
  return {
    async put(path, body) {
      await authorize(path, false)
      await backend.put(path, body)
    },
    async get(path) {
      await authorize(path, false)
      return backend.get(path)
    },
    async list(prefix) {
      await authorize(prefix, true)
      return backend.list(prefix)
    },
  }
}
