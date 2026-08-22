/**
 * `@/codemode/exec-main` — generates the `main()` wrapper around the model's
 * program (RFC §4.1, mirroring Codex `code_mode_exit__exec_main.mjs`).
 *
 * The model authors a program BODY that may `await tools.X(...)` and `return` a
 * value. We wrap it in an async `__main__()` so a top-level `return` is legal
 * and a top-level `await` is legal, then evaluate the wrapper as an EXPRESSION
 * that yields the promise. The runtime resolves that promise and `dump`s the
 * fulfilled value.
 *
 * PURE string generation — no QuickJS, no I/O. The `tools` / `console` globals
 * are installed by the runtime BEFORE this code runs; this wrapper only
 * references them.
 */

/** Wrap the model's program in an async `__main__` and immediately invoke it,
 *  yielding the promise as the evaluated expression. The trailing
 *  `__main__()` (no semicolon issues — it is the final expression) is what
 *  `evalCode` returns a handle to (the native-promise the host drives).
 *
 *  The body is injected verbatim inside the function. A syntax error in the
 *  body surfaces as a parse error at `evalCode` time (before any dispatch — RFC
 *  §4.5), exactly the desired "no partial side effects from an unparseable cell"
 *  behavior. */
export const wrapExecMain = (body: string): string => `(async function __main__() {\n${body}\n})()`
