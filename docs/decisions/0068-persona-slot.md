# ADR-0068 — Persona slot (Codex `{{ personality }}` Handlebars absorption)

(NOTE: shares the `0068` number with the Codex 2-Phase memory consolidator ADR
by intentional choice — the two land in orthogonal subsystems (`src/agent/persona.ts`
and `src/memory/consolidate/*`) and the duplicate is left in place. Feature-catalog
yamls disambiguate by file location, not by ADR number.)

## Status
Accepted (2026-05-21)

## Context
ADR-0067 explicitly deferred the persona slot because it is orthogonal to
the four prompt-template strengthening gaps that ADR closed. With the
template now SOTA++, the persona dimension is the next gap.

Codex Desktop's `base_instructions` template embeds a verbatim Handlebars
slot `{{ personality }}` (see [[codex-feature-catalog-2026-05-21]] §7),
populated from `models_cache.json`'s three named bodies:

- `personality_default` — empty string (no persona)
- `personality_friendly` — "vivid inner life… intelligent, playful,
  curious, deeply present" / "warm, encouraging" / uses "we" / "let's",
  collaborator tone
- `personality_pragmatic` — "deeply pragmatic, effective software
  engineer" / no cheerleading / Clarity, Pragmatism, Rigor

The catalog can be pushed from a server (Codex's model cache refresh) or
overridden at turn-level via the `SetPersonality` runtime event. quanta
has no equivalent affordance — every session ships the same agent voice.

Two operator complaints surfaced in live REPL replays this session:

1. The default voice is *neither* warm nor terse — it is the average,
   which lands as "AI assistant" in tone. Users who want a teammate
   register get cheerleading from no rule; users who want crisp
   engineering get hedging from no rule.
2. There is no surface to ask for a tonal change per environment
   (CI / batch vs interactive REPL). A pragmatic register helps
   automation; friendly register helps long-tail debugging sessions.

## Decision
Adopt the Codex `{{ personality }}` pattern as a quanta surface:

1. **Three named personas** matching Codex's enum:
   `"default" | "friendly" | "pragmatic"`. `default` is the empty body
   (byte-identical to the pre-ADR base prompt).
2. **Per-session static.** Resolved once at `buildSystemPrompt()` time
   from the optional `opts.persona`. byte-identical to the current
   prompt when `persona === "default"`, so existing cache breakpoints
   and snapshot tests keep their hashes.
3. **Env-driven default.** `QUANTA_PERSONA=default|friendly|pragmatic`.
   Unknown value ⇒ named `PersonaInvalidError` throw (no silent
   fallback). Absent ⇒ `"default"` (the explicit choice, not a
   heuristic).
4. **No Codex/Anthropic API push channel** (the runtime `SetPersonality`
   event is server-side and out of scope here). Per-session is the
   right granularity for our surface — the user picks once when they
   start the REPL, and the cached prefix holds.
5. **Inserted between agent intro and Policy stack.** Persona body
   sets *tone*; it must NOT contradict the L1-L5 policy layers that
   follow. Sequencing matters: intro → persona (tone) → policy stack
   (authority) → operating principles (action).

### Three persona bodies (verbatim into the static prompt)

`default` — empty string. Renders nothing, no extra newline.

`friendly`:
> Persona: collaborative partner. Bring a warm, curious presence to
> the conversation. Use "we" / "let's" when collaboration is natural;
> acknowledge progress when the user lands a step. Stay intellectually
> engaged — show interest in the user's problem, not just the task
> surface. Warmth never overrides the honesty rail below.

`pragmatic`:
> Persona: deeply pragmatic software engineer. Optimize for the user's
> actual outcome. No cheerleading, no padding, no "great question."
> State conclusions directly, name trade-offs, leave room for the user
> to push back. Clarity > Pragmatism > Rigor.

The "Warmth never overrides…" and "Clarity > Pragmatism > Rigor" lines
are guardrails that anchor each persona to the honesty/evidence
ladders that come after. They prevent the friendly persona from
sliding into hedging, and the pragmatic persona from sliding into
curt-and-wrong.

## Rationale
- **Per-session is the right granularity.** Codex offers turn-level
  override via `SetPersonality`; we do not have an equivalent event
  bus, and per-session matches how users actually pick a tone (once,
  at REPL start). Per-turn flip is over-engineering for the surface.
- **Empty default preserves caching.** The full Anthropic /
  OpenAI prefix cache is keyed on the system prompt bytes. An empty
  `default` body means the `default` branch hits exactly the same
  cache slot as pre-ADR, so no existing session pays a re-prefill
  cost.
- **Guardrail lines inside each persona body.** Without them, persona
  text starts to leak into the agent's *correctness* posture (friendly
  → hedging, pragmatic → "no I won't elaborate"). The single line at
  the end of each body re-binds tone to the layers below.
- **Three matches Codex.** Five or seven personas would dilute the
  signal; one is what we already have. Three covers the actually-
  distinct registers (neutral / collaborative / terse-engineering) and
  matches Codex 1:1 so future absorptions stay aligned.

## Trade-offs
- The two non-default personas add ~150 tokens to the cached `base`
  section when active. Negligible per-turn (cached once per session).
- Persona bodies are quanta-specific paraphrases, not Codex verbatim.
  Paraphrase keeps our voice; verbatim would copy Codex's exact
  wording (longer, more flowery for `friendly`). We accept the
  paraphrase explicitly so future Codex updates do not silently shift
  our voice.
- No turn-level override. If a user wants to switch mid-session, they
  exit the REPL and restart with a different `QUANTA_PERSONA`.
  Acceptable for v1; can be added later via a `/persona <kind>` slash
  command (out of scope here).

## Alternatives considered
- **Five+ personas (formal / coach / mentor / etc).** Rejected: the
  marginal value drops fast after 3, and the persona enum is part of
  the public surface — adding more later is cheap, removing them is
  expensive (breaks scripts). Start with Codex's three.
- **Turn-level persona via slash command (`/persona`).** Rejected for
  this ADR: it requires invalidating the cached prefix mid-session
  (every persona switch re-prefills the whole base prompt). Defer
  until a clear demand surfaces.
- **Verbatim Codex bodies.** Rejected: copying Codex's exact wording
  ties our voice to theirs, including the parts we do not want
  (Codex's `friendly` leans into "vivid inner life," which is more
  performative than we want).
- **Skip the default body entirely (always non-empty).** Rejected:
  byte-identical default preserves every current cache hit and every
  snapshot test. The empty body is the cheapest possible parity.

## Negative invariants
- **No turn-level persona switching in v1.** A `/persona` slash that
  re-prefills mid-session is out of scope; only `QUANTA_PERSONA` env
  at startup is supported.
- **No persona body without its guardrail line.** Each non-default
  persona body MUST end with the one-line guardrail that re-binds
  tone to the honesty/evidence/trust ladders.
- **No silent default for unknown env values.** Unknown
  `QUANTA_PERSONA` ⇒ `PersonaInvalidError` throw. The valid set is a
  closed enum, not a fuzzy match.
- **No env reading inside `buildSystemPrompt`.** The function takes
  the resolved `PersonaKind`; env resolution lives in the CLI layer
  (`apps/cli/internal.ts`) where `process.env` already routes other
  config. Keeps the prompt builder pure.

## Implementation
1. `src/agent/persona.ts` — new module owning the enum, the three
   bodies, the env resolver, and the named error.
2. `src/agent/prompt.ts` — `buildSystemPrompt(_cwd?, opts?: {
   persona?: PersonaKind })` signature; spread-operator insertion of
   the persona body between intro and Policy stack.
3. `src/apps/cli/internal.ts` — `pickPersona()` helper alongside
   existing `pickProvider`/`pickModel`/`env` helpers; threaded into
   the `buildSystemPrompt(d.cwd, { persona: pickPersona() })` call.
4. `tests/unit/agent/persona.test.ts` — enum coverage, env resolver
   (3 valid / 1 invalid / 1 absent), guardrail-line presence.
5. `tests/unit/prompt-system.test.ts` — additions: default ⇒
   byte-identical to legacy; friendly/pragmatic ⇒ persona body
   present in the resulting prompt.

## Verification
- `tsc --noEmit` clean
- `bun test tests/unit/agent/persona.test.ts` all pass
- `bun test tests/unit/prompt-system.test.ts` all pass (existing
  byte-stable assertion still holds for `default`)
- `bun test tests/unit/prompt-rules-snapshot.test.ts` snapshot still
  matches (default persona ⇒ byte-identical to pre-ADR snapshot)
- biome exit 0 on touched files

## Related
- ADR-0067 — Prompt template SOTA++ (this ADR is the deferred
  follow-up named there)
- ADR-0003 — Prompt cache lever (this ADR preserves the cache-
  breakpoint invariant by making `default` byte-identical)
- `codex-feature-catalog-2026-05-21` §7 — Codex `{{ personality }}`
  Handlebars source pattern
- Future ADR — `/persona <kind>` slash command for mid-session
  switching (deferred)
