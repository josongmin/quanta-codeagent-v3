/** Backwards-compatibility re-export shim.
 *
 *  The canonical home for these helpers is now `@/ui/auth-ui` — a
 *  surface-agnostic slice that can be consumed by REPL / Tauri / CLI
 *  alike. This shim keeps the original import path working byte-
 *  identical for any external code that still references it.
 *
 *  New consumers should import from `@/ui/auth-ui` directly. */
export * from "@/ui/auth-ui";
