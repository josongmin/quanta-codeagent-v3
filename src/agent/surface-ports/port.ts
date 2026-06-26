/**
 * Surface-owned port contracts that the composition-root mega-wire
 * (`WireSlotsComposeConfig`, ADR-0236) references but the LOOP never consumes
 * directly. These are duck-typed seams a surface (REPL / Tauri / Web) fills in;
 * the agent domain owns the CONTRACT, the surface owns the IMPLEMENTATION.
 *
 * Why they live here (not in `apps/cli`): `@/agent` is a core slice and must
 * not depend — even in type position — on a surface (`apps/**`). Before this
 * module existed, `wire-slots-compose.ts` referenced these three interfaces via
 * `import("../../apps/cli/...")`, a dependency-direction inversion (`@/agent` →
 * surface). Hoisting the contract here makes the surface the IMPLEMENTOR and the
 * agent the OWNER, the same posture as the sibling `fork-session/port.ts`,
 * `focus-chain`, and `subagent-typed` ports. The `apps/cli` modules now
 * re-export these symbols so every existing `./text-inbox` / `./edit-plan-cmd`
 * importer is unaffected.
 *
 * Purity: this file imports nothing — pure interface declarations, erased at
 * compile time.
 */

/* ─── Text inbox (ADR-0224) ────────────────────────────────────────────── */

/** Single text attachment — `kind` distinguishes provenance so the surface can
 *  render a friendlier preface ("(web: https://…)" vs "(paste)") on the
 *  prepended bytes. */
export interface TextInboxEntry {
  /** Provenance tag — `web` ⇒ added by `/web`, `paste` ⇒ added by `/paste`,
   *  `other` reserved for future surface integrations (drag-drop on Web). */
  readonly kind: "web" | "paste" | "other"
  /** Short human label — e.g. the URL for `/web`, the path for a `/paste` that
   *  resolved a filesystem path. Surfaced in `list()` output. */
  readonly label: string
  /** The literal text body to attach (markdown or raw). */
  readonly text: string
}

export type TextInboxAddResult =
  | { readonly kind: "ok" }
  | { readonly kind: "over_cap"; readonly cap: number }

/** FIFO single-shot inbox for surface slash commands that attach out-of-band
 *  content to the NEXT user turn. A surface drains it exactly once from its
 *  `PromptSource.next()` impl and concatenates the chunks to the user text. */
export interface TextInbox {
  add(entry: TextInboxEntry): TextInboxAddResult
  /** Snapshot of currently-queued entries. Returns a fresh array; mutating it
   *  has no effect on the inbox. */
  list(): readonly TextInboxEntry[]
  /** Empty the inbox. Idempotent. */
  clear(): void
  size(): number
  /** Atomically return + clear. Single-shot drain semantics — every
   *  `PromptSource.next()` call invokes this exactly once. */
  drain(): readonly TextInboxEntry[]
}

/* ─── External-editor ports (ADR-0225) ─────────────────────────────────── */

/** `/edit-plan` port. The surface owns the wire; the slash never imports
 *  `@/agent`. Async to match the rest of the port surfaces (a Tauri-backed
 *  surface may need to await an IPC round-trip). */
export interface PlanEditPort {
  /** Snapshot the current plan as markdown the user can edit in `$EDITOR`.
   *  Empty string ⇒ no plan exists yet; the user's edit BECOMES the new plan
   *  body. */
  getPlan(): Promise<string> | string
  /** Push the edited body back. Implementation may parse it back to structured
   *  todos or simply enqueue it as an `external_editor` follow-up the next turn
   *  reads (the surface chooses). */
  setPlan(body: string): Promise<void> | void
}

/** `/edit-message` port. The surface owns the pending composer text + commits
 *  it on the next `PromptSource.next()` cycle. */
export interface ComposerEditPort {
  /** Snapshot the pending composer buffer. Empty string ⇒ no pending text; the
   *  user's edit BECOMES the new pending text. */
  getPending(): Promise<string> | string
  /** Push the edited text back into the composer buffer. The surface decides
   *  whether to AUTO-submit (Claude Code does not — the user still hits Enter);
   *  we never auto-submit from the slash side. */
  setPending(body: string): Promise<void> | void
}
