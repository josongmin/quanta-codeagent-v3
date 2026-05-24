# ADR-0198: Identity mode-variant — per-mode system-prompt identity slot

- Status: Accepted
- Date: 2026-05-25
- Related: ADR-0068 (persona slot), ADR-0018 (resolveAgentMode SSOT),
  ADR-0036 (collaboration mode), `src/agent/prompt.ts:39` (buildSystemPrompt seam)

## Context

Three vendor agents — Cursor, Claude Code, Codex — each ship a **different
identity line in their system prompt for each mode** (default / plan /
review / audit, plus an onboarding posture for new users). The identity
line is the first thing the model reads; it primes posture before any
policy stack or evidence rail. quanta today ships a single

    "You are Quanta, an autonomous coding agent working directly in a
     developer's repository. You operate in a ReAct loop: …"

intro in `INTRO_LINES` (`src/agent/prompt-body.ts:18`). Mode is signalled
only by a per-turn `<system-reminder>` block (`PLAN_NOTICE` / `REVIEW_NOTICE`
/ `AUDIT_NOTICE` in `prompt.ts:144-163`), which arrives AFTER the static
identity and persona slots have already framed the model.

The persona slot (ADR-0068) already opens a splice point between the
intro and the policy stack; the identity slot is the same pattern, but
keyed by `AgentMode` rather than `PersonaKind`.

## Decision

Introduce an **IdentityProvider port** + a default-impl table keyed by
`AgentMode | "onboarding"` (5 entries), and extend
`buildSystemPrompt(opts)` with an optional `identity?: readonly string[]`
field. When `identity` is absent or an empty array, the output is
**byte-identical** to the pre-ADR base prompt — every existing snapshot
test, every prefix-cache hit, and every smoke-fixture turn stays
unchanged. Wire:

    src/agent/identity/
      port.ts                 — IdentityProvider port + IdentityMode type
      default-identities.ts   — 5 mode → 1-to-3 line identity table
      lookup.ts               — defaultIdentityProvider(overrides?) factory
      index.ts                — slice barrel

Splice position: `INTRO_LINES → [identity lines] → [persona lines] →
BODY_AFTER_PERSONA → …`. Identity rides BEFORE persona by design —
"who you are in this mode" frames "how you talk"; reversing the order
makes the persona line speak before the model knows what posture it is
in.

Override path: `defaultIdentityProvider({ plan: [...] })` returns a
provider whose `identityFor("plan")` yields the override but every
other mode falls through to the default table. The provider is pure
(no IO, no clock, no mutation); the override map is shallow-merged
into the default table once at construction time.

Newline/injection hygiene: the identity lines are joined by `"\n"` like
every other prompt fragment. The seam validates each line is a single
text segment with no embedded newline (a multi-line identity must
explicitly use multiple array entries); a newline-bearing entry throws
at construction time so an override cannot smuggle a forged section
header into the cached prefix.

## Default identities (per mode)

| Mode       | Identity (1–3 lines) |
|------------|----------------------|
| default    | "You are Quanta, a pragmatic coding partner. You favor small reversible steps, verify before reporting, and prefer existing libs over custom impls." |
| plan       | "You are Quanta in **plan mode**. You design before you act. State assumptions, list options with trade-offs, await approval. No code mutations." |
| review     | "You are Quanta in **review mode**. You read critically and report bugs/risks. Cite file:line. Do not modify code." |
| audit      | "You are Quanta in **audit mode**. You verify claims against source. Quote evidence. No speculation — say 'I don't know' when uncertain." |
| onboarding | "You are Quanta meeting a new user. Be explicit. Explain trade-offs. Ask before mutating." |

`onboarding` is NOT in the legacy `AgentMode` enum — it is a virtual
identity-only mode that exists for first-session priming. Callers that
do not surface it (every current production path) never construct an
`"onboarding"` argument and the entry is dead-code-safe.

## Consequences

- Default-OFF: no caller is required to migrate. `buildSystemPrompt()`
  without `opts.identity` is byte-identical (HELL-ID-01 / HELL-ID-04
  hellgate cases lock the snapshot).
- Wire: the unified-agent assembly path (`src/apps/agent/...`) and the
  REPL session-setup (`src/apps/cli/repl/session-setup.ts:354`) gain a
  single one-liner — `identity: identityProvider.identityFor(mode)` —
  in their `buildSystemPrompt(...)` call. Behavior change is opt-in per
  surface; both can adopt independently.
- Cache discipline: identity is per-session-static (mode is chosen once
  per session in current surfaces). It rides on the cached prefix —
  changing mode mid-session forces a prefix-cache re-prefill, same
  trade-off documented for the persona slot in ADR-0068.
- Closed port: `IdentityProvider` is a structural interface; tests
  inject hand-rolled providers. A future RPC / hot-reload provider can
  plug in without touching the prompt builder.
- Negative invariant: identity lines are NEVER injected via the
  per-turn `<system-reminder>` user message. That block carries
  dynamic context (date, cwd, mode notice); folding identity there
  would defeat both the cache prefix and the splice-position
  invariant (HELL-ID-05).
