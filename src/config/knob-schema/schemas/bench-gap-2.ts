/**
 * Pillar A — authored {@link KnobSchema} declarations for the ENV-DIRECT bench
 * knobs that the sibling slices (bench-a/b/c) listed as DERIVE GAPS: the
 * full-remote EC2 dials and the spot-resume / campaign family, plus the
 * G1 model-lanes override. SSOT for derive (see ../derive).
 *
 * ⚠️ ENV-DIRECT — these knobs have an inventory entry in
 * src/config/knob-inventory/bench.ts but NO registry knob object in
 * src/runner/knobs/knobs/. They are read straight from `process.env` in
 * apps/bench/* (cli.ts / remote/box-session/* / remote/full.ts / resume/* /
 * model-lanes.ts) — there is NO live `parse` to compare against. Consequently:
 *
 *   - The `parse` authored here is BEST-EFFORT, matching the inventory `kind`
 *     convention (int ⇒ positive-int-or-undefined; string ⇒ trim-or-undefined;
 *     bool ⇒ gateOn-style). It is NOT parse-parity-tested — there is no ground
 *     truth registry knob to assert against. That is expected and intentional.
 *   - The PROVEN CONTRACT for this slice is INVENTORY-DERIVE PARITY:
 *     `deriveInventoryEntry(schema)` deep-equals the current bench.ts entry,
 *     byte-for-byte. The parity test
 *     (tests/unit/kernel/derive-parity-gap-2.test.ts) locks ONLY that.
 *
 * Each schema mirrors the EXISTING inventory data verbatim:
 *   - `describe`/`default`/`kind`/`readSite`/`envKey` mirror the CURRENT
 *     src/config/knob-inventory/bench.ts entry,
 *   - `surfaces` are bench-only ⇒ deriveHome reproduces the inventory `home`
 *     cell ("bench") for every entry in this slice.
 *
 * No escape hatches are needed: every bool here records `false` in the inventory
 * (deriveInventoryDefault forces a bool off-default to `false` from kind+undefined),
 * the ints (6 / 90) pass through verbatim, the strings (undefined) pass through
 * verbatim, and every home is "bench" (derived from the bench-only surface set).
 *
 * Additive: not registered, not imported by the live driver.
 */

import type { KnobSchema } from "../contracts"

const BENCH: readonly ["bench"] = ["bench"] as const

/** Best-effort positive-int parse (int kind): trim, integer, ≥1, else undefined. */
const parsePositiveInt = (raw: string | undefined): number | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  if (!/^\d+$/.test(s)) return undefined
  const n = Number(s)
  if (!Number.isInteger(n) || n < 1) return undefined
  return n
}

/** Best-effort trim-or-undefined parse (string kind): empty ⇒ undefined. */
const parseTrimmedString = (raw: string | undefined): string | undefined => {
  if (raw === undefined) return undefined
  const s = raw.trim()
  return s === "" ? undefined : s
}

/** Best-effort gateOn parse (bool kind): 1/on/true ⇒ true, else undefined. */
const GATE_ON = new Set(["1", "on", "true"])
const parseGateOn = (raw: string | undefined): true | undefined => {
  if (raw === undefined) return undefined
  return GATE_ON.has(raw.trim().toLowerCase()) ? true : undefined
}

/* ── full-remote-ami (QUANTA_FULL_REMOTE_AMI) — string ─────────────────────── */
export const fullRemoteAmiSchema: KnobSchema<string> = {
  id: "full-remote-ami",
  envKey: "QUANTA_FULL_REMOTE_AMI",
  kind: "string",
  default: undefined,
  describe:
    "Full-remote: EC2 AMI override (--ami or env). Prebaked image with docker+uv+django; unset ⇒ stock/default AMI selection.",
  readSite: "apps/bench/commands/box.ts",
  surfaces: BENCH,
  parse: parseTrimmedString,
}

/* ── full-remote-concurrency (QUANTA_FULL_REMOTE_CONCURRENCY) — int, default 6 ─ */
export const fullRemoteConcurrencySchema: KnobSchema<number> = {
  id: "full-remote-concurrency",
  envKey: "QUANTA_FULL_REMOTE_CONCURRENCY",
  kind: "int",
  domain: { range: [1, 16] },
  default: 6,
  describe:
    "Full-remote: patch-gen concurrency on the EC2 box (QUANTA_BENCH_CONCURRENCY override for the remote run). Clamped to [1,16]; default 6.",
  readSite: "apps/bench/remote/full.ts",
  surfaces: BENCH,
  parse: parsePositiveInt,
}

/* ── full-remote-instance-type (QUANTA_FULL_REMOTE_INSTANCE_TYPE) — string ──── */
export const fullRemoteInstanceTypeSchema: KnobSchema<string> = {
  id: "full-remote-instance-type",
  envKey: "QUANTA_FULL_REMOTE_INSTANCE_TYPE",
  kind: "string",
  default: undefined,
  describe:
    "Full-remote: EC2 instance-type override. Unset ⇒ the jun-27 default c7i.4xlarge (patch-gen is API-bound, grading serial); bump for high patch-gen concurrency.",
  readSite: "apps/bench/remote/box-session/types.ts",
  surfaces: BENCH,
  parse: parseTrimmedString,
}

/* ── full-remote-ondemand (QUANTA_FULL_REMOTE_ONDEMAND) — bool ──────────────── */
export const fullRemoteOndemandSchema: KnobSchema<true> = {
  id: "full-remote-ondemand",
  envKey: "QUANTA_FULL_REMOTE_ONDEMAND",
  kind: "bool",
  // T = true (no falsy member); inventory off-default `false` is derived by
  // deriveInventoryDefault from kind="bool" + undefined.
  default: undefined,
  describe:
    "Full-remote: on-demand (non-spot) EC2 escape hatch for capacity crunches. Default-OFF.",
  readSite: "apps/bench/commands/box.ts",
  surfaces: BENCH,
  parse: parseGateOn,
}

/* ── full-remote-ready-polls (QUANTA_FULL_REMOTE_READY_POLLS) — int, default 90 ─ */
export const fullRemoteReadyPollsSchema: KnobSchema<number> = {
  id: "full-remote-ready-polls",
  envKey: "QUANTA_FULL_REMOTE_READY_POLLS",
  kind: "int",
  default: 90,
  describe:
    "Full-remote: cloud-init readiness window, in 10s polls (default 90 ≈ 15min). jun-25 BOX-LOSS RCA: a too-short window counted a slow-but-healthy box as LOST. A READY box returns on the first poll, so raising this only tolerates a slow bootstrap (degraded network / stock-AMI image re-pull). The test-seam cfg.maxReadyPolls still wins; unset/garbage ⇒ default.",
  readSite: "apps/bench/remote/box-session/ec2-lifecycle.ts",
  surfaces: BENCH,
  parse: parsePositiveInt,
}

/* ── resume (QUANTA_BENCH_RESUME) — bool ───────────────────────────────────── */
export const resumeSchema: KnobSchema<true> = {
  id: "resume",
  envKey: "QUANTA_BENCH_RESUME",
  kind: "bool",
  default: undefined,
  describe:
    "Bench: enable spot-resume: stream per-turn cassette to S3 + replay on a fresh box after reclaim. Default-OFF (gateOn) ⇒ byte-identical (no S3 touch). Requires QUANTA_BENCH_RESUME_S3_BUCKET; enabled-but-no-bucket is treated as off (fail-closed).",
  readSite: "apps/bench/resume/config.ts",
  surfaces: BENCH,
  parse: parseGateOn,
}

/* ── resume-s3-bucket (QUANTA_BENCH_RESUME_S3_BUCKET) — string ──────────────── */
export const resumeS3BucketSchema: KnobSchema<string> = {
  id: "resume-s3-bucket",
  envKey: "QUANTA_BENCH_RESUME_S3_BUCKET",
  kind: "string",
  default: undefined,
  describe:
    "S3 bucket for resume cassettes; required when QUANTA_BENCH_RESUME on. Unset ⇒ resume stays inert (resumeActive=false).",
  readSite: "apps/bench/resume/config.ts",
  surfaces: BENCH,
  parse: parseTrimmedString,
}

/* ── campaign-id (QUANTA_BENCH_CAMPAIGN_ID) — string ───────────────────────── */
export const campaignIdSchema: KnobSchema<string> = {
  id: "campaign-id",
  envKey: "QUANTA_BENCH_CAMPAIGN_ID",
  kind: "string",
  default: undefined,
  describe:
    "stable campaign id; resume key prefix. Unset ⇒ 'default-campaign'. Scopes the resume cassette/receipt S3 prefix (<campaignId>/<instanceId>).",
  readSite: "apps/bench/resume/config.ts",
  surfaces: BENCH,
  parse: parseTrimmedString,
}

/* ── resume-iam-profile (QUANTA_BENCH_RESUME_IAM_PROFILE) — string ──────────── */
export const resumeIamProfileSchema: KnobSchema<string> = {
  id: "resume-iam-profile",
  envKey: "QUANTA_BENCH_RESUME_IAM_PROFILE",
  kind: "string",
  default: undefined,
  describe:
    "EC2 instance-profile attached to the box ONLY when QUANTA_BENCH_RESUME is on (the box reads/writes its cassette in S3). Unset ⇒ 'quanta-bench-resume-profile'. No effect when resume is off (no profile attached).",
  readSite: "apps/bench/remote/box-session/ec2-lifecycle.ts",
  surfaces: BENCH,
  parse: parseTrimmedString,
}

/* ── instance-id (QUANTA_BENCH_INSTANCE_ID) — string ───────────────────────── */
export const instanceIdSchema: KnobSchema<string> = {
  id: "instance-id",
  envKey: "QUANTA_BENCH_INSTANCE_ID",
  kind: "string",
  default: undefined,
  describe:
    "the single SWE-bench instance the box is running (resume is chunk-size=1). Scopes the resume cassette/receipt S3 key (<campaignId>/<instanceId>) on both record and replay. Set by the pool worker on the box; unset ⇒ resume-write inert (fail-closed).",
  readSite: "apps/bench/resume/recorder.ts",
  surfaces: BENCH,
  parse: parseTrimmedString,
}

/* ── model-lanes (QUANTA_BENCH_MODEL_LANES) — string ───────────────────────── */
export const modelLanesSchema: KnobSchema<string> = {
  id: "model-lanes",
  envKey: "QUANTA_BENCH_MODEL_LANES",
  kind: "string",
  default: undefined,
  describe:
    "G1 verify-select diversity lanes override: comma-separated explicit model IDs or bare true-like value for built-in default pair, used by apps/bench/model-lanes to build per-candidate LLM lanes. Default-OFF (unset/empty) keeps single-lane byte-identical behavior.",
  readSite: "apps/bench/model-lanes.ts",
  surfaces: BENCH,
  parse: parseTrimmedString,
}
