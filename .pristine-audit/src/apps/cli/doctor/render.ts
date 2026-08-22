/**
 * `/doctor` report renderer (RFC jun-6-doctor-selfcheck §4.4).
 *
 * Reuses the rounded-box vocabulary (`renderBox`/`green`/`yellow`/`red`/`dim`)
 * so the report looks native to `/status`. One line per check, a trailing
 * pass/warn/fail summary. `--json` mode (see `renderDoctorJson`) emits the
 * raw `CheckResult[]` with NO ANSI color (machine-readable for CI / bug
 * reports).
 */

import { cyan, dim, green, red, renderBox, yellow } from "@/ui/ui-helpers"
import type { CheckResult, CheckStatus } from "./types"

const GLYPH: Record<CheckStatus, string> = {
  ok: "✓",
  warn: "●",
  fail: "✗",
}

const COLOR: Record<CheckStatus, (s: string) => string> = {
  ok: green,
  warn: yellow,
  fail: red,
}

const ID_WIDTH = 9

const padId = (id: string): string => id + " ".repeat(Math.max(0, ID_WIDTH - id.length))

const renderLine = (r: CheckResult): string[] => {
  const color = COLOR[r.status]
  const head = `${color(GLYPH[r.status])} ${padId(r.id)} ${r.detail}`
  const out = [head]
  if (r.remedy !== undefined && (r.status === "fail" || r.status === "warn")) {
    out.push(`  ${dim("→")} ${dim(r.remedy)}`)
  }
  return out
}

/** Render the human-readable rounded-box report. */
export const renderDoctorReport = (results: readonly CheckResult[]): string => {
  const failCount = results.filter((r) => r.status === "fail").length
  const warnCount = results.filter((r) => r.status === "warn").length
  const okCount = results.filter((r) => r.status === "ok").length

  const body: string[] = []
  for (const r of results) {
    body.push(...renderLine(r))
  }
  body.push("")
  const summary =
    failCount > 0
      ? red(`${failCount} fail`)
      : warnCount > 0
        ? yellow(`${warnCount} warn`)
        : green("all healthy")
  body.push(
    `${green(`${okCount} ok`)} ${dim("·")} ${yellow(`${warnCount} warn`)} ${dim("·")} ${red(`${failCount} fail`)} ${dim("—")} ${summary}`,
  )

  return renderBox(body, { title: "quanta doctor", titleStyle: cyan })
}

/** Render machine-readable JSON — the same redacted `CheckResult[]`, no ANSI. */
export const renderDoctorJson = (results: readonly CheckResult[]): string =>
  JSON.stringify(
    {
      checks: results.map((r) => ({
        id: r.id,
        status: r.status,
        detail: r.detail,
        ...(r.remedy !== undefined ? { remedy: r.remedy } : {}),
      })),
      summary: {
        ok: results.filter((r) => r.status === "ok").length,
        warn: results.filter((r) => r.status === "warn").length,
        fail: results.filter((r) => r.status === "fail").length,
      },
    },
    null,
    2,
  )
