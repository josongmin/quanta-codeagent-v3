/**
 * Tool profile preset definitions (ADR-0213).
 *
 * Each preset is a CLOSED set of rules over (toolName, isReadOnly). The
 * presets are intentionally COARSE — they exist to express user-facing
 * intent ("Zed Ask mode, all mutations require confirm") in ONE knob.
 * Fine-grained per-tool policy still lives in ADR-0046 (permission stack)
 * and ADR-0055 (HITL tier).
 *
 * The 4 presets:
 *
 *   write     — DEFAULT. Every tool permitted; deferred to the underlying
 *               permission stack. Equivalent to "no preset".
 *
 *   ask       — Zed "Ask mode" parity. All read-only tools `allow`;
 *               every mutating tool `confirm` (user prompt) regardless of
 *               the permission stack's auto-approval state. Useful as a
 *               safety net for sensitive sessions.
 *
 *   minimal   — LSP + git read-only ONLY. Every other tool `deny`. The
 *               profile for "I am exploring; do not let the model touch
 *               anything outside read-paths."
 *
 *   code-only — File-edit + LSP + shell (`bash`) ALLOWED; web / voice /
 *               image surfaces DENIED. The profile for "this session is a
 *               coding session — no browsing, no images, no voice".
 *
 * Profile rules are evaluated in this order (first match wins):
 *   1. explicit per-tool entry in `tools` map
 *   2. category fallback (read-only / mutating)
 *   3. default
 */

import type { ToolProfileAdmissibility, ToolProfileName } from "./port"

/** Internal preset shape. The resolver evaluates the rules with the
 *  precedence documented above. */
export interface ToolProfilePresetSpec {
  readonly name: ToolProfileName
  /** Per-tool overrides. The KEY is the exact tool name as registered. */
  readonly tools: Readonly<Record<string, ToolProfileAdmissibility>>
  /** Default for any read-only tool not in `tools`. */
  readonly defaultReadOnly: ToolProfileAdmissibility
  /** Default for any mutating tool not in `tools`. */
  readonly defaultMutating: ToolProfileAdmissibility
  /** One-line description for `/status` and CLI help. */
  readonly description: string
}

/** The 4 closed preset definitions. Frozen at module load. */
export const PROFILE_PRESETS: Readonly<Record<ToolProfileName, ToolProfilePresetSpec>> =
  Object.freeze({
    write: Object.freeze({
      name: "write",
      tools: Object.freeze({}),
      defaultReadOnly: "allow",
      defaultMutating: "allow",
      description: "Default — every tool permitted; underlying permission stack decides per-call.",
    }),

    ask: Object.freeze({
      name: "ask",
      // No explicit overrides; categories cover the rules.
      tools: Object.freeze({}),
      defaultReadOnly: "allow",
      defaultMutating: "confirm",
      description:
        "Read-only allowed; every mutating tool requires user confirmation regardless of permission stack.",
    }),

    minimal: Object.freeze({
      name: "minimal",
      // Allow ONLY explicit LSP-read + git-read entries; deny everything
      // else via the defaults below (defaultReadOnly=deny denies
      // read-only tools NOT named here, defaultMutating=deny covers the
      // mutating side).
      tools: Object.freeze({
        // LSP read-only surfaces (ADR-0140)
        lsp_definition: "allow",
        lsp_references: "allow",
        lsp_hover: "allow",
        lsp_type_definition: "allow",
        lsp_implementation: "allow",
        lsp_document_symbol: "allow",
        lsp_workspace_symbol: "allow",
        // Git read-only surfaces (ADR-0098 family)
        git_status: "allow",
        git_log: "allow",
        git_diff: "allow",
        git_blame: "allow",
      }),
      defaultReadOnly: "deny",
      defaultMutating: "deny",
      description:
        "Read-only ONLY — LSP read + git read. Every other tool denied; for exploration sessions.",
    }),

    "code-only": Object.freeze({
      name: "code-only",
      tools: Object.freeze({
        // Web surfaces denied (ADR-0127)
        web_fetch: "deny",
        web_search: "deny",
        // Image surfaces denied (ADR-0126)
        read_image: "deny",
        read_image_url: "deny",
        // Voice surfaces denied (ADR-0202 — voice-input STT)
        voice_input: "deny",
        voice_transcribe: "deny",
      }),
      defaultReadOnly: "allow",
      defaultMutating: "allow",
      description:
        "Coding session — file edit + LSP + shell allowed; web / image / voice surfaces denied.",
    }),
  })
