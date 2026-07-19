/**
 * PURITY-RATCHET CONTROL fixture (ticket 02 S5) — boots the REAL CLI entry
 * after deliberately polluting stdout with a non-envelope line. The e2e's
 * stdout-purity checker MUST flag this run; if it stays green here the checker
 * is vacuous. Never imported by production code.
 */
process.stdout.write("SERVE_STDIO_POLLUTION this line is not a session.v1 frame\n")

// Boot the actual entry (it runs `main()` at module scope).
await import("../../../../src/apps/cli/index.ts")
