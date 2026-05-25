# ADR-0213: Tool profile preset — 4 named bundles + UP-nudge composition

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0046 (permission stack), ADR-0055 (tool-tier matcher),
  ADR-0036 (collaboration mode), ADR-0135 (permission profile +
  4-pillar + 4-tier), `src/agent/tool-profile/` (this slice)

## Context

Zed ships three named "tool profile" modes (Write / Ask / Minimal) that
the user can pick once per session to bundle a coarse tool-admissibility
policy. Codex's `agent_role` enum (`explorer | worker | none`) is the
same pattern at the subagent layer. v3 has the fine-grained pieces —
ADR-0046 permission stack, ADR-0055 HITL tier matcher, ADR-0135 4-pillar
profile — but no named "bundle of bundles" the user can pick by name.

Without a named preset, every session has to re-derive the same
deny-set on every config wire-up. The user-facing knob is missing:
"this session is exploration only, never write" requires 5+ permission
table edits today.

## Decision

Introduce a new slice `src/agent/tool-profile/` with four named presets:

```
src/agent/tool-profile/
  port.ts       — ToolProfileName + ToolPolicy + ToolProfileResolver + typed error
  presets.ts    — PROFILE_PRESETS (4 closed bundles)
  registry.ts   — defaultToolProfileRegistry (thin reader)
  resolver.ts   — defaultToolProfileResolver + composeToolProfileWithBaseline
  index.ts      — slice barrel
```

The 4 presets:

| Name        | Read-only default | Mutating default | Explicit deny-list           |
|-------------|-------------------|------------------|------------------------------|
| `write`     | allow             | allow            | (none) — DEFAULT, neutral    |
| `ask`       | allow             | **confirm**      | (none)                       |
| `minimal`   | **deny**          | **deny**         | LSP-read + git-read allowed  |
| `code-only` | allow             | allow            | web / image / voice all deny |

Profile rule precedence (first match wins):
1. explicit per-tool entry in `tools` map
2. category fallback (read-only / mutating)

The resolver — ONE port surface:

```ts
interface ToolProfileResolver {
  resolve(input: {
    profileName: ToolProfileName
    toolName: string
    isReadOnly: boolean
  }): ToolPolicy   // { kind: "allow" | "confirm" | "deny", reason: string }
}
```

## Composition with ADR-0046 / ADR-0055

The profile NEVER calls the lower layers — it returns a typed `ToolPolicy`
the host folds INTO the permission decision stream. The composition
helper `composeToolProfileWithBaseline(baseline, profile)` encodes the
**UP-nudge-only** rule:

- `deny` overrides everything
- `confirm` overrides `allow`
- `allow` is overridden by both

So a profile may only NUDGE UP toward stricter outcomes; it can never
weaken the underlying permission stack's verdict. A `write` preset is
admissibility-neutral by construction (all `allow`).

Composition order at runtime (host responsibility):
1. ADR-0213 tool profile        — coarse "what may even be considered"
2. ADR-0055 inferToolTier       — per-tool HITL tier
3. ADR-0046 permission stack    — per-call evidence + scope decision

## Surface

```ts
const resolver = defaultToolProfileResolver()
const policy = resolver.resolve({
  profileName: "ask",
  toolName: "edit",
  isReadOnly: false,
})
// policy = { kind: "confirm", reason: 'tool-profile "ask" default for mutating tools' }
```

The CLI surface (host responsibility, NOT this slice) is expected to
expose `--tool-profile=<name>` and a `/profile` slash command; both flow
through `isToolProfileName` for safe parse.

## Consequences

- **Default-OFF**: no caller is required to migrate. Hosts that do not
  wire a profile get their current behavior (which is the `write`
  preset's all-allow shape). Wire is a single line at the composition
  root.
- **Closed enum**: `ToolProfileName` is a 4-literal union; the
  `mode-mutating-table.test.ts` parallel pattern (`HELL-TP-14` here)
  fails loudly when a new preset is registered without a matching rule
  table.
- **No-throw at resolve**: per-call `resolve()` returns a typed policy;
  the only throw point is the construction-time `UnknownToolProfileError`
  for an unknown profile name (programmer error, not runtime).
- **UP-nudge invariant**: `composeToolProfileWithBaseline` cannot weaken
  the baseline. HELL-TP-06/07/08/13 lock this contract.
- **Reason field**: every `ToolPolicy.reason` surfaces the profile name
  so deny messages explain WHY ("blocked by `minimal` profile").
- **Negative invariants** (locked by hellgate):
  - HELL-TP-05: unknown profile name throws typed `UnknownToolProfileError`.
  - HELL-TP-09: `isToolProfileName` is a type guard at the parse boundary.
  - HELL-TP-11: explicit per-tool override beats the category default.
  - HELL-TP-14: exhaustive — every named profile yields a defined
    policy for both read-only and mutating inputs.
