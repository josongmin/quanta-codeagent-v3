/**
 * Browser tool — BrowserError → ToolResult mapping + output guard (ADR-0427).
 *
 * Translates the slice's closed `BrowserError` union into typed
 * {@link ToolResult.failure} modes (no `output` regex needed downstream), and
 * routes page-derived text through `escapeReminderBoundary` (strengthen #3) so a
 * malicious page cannot forge a `<system-reminder>` boundary in tool output.
 *
 * `escapeBoundary` is imported from the leaf `@/agent/untrusted` (zero imports →
 * no cross-plane cycle).
 */

import { escapeBoundary } from "@/agent/untrusted"
import type { BrowserError } from "@/browser"
import type { ToolResult } from "@/tool"

/** Neutralize any `<system-reminder>` boundary tokens in page-derived text. */
export const guardPageText = (text: string): string => escapeBoundary("system-reminder", text)

export const mapBrowserError = (e: BrowserError): ToolResult => {
  switch (e.kind) {
    case "backend-missing":
      return {
        ok: false,
        output: "browser backend unavailable: no chrome/chromium binary found on PATH",
        failure: { mode: "spawn_error", error: "backend-missing" },
      }
    case "spawn-failed":
      return {
        ok: false,
        output: `browser failed to start: ${e.detail}`,
        failure: { mode: "spawn_error", error: e.detail },
      }
    case "navigation-denied":
      return {
        ok: false,
        output: `navigation denied: ${e.reason}`,
        failure: { mode: "permission_denied" },
      }
    case "element-not-found":
      return {
        ok: false,
        output: `element not found for ref "${e.ref}" — take a fresh browser_snapshot`,
        failure: { mode: "not_found" },
      }
    case "cdp-method-denied":
      return {
        ok: false,
        output: `cdp method denied by allowlist: ${e.method}`,
        failure: { mode: "permission_denied" },
      }
    case "cdp-error":
      return {
        ok: false,
        output: `browser protocol error: ${e.detail}`,
        failure: { mode: "error", modelVisibleError: e.detail },
      }
    case "timeout":
      return {
        ok: false,
        output: `browser action timed out after ${e.ms}ms`,
        failure: { mode: "timeout", timeoutMs: e.ms },
      }
    case "cancelled":
      return {
        ok: false,
        output: "browser action cancelled",
        failure: { mode: "error", modelVisibleError: "cancelled" },
      }
    case "closed":
      return {
        ok: false,
        output: "browser session is closed",
        failure: { mode: "error", modelVisibleError: "closed" },
      }
    default: {
      const _exhaustive: never = e
      return {
        ok: false,
        output: "unknown browser error",
        failure: { mode: "error", modelVisibleError: String(_exhaustive) },
      }
    }
  }
}
