/** `src/ui` slice — surface-agnostic UI helpers.
 *
 *  Pure string / ANSI / box-drawing utilities that any surface (CLI,
 *  REPL, embedded browser, Tauri renderer) can compose. No I/O is
 *  performed by this slice; callers own writing the rendered string
 *  to their own sink. Depends on `@/shared` only — see RFC 3.1 slice
 *  isolation. */
export * from "./auth-ui";
