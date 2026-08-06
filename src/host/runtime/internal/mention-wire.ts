/**
 * ADR-0422 — host-runtime mention-injector wire.
 *
 * Single helper that installs `AgentConfig.mentionInjector` for the host
 * runtime surfaces (the CLI REPL flows through `buildAgentConfigFromBase`).
 * Extracted from `context-binding.ts` so it is independently testable and so
 * the binding module stays focused.
 *
 * Idempotent + caller-override-precedence: `installCodexR2Wires` only fills
 * `cfg.mentionInjector` when it is still unset, so a surface that already
 * wired mention (e.g. the unified-agent `assembleAgentConfig` turnAssembler
 * path) is left byte-identical.
 *
 * Builds the DRY composite via `buildDefaultMentionResolver`:
 *   - `@file`   — workspace root = `cfg.cwd` (`QUANTA_MENTION_FILE`).
 *   - `@symbol` — LSP union over DETERMINISTICALLY-synthesized anchors (ADR-0422
 *                 follow-up) + semantic-index fallback (`auto`), both built by
 *                 `buildMentionSymbolDeps`. Graceful-null until a language
 *                 server is installed / the index has entries; `QUANTA_MENTION_SYMBOL`.
 *   - `@skill`  — omitted (no read-only skill registry exists at this layer;
 *                 the per-turn inventory is built inside the loop).
 *
 * With every knob `=off` the composite resolves all mentions to `null`, so the
 * loop injects nothing (byte-identical default-OFF). NO-THROW: a build failure
 * leaves the slot unwired (legacy no-mention path).
 */

import type { AgentConfig } from "@/agent"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"
import { buildDefaultMentionResolver } from "@/agent/mention-runner"
import { buildAppPluginMentionDeps } from "./mention-app-plugin-deps"
import { buildMentionResolverOwners, type MentionLiveSources } from "./mention-source-deps"
import { buildMentionSymbolDeps } from "./mention-symbol-deps"

/**
 * Install the mention-injector on a host-runtime AgentConfig. Returns the
 * same (mutated) config for fluent use at the call site.
 *
 * RFC-12-2 WIRING — the three new mention kinds ride the composition root's
 * LIVE owners:
 *   - `@subagent:` — the config's ALREADY-WIRED `namedAgentResolver`
 *     (`loadNamedAgents(cwd)`; the same repo-controlled registry the subagent
 *     runner consults — RFC-07 foreign-lineage-safe). Present iff the surface
 *     loaded a non-empty `.quanta/agents`.
 *   - `@mcp:` / `@thread:` — the MCP-server snapshot (`loadMcpTools` result) and
 *     the session-list thunk (`listSessions`), threaded on the host-only
 *     {@link MentionLiveSources} bundle (stripped from the base before it becomes
 *     an AgentConfig — see `context-binding/base.ts`).
 *
 * Absent owner ⇒ that kind resolves null (byte-identical). The per-kind
 * `QUANTA_MENTION_{MCP,SUBAGENT,THREAD}` kill-switches are honoured downstream
 * by `buildDefaultMentionResolver`.
 */
export const installCliMentionInjector = (
  cfg: AgentConfig,
  sources?: MentionLiveSources,
): AgentConfig => {
  if (cfg.mentionInjector !== undefined) return cfg
  try {
    // Subagents ride the config's live named-agent resolver; mcp + threads ride
    // the injected host-only sources bundle. An absent owner ⇒ that kind dark.
    const ownerSources: MentionLiveSources = {
      ...sources,
      ...(cfg.namedAgentResolver !== undefined ? { subagents: cfg.namedAgentResolver } : {}),
    }
    const mentionResolver = buildDefaultMentionResolver({
      cwd: cfg.cwd,
      env: process.env,
      ...buildMentionSymbolDeps(cfg.cwd, process.env),
      ...buildAppPluginMentionDeps(cfg.cwd, process.env),
      ...buildMentionResolverOwners(ownerSources),
    })
    installCodexR2Wires(cfg, {
      mentionResolver,
      ...(cfg.sessionId !== undefined ? { sessionId: cfg.sessionId } : {}),
    })
  } catch {
    // Build failure ⇒ slot stays unwired (legacy no-mention path).
  }
  return cfg
}
