/**
 * Benchmark MANAGEMENT actions for the dashboard (RFC jun-29 — SOTA++ platform console).
 *
 * The dashboard server spawns the bench CLI in response to WEB requests (launch a run, stop a
 * box, follow logs). That is a privilege boundary: a hostile/typo'd request must NEVER become
 * arbitrary shell. So this module is the SINGLE place that turns request params into a
 * validated **argv array** (never a shell string) — every field is checked against an allowlist
 * or a strict pattern, and unknown input throws `ActionError` (the server maps it to HTTP 400).
 *
 * Pure + exported for unit test — no process spawning here (the server owns child_process).
 */

export type Family = "verified" | "pro" | "live"
const FAMILIES: ReadonlySet<string> = new Set(["verified", "pro", "live"])

/** Thrown on invalid input. The server returns 400 with `.message`; never spawns. */
export class ActionError extends Error {}

/** An EC2 instance id: `i-` + hex. The ONLY shape accepted for box ops (no `all`, no globs —
 *  a web-triggered "terminate all" is too dangerous; that stays CLI-only). */
const INSTANCE_ID = /^i-[0-9a-f]{8,}$/

/** A preset name: lowercase alnum + `-` (matches KNOB_PRESETS keys like `agentless-v1`). The
 *  caller passes the live allowlist (the dashboard already loads the knob catalog). */
const PRESET_SHAPE = /^[a-z0-9][a-z0-9-]{0,63}$/

/** A model id: alnum + `.`/`-` (gpt-5.5, claude-opus-4-6). */
const MODEL_SHAPE = /^[a-zA-Z0-9][a-zA-Z0-9.-]{0,63}$/

/** A comma-separated instance-id filter (Scale/SWE-bench ids: alnum + `_`/`-`/`.`/`,`). MUST
 *  start with alnum — a LEADING `-` would be parsed by the bench CLI as a flag, not a value
 *  (argv-injection: `instances="--keep"` → `hasFlag("--keep")` true → box never terminated →
 *  runaway billing). The leading-char class excludes `-`. */
const INSTANCE_FILTER = /^[a-zA-Z0-9_.,][a-zA-Z0-9_.,-]{0,4095}$/

/** A dataset path/name token — no shell metacharacters, no whitespace, no `..` traversal, and
 *  NO leading `-` (same argv-flag-injection fence as INSTANCE_FILTER). A leading `/` (absolute
 *  path) is allowed for a real dataset file; `..` is rejected separately. */
const DATASET_TOKEN = /^[a-zA-Z0-9_./][a-zA-Z0-9_./-]{0,511}$/

export interface LaunchSpec {
  family: Family
  dataset: string // jsonl path or HF id (validated DATASET_TOKEN)
  preset: string
  model: string
  instances?: string // optional --instance filter
  onDemand?: boolean // QUANTA_FULL_REMOTE_ONDEMAND (stable box, no spot reclaim)
}

const must = (cond: boolean, msg: string): void => {
  if (!cond) throw new ActionError(msg)
}

/** Build the `grade --mode full` argv + the env overrides for a dashboard-launched run.
 *  Returns {argv, env} — the server spawns `bun` with argv + {...process.env, ...env}. The
 *  family/dataset drive QUANTA_SWEBENCH_DATASET_FAMILY (env, the signal the box derivations
 *  read). `validPresets` is the live allowlist (knob-catalog keys) so a typo can't launch. */
export const buildLaunchAction = (
  spec: LaunchSpec,
  validPresets: ReadonlySet<string>,
): { argv: string[]; env: Record<string, string> } => {
  must(FAMILIES.has(spec.family), `unknown dataset family: ${spec.family}`)
  must(DATASET_TOKEN.test(spec.dataset), `invalid dataset token: ${spec.dataset}`)
  must(!spec.dataset.includes(".."), "dataset path must not traverse (..)")
  must(PRESET_SHAPE.test(spec.preset), `invalid preset: ${spec.preset}`)
  must(validPresets.has(spec.preset), `preset not in catalog: ${spec.preset}`)
  must(MODEL_SHAPE.test(spec.model), `invalid model: ${spec.model}`)
  if (spec.instances !== undefined && spec.instances !== "") {
    must(INSTANCE_FILTER.test(spec.instances), `invalid --instance filter: ${spec.instances}`)
  }
  const argv = [
    "run",
    "src/apps/bench/cli.ts",
    "grade",
    "--mode",
    "full",
    "--allow-remote-secrets",
    "--dataset",
    spec.dataset,
    "--dataset-family",
    spec.family,
    "--preset",
    spec.preset,
    "--model",
    spec.model,
    "--allow-extra-boxes",
    ...(spec.instances !== undefined && spec.instances !== ""
      ? ["--instance", spec.instances]
      : []),
  ]
  const env: Record<string, string> = { QUANTA_SWEBENCH_DATASET_FAMILY: spec.family }
  if (spec.onDemand === true) env.QUANTA_FULL_REMOTE_ONDEMAND = "1"
  return { argv, env }
}

/** `quanta-bench box ls --json` — list running boxes. No params ⇒ always safe. */
export const buildBoxLsAction = (): string[] => [
  "run",
  "src/apps/bench/cli.ts",
  "box",
  "ls",
  "--json",
]

/** `quanta-bench box logs <iid> --follow` — stream a box's run.log. iid strictly validated. */
export const buildBoxLogsAction = (iid: string, follow = true): string[] => {
  must(INSTANCE_ID.test(iid), `invalid instance id: ${iid}`)
  return [
    "run",
    "src/apps/bench/cli.ts",
    "box",
    "logs",
    iid,
    ...(follow ? ["--follow"] : ["--lines", "200"]),
  ]
}

/** `quanta-bench box rm <iid>` — terminate ONE box. NEVER accepts `all` from the web (a
 *  web-triggered fleet wipe is too dangerous; `box rm all` stays CLI-only with its own guard). */
export const buildBoxRmAction = (iid: string): string[] => {
  must(
    INSTANCE_ID.test(iid),
    `invalid instance id (web box-rm is single-box only, never 'all'): ${iid}`,
  )
  return ["run", "src/apps/bench/cli.ts", "box", "rm", iid]
}

/** `quanta-bench box status --json` — fleet + budget snapshot for the "running now" view. */
export const buildBoxStatusAction = (): string[] => [
  "run",
  "src/apps/bench/cli.ts",
  "box",
  "status",
  "--json",
]
