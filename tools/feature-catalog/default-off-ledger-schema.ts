import { z } from "zod"

export const SurfaceDefaultSchema = z.enum(["on", "off", "resource", "na", "unknown"])

const EffectiveDefaultSchema = z
  .object({
    cli: SurfaceDefaultSchema,
    web: SurfaceDefaultSchema,
    bench: SurfaceDefaultSchema,
    headless: SurfaceDefaultSchema,
    daemon: SurfaceDefaultSchema,
  })
  .strict()

const ProofTierSchema = z.enum(["unit", "wire", "real-loop", "external-e2e"])

const ReceiptSchema = z
  .object({
    feature_id: z.string().min(1),
    command: z.string().min(1),
    test_path: z.string().min(1),
    revision: z.string().regex(/^[0-9a-f]{7,40}$/),
    exit_code: z.number().int(),
    proof_tier: ProofTierSchema,
  })
  .strict()

const ProofSchema = z
  .object({
    on: z.union([ProofTierSchema, z.literal("unknown")]),
    off_identity: z.union([ProofTierSchema, z.literal("unknown")]),
    receipt: ReceiptSchema.nullable(),
  })
  .strict()

const LifecycleEvidenceSchema = z
  .object({
    kind: z.enum(["external-blocked", "platform-unavailable", "forward-contract", "sunset"]),
    evidence: z.string().min(1),
    recheck_command: z.string().min(1).nullable(),
  })
  .strict()

export const DefaultOffLedgerRowBaseSchema = z
  .object({
    gate_owner: z.array(z.string().min(1)).min(1),
    activation: z.enum([
      "always",
      "inverse-kill-switch",
      "env/config",
      "host-seeded",
      "preset",
      "resource/command",
      "port-present",
      "unwired",
      "unknown",
    ]),
    effective_default: EffectiveDefaultSchema,
    reachability: z.enum([
      "wired",
      "producer-only",
      "consumer-only",
      "seam-only",
      "forward-contract",
      "unknown",
    ]),
    proof: ProofSchema,
    risk: z.enum([
      "behavioral-cost",
      "mutating",
      "network",
      "credential",
      "provider-cost",
      "security",
      "external",
      "platform",
      "unknown",
    ]),
    decision: z.enum([
      "enable-now",
      "measure-first",
      "repair-first",
      "hold",
      "delete-proven-duplicate",
      "unknown",
    ]),
    owner_seam: z.string().min(1),
    rollback: z.string().min(1),
    duplicate_of: z.string().min(1).nullable(),
    lifecycle_evidence: LifecycleEvidenceSchema.nullable(),
  })
  .strict()

export const DefaultOffLedgerRowSchema = DefaultOffLedgerRowBaseSchema.extend({
  feature_id: z.string().min(1),
}).strict()

export const DefaultOffLedgerSchema = z
  .object({
    version: z.literal(1),
    scope: z
      .object({
        catalog_label: z.literal("default-off"),
        include_runtime_cli_seed_features: z.literal(true),
        limitations: z.array(z.string().min(1)).min(1),
      })
      .strict(),
    runtime_cli_seed_mappings: z.record(z.string().min(1), z.string().min(1)),
    row_defaults: z.record(z.string().min(1), DefaultOffLedgerRowBaseSchema),
    rows: z.array(DefaultOffLedgerRowSchema).min(1),
  })
  .strict()

export type DefaultOffLedger = z.infer<typeof DefaultOffLedgerSchema>
export type DefaultOffLedgerRow = z.infer<typeof DefaultOffLedgerRowSchema>
