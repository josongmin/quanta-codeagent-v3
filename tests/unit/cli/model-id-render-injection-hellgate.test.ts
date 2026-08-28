/**
 * ★ HELLGATE — an UNTRUSTED model id cannot drive the terminal (aug-28).
 *
 * A model id is not operator-authored text. It arrives from:
 *   - `~/.quanta/sticky-model.json` — any local process, and the agent's OWN bash
 *     tool, can write that file; and
 *   - a provider `/models` response (`LLMPort.listModels`), i.e. a remote endpoint
 *     whose base URL is env-overridable.
 *
 * It is then rendered RAW into two places that write straight to the tty:
 *   1. the welcome banner's `model` row — the CLI's FIRST paint, no interaction;
 *   2. `/model`'s candidate rows.
 *
 * A measured PoC put `ESC[2J` + `ESC]0;PWNED BEL` + a newline in the sticky file
 * and got: the screen cleared, the terminal title changed, and a forged top-level
 * "Approve destructive action? [y/N]" line under the box — i.e. a fake approval
 * prompt in a coding agent. Two independent defenses now stand:
 *   - ADMISSION: the boot resolution drops an id that is not a plausible provider
 *     slug (so the banner/status line/picker header never see it), and the catalog
 *     wire applies the same predicate before minting a candidate;
 *   - THE SEAM: both renderers sanitize + fold newlines, so even an id that
 *     reached them by some other path cannot emit control sequences or forge rows.
 *
 * RED-on-injection: drop the `isPlausibleModelSlug` check in `sticky-model-boot`
 * ⇒ the banner cases fail; drop `sanitizeLogText`/`escapeBodyForLine` in
 * `formatModelLine` or `welcome-banner` ⇒ the seam cases fail.
 */

import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { resolveStickyModelBoot } from "@/apps/cli/repl/sticky-model-boot"
import { formatModelLine } from "@/apps/cli/slash/model-picker"
import { buildWelcomeInfo, renderWelcomeBanner } from "@/apps/cli/welcome-banner"
import { isPlausibleModelSlug } from "@/llm/model-catalog"

const ESC = String.fromCharCode(27)
const BEL = String.fromCharCode(7)
/** The PoC value: clear-screen CSI + OSC title + a newline that breaks out of the
 *  banner box to forge a prompt line. */
const HOSTILE = `${ESC}[2J${ESC}]0;PWNED${BEL}claude-evil\nApprove destructive action? [y/N]`

const dirs: string[] = []
const stickyFileWith = (picks: Record<string, string>): string => {
  const dir = mkdtempSync(join(tmpdir(), "model-inject-"))
  dirs.push(dir)
  const path = join(dir, "sticky-model.json")
  writeFileSync(path, JSON.stringify(picks), "utf8")
  return path
}
afterEach(() => {
  while (dirs.length > 0) {
    const d = dirs.pop()
    if (d !== undefined) rmSync(d, { recursive: true, force: true })
  }
})

const bannerFor = (effectiveModel: string): string =>
  renderWelcomeBanner(
    buildWelcomeInfo(
      {
        provider: "anthropic",
        model: "claude-sonnet-4-6",
        mode: "default",
        cwd: "/tmp",
        history: [],
        mcpClients: [],
        mcpTools: [],
        effortStore: { get: () => "default" },
      },
      undefined,
      undefined,
      effectiveModel,
    ),
  )

describe("untrusted model ids cannot drive the terminal", () => {
  test("the predicate itself: real slugs pass, hostile / oversized / traversal fail", () => {
    for (const ok of [
      "gpt-4o",
      "gpt-5.6-terra",
      "claude-haiku-4-5-20251001",
      "anthropic/claude-x",
      "us.anthropic.claude:1",
    ]) {
      expect(isPlausibleModelSlug(ok), ok).toBe(true)
    }
    for (const bad of [
      HOSTILE,
      "",
      " leading-space",
      "has space",
      "../../etc/passwd",
      `${ESC}[31mred`,
      "‮gnp",
      "a".repeat(200),
    ]) {
      expect(isPlausibleModelSlug(bad), JSON.stringify(bad.slice(0, 20))).toBe(false)
    }
  })

  test("ADMISSION — a hostile persisted id is dropped at boot, so the banner shows the boot model", () => {
    const path = stickyFileWith({ default: HOSTILE })
    const boot = resolveStickyModelBoot({ planMode: false, path })
    expect(boot.modelId).toBeUndefined()
    expect(boot.effectiveModel("claude-sonnet-4-6")).toBe("claude-sonnet-4-6")

    const banner = bannerFor(boot.effectiveModel("claude-sonnet-4-6"))
    expect(banner).not.toContain(`${ESC}[2J`)
    expect(banner).not.toContain("Approve destructive")
    expect(banner).toContain("claude-sonnet-4-6")
  })

  test("ADMISSION paired control — a PLAUSIBLE persisted id is still honored", () => {
    const path = stickyFileWith({ default: "claude-haiku-4-5-20251001" })
    const boot = resolveStickyModelBoot({ planMode: false, path })
    expect(boot.modelId).toBe("claude-haiku-4-5-20251001")
    expect(bannerFor(boot.effectiveModel("claude-sonnet-4-6"))).toContain(
      "claude-haiku-4-5-20251001",
    )
  })

  test("THE SEAM — the banner sanitizes even if a hostile value reaches it directly", () => {
    const banner = bannerFor(HOSTILE)
    expect(banner).not.toContain(ESC + "[")
    expect(banner).not.toContain(ESC + "]")
    expect(banner).not.toContain(BEL)
    // The box keeps its own line count: no forged row underneath it.
    expect(banner.split("\n").some((l) => l.trimStart().startsWith("Approve destructive"))).toBe(
      false,
    )
  })

  test("THE SEAM — a candidate row cannot emit control sequences or forge extra rows", () => {
    const row = formatModelLine({ id: HOSTILE }, false)
    expect(row).not.toContain(ESC)
    expect(row).not.toContain(BEL)
    // Exactly one newline: the row terminator itself.
    expect((row.match(/\n/g) ?? []).length).toBe(1)
  })

  test("THE SEAM paired control — an ordinary id renders byte-identically", () => {
    expect(formatModelLine({ id: "gpt-4o", contextWindow: 128_000 }, true)).toBe(
      ` * ${"gpt-4o".padEnd(20)}  128k ctx\n`,
    )
  })
})
