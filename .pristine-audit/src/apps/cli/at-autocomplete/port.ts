/**
 * RFC-12 / ADR-0439 — `@`-mention autocomplete closed ports.
 *
 * The existing `MentionResolverPort` (`@/agent/mention-injection`) is a
 * ONE-DIRECTIONAL `target → body` renderer — given `@src/foo.ts` it reads
 * the file body. It CANNOT enumerate candidates from a partial query. The
 * autocomplete dropdown needs the OPPOSITE direction — `partial query →
 * ranked candidate list` — so this slice defines a NEW listing port. The
 * resolve port is untouched; accept inserts raw `@target` text and the
 * existing agent-loop `mentionInjector` (`loop.ts:1036`) re-parses + resolves
 * it on submit (RFC §4.6 round-trip).
 */

import type { MentionKind } from "@/agent/mention-injection"

/**
 * One autocomplete candidate.
 *
 * `insertText` is the raw text spliced into the input buffer on accept —
 * it MUST carry the sigil so the submit-time `parseMentions` re-classifies
 * it (e.g. `"@src/foo.ts"`, `"@code-review"`, `"plugin://github"`).
 * `label` is the dropdown display name; `detail` is the dim right column
 * (relative path / signature / description first line). `score` — when the
 * provider supplies it — is the stable sort key (lower = earlier; RFC §4.5
 * 3-tier `0=exact, 1=prefix, 2=substring`). Renderers never compute their own score.
 */
export interface AtCandidate {
  readonly kind: MentionKind
  readonly insertText: string
  readonly label: string
  readonly detail?: string
  readonly score?: number
}

/**
 * Candidate listing port. `query` is the text typed AFTER the `@` sigil
 * (sigil excluded). The provider infers the kind from the query shape
 * (mirroring the parser cascade) and returns a flat, kind-groupable array.
 *
 * Contract:
 *   - async — file glob / LSP `workspaceSymbol` are I/O.
 *   - NO-THROW — implementations SHOULD catch internally; the keypress
 *     wire layer ALSO degrades a thrown/rejected promise to `[]` (RFC §6.1).
 *   - cancellable — an `AbortSignal` lets the wire drop a stale lookup when
 *     the user keeps typing.
 */
export interface AtCandidateProvider {
  list(query: string, signal?: AbortSignal): Promise<readonly AtCandidate[]>
}
