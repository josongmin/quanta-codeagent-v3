# ADR-0197: MCP Elicitation — 7 typed prompt schemas + closed prompter port

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0049 (MCP stdio client foundation), ADR-0196 (MCP Tasks
  Capability sibling), ADR-0095 (request_user_input — quanta-side operator
  input)
- Cross-vendor signal: Cursor 3.2.16 / Claude Desktop 1.7196.3 / Codex
  0.131.0-alpha.9 all ship MCP elicitation with the same 7-arm schema
  taxonomy; quanta servers cannot currently solicit structured input.

## Context

MCP elicitation lets a server ask the client for typed input mid-call —
"pick one of these branches", "confirm this delete", "enter a commit
message". rmcp 0.15 defines exactly 7 schemas (String, Number, Integer,
Boolean, Enum, MultiSelectEnum, SingleSelectEnum), each in two variants
(Titled with a display label, Untitled bare-value). Without a port the
client must hard-reject every elicitation, blocking servers that gate
behavior on operator confirmation.

Today there is no elicitation handler at all — a server's `elicitation/*`
RPC would land at the JSON-RPC dispatcher and surface as `method not
found`. The default posture must be `headless-denied`: the agent typically
runs without a human prompt sink, and silently substituting a synthesized
answer is worse than a typed deny.

External SDK reason-for-rejecting: same as ADR-0196 — installs are
blocked, rmcp TS bindings would add a 2 MB transitive graph for seven
zod schemas, and the self-impl IS seven `z.object({...})` declarations.

## Decision

Ship one closed-port (`ElicitationPrompter`) with seven methods, one per
rmcp schema, and 7×2 = 14 zod schemas covering the Titled + Untitled
variants. The port surface is 7 methods (`promptString`, `promptNumber`,
`promptInteger`, `promptBoolean`, `promptEnum`, `promptMultiEnum`,
`promptSingleEnum`) — variant is conveyed via the request payload's
optional `title` field, not as a method-count doubling.

Two default impls ship:

1. **`headlessRejecter`** — every method resolves to typed
   `{ ok: false, reason: "headless-denied" }`. This is the DEFAULT —
   sessions without an interactive surface see immediate, deterministic
   rejection (no hang waiting on stdin that will never come).

2. **`cliPrompter(opts)`** — writes the schema-rendered prompt to
   stdout, reads stdin, validates with the corresponding zod schema. One
   retry on validation error; the second violation aborts with
   `{ ok: false, reason: "validation-error" }`. AbortSignal cancellation
   resolves to `{ ok: false, reason: "cancelled" }` without leaking the
   stdin listener.

The result envelope is closed-union:
`{ ok: true, value: T } | { ok: false, reason: "headless-denied" |
"validation-error" | "cancelled" | "empty-enum" | "invalid-input" }`.
A 6th arm requires an ADR amendment AND a compile-error update at every
exhaustive switch.

Wire is read-only (no model tool registered here — the
elicitation port is consumed by the MCP client when handling inbound
`elicitation/*` RPCs, not by an LLM-callable tool). Hellgate tests
exercise the port directly.

## Consequences

- **Default-OFF + byte-identical**: existing sessions register no
  prompter, the MCP RPC dispatcher continues to surface elicitation
  methods as `method not found`, and there is zero new wire surface.
- **`exactOptionalPropertyTypes`**: `title` on Untitled-variant requests
  is OMITTED, not set to `undefined`. zod `.optional()` produces `| undefined`
  outputs; the port surface re-projects so consumers see the canonical
  omit shape.
- **Closed-union failure set**: 5 typed reasons, exhaustively switched.
- **Enum guards**: empty options list short-circuits to
  `reason: "empty-enum"` BEFORE prompting. Number/Integer reject
  `NaN`/`+Infinity`/`-Infinity` with `reason: "invalid-input"`.
- **Slice fence**: `@/mcp/elicitation/*` depends only on `@/shared` +
  zod. No tool slice imports.
- **Future swap**: if rmcp TS bindings become installable, the seam is
  a single-file swap (`@/mcp/elicitation/schemas` adopts the rmcp zod
  exports). Sibling ADR future scope.
