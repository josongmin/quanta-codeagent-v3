/**
 * Hellgate — every string knob in the unified catalogue is classified for the test fence.
 *
 * `tests/_support/quanta-home-fence.ts` removes an operator's exported per-subsystem
 * STATE path (`STATE_PATH_OVERRIDES`) from test processes. No knob declares a "path" kind,
 * so the fence cannot find those keys by rule; this file is what keeps the list complete.
 * It lives under `tests/unit/cli/` because the unified catalogue is composed by the CLI
 * wire, which only CLI tests may import (slice isolation).
 */
import { describe, expect, test } from "bun:test"
import { buildKnobCatalog } from "../../../src/apps/cli/knob-catalog-wire"
import { STATE_PATH_OVERRIDES } from "../../_support/quanta-home-fence"

describe("quanta-home fence — string knob classification", () => {
  /**
   * EXHAUSTIVE: every `kind: "string"` knob in the unified catalogue is classified, so a new
   * knob that names a location cannot slip past the fence by not being listed. Only
   * `STATE_PATH_OVERRIDES` (and the roots) are fenced; the other kinds are read, not
   * written, or are not locations at all — each list was reviewed against its describe
   * text and, for the ambiguous ones, its read site.
   */
  const REVIEWED_NOT_STATE: Readonly<Record<string, readonly string[]>> = {
    "quanta-root (fenced above)": [
      "QUANTA_BENCH_HOME",
      "QUANTA_CONFIG_DIR",
      "QUANTA_HOME",
      "QUANTA_PREFS_HOME",
    ],
    "fenced by bench-results-fence": ["QUANTA_BENCH_RESULTS_DIR"],
    "operator config, read": [
      "QUANTA_BENCH_AUTH_POOL",
      "QUANTA_GITHUB_WEBHOOK_SECRETS_FILE",
      "QUANTA_HITL_OVERRIDES",
      "QUANTA_MANAGED_SETTINGS_PATH",
      "QUANTA_ORG_CONFIG_DIR",
      "QUANTA_PROFILES_DIR",
      "QUANTA_TRUSTED_PATHS",
    ],
    "external input, read": [
      "QUANTA_BENCH_REPLAY_TRAJECTORY",
      "QUANTA_LLM_REPLAY",
      "QUANTA_NDJSON_INGEST_FILE",
      "QUANTA_OFFICIAL_GRADE_RECEIPT",
      "QUANTA_PROMAX_BUNDLE_ROOT",
      "QUANTA_PROMAX_SAMPLE",
      "QUANTA_RESUME",
      "QUANTA_SWEBENCH_CORPUS_ROOT",
      "QUANTA_SWEBENCH_DATASET",
      "QUANTA_TREE_SITTER_DIR",
      "QUANTA_WEB_DIST",
    ],
    executable: ["QUANTA_PROMAX_PYTHON", "QUANTA_SWEBENCH_PYTHON_BIN", "QUANTA_TERMINAL_BRAIN_CMD"],
    "not a location (ids, urls, selectors, commands, secrets, text, lists)": [
      "QUANTA_ADVISOR_MODEL",
      "QUANTA_API_KEY_HELPER",
      "QUANTA_AUTOMATION_STORE",
      "QUANTA_AUTORUN_POLICY",
      "QUANTA_AWS_AUTH_REFRESH",
      "QUANTA_BENCH_ACCEPTANCE",
      "QUANTA_BENCH_ADVERSARIAL_REPRO",
      "QUANTA_BENCH_BRANCH_SEARCH",
      "QUANTA_BENCH_CAMPAIGN_ID",
      "QUANTA_BENCH_CHA_MULTISITE_GENERAL",
      "QUANTA_BENCH_CHA_MULTISITE_STEER",
      "QUANTA_BENCH_CLOSEOUT",
      "QUANTA_BENCH_CLOSURE_REPAIR",
      "QUANTA_BENCH_DYNAMIC_MESSAGE_MATCHER",
      "QUANTA_BENCH_EFFORT_LADDER",
      "QUANTA_BENCH_FAULT_EVIDENCE",
      "QUANTA_BENCH_FORWARD_LOCALIZE",
      "QUANTA_BENCH_HOOKS",
      "QUANTA_BENCH_IN_LOOP_EXEC",
      "QUANTA_BENCH_INSTANCE_ID",
      "QUANTA_BENCH_ISSUE_HINT",
      "QUANTA_BENCH_ISSUE_HINT_EXPECTED_ACTUAL",
      "QUANTA_BENCH_LLM_SELECT",
      "QUANTA_BENCH_LOCALIZE_BUDGET",
      "QUANTA_BENCH_LOCALIZE_PHASE",
      "QUANTA_BENCH_LOCATION_FANOUT",
      "QUANTA_BENCH_LSP",
      "QUANTA_BENCH_LSP_CHEAP",
      "QUANTA_BENCH_LSP_STEER",
      "QUANTA_BENCH_MODEL_LANE_DIVERSITY",
      "QUANTA_BENCH_MODEL_LANES",
      "QUANTA_BENCH_MUST_PASS",
      "QUANTA_BENCH_NO_PATCH_BREAKER",
      "QUANTA_BENCH_NO_PATCH_FORCE_FRACTION",
      "QUANTA_BENCH_PAIRED_CONTROL",
      "QUANTA_BENCH_PATCH_BUDGET",
      "QUANTA_BENCH_PATCH_BUDGET_STRICT",
      "QUANTA_BENCH_PATCH_HYGIENE",
      "QUANTA_BENCH_PRESET",
      "QUANTA_BENCH_PRIMARY_RAIL",
      "QUANTA_BENCH_REGRESSION_MAX_TESTS",
      "QUANTA_BENCH_REPAIR_BREADTH",
      "QUANTA_BENCH_REPAIR_ESCALATION",
      "QUANTA_BENCH_REPAIR_SPEC_GATE",
      "QUANTA_BENCH_REPAIR_STRONG_ORACLE",
      "QUANTA_BENCH_REPRO_DOUBT",
      "QUANTA_BENCH_REPRO_EXEC_TIMEOUT_MS",
      "QUANTA_BENCH_REPRO_GROUNDING",
      "QUANTA_BENCH_REPRO_TEST",
      "QUANTA_BENCH_REPRO_VOTE",
      "QUANTA_BENCH_RESUME_IAM_PROFILE",
      "QUANTA_BENCH_RESUME_KMS_KEY_ARN",
      "QUANTA_BENCH_RESUME_PRINCIPAL_ARN",
      "QUANTA_BENCH_RESUME_S3_BUCKET",
      "QUANTA_BENCH_RETRY_TRANSIENT",
      "QUANTA_BENCH_SELECTOR_MODE",
      "QUANTA_BENCH_SKILLS",
      "QUANTA_BENCH_SPEC_FIDELITY_INVARIANT",
      "QUANTA_BENCH_SPEC_FIDELITY_STEER",
      "QUANTA_BENCH_SUBAGENT",
      "QUANTA_BENCH_VERIFICATION_PLAN",
      "QUANTA_BENCH_VERIFY_SELECT",
      "QUANTA_BENCH_VERIFY_SELECT_CONCURRENCY",
      "QUANTA_BENCH_VERIFY_SELECT_COUNTERFACTUAL",
      "QUANTA_BENCH_VERIFY_SELECT_EARLY_ACCEPT",
      "QUANTA_BENCH_VERIFY_SELECT_LLM_RISK_GATE",
      "QUANTA_BENCH_VERIFY_SELECT_PROOF_REQUIRED",
      "QUANTA_BENCH_VERIFY_SELECT_REGRESSION",
      "QUANTA_BENCH_VERIFY_SELECT_REPRO",
      "QUANTA_BENCH_VERIFY_SELECT_RISK_GATE",
      "QUANTA_BENCH_WORKING_STATE",
      "QUANTA_CHATGPT_API_BASE",
      "QUANTA_CLIP_ENDPOINT",
      "QUANTA_CLOSEOUT_CRITIC",
      "QUANTA_COMMAND_HOOKS_ACK",
      "QUANTA_COMMIT",
      "QUANTA_COMPACT_MODEL",
      "QUANTA_COMPACT_PROVIDER",
      "QUANTA_COMPOSE_AUTHORING",
      "QUANTA_DEBUG",
      "QUANTA_DEPLOYMENT_ENV",
      "QUANTA_EMBED_PROVIDER",
      "QUANTA_FAST_APPLY_MODEL",
      "QUANTA_FULL_REMOTE_AMI",
      "QUANTA_FULL_REMOTE_INSTANCE_TYPE",
      "QUANTA_FULL_REMOTE_REGION",
      "QUANTA_GCP_AUTH_REFRESH",
      "QUANTA_GIT_DIRECTIVE_EMIT",
      "QUANTA_GIT_SHA",
      "QUANTA_GITHUB_WEBHOOK_SECRET",
      "QUANTA_GITHUB_WEBHOOK_SECRETS",
      "QUANTA_GITHUB_WEBHOOK_SESSION",
      "QUANTA_INDEX_GLOB",
      "QUANTA_KNOBS_PRESET",
      "QUANTA_LANCE_BASE_URL",
      "QUANTA_LANCE_TABLE",
      "QUANTA_LAST_TOKENS",
      "QUANTA_LLM_ENDPOINT",
      "QUANTA_LLM_TRANSPORT",
      "QUANTA_LOCAL_ENV",
      "QUANTA_MCP_PROTOCOL_MAX",
      "QUANTA_MCP_SERVER_EXPOSE",
      "QUANTA_MCP_TOOL_ANNOTATIONS",
      "QUANTA_MEMORY_EMBED_MODEL",
      "QUANTA_MEMORY_MODE",
      "QUANTA_MEMORY_RECALL_TIERS",
      "QUANTA_MEMORY_WRITE_GUARD_PCT",
      "QUANTA_MODEL",
      "QUANTA_MODEL_FALLBACK",
      "QUANTA_MULTI_VOTER",
      "QUANTA_NAMESPACE",
      "QUANTA_NETWORK_PROXY",
      "QUANTA_OAUTH_CLIENT_ID",
      "QUANTA_OAUTH_ISSUER",
      "QUANTA_OAUTH_ORIGINATOR",
      "QUANTA_OAUTH_SKU",
      "QUANTA_OTEL_ENDPOINT",
      "QUANTA_OTEL_SERVICE_NAME",
      "QUANTA_PERMISSION_PROFILES_JSON",
      "QUANTA_PERSONA",
      "QUANTA_PII_ALLOWLIST",
      "QUANTA_PII_KINDS",
      "QUANTA_POLICY_MERGE_STRATEGY",
      "QUANTA_PRICING_VERSION",
      "QUANTA_QDRANT_BASE_URL",
      "QUANTA_QDRANT_COLLECTION",
      "QUANTA_RATELIMIT_NOTICE",
      "QUANTA_READ_OUTLINE",
      "QUANTA_REFUSAL_FALLBACK_PROMPT",
      "QUANTA_REMOTE_DEFAULT_IMAGE",
      "QUANTA_REMOTE_LIMA_VM",
      "QUANTA_REMOTE_NETWORK",
      "QUANTA_REPO_MAP",
      "QUANTA_REPO_URL",
      "QUANTA_RETRY_MODELS",
      "QUANTA_RUN_ID",
      "QUANTA_SERVICE_NAME",
      "QUANTA_SERVICE_TIER",
      "QUANTA_SESSION_TITLE_MODEL",
      "QUANTA_SETTING_SOURCES",
      "QUANTA_STATUS_LINE_CONFIG",
      "QUANTA_SWEBENCH_DATASET_NAME",
      "QUANTA_SWEBENCH_NAMESPACE",
      "QUANTA_SWEBENCH_REPO_BASE_URL",
      "QUANTA_TASK_BUDGET",
      "QUANTA_TB_AGENT_VERSION",
      "QUANTA_TEST_RUNNER",
      "QUANTA_TLS_MITM_ACK",
      "QUANTA_VERSION",
      "QUANTA_VOICE_LIVE_ENDPOINT",
      "QUANTA_VOICE_LIVE_MODEL",
      "QUANTA_VOICE_LIVE_VOICE",
      "QUANTA_WEB_BIND",
    ],
  }

  test("every string knob in the catalogue is classified exactly once", () => {
    const stringKnobs = [...buildKnobCatalog().values()]
      .filter((k) => k.kind === "string")
      .map((k) => k.envKey)
    expect(stringKnobs.length, "the catalogue enumerated no string knobs").toBeGreaterThan(100)
    const classified = new Map<string, string>()
    const place = (key: string, where: string): void => {
      expect(classified.get(key), `${key} is classified twice`).toBeUndefined()
      classified.set(key, where)
    }
    for (const key of STATE_PATH_OVERRIDES) place(key, "state-path (fenced)")
    for (const [kind, keys] of Object.entries(REVIEWED_NOT_STATE))
      for (const k of keys) place(k, kind)
    const unclassified = stringKnobs.filter((k) => !classified.has(k))
    expect(
      unclassified,
      "a string knob is not classified. If it names where Quanta writes state, add it to " +
        "STATE_PATH_OVERRIDES in tests/_support/quanta-home-fence.ts; otherwise put it under " +
        "the kind that describes it here.",
    ).toEqual([])
    // Uncatalogued state paths are admitted only if the source still reads them.
    const UNCATALOGUED_STATE_PATHS = ["QUANTA_OTEL_SINK"]
    const srcReads = (key: string): boolean =>
      Bun.spawnSync(["grep", "-rlF", key, "src"]).stdout.toString().trim() !== ""
    for (const key of UNCATALOGUED_STATE_PATHS) {
      expect(srcReads(key), `${key} is no longer read in src/`).toBe(true)
      // The catalogue cannot notice an uncatalogued key leaving the fence, so this does
      // (round-10 audit: unlisting QUANTA_OTEL_SINK failed nothing).
      expect(STATE_PATH_OVERRIDES as readonly string[], `${key} left the fence`).toContain(key)
    }
    const stale = [...classified.keys()].filter(
      (k) => !stringKnobs.includes(k) && !UNCATALOGUED_STATE_PATHS.includes(k),
    )
    expect(stale, "classified names that are no longer string knobs").toEqual([])
  })
})
