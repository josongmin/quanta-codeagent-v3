# ADR-0211: System-prompt mode-variant — registry + 6-mode variant table

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0198 (identity slot), ADR-0068 (persona slot),
  ADR-0018 (resolveAgentMode SSOT), ADR-0036 (collaboration mode dispatch
  seam), `src/agent/prompt.ts:88` (AgentMode upstream), `src/agent/identity/`
  (ADR-0198 slice)

## Context

Three vendor agents — Cursor, Claude Code, Codex — each ship a per-mode
identity line that the model reads as its first posture cue. ADR-0198
introduced the identity slot for the 4 legacy `AgentMode` values plus a
virtual `onboarding` mode (5 entries total). Two SOTA posture variants
that the vendors ship are missing from our table:

- **architect** — deep-reasoning, design-first, READ-ONLY. Cursor's
  "Architect mode", Claude's `Architect` skill posture, Codex's
  `prefix_rule.design_first` mode.
- **editor**    — minimal-diff, surgical, MUTATING. Cline/Roo "Act mode",
  Cursor's `precise edit` mode, Codex's `apply_patch` posture when the
  user has explicitly asked for minimal scope.

The identity slice (ADR-0198) builds a 1-line identity per mode. The
SOTA registry pattern goes further: it exposes a CLOSED REGISTRY of
`{mode → identity}` that the prompt builder consumes through a port, so
hosts can register custom variants, tests can inject hand-rolled
registries, and the production default-impl can be swapped at
composition time without touching the prompt builder.

## Decision

Introduce a new slice `src/agent/system-prompt/` that sits ABOVE the
identity slice:

```
src/agent/system-prompt/
  port.ts             — SystemPromptVariantRegistry + ModeVariantKey
  mode-variants.ts    — DEFAULT_MODE_VARIANTS table (6 entries) + fallback
  default-builder.ts  — defaultModeVariantRegistry + buildSystemPromptForMode
  index.ts            — slice barrel
```

Extend `AgentMode` (`src/agent/prompt.ts:88`) with `architect | editor`:

```ts
export type AgentMode = "default" | "plan" | "review" | "audit" | "architect" | "editor"
```

Update `MUTATING_MODES` (`src/agent/mode.ts:26`):

```ts
const MUTATING_MODES = new Set<AgentMode>(["default", "editor"])
```

`architect` is INTENTIONALLY OMITTED from `MUTATING_MODES` — it inherits
the fail-closed read-only posture (mutating tools blocked by default).
`editor` is the only ADR-0211 addition that ships write-capable; it
mirrors `default` in admissibility but the prompt posture nudges
minimal-diff behavior.

The registry surface:

```ts
interface SystemPromptVariantRegistry {
  variantFor(mode: ModeVariantKey): ModeVariant
}

const registry = defaultModeVariantRegistry()
const prompt = buildSystemPromptForMode({ mode: "editor", registry })
```

`buildSystemPromptForMode` threads the variant's identity lines through
the existing `buildSystemPrompt({ identity })` seam (ADR-0198) — so the
new slice is ADDITIVE: callers that do not invoke it get a byte-identical
prompt (HELL-MV-10 hellgate locks the OFF-parity invariant).

## Default variant table

| Mode      | Identity (1 line)                                                  |
|-----------|--------------------------------------------------------------------|
| default   | "You are Quanta, a pragmatic coding partner. …"                    |
| plan      | "You are Quanta in Plan mode — propose, never apply. …"            |
| review    | "You are Quanta in Review mode. Read critically; …"                |
| audit     | "You are Quanta in Audit mode. Verify claims against source. …"    |
| architect | "You are Quanta in Architect mode — deep reasoning, design-first." |
| editor    | "You are Quanta in Editor mode — minimal diffs only. …"            |

Override path: `defaultModeVariantRegistry({ plan: [...] })` shallow-
replaces the table entry. Each override array is validated by
`assertValidVariantLines` once at construction time so a forged
newline-bearing or empty entry surfaces immediately, not deep inside the
prompt-build path.

## Consequences

- **Default-OFF**: no caller is required to migrate. `buildSystemPrompt()`
  without `opts.identity` stays byte-identical to the pre-ADR base prompt
  (HELL-MV-10 locks the snapshot).
- **Cache discipline**: the variant identity rides on the cached prefix —
  changing mode mid-session forces a prefix-cache re-prefill, same
  trade-off documented for the persona slot in ADR-0068 and the identity
  slot in ADR-0198.
- **Identity slice extension**: the ADR-0198 `DEFAULT_IDENTITIES` table
  also grows to 7 entries (was 5). This is required because
  `IdentityMode = AgentMode | "onboarding"` and `AgentMode` widened — the
  ADR-0198 table would otherwise fail tsc.
- **mode.ts cross-checks**: `MUTATING_TOOL_TABLE` is unchanged. The new
  `editor` mode is added to `MUTATING_MODES` so its mutating tools pass;
  `architect` inherits the fail-closed default and blocks mutating tools
  by construction.
- **`modeNotice` updates**: `prompt.ts` adds `ARCHITECT_NOTICE` +
  `EDITOR_NOTICE` for the per-turn `<system-reminder>` block; the legacy
  4 notices are unchanged.
- **Negative invariants** (locked by hellgate):
  - HELL-MV-07: unknown mode does NOT crash the prompt path (typed
    fallback).
  - HELL-MV-08: override validation throws on empty / LF / CR lines
    (forged section header attempt).
  - HELL-MV-09: defensive copy on get (caller mutation cannot poison
    the next lookup).
  - HELL-MV-10: OFF parity (byte-identical to pre-ADR base prompt).
  - HELL-MV-12: every variant body is unique (no two modes share an
    identity).
