# ADR-0493: thin-client dispatch routing

- **상태**: Accepted
- **날짜**: 2026-06-07
- **관련**:
  - `src/shared/thin-client-route.ts` (leaf vocab + parser)
  - `src/agent/thin-client-dispatch/` (gate-aware resolver)
  - `src/skill/types.ts` · `src/skill/skill-frontmatter.ts` · `src/skill/discover.ts` (Skill descriptor + frontmatter)
  - `src/apps/cli/slash-contract.ts` (SlashCommand descriptor)
  - Tests: `tests/unit/thin-client-dispatch-hellgate.test.ts`
  - Absorbs: Claude Code 2.1.167 `thinClientDispatch` (docs/plans/jun-7-draft-ide-integration-spec-claude.md §8)

## Context

quanta is multi-surface (CLI / Web-Tauri / embedded / IDE). A slash-command or skill defined ONCE must
run correctly whether the client is a full process (a real TTY) or a thin host UI (web/IDE) that only
renders a stream and relays input. Claude Code tags each command with `thinClientDispatch` so a thin host
knows whether to run it locally, post its text into the stream, or issue a control request. quanta had no
such routing tag — a command that assumes an interactive TTY would break on a thin host.

## Decision

A closed route vocabulary `ThinClientRoute = "local" | "post-text" | "control-request"` lives in `@/shared`
(leaf) with a NO-THROW `parseThinClientRoute`. An optional `thinClientDispatch?` field is added to the
`Skill` descriptor (+ kebab frontmatter key `thin-client-dispatch`) and the `SlashCommand` interface. A
pure, gate-aware `resolveThinClientRoute(descriptor, surface, env)` in `@/agent/thin-client-dispatch`
maps to the effective route:

- gate OFF → `"local"` (byte-identical default);
- THICK surface (cli/headless/bench) → `"local"` (a tag never breaks a real terminal);
- THIN surface (web/ide), gate ON → the descriptor's valid tag, else `"local"`.

## Default posture

OFF. Gate `QUANTA_THIN_CLIENT_DISPATCH` (opt-in via the @/shared SSOT). Absent ⇒ the resolver returns
`"local"` for every descriptor on every surface — byte-identical to a world without this slice. The
descriptor field is additive: a skill/command without it parses and behaves exactly as before. The thin
host (web/ide adapter, out-of-repo per ADR-0092) consumes the resolved route; the CLI is always local.

## Correctness invariants (hellgate-proven)

1. Default-OFF byte-identity across every (tag × surface).
2. THICK surfaces never route away from `"local"` even with the gate on.
3. THIN surfaces honor the tag only when gated on; the full truthy/falsy gate vocab is respected.
4. `parseThinClientRoute` rejects unknown tokens (→ undefined); a garbage tag degrades to `"local"`,
   never throws.

## ROI / tradeoff

Tiny, additive, default-OFF. Unlocks correct command behavior on quanta's thin surfaces without touching
the CLI hot path. The actual web/IDE host consumption is the documented follow-up wire.
