export const NIGHTLY_SCHEDULES = [
  { file: "verification-nightly.yml", cron: "0 4 * * *", purpose: "cache-off verification" },
  { file: "ci.yml", cron: "0 6 * * *", purpose: "nightly eval" },
  { file: "agent-nightly-regression.yml", cron: "0 8 * * *", purpose: "agent regression" },
  { file: "grounding-live-gate.yml", cron: "0 9 * * *", purpose: "grounding live gate" },
] as const

export const NIGHTLY_MEMBERSHIP = {
  schema: "quanta.verification-nightly.v1",
  cacheMode: "off",
  includes: ["cache-off-full-suite", "exhaustive-fuzz", "exhaustive-static-oracles"],
  excludesPaidEvalMove: true,
} as const

/** One authority for expensive deterministic cases that run nightly, not per PR. */
export const nightlyStressEnabled = (
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean => env.QUANTA_TEST_STRESS === "1"
