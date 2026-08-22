/**
 * PMX-06 — THE VERIFICATION RAILS a campaign must be green on before live spend.
 *
 * The ticket lists a `bun test` selection and then says the thing that makes it
 * a rail rather than a suggestion:
 *
 *   *"Use actual paths after implementation; no command may pass over an empty
 *   test selection. Add anti-vacuum count assertions where directory selection
 *   is used."*
 *
 * That rule paid for itself the moment it was written down. The draft selection
 * named `src/apps/bench/promax` — a directory with production code and ZERO
 * `.test.ts` files. `bun test` over it exits 0 having run nothing, so the rail
 * would have been GREEN while proving nothing at all. The ProMax suite actually
 * lives under `tests/unit/apps/bench/promax`, which is what this file declares.
 *
 * Each rail therefore carries three things a bare command string cannot:
 *  - `minTestFiles` — the count floor, so a moved suite is loud;
 *  - `mustInclude`  — the KNOWN-ITEM floor, so a rail that still resolves to
 *    *something* cannot quietly stop covering the thing it was written for;
 *  - `why`          — what this rail is protecting, for the operator reading a
 *    refusal at 3am.
 *
 * The resolver reads the filesystem; the judgement
 * ({@link assertRailSelectionsNonEmpty}) is pure and throws. Nothing here RUNS
 * a command — a rail that shelled out to `bun test` would recurse, and running
 * the suite is the operator's job, not the declaration's.
 */
import { readdirSync, statSync } from "node:fs"
import { join, relative, sep } from "node:path"
import { errMessage, logger } from "@/shared"

export type ProMaxRailKind = "typecheck" | "lint" | "test"

export interface ProMaxVerificationRail {
  /** The exact command an operator runs. */
  readonly command: string
  readonly kind: ProMaxRailKind
  /** Repo-relative files/directories the command selects. */
  readonly selection: readonly string[]
  /** Anti-vacuum count floor over the RESOLVED `.test.ts` files. */
  readonly minTestFiles: number
  /** Known-item floor: files this rail exists to cover. */
  readonly mustInclude: readonly string[]
  readonly why: string
}

/**
 * The rails, with the paths that exist AFTER this implementation. Ordered
 * cheapest-first: an operator running them top to bottom learns the most in the
 * least time.
 */
export const PROMAX_VERIFICATION_RAILS: readonly ProMaxVerificationRail[] = [
  {
    command: "bun run typecheck",
    kind: "typecheck",
    selection: ["src"],
    minTestFiles: 0,
    mustInclude: [],
    why: "production types — the compile-time half of every closed union in this packet",
  },
  {
    command: "bun run typecheck:tests",
    kind: "typecheck",
    selection: ["tests"],
    minTestFiles: 0,
    mustInclude: [],
    why: "`bun test` does NOT typecheck test files; a narrowing error runs green there and only this catches it",
  },
  {
    command: "bun run lint",
    kind: "lint",
    selection: ["src"],
    minTestFiles: 0,
    mustInclude: [],
    why: "biome over the tree",
  },
  {
    command: "bun test tests/unit/apps/bench/promax",
    kind: "test",
    selection: ["tests/unit/apps/bench/promax"],
    minTestFiles: 30,
    mustInclude: [
      "tests/unit/apps/bench/promax/promax-campaign-gates.test.ts",
      // The gate TEETH, driven through the operator command over artefact bytes.
      // Pinned by name because the directory selection alone would stay green if
      // this file were deleted, and it is the only rail proving the staged gates
      // refuse the runs an adversarial audit showed they used to admit.
      "tests/unit/apps/bench/promax/promax-campaign-gate-teeth.test.ts",
      "tests/unit/apps/bench/promax/promax-campaign-record.test.ts",
      "tests/unit/apps/bench/promax/promax-campaign-fail-closed.test.ts",
      "tests/unit/apps/bench/promax/promax-source-owner-audit.test.ts",
      "tests/unit/apps/bench/promax/promax-verification-rails.test.ts",
      "tests/unit/apps/bench/promax/promax-gold-sentinel.test.ts",
      "tests/unit/apps/bench/promax/promax-image-provenance-gates.test.ts",
    ],
    why: "the whole ProMax packet: provenance, corpus, evaluator, image freeze, and PMX-06's gates. NOTE: `src/apps/bench/promax` holds no tests — selecting it would run nothing",
  },
  {
    command: "bun test src/apps/bench/profiles src/apps/bench/dataset-family.test.ts",
    kind: "test",
    selection: ["src/apps/bench/profiles", "src/apps/bench/dataset-family.test.ts"],
    minTestFiles: 3,
    mustInclude: [
      "src/apps/bench/profiles/family-four-stop-rule.test.ts",
      "src/apps/bench/profiles/registry.test.ts",
      "src/apps/bench/dataset-family.test.ts",
    ],
    why: "one family registry: the four-family stop rule and the family selector",
  },
  {
    command: "bun test src/apps/bench/benchmark-suite.test.ts src/apps/bench/run-config.test.ts",
    kind: "test",
    selection: ["src/apps/bench/benchmark-suite.test.ts", "src/apps/bench/run-config.test.ts"],
    minTestFiles: 2,
    mustInclude: ["src/apps/bench/benchmark-suite.test.ts", "src/apps/bench/run-config.test.ts"],
    why: "one suite dispatcher and one typed config resolver",
  },
  {
    command: "bun test src/apps/bench/remote/box-session",
    kind: "test",
    selection: ["src/apps/bench/remote/box-session"],
    minTestFiles: 5,
    mustInclude: ["src/apps/bench/remote/box-session/keep-orphan-leak.test.ts"],
    why: "remote transport, and the terminator contract that keeps a failed launch from leaking boxes",
  },
  {
    command:
      "bun test src/runner/batch/report-r4.test.ts tests/unit/apps/bench/batch-report-schema-parity.test.ts",
    kind: "test",
    selection: [
      "src/runner/batch/report-r4.test.ts",
      "tests/unit/apps/bench/batch-report-schema-parity.test.ts",
    ],
    minTestFiles: 2,
    mustInclude: [
      "src/runner/batch/report-r4.test.ts",
      "tests/unit/apps/bench/batch-report-schema-parity.test.ts",
    ],
    why: "one canonical report writer and its persisted schema",
  },
  {
    command:
      "bun test tools/leaderboard-dashboard/projectors tools/leaderboard-dashboard/server.test.ts",
    kind: "test",
    selection: [
      "tools/leaderboard-dashboard/projectors",
      "tools/leaderboard-dashboard/server.test.ts",
    ],
    minTestFiles: 4,
    mustInclude: [
      "tools/leaderboard-dashboard/projectors/structural.test.ts",
      "tools/leaderboard-dashboard/projectors/registry.test.ts",
      "tools/leaderboard-dashboard/server.test.ts",
    ],
    why: "one SWE projector registration and no second denominator in the dashboard",
  },
  {
    command:
      "bun test tests/unit/god-code-ratchet.test.ts tests/unit/dataset-family-profile-ssot.test.ts",
    kind: "test",
    selection: [
      "tests/unit/god-code-ratchet.test.ts",
      "tests/unit/dataset-family-profile-ssot.test.ts",
    ],
    minTestFiles: 2,
    mustInclude: [
      "tests/unit/god-code-ratchet.test.ts",
      "tests/unit/dataset-family-profile-ssot.test.ts",
    ],
    why: "the structural ratchets: no god module, and no scattered family branch",
  },
]

export interface ProMaxRailResolution {
  readonly rail: ProMaxVerificationRail
  /** Repo-relative `.test.ts` files the selection actually reaches, sorted. */
  readonly resolvedTestFiles: readonly string[]
}

const collectTestFiles = (repoRoot: string, target: string, out: string[]): void => {
  const abs = join(repoRoot, target)
  let stats: ReturnType<typeof statSync>
  try {
    stats = statSync(abs)
  } catch (e) {
    // Skipping the target stays the behavior, but a rail exists to say "this
    // selection still reaches the suite it was written for". A stat fault here
    // SHRINKS `resolvedTestFiles` silently — the same shape as the empty-selection
    // trap this module was written to close — so the drop is attributed.
    logger.warn(`promax-rails.collectTestFiles: skipped ${target}: ${errMessage(e)}`)
    return
  }
  if (!stats.isDirectory()) {
    if (target.endsWith(".test.ts")) out.push(target)
    return
  }
  for (const entry of readdirSync(abs)) {
    if (entry === "node_modules" || entry.startsWith(".")) continue
    collectTestFiles(repoRoot, `${target}/${entry}`, out)
  }
}

/** Resolve every rail's selection against the tree. */
export const resolveProMaxVerificationRails = (
  repoRoot: string,
  rails: readonly ProMaxVerificationRail[] = PROMAX_VERIFICATION_RAILS,
): readonly ProMaxRailResolution[] =>
  rails.map((rail) => {
    const files: string[] = []
    for (const target of rail.selection) collectTestFiles(repoRoot, target, files)
    return {
      rail,
      resolvedTestFiles: [...new Set(files.map((f) => f.split(sep).join("/")))].sort(),
    }
  })

/**
 * THE anti-vacuum judgement. A test rail that resolves to nothing, falls under
 * its count floor, or has lost a known item is a REFUSAL — because all three
 * look exactly like success on the command line.
 */
export const assertRailSelectionsNonEmpty = (
  resolutions: readonly ProMaxRailResolution[],
): void => {
  const problems: string[] = []
  for (const { rail, resolvedTestFiles } of resolutions) {
    if (rail.kind !== "test") continue
    if (resolvedTestFiles.length === 0) {
      problems.push(
        `\`${rail.command}\` resolves to an EMPTY test selection (${rail.selection.join(", ")}) — ` +
          "the command would exit 0 having run nothing",
      )
      continue
    }
    if (resolvedTestFiles.length < rail.minTestFiles) {
      problems.push(
        `\`${rail.command}\` resolves to ${resolvedTestFiles.length} test file(s), below its floor of ` +
          `${rail.minTestFiles} — the suite it protects has moved or shrunk`,
      )
    }
    for (const known of rail.mustInclude) {
      if (resolvedTestFiles.includes(known)) continue
      problems.push(
        `\`${rail.command}\` no longer covers ${known}, which it exists to protect (${rail.why})`,
      )
    }
  }
  if (problems.length === 0) return
  throw new Error(
    `bench: the ProMax verification rails are not runnable as declared — ${problems.join(" | ")}. ` +
      "REFUSING to treat a vacuous rail as evidence.",
  )
}

/** Repo-relative path of a rail target, for messages. */
export const railRelative = (repoRoot: string, absolute: string): string =>
  relative(repoRoot, absolute).split(sep).join("/")
