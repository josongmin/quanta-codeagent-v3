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
import { buildMentionSymbolDeps } from "./mention-symbol-deps"

/** Install the mention-injector on a host-runtime AgentConfig. Returns the
 *  same (mutated) config for fluent use at the call site. */
export const installCliMentionInjector = (cfg: AgentConfig): AgentConfig => {
  if (cfg.mentionInjector !== undefined) return cfg
  try {
    const mentionResolver = buildDefaultMentionResolver({
      cwd: cfg.cwd,
      env: process.env,
      ...buildMentionSymbolDeps(cfg.cwd, process.env),
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
