/**
 * PR-5 / ADR-0081 — Typed event stream for long-running shell execution.
 *
 * The canonical definitions now live in `@/shared/shell-exec-types` (a
 * cross-cutting telemetry contract — see RFC 3.1 slice isolation). This module
 * re-exports them so `@/tool`'s public API is UNCHANGED: existing consumers
 * (`import { ShellExecObserver } from "@/tool"`) keep working.
 */
export {};
