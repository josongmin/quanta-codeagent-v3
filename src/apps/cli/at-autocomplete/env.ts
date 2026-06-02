/**
 * RFC-12 / ADR-0436 §5.3 — Feature gate.
 *
 * Default-OFF: the `@`-autocomplete provider is only constructed + injected
 * when `QUANTA_AT_AUTOCOMPLETE=1`. Absent / any other value ⇒ no provider ⇒
 * `readLine` byte-identical (RFC §4.8 — `@` stays an ordinary input char).
 */

/** `true` iff the `@`-mention autocomplete feature is enabled. */
export const atAutocompleteEnabled = (env: NodeJS.ProcessEnv = process.env): boolean =>
  env.QUANTA_AT_AUTOCOMPLETE === "1"
