/** Surface-supplied OAuth callback receiver.
 *
 *  The OAuth authorize step redirects back with `?code=…&state=…` — *how*
 *  that redirect is received depends on the surface:
 *
 *    - **CLI**     bind a loopback HTTP listener on `127.0.0.1:<port>`,
 *                  redirect_uri = `http://localhost:<port>/auth/callback`.
 *    - **Tauri**   register a deep-link handler for `quanta://oauth/callback`
 *                  (or `app.deep_link()` event), redirect_uri = that custom
 *                  scheme — OS hands the URL back to the running app.
 *    - **Web**     the SPA route `/oauth/callback` is mounted in the same
 *                  origin the user started in; the page reads `code` + `state`
 *                  from `location.search` and posts it to the in-process
 *                  EventBus the login flow is subscribed to. redirect_uri =
 *                  the page's absolute URL.
 *
 *  Each surface implements this port and injects it into `runBrowserFlow`.
 *  When no provider is supplied, the loopback-HTTP CLI default kicks in so
 *  the existing terminal flow is byte-identical to its pre-port behavior.
 */

/** Outcome of a successful callback — the redeemable authorization code.
 *  `state` validation is performed inside the provider before resolving (the
 *  provider receives the expected state and must reject `state_mismatch`
 *  itself), so the caller only sees the code on the happy path. */
export interface OAuthCallbackResult {
  readonly code: string
}

export interface OAuthCallbackStartInput {
  /** The `state` value the authorize URL was built with. Provider MUST
   *  reject (do not resolve) if the inbound callback's state ≠ this value
   *  — that's the CSRF guard. */
  readonly expectedState: string
  /** Caller-supplied abort signal — fires on user Ctrl+C / surface
   *  cancellation. Provider MUST reject any in-flight `received` promise on
   *  abort. */
  readonly signal?: AbortSignal
}

export interface OAuthCallbackHandle {
  /** The exact `redirect_uri` to use in the OAuth authorize URL — must be
   *  byte-identical to the value the provider will see at callback time
   *  (OAuth servers reject mismatched redirect_uri). For loopback this is
   *  `http://localhost:<bound-port>/auth/callback`; for deep-links it's the
   *  custom scheme; for web it's the absolute URL of the callback route. */
  readonly redirectUri: string
  /** Resolves with the code (after state validation) on a valid callback;
   *  rejects on timeout / user-cancel / state-mismatch / oauth error param /
   *  malformed callback. Resolution and rejection are one-shot — provider
   *  ignores any subsequent callbacks on the same handle. */
  readonly received: Promise<OAuthCallbackResult>
  /** Idempotent resource release. Unsettled `received` rejects; the loopback
   *  listener (or equivalent) is dropped so the same port can rebind. Safe
   *  after success, timeout, abort, or opener failure. */
  close(): void
}

export interface OAuthCallbackProvider {
  /** Begin listening for the OAuth callback. Returns the redirect_uri the
   *  authorize URL should embed, plus a promise that settles with the code
   *  (or a typed error). The caller owns `close()` from the moment `start`
   *  resolves — including opener failure — and MUST call it. Settling
   *  `received` also releases resources; `close` stays idempotent. */
  start(input: OAuthCallbackStartInput): Promise<OAuthCallbackHandle>
}
