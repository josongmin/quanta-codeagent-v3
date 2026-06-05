/**
 * G1 — appshot verify-loop port (RFC jun-6-appgen-appshot §4.2, Phase 1).
 *
 * The CLOSED seam the verify loop drives. quanta already owns both ends of a
 * generation→verification cycle in SEPARATE slices that have never been joined:
 *   - a GENERATION axis (`image_gen`, Office authoring, the artifact store), and
 *   - a render+observe half (`browser_navigate` + `browser_screenshot` over CDP).
 * appshot binds them into a CLOSED feedback loop: spec → scaffold → render →
 * screenshot → LLM-judge → iterate (bounded) until the rendering matches the
 * spec.
 *
 * Slice posture (RFC §3.1, §4.2): this file imports NOTHING (no `@/browser`, no
 * `@/agent`, no `@/llm`). The port is a pure interface — the composition root
 * wires `render`/`screenshot` to the real `BrowserPort`, `verify` to an
 * LLM-judge, `scaffold` to the jailed writer; hellgate injects a `FakeAppshotPort`
 * (scripted renders + deterministic verdicts) so the loop runs with NO Chrome,
 * NO network, CI-safe.
 *
 * Contract: NO-THROW is NOT promised by the port itself (a real CDP/LLM adapter
 * MAY throw — Chrome launch fragility, transport drop); the LOOP catches every
 * effect at its boundary and maps a throw to a typed, non-throwing loop outcome
 * (see `./loop.ts`). Every effect honors the injected `AbortSignal`.
 */

/** A natural-language app spec plus the accumulated verify feedback. The loop
 *  threads the previous verdict's `notes` back in as `feedback` on the next
 *  iteration (the "edit" arrow of the cycle) so `scaffold` can refine. */
export interface AppSpec {
  /** The user's natural-language description of the app to build. */
  readonly prompt: string
  /** Verify feedback from prior iterations, oldest→newest. Empty on iter 0. The
   *  scaffold adapter folds these into the next render attempt. */
  readonly feedback: readonly string[]
}

/** Result of one `scaffold` call — the entry URL the loop navigates to (a
 *  `file://…/index.html` or a local server URL) plus the jailed on-disk path of
 *  the written entry file (for artifact registration). */
export interface ScaffoldResult {
  /** URL the loop hands to `render` (e.g. `file:///…/index.html`). */
  readonly entryUrl: string
  /** Jailed absolute on-disk path of the scaffolded entry file — the loop
   *  registers THIS into the artifact store. */
  readonly entryPath: string
  /** IANA media type of the entry artifact (e.g. `text/html`). */
  readonly mediaType: string
}

/** A verify verdict — does the rendered screenshot satisfy the spec? `pass`
 *  ends the loop early; `notes` is fed back as the next iteration's feedback. */
export interface VerifyVerdict {
  readonly pass: boolean
  /** Model-visible critique text. Threaded back as scaffold feedback when
   *  `pass` is false; surfaced to the user as the final verdict when the loop
   *  ends (pass OR cap). */
  readonly notes: string
}

/**
 * The closed appshot port. Each method is ONE arrow of the verify cycle. A real
 * adapter MAY throw; the loop boundary catches it. Methods honor the signal.
 */
export interface AppshotPort {
  /** Write an app scaffold for `spec` into `outDir` (jailed). Returns the entry
   *  URL + on-disk path. A path-escape in the spec MUST be rejected by the
   *  adapter (it writes through the FS-jail chokepoint). */
  scaffold(spec: AppSpec, outDir: string, signal?: AbortSignal): Promise<ScaffoldResult>
  /** Navigate the (injected) browser to `url`. */
  render(url: string, signal?: AbortSignal): Promise<void>
  /** Capture a PNG of the current render. The loop enforces a byte cap on the
   *  returned bytes (reusing the `browser_screenshot` `MAX_SCREENSHOT_BYTES`
   *  invariant) — an oversize shot is refused, not judged. */
  screenshot(signal?: AbortSignal): Promise<Uint8Array>
  /** LLM-judge: does `shot` satisfy `spec`? Returns a typed verdict. */
  verify(shot: Uint8Array, spec: AppSpec, signal?: AbortSignal): Promise<VerifyVerdict>
}

/** Duck-typed mirror of `@/artifact`'s `ArtifactRegistry.register` — the ONLY
 *  method the loop needs. Keeps the appshot slice fence-clean (`@/tool` may not
 *  import `@/artifact`); the composition root passes the real registry, which
 *  matches structurally. Optional — absent ⇒ the loop skips registration and is
 *  byte-identical. */
export interface AppshotArtifactSink {
  register(spec: {
    readonly kind: "other"
    readonly path: string
    readonly mediaType: string
    readonly label?: string
  }): { readonly id: string }
}
