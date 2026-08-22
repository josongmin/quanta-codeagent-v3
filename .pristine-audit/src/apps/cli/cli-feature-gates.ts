/**
 * WS-E.2 (jul-10, UUX-1-09/6-26) — CLI feature-gate seed list, as DATA.
 *
 * jun-03 history: the CLI host opts IN by default to a set of absorbed
 * feature gates by seeding each to "1" when the operator has not set it. The
 * SLICES stay default-OFF by construction (their `=== "1"` / `gateOn` reads +
 * hellgates are unchanged, so off=byte-identical holds for every non-CLI
 * embedding); an explicit `QUANTA_X=0` (any value ≠ "1") still wins, and the
 * seed happens AFTER dotenv load so a `.env*` value or a real shell export is
 * never clobbered (see `index.ts`).
 *
 * Why a separate leaf module (moved out of `index.ts` jul-10): `index.ts` has
 * top-level side effects (env seeding, argv routing) so nothing could IMPORT
 * the list — `/help` hand-wrote its env table instead and silently omitted
 * every seeded gate (UUX-1-09). Now:
 *  - `index.ts` imports {@link CLI_FEATURE_GATE_NAMES} for the seed loop,
 *  - `help-render.ts` derives one env row per entry from {@link CLI_FEATURE_GATES}
 *    (the parity hellgate pins every entry surfaces exactly once),
 *  - the drift hellgates import this module directly (no more source-regex).
 *
 * These are CLI surface BEHAVIORS, not LLM tools — LLM tool gates derive from
 * the tool-surface SSOT (`seedEnvVarsForSurface("cli")`) and are NOT listed
 * here. Deleting a feature ⇒ delete its entry (drift hellgate red otherwise).
 *
 * Slice pin: pure data leaf, ZERO imports.
 */

export interface CliFeatureGate {
  /** The env var the CLI seeds to "1" when unset. */
  readonly gate: string
  /** One-line operator-facing description — rendered verbatim in `/help`.
   *  MUST NOT start with a `QUANTA_*` token (the parity hellgate detects row
   *  keys by line prefix). */
  readonly describe: string
}

export const CLI_FEATURE_GATES: readonly CliFeatureGate[] = [
  {
    gate: "QUANTA_ENABLE_ENV_PROBE",
    describe: "Runtime env probe: snapshot shell/tooling facts for the system prompt",
  },
  // ADR-0474 — protective correctness guard.
  {
    gate: "QUANTA_STALE_READ_GUARD",
    describe: "Block write/edit of a file externally modified since the agent read it",
  },
  // Protective correctness guard — defer a mid-flight abort until an atomic FS
  // critical section (apply-patch / write / scripted-replace) completes, so an
  // interrupt cannot leave a half-written file. OFF byte-identical in normal
  // operation; the deferral is watchdog-bounded (cannot hang). ALSO a
  // RuntimeConfig field → its `/help` row comes from ENV_TABLE (derived skips).
  {
    gate: "QUANTA_TOOL_INTERRUPT_BLOCK",
    describe: "Defer an interrupt until an atomic file write finishes (no half-written files)",
  },
  // ADR-0471 (H2) — structural prompt-injection defense. ALSO a RuntimeConfig
  // field, so its `/help` row comes from ENV_TABLE (curated) — the derived
  // section skips it (exactly-once parity).
  {
    gate: "QUANTA_UNTRUSTED_ENVELOPE",
    describe: "Wrap external tool output in an <untrusted-source> envelope (injection defense)",
  },
  // H9 — pure token savings in iterative loops.
  {
    gate: "QUANTA_READ_DEDUP",
    describe: "Re-read of an unchanged file returns a compact file_unchanged sentinel",
  },
  // RFC jun-4/jun-6, ADR-0479/0480/0482 — agent↔agent coordination behaviors.
  {
    gate: "QUANTA_TEAM_DAG",
    describe: "spawn_batch honors `dependencies` (ordered subagent fan-out)",
  },
  {
    gate: "QUANTA_TEAM_BROKER",
    describe: "Soft-denied subagent may escalate to the leader's HITL authority",
  },
  {
    gate: "QUANTA_TEAM_IDLE",
    describe: "Leader fan-in barrier over resident side-agent daemons",
  },
  // ADR-0041/0437 — the agent↔agent ACTIVE-call tool (vs the passive mailbox).
  {
    gate: "QUANTA_SUBAGENT_FOLLOWUP",
    describe: "followup_task tool: deliver a message to a child AND trigger its turn",
  },
  // jun-11 CLI-UX default-ON (R3-hardened worklist) — consumers pinned by the
  // cli-feature-gates drift hellgate.
  {
    gate: "QUANTA_AT_AUTOCOMPLETE",
    describe: "@-file/@-symbol mention autocomplete dropdown at the prompt",
  },
  {
    gate: "QUANTA_EXTERNAL_EDITOR",
    describe: "Ctrl+X Ctrl+E composes the draft in $EDITOR",
  },
  {
    gate: "QUANTA_KEYBINDINGS",
    describe: "~/.quanta/keybindings.json action remap (no-throw merge)",
  },
  {
    gate: "QUANTA_RATELIMIT_NOTICE",
    describe: "Transient status notice when the provider rate-limit is reached",
  },
  // The operator EXPLICITLY opted into the full 4-rung cycle INCLUDING the
  // no-confirm `bypass` rung — deliberate trade-off; the red BYPASS pill is
  // the guard (see index.ts history).
  {
    gate: "QUANTA_MODE_CYCLE",
    describe: "Shift+Tab cycles permission mode (default → acceptEdits → plan → bypass)",
  },
  // #5/#6 — paired (capture alone = blind typing).
  {
    gate: "QUANTA_MIDTURN_CAPTURE",
    describe: "Capture keystrokes typed while a turn is streaming",
  },
  {
    gate: "QUANTA_MIDTURN_VISIBLE",
    describe: "Visible bottom input lane for mid-turn typing (pairs with capture)",
  },
  // #19 — approval-time applicability pre-flight (never mutates).
  {
    gate: "QUANTA_PREFLIGHT_CHECK",
    describe: "Warn in the confirm prompt when a mutating edit would not cleanly apply",
  },
  // #10 — correctness fix: multi-line paste no longer submits at the first
  // embedded newline (DECSET 2004 accumulation).
  {
    gate: "QUANTA_BRACKETED_PASTE",
    describe: "Bracketed-paste mode: a multi-line paste submits only on a real Enter",
  },
  // SOTA++ (jul-10, decision #3) — mid-turn control is table stakes (Claude
  // Code Esc-interrupt / Codex mid-turn input): /cancel + /summarize-now +
  // the mid-loop drain all ride this surface; byte-identity of the OFF path
  // was proven before seeding (paired control + Proxy witness + smoke 15/15).
  {
    gate: "QUANTA_CONVERSATION_ACTIONS",
    describe: "Mid-turn typed control surface (/cancel, /summarize-now) + same-turn drain",
  },
  // SOTA++ (jul-10, decision #4) — stall visibility is the observability
  // north star ("why is it stuck"); latched per episode, recovery clears.
  // Thresholds tune via telemetry; flip off here if false positives appear.
  {
    gate: "QUANTA_SPINNER_STALL",
    describe: "LLM stream stall detector → operator notice (per-episode latch)",
  },
  // jul-15 (peer-mail surfacing) — inter-agent + side-agent mail becomes VISIBLE
  // to the user (Codex "Sent from another task" parity). The surface decorator
  // needs a mailbox to wrap, so BOTH the mailbox substrate AND the surface knob
  // are seeded on the interactive CLI: `QUANTA_SUBAGENT_MAILBOX` mints the
  // per-session mailbox (re-enabling it here — the jun-26 frontier-audit opt-in
  // was about UNVERIFIED coordination-tool-menu engagement, orthogonal to
  // surfacing mail to the user), `QUANTA_PEER_MSG_SURFACE` installs the
  // enqueue-time `peer_message` notifier.
  {
    gate: "QUANTA_SUBAGENT_MAILBOX",
    describe: "In-memory inter-agent mailbox (subagent_send_message / _read_messages)",
  },
  {
    gate: "QUANTA_PEER_MSG_SURFACE",
    describe: "Surface peer/side-agent mail to the user as a transcript notice at enqueue time",
  },
] as const

/** The seed-loop projection (what `index.ts` iterates). */
export const CLI_FEATURE_GATE_NAMES: readonly string[] = CLI_FEATURE_GATES.map((g) => g.gate)
