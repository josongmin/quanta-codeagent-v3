# Ticket 01 — hoist the slash registry + `SlashContext` into `@/runner`

> **Scope note (jun-09 audit)**: this hoist is needed **only for the ADR-0493 `local` route** (the daemon runs a slash handler for long-tail renderers with no typed `control-request`). The high-value north-star readouts go through the typed `control-request` path (ticket 02) and do **not** need the hoist. Still do this ticket — but size it to the long tail, not all 43 commands.

**Phase**: 0 (keystone enabler) · **Blocks**: 03 (`local` route only) · **Risk**: medium (cross-slice move; biome fences + many CLI imports shift)

## Goal
Make the slash-command **contract + surface-agnostic registry/handlers** importable by the daemon, by moving them out of `apps/cli` (which the fence forbids any library/daemon slice from importing) into a shared `@/runner/slash/**`. Leave **only the CLI-specific ctx construction** (binding `out`→`process.stdout`, readline prompts, prefs-file paths) in `apps/cli`.

## Why
- Fence: [biome.json:81-82](../../../biome.json#L81) — "src/apps/cli … library slices and external tests must NOT import its internals." The daemon (ticket 03) cannot reuse the handlers while they live in `apps/cli`.
- The handlers are *already* surface-agnostic: they speak only `SlashContext` ([slash-contract.ts:9-80+](../../../src/apps/cli/slash-contract.ts#L9), `out/err: (s:string)=>void` injected sinks + slot ports `workingState`/`planSnapshot`/`branchSearch`/`profile`/`identity`/`skillScope`/`cost`/`contextUsage`/…). Nothing in them touches a terminal directly.
- This is the explicit migration target in [SURFACE_INTEGRATION.md §2.1](../../runner/SURFACE_INTEGRATION.md) ("lift the pure-composition core … into `@/runner`").

## Touchpoints (current → target)
| Current (apps/cli) | Move to | Notes |
|---|---|---|
| [src/apps/cli/slash-contract.ts](../../../src/apps/cli/slash-contract.ts) (`SlashContext`, `SlashCommand`) | `src/runner/slash/contract.ts` | pure types — cleanest move. Re-export from old path for back-compat during migration. |
| [src/apps/cli/slash/registry-surface.ts:836 `buildSurfaceSlashCommands`](../../../src/apps/cli/slash/registry-surface.ts#L836) + `:904 SURFACE_SLASH_COMMANDS` | `src/runner/slash/registry-surface.ts` | the 18 surface handlers — surface-agnostic |
| [src/apps/cli/slash/registry-session.ts](../../../src/apps/cli/slash/registry-session.ts) (`SESSION_SLASH_COMMANDS`) | `src/runner/slash/registry-session.ts` | session-bound handlers |
| [src/apps/cli/slash/registry-app.ts](../../../src/apps/cli/slash/registry-app.ts) (`APP_SLASH_COMMANDS`) | `src/runner/slash/registry-app.ts` | app-layer handlers; audit each for hidden `process.*` / readline use and split those out |
| `dispatchSlash` builder ([prompt-pipeline.ts:63](../../../src/apps/cli/repl/prompt-pipeline.ts#L63), [session-loop-options.ts:58](../../../src/apps/cli/repl/session-loop-options.ts#L58)) | `src/runner/slash/dispatch.ts` (pure `dispatchSlash(registry, name, args, ctx)`) | the reusable name→handler dispatch both CLI + daemon call |
| **Stays in apps/cli** | — | the *ctx construction*: `out: process.stdout.write` ([batch-cmd.ts:110-113](../../../src/apps/cli/batch-cmd.ts#L110)), readline prompts, prefs-file path resolution ([registry-surface.ts:78-81](../../../src/apps/cli/slash/registry-surface.ts#L78)), TTY-only slots (`voiceLive`, color theme). |

## Steps
1. Add `@/runner/slash` to [tsconfig.base.json](../../../tsconfig.base.json) paths + a biome slice-fence entry for `@/runner/slash/**` (no `apps/**` imports).
2. Move `SlashContext`/`SlashCommand` → `@/runner/slash/contract.ts`. Keep `apps/cli/slash-contract.ts` as a thin `export * from "@/runner/slash/contract"` shim until all imports are repointed (avoids a giant atomic diff).
3. Move the three registries + the `dispatchSlash` core. Any handler that *reaches a terminal directly* (none expected — verify) gets its terminal bit injected via a new `SlashContext` slot instead.
4. Repoint `apps/cli` imports to `@/runner/slash`. Delete the shim once green.
5. Audit `registry-app.ts` handlers (`/doctor`, `/mcp`, `/login`…) for `process.env` / fs / network reads that are genuinely CLI-only — those either stay behind a slot port or are marked Phase-4 non-goals.

## Definition of Done
- `bun run typecheck` 0; biome slice-fence clean (no `@/runner/slash` → `apps/**` import).
- CLI slash behaviour **byte-identical** (existing CLI slash tests green — `tests/unit/apps/cli/**` slash suites).
- A new `@/runner/slash` unit test proves `dispatchSlash(registry, "state", [], ctxStub)` runs the handler against an injected capture sink (no terminal).
- `grep -rn "apps/cli/slash-contract\|apps/cli/slash/registry" src/apps/web-daemon` is still empty *now* (daemon doesn't import yet — that's ticket 03), but the move makes it *possible*.

## Risks
- **Wide import churn** (memory: "코드이동이 source-grep 가드 줄줄이 깸" — relocation breaks source-grep guards). Use the re-export shim to stage it; run the full slash + surface-coupling ratchets after.
- A handler that secretly reads `process.*` would break server-side — the ticket-3 capture test catches it (red-on-injection).
