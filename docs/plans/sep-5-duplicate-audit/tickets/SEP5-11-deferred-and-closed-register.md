# SEP5-11 — deferred and closed duplicate findings register

**Priority:** governance
**Status:** ACTIVE REGISTER; no implementation by default
**Depends on:** SEP5-00
**Finding coverage:** D7–D9, D12–D14, D16–D18, D20–D26, D29–D30

## Purpose

Prevent rejected consolidation proposals from returning as unscoped cleanup.
An item can leave this register only with the concrete trigger listed below and
an owner-local failing rail.

## Conditional items

| ID | Current decision | Reopen trigger | Allowed scope |
|---|---|---|---|
| D7 | Do not build `voice -> media` REST core | Proven live/public consumer of both STT contracts, or decision to delete media stack | Delete unused stack; otherwise extract a neutral injected transport without peer import |
| D8 | Leave helpers local | Observed first-line output or error-policy drift | Extract only pure first-line helper; warning policy remains caller-owned |
| D13 | Do not force all git domains onto one `GitRunner` | Reproduced env leak, shell injection, orphan child, or missing timeout | Share execution policy/argv runner at a legal composition seam; retain domain ports |
| D16 | Do not merge tool registries | Concrete tool missing/duplicated between surfaces against an agreed capability manifest | Extract group registration primitive, not one mega optional builder |
| D17 | Do not add `buildModePresetBase` | Same mode-independent field drifts in at least two presets | Extract the field resolver only; avoid an overrides/options bag |
| D21 | Do not merge CLI/Web boot | A written common session-bootstrap input/output contract and behavioral parity RED exist | Move one collaborator-minting core to host; keep TTY/WS adapters separate |
| D22 | Opportunistic cleanup only | The duplicated helper's owning file is already being changed | `detectEol`/same-slice timeout only; preserve different JSON sentinels and abort semantics |
| D23 | Keep CDP correlators separate | Reproduced lost reply/waiter leak caused by divergent correlator state logic | Extract pure id/pending-map state machine only |
| D25 | Existing shared grace constant is sufficient | Pump-death behavior diverges under the same process fixture | Extract a neutral settlement helper to shared; never make plugin-isolation the generic owner |
| D26 | No central AgentEvent mega-table | A new event is silently dropped by a consumer that should handle it | Add per-consumer exhaustive switch or explicit allowed-filter policy |

## Closed items

| ID | Why closed | Guard against recurrence |
|---|---|---|
| D9 | `SessionVerbSurface<R>` and source-level compile pins already enforce verb key/argument/result-grade parity | Keep typecheck pins; require a semantic drift reproduction before a factory |
| D12 | grep, glob, and lexical ripgrep have different output/fallback/jail contracts | Track shell/argv execution hardening under D13-style policy, not DRY |
| D14 | One-line SHA-256 wrappers are stable and intentionally fence-local | Do not create a dependency solely to share `createHash(...).digest("hex")` |
| D18 | Moving fake bootstrap defaults into production host would promote test policy to runtime authority | Keep surface fakes local; share only a real production contract with required inputs |
| D20 | JSONL stores have different append/rewrite/resume/corruption/durability semantics | Share only separately specified atomic-file primitives |
| D24 | MCP sandbox and remote job runners have different lifecycle and policy contracts | Share a backend probe only after proving identical CLI/version semantics |
| D29 | Storage and LSP atomic writers intentionally have different ports/fence ownership | Preserve the existing documented algorithm parity and separate tests |
| D30 | MCP outer mutex coalesces fresh interactive auth; token rotator coalesces refresh | SEP5-04B changes ChatGPT only; do not remove MCP's outer guard |

## Evidence required to reopen

Every reopened item must provide:

1. exact HEAD and reachable consumer;
2. expected vs actual behavioral reproduction;
3. canonical owner and legal dependency direction;
4. exact write set;
5. RED that fails before implementation and a negative control;
6. proof that the abstraction reduces authority rather than adding another
   layer;
7. deletion or deprecation plan for the old implementation.

Similarity metrics, matching basenames, shared executable names, or copied
one-line helpers are insufficient.

## Register verification

At each campaign closeout:

```sh
git rev-parse HEAD
git status --short
rg -n 'buildVerbSurfaceFromSubmit|buildModePresetBase|storage/jsonl-io|media/stt/rest-core' src
bun run typecheck
bun test tests/unit/slice-boundary-config-parity.test.ts
```

An `rg` hit is triage input, not failure by itself. Inspect ownership and
reachability before changing status.

## Reopen ratchet template

No generic test is added for a closed item: that would encode a speculative
abstraction as policy. When an item reopens, its first change is a ticket-local
test packet containing:

- one reachable public/production entrypoint and the exact expected-vs-actual
  failure;
- a numeric consumer/case floor and a type-correct injected defect;
- a canonical owner with legal slice direction;
- an assertion that the old authority has zero live callers after migration;
- focused command, typecheck, architecture test, and full-CI enrollment.

The mutation must reintroduce the observed drift and fail the named assertion.
An `rg` hit, duplicate basename, import, comment, or zero-caller scan cannot be
the sole RED. Until all fields exist, the register entry stays conditional or
closed and no consolidation code is authorized.

## Definition of done

- Closed proposals are removed from the active PR queue.
- Conditional proposals have explicit reopen evidence, not calendar dates.
- No worker implements a listed generic abstraction without updating this
  register and producing the required RED packet.
