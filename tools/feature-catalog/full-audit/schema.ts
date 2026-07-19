import { z } from "zod"

export const AuditPrioritySchema = z.enum(["P0", "P1", "P2", "P3"])
export type AuditPriority = z.infer<typeof AuditPrioritySchema>

export const AuditSnapshotEntrySchema = z.object({
  feature_id: z.string().min(1),
  source_path: z.string().min(1),
  section: z.number().int().min(1).max(10),
  maturity: z.enum(["L1", "L2", "L3", "L4", "L5"]),
  priority: AuditPrioritySchema,
  proof_scope: z.enum(["static", "dynamic"]),
  default_off_eligible: z.boolean(),
  reachability_grandfathered: z.boolean(),
})

export const AuditSnapshotSchema = z.object({
  version: z.literal(1),
  snapshot_head: z.string().regex(/^[0-9a-f]{40}$/),
  created_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  catalog_total: z.number().int().nonnegative(),
  priority_counts: z.record(AuditPrioritySchema, z.number().int().nonnegative()),
  entries: z.array(AuditSnapshotEntrySchema),
})

export type AuditSnapshot = z.infer<typeof AuditSnapshotSchema>
export type AuditSnapshotEntry = z.infer<typeof AuditSnapshotEntrySchema>

const ProofReceiptSchema = z.object({
  kind: z.enum(["source", "test", "runtime", "external"]),
  command: z.string().min(1),
  revision: z.string().regex(/^[0-9a-f]{7,40}$/),
  result: z.enum(["pass", "fail", "blocked"]),
  evidence: z.string().min(1),
})

const AuditRecordBaseSchema = z.object({
  version: z.literal(1),
  feature_id: z.string().min(1),
  snapshot_head: z.string().regex(/^[0-9a-f]{40}$/),
})

const InProgressAuditRecordSchema = AuditRecordBaseSchema.extend({
  status: z.literal("in-progress"),
  owner_seam: z.string().min(1).optional(),
  notes: z.string().min(1),
})

const ClosedAuditRecordSchema = AuditRecordBaseSchema.extend({
  status: z.literal("closed"),
  owner_seam: z.string().min(1),
  entrypoints: z.array(z.string().min(1)),
  activation: z.array(z.string().min(1)),
  effective_defaults: z.object({
    cli: z.enum(["on", "off", "resource", "na", "unknown"]),
    web: z.enum(["on", "off", "resource", "na", "unknown"]),
    bench: z.enum(["on", "off", "resource", "na", "unknown"]),
    headless: z.enum(["on", "off", "resource", "na", "unknown"]),
    daemon: z.enum(["on", "off", "resource", "na", "unknown"]),
  }),
  producer: z.array(z.string().min(1)),
  consumer: z.array(z.string().min(1)),
  reachable: z.enum(["yes", "no", "conditional", "unknown"]),
  surface_findings: z.array(z.string().min(1)),
  off_identity_proof: ProofReceiptSchema.nullable(),
  on_efficacy_proof: ProofReceiptSchema.nullable(),
  failure_posture: z.enum(["fail-closed", "fail-loud", "degraded", "na", "unknown"]),
  security_posture: z.enum(["verified", "conditional", "na", "unknown"]),
  observability: z.enum(["verified", "partial", "na", "unknown"]),
  verdict: z.enum([
    "pass",
    "conditional",
    "seam-only",
    "not-activatable",
    "proof-gap",
    "stale-claim",
    "duplicate",
    "removed",
  ]),
  blocker: z.string().min(1).nullable(),
  disposition: z.enum([
    "keep",
    "downgrade",
    "hold",
    "wire",
    "fix-claim",
    "delete-duplicate",
    "removed",
  ]),
  receipts: z.array(ProofReceiptSchema).min(1),
  audited_at: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  auditor: z.string().min(1),
  review_state: z.enum(["pending", "approved"]),
  reviewer: z.string().min(1).nullable(),
})

type ClosedAuditRecord = z.infer<typeof ClosedAuditRecordSchema>

const refinePass = (record: ClosedAuditRecord, ctx: z.RefinementCtx): void => {
  if (record.verdict !== "pass") return
  if (record.reachable !== "yes") {
    ctx.addIssue({ code: "custom", message: "PASS requires reachable=yes", path: ["reachable"] })
  }
  if (record.consumer.length === 0) {
    ctx.addIssue({ code: "custom", message: "PASS requires a live consumer", path: ["consumer"] })
  }
  if (record.on_efficacy_proof?.result !== "pass") {
    ctx.addIssue({
      code: "custom",
      message: "PASS requires passing ON efficacy proof",
      path: ["on_efficacy_proof"],
    })
  }
}

const refineVerdict = (record: ClosedAuditRecord, ctx: z.RefinementCtx): void => {
  if (record.verdict === "conditional" && record.blocker === null) {
    ctx.addIssue({ code: "custom", message: "CONDITIONAL requires blocker", path: ["blocker"] })
  }
  if (["seam-only", "not-activatable"].includes(record.verdict) && record.reachable === "yes") {
    ctx.addIssue({
      code: "custom",
      message: `${record.verdict} cannot claim reachable=yes`,
      path: ["reachable"],
    })
  }
}

const refineReview = (record: ClosedAuditRecord, ctx: z.RefinementCtx): void => {
  if (record.review_state !== "approved") return
  if (record.reviewer === null) {
    ctx.addIssue({
      code: "custom",
      message: "approved review requires reviewer",
      path: ["reviewer"],
    })
  } else if (record.reviewer === record.auditor) {
    ctx.addIssue({
      code: "custom",
      message: "reviewer must be independent from auditor",
      path: ["reviewer"],
    })
  }
}

export const AuditRecordSchema = z
  .discriminatedUnion("status", [InProgressAuditRecordSchema, ClosedAuditRecordSchema])
  .superRefine((record, ctx) => {
    if (record.status !== "closed") return
    refinePass(record, ctx)
    refineVerdict(record, ctx)
    refineReview(record, ctx)
  })

export type AuditRecord = z.infer<typeof AuditRecordSchema>
