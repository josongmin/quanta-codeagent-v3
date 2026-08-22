/**
 * Browser tool — BrowserError → ToolResult mapping + output guard (ADR-0427).
 *
 * Translates the slice's closed `BrowserError` union into typed
 * {@link ToolResult.failure} modes (no `output` regex needed downstream), and
 * routes page-derived text through `escapeReminderBoundary` (strengthen #3) so a
 * malicious page cannot forge a `<system-reminder>` boundary in tool output.
 *
 * `escapeBoundary` is imported from the base utility slice `@/shared` (the
 * primitive is a zero-dependency pure string escaper — it lives in `@/shared`
 * so both `@/agent` and `@/tool` can consume it without `@/tool` crossing the
 * slice-boundary fence into `@/agent`).
 */

import type { BrowserError } from "@/browser"
import { escapeBoundary } from "@/shared"
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
      // `method` is model-supplied; defang any forged boundary (R3 audit [8]).
      return {
        ok: false,
        output: `cdp method denied by allowlist: ${guardPageText(e.method)}`,
        failure: { mode: "permission_denied" },
      }
    case "cdp-error":
      // `detail` is a CDP/page-derived error string — route it through the guard
      // so a page cannot forge a <system-reminder> boundary in the error (R3 [8]).
      return {
        ok: false,
        output: `browser protocol error: ${guardPageText(e.detail)}`,
        failure: { mode: "error", modelVisibleError: guardPageText(e.detail) },
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
    case "tab-not-found":
      // `id` is model-supplied; defang. Echo the open tab ids so the model
      // self-corrects in one turn (TICKET-24 Wave B).
      return {
        ok: false,
        output: `no such tab "${guardPageText(e.id)}" — open tabs: ${e.open.map((t) => guardPageText(t)).join(", ") || "(none)"}`,
        failure: { mode: "not_found" },
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
