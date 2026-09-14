/**
 * ADR-0350 — Composition-root auto-wire for `cfg.activatePlugins`.
 *
 * Closes the value gap left by ADR-0346: the loop hook calls
 * `cfg.activatePlugins` once per turn, but nothing populates the slot.
 * Composition roots were required to assemble the registry + launcher +
 * handler by hand. This helper performs that assembly automatically from
 * the minimal inputs (cwd + optional event store), so any composition
 * root that calls `autoWirePluginActivation(cfg, deps)` AFTER the bare
 * AgentConfig is constructed gets per-turn plugin activation for free.
 *
 * # Invariants
 *
 *  1. NO-THROW. Every step is wrapped: missing plugin root, fs errors,
 *     malformed manifests, registry construction failures all degrade to
 *     "leave `cfg.activatePlugins` undefined" — byte-identical legacy.
 *
 *  2. Caller-override-precedence. If `cfg.activatePlugins` is ALREADY
 *     set (the host wired its own activator), this helper is a no-op.
 *     Mirrors the ADR-0332 install pattern.
 *
 *  3. Empty-discovery short-circuit. When the plugin root is missing or
 *     contains zero parseable manifests, the slot stays undefined. The
 *     loop hook then short-circuits at its first check ⇒ byte-identical.
 *
 *  4. Bench replay determinism. Bench composition (ADR-0334 row 4 +
 *     ADR-0347 row 4) does NOT call this helper. The wire is restricted
 *     to `apps/agent/assemble.ts` for the rich-deps composition root only.
 *
 *  5. Slice fence. This module MAY import `@/agent/plugin-discovery`,
 *     `@/agent/plugin-mcp-launcher`, `@/skill/registry-readonly`, and
 *     `@/agent/types`. It MUST NOT import `@/agent/loop`,
 *     `@/agent/dispatch`, or `@/agent/prompt`.
 *
 * # Defaults
 *
 *  - Plugin root: `<cwd>/.quanta/plugins`. This matches the discovery
 *    convention noted in `@/agent/plugin-discovery/discovery.ts` (`e.g.
 *    ~/.quanta/plugins`) but anchored at the workspace so different
 *    workspaces ship different plugin sets. Override via
 *    `deps.pluginRoot`.
 *  - Filesystem port: a thin sync node:fs shim (readDir + readFile).
 *    Override via `deps.fs` for tests / non-node hosts.
 *  - Skill registry: intentionally OMITTED. The handler degrades the
 *    skill-resolution step to a no-op (empty resolvedSkills) when no
 *    `skillRegistry` is supplied; building one synchronously is not
 *    possible here (`buildSkillBlock` is async + caches per-session
 *    inside the loop). Plugin-declared skills are out-of-scope for the
 *    auto-wire; hosts that want them MUST set `cfg.activatePlugins`
 *    themselves with a fully configured handler.
 */

import { readdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import {
  createInMemoryPluginRegistry,
  discoverPlugins,
  type FilesystemPort,
  type PluginManifest,
} from "@/agent/plugin-discovery"
import {
  createInMemoryPluginMcpRegistry,
  createIsolatedMcpLauncherPort,
} from "@/agent/plugin-mcp-launcher"
import { type AgentMode, modeLoadsRepoRules } from "@/agent/run-mode"
import type { AgentConfig } from "@/agent/types"
import { isWorkspaceTrusted, untrustedWorkspaceMessage } from "@/agent/workspace-trust"
import { emitOperatorNotice } from "@/shared"
import { activatePluginsFromMentions } from "./composite-activation"
import { createPluginActivationHandler } from "./handler"

/**
 * Inputs to {@link autoWirePluginActivation}. All fields are optional —
 * with everything absent the helper still works (default node-fs port,
 * default plugin root under cwd).
 */
export interface AutoWireDeps {
  /** Override the plugin root (defaults to `<cwd>/.quanta/plugins`). */
  readonly pluginRoot?: string
  /** Override the filesystem port (defaults to a sync node:fs shim).
   *  Tests inject an in-memory port to avoid touching the real fs. */
  readonly fs?: FilesystemPort
}

/** Default node:fs adapter. Sync to match the {@link FilesystemPort}
 *  contract. Errors propagate up; the scanner wraps each call in its
 *  own try/catch so a thrown read here degrades gracefully. */
const defaultNodeFs: FilesystemPort = {
  readDir(dir: string): readonly string[] {
    return readdirSync(dir)
  },
  readFile(path: string): string | null {
    try {
      return readFileSync(path, "utf8")
    } catch {
      return null
    }
  },
}

/** Safe discovery wrapper. NO-THROW: any error during scan becomes []. */
const safeDiscover = (rootDir: string, fs: FilesystemPort): readonly PluginManifest[] => {
  try {
    return discoverPlugins(rootDir, fs)
  } catch {
    return []
  }
}

/**
 * Auto-wire `cfg.activatePlugins` IFF the slot is empty and at least one
 * plugin manifest is discoverable under the plugin root.
 *
 * Mutates `cfg` in place (mirrors the ADR-0332 install pattern). NEVER
 * throws to the caller. Returns nothing — observability is via the
 * eventual loop hook + the handler's NO-THROW shape.
 *
 * @param cfg   AgentConfig to wire. Bare cfg is fine; the helper only
 *              reads `cfg.cwd` + `cfg.activatePlugins`.
 * @param deps  Optional overrides — plugin root + filesystem port. The
 *              defaults work for production node hosts; tests inject
 *              fakes.
 */
/** Trust context for the auto-wire decision. `mode` omitted ⇒ the legacy
 *  (ungated) behavior, so an existing caller that has no mode in scope is
 *  byte-identical; every production caller SHOULD pass it. */
export interface AutoWireTrust {
  readonly mode?: AgentMode
}

export const autoWirePluginActivation = (
  cfg: AgentConfig,
  deps: AutoWireDeps = {},
  opts: AutoWireTrust = {},
): void => {
  try {
    // aug-22 audit — REPO-SUPPLIED CODE IS UNTRUSTED IN UNTRUSTED TREES.
    // The plugin root is `<cwd>/.quanta/plugins`, i.e. CONTENT THAT ARRIVES
    // WITH A CLONE, and a discovered manifest's `mcpServers[].command` reaches
    // an argv spawn. Nothing on this path consulted the trust store, so a PR
    // that adds `.quanta/plugins/x/.codex-plugin/plugin.json` executed the
    // attacker's argv on any surface that ran the checkout. The sibling
    // `.mcp.json` path has the same rule: a folder's own config, or one a
    // relative or dotenv-supplied path names, loads only in a trusted folder
    // (`readMcpConfig`, ADR-0559).
    //
    // This reuses the EXISTING repo-content trust policy rather than inventing
    // a second one: `modeLoadsRepoRules` already classifies `ci-bot` (PR
    // checkout) and `daemon` (host-created webhook worktree) as untrusted trees
    // and `batch` as a hermetic sandbox. A mode that must not read a repo's
    // AGENTS.md must certainly not execute its plugin manifests.
    if (opts.mode !== undefined && !modeLoadsRepoRules(opts.mode)) return

    // Caller-override-precedence: already wired ⇒ no-op.
    if (cfg.activatePlugins !== undefined) return

    // Cwd guard — a malformed cfg without cwd cannot scan anything.
    if (typeof cfg.cwd !== "string" || cfg.cwd.length === 0) return

    const fs = deps.fs ?? defaultNodeFs
    const root = deps.pluginRoot ?? join(cfg.cwd, ".quanta", "plugins")
    const manifests = safeDiscover(root, fs)

    // Empty-discovery short-circuit: leave the slot undefined ⇒ loop hook
    // short-circuits at its first check ⇒ byte-identical legacy.
    if (manifests.length === 0) return

    // The mode policy above only knows which surfaces run in untrusted trees; an
    // interactive session in a folder nobody trusted is one too. A plugin manifest's
    // `mcpServers[].command` is spawned, so the folder must be trusted (workspace-trust).
    if (!isWorkspaceTrusted(cfg.cwd)) {
      emitOperatorNotice({
        severity: "warn",
        source: "plugins",
        message: untrustedWorkspaceMessage(`The plugins in ${root}`, cfg.cwd),
        hint: "no project plugin was wired",
      })
      return
    }

    const pluginRegistry = createInMemoryPluginRegistry(manifests)
    const mcpRegistry = createInMemoryPluginMcpRegistry()
    const mcpLauncherPort = createIsolatedMcpLauncherPort()

    const handler = createPluginActivationHandler({
      pluginRegistry,
      mcpLauncherPort,
      mcpRegistry,
      // skillRegistry intentionally omitted — see module docstring §Defaults.
      // emit intentionally omitted — typed-history store is wired through
      // the codex-r2 install path; we do not double-emit here.
    })

    cfg.activatePlugins = (mentions, opts) => activatePluginsFromMentions(mentions, handler, opts)
  } catch {
    // NO-THROW: any internal failure leaves cfg.activatePlugins untouched.
    // The loop hook will short-circuit ⇒ byte-identical legacy.
  }
}
