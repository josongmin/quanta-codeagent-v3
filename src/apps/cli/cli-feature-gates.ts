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
 * Slice pin: pure data leaf, ZERO external imports. Overlap knob projections
 * are declared here so `cli-knobs.ts` can derive `/knobs` rows without a
 * second copy of the env key.
 */

export interface CliFeatureGate {
  /** The env var the CLI seeds to "1" when unset. */
  readonly gate: string
  /** One-line operator-facing description — rendered verbatim in `/help`.
   *  MUST NOT start with a `QUANTA_*` token (the parity hellgate detects row
   *  keys by line prefix). */
  readonly describe: string
}

/** Keys that are both seeded gates and CLI_KNOBS declarations. Gate list owns
 *  seed + `/help` copy; `cli-knobs.ts` projects kind/default/readSite. */
export interface CliSeededSurfaceKnob extends CliFeatureGate {
  readonly kind: "bool"
  readonly default: boolean
  readonly group: "input" | "session"
  readonly readSite: string
  readonly knobDescribe: string
}

export const CLI_SEEDED_SURFACE_KNOBS: readonly CliSeededSurfaceKnob[] = [
  {
    gate: "QUANTA_ENABLE_ENV_PROBE",
    describe: "Runtime env probe: snapshot shell/tooling facts for the system prompt",
    kind: "bool",
    default: false,
    group: "session",
    readSite: "repl/env-probe-wire.ts",
    knobDescribe: "Shell environment probe (opt-in).",
  },
  {
    gate: "QUANTA_AT_AUTOCOMPLETE",
    describe: "@-file/@-symbol mention autocomplete dropdown at the prompt",
    kind: "bool",
    default: false,
    group: "input",
    readSite: "at-autocomplete/env.ts",
    knobDescribe: "@-mention autocomplete (opt-in).",
  },
  {
    gate: "QUANTA_EXTERNAL_EDITOR",
    describe: "Ctrl+X Ctrl+E composes the draft in $EDITOR",
    kind: "bool",
    default: false,
    group: "input",
    readSite: "repl/surface-compose.ts",
    knobDescribe: "External-editor gesture (opt-in).",
  },
  {
    gate: "QUANTA_KEYBINDINGS",
    describe: "~/.quanta/keybindings.json action remap (no-throw merge)",
    kind: "bool",
    default: false,
    group: "input",
    readSite: "repl/surface-compose.ts",
    knobDescribe: "Load ~/.quanta/keybindings.json (opt-in).",
  },
  {
    gate: "QUANTA_MODE_CYCLE",
    describe: "Shift+Tab cycles permission mode (default → acceptEdits → plan → bypass)",
    kind: "bool",
    default: false,
    group: "input",
    readSite: "mode-cycle.ts",
    knobDescribe: "Shift+Tab mode-cycle (opt-in).",
  },
  {
    gate: "QUANTA_PREFLIGHT_CHECK",
    describe: "Warn in the confirm prompt when a mutating edit would not cleanly apply",
    kind: "bool",
    default: true,
    group: "input",
    readSite: "preflight.ts",
    knobDescribe: "Approval-time edit applicability pre-flight (CLI default-ON; =0 disables).",
  },
  {
    gate: "QUANTA_BRACKETED_PASTE",
    describe: "Bracketed-paste mode: a multi-line paste submits only on a real Enter",
    kind: "bool",
    default: true,
    group: "input",
    readSite: "repl/surface-compose.ts",
    knobDescribe: "Bracketed-paste — multi-line paste submits as one buffer (CLI default-ON).",
  },
]

const overlapGate = (gate: string): CliFeatureGate => {
  const row = CLI_SEEDED_SURFACE_KNOBS.find((r) => r.gate === gate)
  if (row === undefined) {
    throw new Error(`CLI seeded surface knob missing: ${gate}`)
  }
  return { gate: row.gate, describe: row.describe }
}

export const CLI_FEATURE_GATES: readonly CliFeatureGate[] = [
  overlapGate("QUANTA_ENABLE_ENV_PROBE"),
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
  overlapGate("QUANTA_AT_AUTOCOMPLETE"),
  overlapGate("QUANTA_EXTERNAL_EDITOR"),
  overlapGate("QUANTA_KEYBINDINGS"),
  {
    gate: "QUANTA_RATELIMIT_NOTICE",
    describe: "Transient status notice when the provider rate-limit is reached",
  },
  // The operator EXPLICITLY opted into the full 4-rung cycle INCLUDING the
  // no-confirm `bypass` rung — deliberate trade-off; the red BYPASS pill is
  // the guard (see index.ts history).
  overlapGate("QUANTA_MODE_CYCLE"),
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
  overlapGate("QUANTA_PREFLIGHT_CHECK"),
  // #10 — correctness fix: multi-line paste no longer submits at the first
  // embedded newline (DECSET 2004 accumulation).
  overlapGate("QUANTA_BRACKETED_PASTE"),
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
]

/** The seed-loop projection (what `index.ts` iterates). */
export const CLI_FEATURE_GATE_NAMES: readonly string[] = CLI_FEATURE_GATES.map((g) => g.gate)
