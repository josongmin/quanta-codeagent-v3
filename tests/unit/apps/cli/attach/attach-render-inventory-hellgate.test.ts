import { describe, expect, test } from "bun:test"
import {
  ATTACH_IGNORED_SESSION_EVENT_TYPES,
  ATTACH_RENDERED_SESSION_EVENT_TYPES,
} from "@/apps/cli/attach/render"
import { SESSION_EVENT_TYPES } from "@/protocol/session"

/**
 * Attach renderer inventory hellgate.
 *
 * `renderSessionEvent` is the attach surface's `SessionEvent` consumer. This
 * guard forces the surface to classify EVERY canonical `SessionEventType` as
 * either:
 *   - explicitly rendered, or
 *   - explicitly ignored
 *
 * so a newly-added wire event cannot drift into the attach surface as an
 * accidental silent default branch.
 */
describe("attach render inventory hellgate", () => {
  test("rendered + ignored types partition SESSION_EVENT_TYPES exactly", () => {
    const canonical = [...SESSION_EVENT_TYPES].sort()
    const rendered = [...ATTACH_RENDERED_SESSION_EVENT_TYPES].sort()
    const ignored = [...ATTACH_IGNORED_SESSION_EVENT_TYPES].sort()
    const combined = [...new Set([...rendered, ...ignored])].sort()

    expect(combined).toEqual(canonical)
    const ignoredSet = new Set<string>(ignored)
    expect(rendered.filter((t) => ignoredSet.has(t))).toEqual([])
  })

  test("inventory teeth: removing one canonical rendered event changes the combined set", () => {
    const canonical = [...SESSION_EVENT_TYPES].sort()
    const withoutClosed = [
      ...ATTACH_RENDERED_SESSION_EVENT_TYPES.filter((t) => t !== "session.closed"),
      ...ATTACH_IGNORED_SESSION_EVENT_TYPES,
    ].sort()
    expect(withoutClosed).not.toEqual(canonical)
  })
})
