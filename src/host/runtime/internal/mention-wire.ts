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
 *   - `@symbol` — LSP nav adapter (graceful-null until a language server +
 *                 anchor exist; `QUANTA_MENTION_SYMBOL`).
 *   - `@skill`  — omitted (no read-only skill registry exists at this layer;
 *                 the per-turn inventory is built inside the loop).
 *
 * With every knob `=off` the composite resolves all mentions to `null`, so the
 * loop injects nothing (byte-identical default-OFF). NO-THROW: a build failure
 * leaves the slot unwired (legacy no-mention path).
 */

import type { AgentConfig } from "@/agent"
import { installCodexR2Wires } from "@/agent/codex-r2-wire-install"
import { lspNavProvider } from "@/agent/lsp-bridge"
import { createLspSymbolLookup } from "@/agent/mention-injection"
import { buildDefaultMentionResolver } from "@/agent/mention-runner"

/** Install the mention-injector on a host-runtime AgentConfig. Returns the
 *  same (mutated) config for fluent use at the call site. */
export const installCliMentionInjector = (cfg: AgentConfig): AgentConfig => {
  if (cfg.mentionInjector !== undefined) return cfg
  try {
    const mentionResolver = buildDefaultMentionResolver({
      cwd: cfg.cwd,
      env: process.env,
      lsp: createLspSymbolLookup({ provider: lspNavProvider(), cwd: cfg.cwd }),
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
