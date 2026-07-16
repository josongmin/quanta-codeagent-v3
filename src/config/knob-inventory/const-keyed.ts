import type { KnobInventoryEntry } from "./types"

export const CONST_KEYED: readonly KnobInventoryEntry[] = [
  {
    envKey: "QUANTA_CONTEXT_1M",
    kind: "bool",
    default: false,
    group: "llm",
    home: "runtime-config",
    describe: "1M-token context window (opt-in).",
    readSite: "llm/context-1m.ts",
  },
  {
    envKey: "QUANTA_ITEM_LIFECYCLE",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Stream item-lifecycle events (opt-in).",
    readSite: "stream/item-lifecycle.ts",
  },
  {
    // T01 — fine-grained `item/*` streaming protocol (Codex app-server parity):
    // a turn's interior projected as session.v1 `item.*` events + web agent-state
    // `item.*` messages from a SINGLE ItemStreamProjector. Distinct from
    // QUANTA_ITEM_LIFECYCLE (coarse in-proc AgentEvents); this is the wire plane.
    envKey: "QUANTA_ITEM_STREAM",
    kind: "bool",
    default: false,
    group: "observability",
    home: "runtime-config",
    describe: "Fine-grained item/* streaming on session.v1 + agent-state (opt-in).",
    readSite:
      "shared/item-stream.ts (itemStreamEnabled; wired host/runtime context-binding + agent/optional-ports)",
  },
  {
    envKey: "QUANTA_FAST_APPLY",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Fast-apply edit merge (opt-in).",
    readSite: "agent/optional-ports.ts",
  },
  {
    envKey: "QUANTA_EFFORT_AUTO",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Automatic effort escalation (opt-in).",
    readSite: "agent/optional-ports.ts",
  },
  {
    envKey: "QUANTA_SUBAGENT_FOLLOWUP",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Subagent follow-up task tool (opt-in).",
    readSite: "agent/optional-ports.ts",
  },
  {
    envKey: "QUANTA_REFUSAL_FALLBACK",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "T08 model-refusal recovery — fork/neutralize the refused turn and re-prompt once (opt-in).",
    readSite: "agent/optional-ports.ts",
  },
  {
    envKey: "QUANTA_REFUSAL_FALLBACK_PROMPT",
    kind: "string",
    default: undefined,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Override the refusal-fallback re-prompt template (built-in default when unset).",
    readSite: "agent/optional-ports.ts",
  },
  {
    envKey: "QUANTA_ENABLE_PROMPT_SUGGESTION",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Prompt-suggestion orchestrator (opt-in).",
    readSite: "agent/prompt-suggestion/orchestrator.ts",
  },
  {
    envKey: "QUANTA_PROACTIVE_REACTOR",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Proactive self-wake reactor (opt-in).",
    readSite: "reactor/self-wake.ts",
  },
  {
    envKey: "QUANTA_CONTROL_REQUEST",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Runtime control-request surface (opt-in).",
    readSite: "agent/control-request/types.ts",
  },
  {
    envKey: "QUANTA_REFLECT",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Reflection tool (opt-in).",
    readSite: "tool/surface/gated-tools.ts",
  },
  // NB: QUANTA_LANG_DETECT / NOTEBOOK_EDIT / DEBUG_TOOLS / TEST_RUNNER / EVIDENCE
  // are declared in @/shared/runtime-config-knobs.ts (their `home`), NOT here —
  // re-declaring would violate the pairwise-disjoint registry ratchet (ADR-0503 P3).
  {
    envKey: "QUANTA_WEB_AGENT_STATE",
    kind: "bool",
    default: false,
    group: "web-daemon",
    home: "runtime-config",
    // Read via gateOn at the daemon site (NOT loadFromEnv), so it lives here (a
    // declaration-only registry) rather than runtime-config-knobs (which the
    // parity ratchet requires every entry be read by loadFromEnv).
    describe: "Web daemon — forward agent-state frames to the web client (opt-in).",
    readSite: "apps/web-daemon/runtime-factory.ts",
  },
  {
    envKey: "QUANTA_SHADOW",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe: "Shadow-workspace tooling (opt-in).",
    readSite: "tool/surface/gated-tools.ts",
  },
  {
    envKey: "QUANTA_THIN_CLIENT_DISPATCH",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "Thin-client dispatch routing + T02 thread-follower co-control verbs (steer/interrupt/approval-relay, timeout-bounded) (opt-in).",
    readSite: "shared/thin-client-route.ts",
  },
  {
    envKey: "QUANTA_INBOUND_MODE",
    kind: "enum",
    default: "queue",
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "Inbound message delivery mode while a turn is in flight (queue | weave | interrupt). Seeds the session inbound-mode ref (CLI /inbound + T02 follower set-queue-mode mutate it).",
    readSite: "apps/web-daemon/runtime-factory.ts",
  },
  {
    envKey: "QUANTA_FOLLOWER_APPROVAL_TIMEOUT_MS",
    kind: "int",
    default: 0,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "T02 follower approval-relay deadline (ms). >0 ⇒ an unanswered relayed approval times out to a fail-safe DENY + a late follower decision is dropped (no stale-decision). 0/unset ⇒ pass-through (no timeout).",
    readSite: "apps/web-daemon/server/follower-approval.ts",
  },
  {
    envKey: "QUANTA_CRASH_RESUME",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "§13.2 persisted interrupted-turn marker — detect a mid-turn crash on restart and offer resume (opt-in).",
    readSite: "session/crash-resume.ts",
  },
  {
    envKey: "QUANTA_CRASH_RESUME_PARTIAL",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "ADR-0528 L3 — keep the crash-resume marker's partial progress fresh mid-turn (flush on tool.invoked). Superset of QUANTA_CRASH_RESUME (opt-in).",
    readSite: "session/crash-resume.ts",
  },
  {
    envKey: "QUANTA_USE_FOUNDRY",
    kind: "bool",
    default: false,
    group: "llm",
    home: "runtime-config",
    describe: "Azure AI Foundry provider (opt-in).",
    readSite: "llm/providers/registry.ts",
  },
  {
    envKey: "QUANTA_USE_MANTLE",
    kind: "bool",
    default: false,
    group: "llm",
    home: "runtime-config",
    describe: "Mantle provider (opt-in).",
    readSite: "llm/providers/registry.ts",
  },
  {
    envKey: "QUANTA_GH_ACTIONS_TRIGGER",
    kind: "bool",
    default: false,
    group: "integration",
    home: "runtime-config",
    describe: "GitHub Actions event-source trigger (opt-in).",
    readSite: "integrations/github/event-source-actions.ts",
  },
  {
    envKey: "QUANTA_AUTOMATION_INTERVAL_MS",
    kind: "int",
    default: undefined,
    group: "scheduler",
    home: "runtime-config",
    describe: "Scheduler automation tick interval (ms).",
    readSite: "scheduler/runtime-wire.ts",
  },
  // security — composite TLS-MITM gate (master + verbatim ack phrase)
  {
    envKey: "QUANTA_TLS_MITM",
    kind: "bool",
    default: false,
    group: "security",
    home: "runtime-config",
    describe: "TLS-MITM master switch (strict; pairs with _ACK).",
    readSite: "runtime/network-proxy/mitm-gate.ts",
  },
  {
    envKey: "QUANTA_TLS_MITM_ACK",
    kind: "string",
    default: undefined,
    group: "security",
    home: "runtime-config",
    describe: "Verbatim ack phrase enabling TLS-MITM.",
    readSite: "runtime/network-proxy/mitm-gate.ts",
  },
  // ChatGPT OAuth endpoint/client config (PUBLIC config, not secrets — defaults baked in)
  {
    envKey: "QUANTA_OAUTH_ISSUER",
    kind: "string",
    default: "https://auth.openai.com",
    group: "auth",
    home: "runtime-config",
    describe: "OAuth issuer URL override.",
    readSite: "auth/chatgpt-oauth/config.ts",
  },
  {
    envKey: "QUANTA_CHATGPT_API_BASE",
    kind: "string",
    default: "https://chatgpt.com/backend-api",
    group: "auth",
    home: "runtime-config",
    describe: "ChatGPT API base URL override.",
    readSite: "auth/chatgpt-oauth/config.ts",
  },
  {
    envKey: "QUANTA_OAUTH_CLIENT_ID",
    kind: "string",
    default: "app_EMoamEEZ73f0CkXaXp7hrann",
    group: "auth",
    home: "runtime-config",
    describe: "OAuth client id override (public).",
    readSite: "auth/chatgpt-oauth/config.ts",
  },
  {
    envKey: "QUANTA_OAUTH_SKU",
    kind: "string",
    default: "CODEX",
    group: "auth",
    home: "runtime-config",
    describe: "OAuth SKU override.",
    readSite: "auth/chatgpt-oauth/config.ts",
  },
  {
    envKey: "QUANTA_OAUTH_ORIGINATOR",
    kind: "string",
    default: "codex_cli",
    group: "auth",
    home: "runtime-config",
    describe: "OAuth originator override.",
    readSite: "auth/chatgpt-oauth/config.ts",
  },
  {
    // ADR-0540 W1-A — extends the CLI jun-10 inline-interactive approval machinery
    // to headless. ON ⇒ a mid-turn approval ask resolves INLINE (auto-policy
    // surface, same turn, no deferred throw + turn re-run); OFF ⇒ byte-identical
    // deferred path. const-keyed via `HEADLESS_INLINE_APPROVAL_GATE`.
    // ADR-0540 W1-B — the SAME gate also arms the web-daemon's daemon-owned
    // post-approval continuation (the daemon re-issues `turn.run`; clients see
    // the `serverAutoContinues` capability marker and skip their re-issue).
    // const-keyed there via `WEB_INLINE_APPROVAL_GATE`.
    envKey: "QUANTA_INLINE_APPROVAL_RESOLVER",
    kind: "bool",
    default: false,
    group: "agent-feature",
    home: "runtime-config",
    describe:
      "ADR-0540 approval resolver gate: headless inline + web-daemon continuation (opt-in).",
    readSite:
      "apps/headless/approval-wiring.ts (W1-B also: apps/web-daemon/server/approval-continuation.ts)",
  },
]
