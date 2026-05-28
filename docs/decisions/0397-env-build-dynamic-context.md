# ADR-0397 — Env / build dynamic context block

**Status:** Accepted (2026-05-28)
**Slice:** `src/agent/env-context.ts` (new, self-contained) + a one-block
extension to `src/agent/prompt.ts`'s `buildDynamicContext` + a new optional
field on `TurnContextInput`.
**Default-OFF:** Yes — `TurnContextInput.env` absent (or fully empty) leaves
the rendered `<system-reminder>` BYTE-IDENTICAL to the pre-ADR-0397 build.
Pinned by `tests/unit/prompt-env-context-hellgate.test.ts`.

## Context

Every other coding agent that ships per-turn host context (Claude Code,
Codex, Cursor, Aider) feeds the model four pieces of build / environment
state so the LLM picks tool invocations that match the host:

- **Platform** — `darwin` vs `linux` decides which shell utilities are
  available; arch affects which prebuilt binaries make sense to suggest;
  release/version pins workaround surfaces.
- **Shell** — `$SHELL` (zsh vs bash vs fish) is load-bearing because the
  three diverge on `<()`, `set -o pipefail`, and parameter expansion.
- **Git status** — a compressed one-line view (e.g. `M 5, ?? 2, ahead 3`)
  tells the model whether the workspace is mid-change, and how dirty.
- **Package manager** — `bun` vs `npm` vs `pnpm` vs `yarn` decides which
  `add` / `run` / `install` invocation will succeed.

quanta has had none of this on the dynamic block. The model has been
guessing the host posture from cwd + free text, which is observably worse on
multi-shell workspaces and on the `bun` toolchain quanta itself targets.

The blocker before was the cache prefix invariant: the dynamic block already
rides the per-turn `<system-reminder>` (correctly OFF the cached prefix), but
adding host probes inside `buildDynamicContext` would (a) make the renderer
impure (depending on `node:os` and `process.env`), (b) tangle async
git-status into a sync codepath, and (c) drift the rendered text day-over-
day for replay.

The clock-injection pattern (`now?: () => number`, established by
ADR-0078 / mirrored by `admissibility-gate.ts` / `memory/consolidate/writer.ts`)
already shows the way: optional pre-computed input → deterministic renderer →
live probe is OPT-IN and lives outside the renderer.

## Decision

Introduce a single optional field `env?: TurnEnvContext` on
`TurnContextInput`, threaded through `buildDynamicContext`, with the
following contract:

1. **Default-OFF byte-identical**. `env` absent OR every field undefined ⇒
   `renderEnvBlock(env)` returns `undefined` and `buildDynamicContext`
   appends ZERO bytes. The rendered `<system-reminder>` is byte-identical
   to the pre-ADR-0397 path. The hellgate pins this with a string-equality
   assertion against the legacy output.

2. **Pure rendering**. When `env` is provided the renderer is a pure
   function of the four optional string fields. No `os.*`, no
   `process.env`, no `Date.now()`, no `spawnSync` inside
   `buildDynamicContext` / `renderEnvBlock` / their helpers. Same input ⇒
   identical output (replay determinism, pinned by hellgate).

3. **Opt-in live probe**. A separate exported helper `probeTurnEnv(opts)`
   in `src/agent/env-context.ts` collects the four fields from
   `node:os` / `node:fs` / a caller-supplied porcelain stdout. Best-effort:
   never throws; on any unexpected failure the relevant field is omitted.
   The caller (runner / CLI bootstrap) invokes it once per turn and
   threads the result into `TurnContextInput.env`.

4. **No async injected**. `probeTurnEnv` does NOT spawn git. The git probe
   takes pre-captured `gitPorcelainStdout` and parses it via the
   now-exported `parsePorcelainV2` from `@/tool/git/status`. Callers that
   already run `git status` via the existing `GitRunner` port pipe stdout
   in; callers that don't supply nothing and the field is omitted.

5. **Cross-slice safe**. The new module imports `parsePorcelainV2` from
   `@/tool/git/status` (already an established cross-slice import from
   `@/agent/turn-diff` and `@/agent/git-observability`). No new slice
   boundary crossed; no other slice references the new module.

6. **No heuristics**. The pkg-manager inference is a fixed lookup over a
   closed ordered list of well-known lock filenames
   (`bun.lockb` → `pnpm-lock.yaml` → `yarn.lock` → `package-lock.json`),
   gated on `package.json` presence. No fuzzy detection, no probabilistic
   ranking. The first lock found wins because that's the manager whose
   install would resolve the current dependency graph.

### Rendered shape

```
## Environment
Platform: darwin arm64 24.6.0
Shell: /bin/zsh
Git: M 5, ?? 2, ahead 3
Package manager: bun
```

The block sits ABOVE `## Repo-local rules` in the dynamic context — env /
build state is the most-static authority (host doesn't change mid-turn),
above repo authority, above session L3 working state, above memory hints.

### Compressed git-status shape

`parsePorcelainV2(stdout).files[].code` is rolled into closed buckets:
`M / A / D / R / U / ?? / !!`. The render is `BUCKET N` segments joined by
`, ` in the fixed order above, followed by `ahead N, behind N` when either
is non-zero. A clean tree (no files AND no ahead/behind) produces an
omitted field (not `clean`) — there's nothing the model needs to know.

## Consequences

- The runner / CLI bootstrap can wire `probeTurnEnv` once and the model
  immediately sees host context. The wire is a one-line change at the
  composition root: read `gitPorcelainStdout` from the same `GitRunner`
  the runner already uses and pass `env: probeTurnEnv({...})` into
  `buildTurnContext`. No other slice mutates.
- The cached `SystemBlock[]` prefix is untouched (env rides the per-turn
  user-side reminder, not the static base). Existing cache hits hold.
- Replay determinism is preserved: a recorded session that captured
  `env: {platform: "...", ...}` replays byte-identical regardless of the
  replay host.
- No tool count change. No new ports beyond the optional `env` field.

## Alternatives considered

- **Probe inside `buildDynamicContext`** — rejected: tangles `node:os` +
  `process.env` + (potentially) `spawnSync` into a slice that has to stay
  sync, pure, and cache-safe. Replay would drift host-by-host.
- **New tool for the model to call** — rejected: this is per-turn ambient
  state, not a tool result. A tool call would burn a turn just to see what
  shell we're on. The `<system-reminder>` is the right channel.
- **Cache the env on the SystemBlock prefix** — rejected: the platform /
  shell / pkg-mgr are stable, but `gitStatus` is per-turn dynamic. Mixing
  static and dynamic in the cached prefix would invalidate the cache
  every turn.

## References

- `src/agent/env-context.ts` — slice (new).
- `src/agent/prompt.ts` — one-block extension to `buildDynamicContext`.
- `src/tool/git/status.ts` — `parsePorcelainV2` + `ParsedStatus` exported
  for cross-slice reuse.
- `src/agent/index.ts` — barrel export.
- `tests/unit/prompt-env-context-hellgate.test.ts` — byte-identical /
  replay-determinism / probe hellgate (22 cases).
- ADR-0078 — determinism leak (date) — clock-injection pattern this slice
  mirrors.
- ADR-0110 — session git-fingerprint — separate, session-scoped signal
  (sha / branch / origin); orthogonal to the per-turn `gitStatus` field.
- ADR-0203 — playbook frontmatter — sibling per-turn dynamic block
  rendering pattern.
