/**
 * TB21-05 — the OFFICIAL Terminal-Bench 2.1 competitor importer.
 *
 * This replaces `rawdata/tb-pertask.md` (a parsed TB **2.0** HuggingFace matrix)
 * with a pinned, offline refresh over the upstream repo's own
 * `leaderboard/submissions/*.json`.
 *
 * The rails below bind the REAL checked-in submission — TB21-04 vendored
 * `2026-07-10-gpt-5-6-luna-max-codex.json` verbatim — rather than a hand-written
 * approximation of it, so a normaliser that quietly renamed a field cannot pass.
 *
 * Three properties carry the security weight and each is proven by OBSERVED
 * behaviour, not by reading the source:
 *   1. an immutable upstream ref is REQUIRED (a `main`/`latest` snapshot is not a
 *      comparison, it is a moving target);
 *   2. every external URL is scheme-checked at IMPORT time — `esc()` at the HTML
 *      boundary does NOT neutralise `javascript:` inside an `href`;
 *   3. the refresh is offline and side-effect free: no network, no Harbor, and no
 *      Quanta run report.
 */
import { describe, expect, test } from "bun:test"
import { readFileSync } from "node:fs"
import { join } from "node:path"
import {
  assertImmutableUpstreamRef,
  buildOfficialComparison,
  decodeOfficialComparison,
  MUTABLE_REF_TOKENS,
  normalizeOfficialSubmission,
  OFFICIAL_COMPARISON_SCHEMA_VERSION,
  type OfficialImportPorts,
  runOfficialImport,
  UPSTREAM_REPO,
} from "./terminal-bench-official"

const REPO = join(import.meta.dir, "..", "..", "..")

/** The pinned upstream commit (TB21-04's authority, `dataset.ts` header). */
const PINNED_REF = "7131e4375048a0e408a8fb404b5f499d726b695b"
const PINNED_DATASET_REF = "sha256:7d7bdc1cbedad549fc1140404bd4dc45e5fd0ea7c4186773687d177ad3a0699a"

const FIXTURE_NAME = "2026-07-10-gpt-5-6-luna-max-codex.json"
const FIXTURE_PATH = join(
  REPO,
  "tests",
  "unit",
  "apps",
  "bench",
  "terminal",
  "fixtures",
  `official-submission-${FIXTURE_NAME}`,
)

const fixture = (): Record<string, unknown> =>
  JSON.parse(readFileSync(FIXTURE_PATH, "utf8")) as Record<string, unknown>

const HOSTILE = `</style><script>alert(1)</script>`

const normalized = (raw: Record<string, unknown> = fixture()) =>
  normalizeOfficialSubmission(raw, { sourceFile: FIXTURE_NAME, upstreamRef: PINNED_REF })

// ---------------------------------------------------------------------------
// The upstream ref must be IMMUTABLE.
// ---------------------------------------------------------------------------

describe("TB21-05 importer — an immutable upstream ref is required", () => {
  test("the pinned 40-hex commit is accepted and returned verbatim", () => {
    expect(assertImmutableUpstreamRef(PINNED_REF)).toBe(PINNED_REF)
  })

  test("every mutable ref token is refused, with the MOVING-ref diagnostic", () => {
    // Non-vacuity: the union must actually contain the branch names people reach
    // for, so an empty/renamed table cannot make this loop assert nothing.
    expect([...MUTABLE_REF_TOKENS].sort()).toEqual(["head", "latest", "main", "master"])
    for (const token of MUTABLE_REF_TOKENS) {
      // The DISTINCT message is what this table owns (the 40-hex gate below would
      // refuse a branch name anyway); asserting only "it throws" would let the
      // table be deleted with every test still green — verified by injection.
      expect(() => assertImmutableUpstreamRef(token)).toThrow(/MOVING ref/)
      expect(() => assertImmutableUpstreamRef(token.toUpperCase())).toThrow(/MOVING ref/)
    }
    // ...and a ref that is merely malformed gets the OTHER diagnostic, so the two
    // branches are distinguishable rather than one message wearing two hats.
    expect(() => assertImmutableUpstreamRef("v2.1.0")).toThrow(/not an immutable 40-hex/)
    expect(() => assertImmutableUpstreamRef("v2.1.0")).not.toThrow(/MOVING ref/)
  })

  test("a short sha / tag / empty ref is refused (never padded, never guessed)", () => {
    for (const bad of ["7131e43", "v2.1.0", "", "   ", `${PINNED_REF}0`, "zzzz"]) {
      expect(() => assertImmutableUpstreamRef(bad)).toThrow()
    }
  })
})

// ---------------------------------------------------------------------------
// The REAL checked-in submission renders its checked-in numbers.
// ---------------------------------------------------------------------------

describe("TB21-05 importer — the pinned submission fixture normalises losslessly", () => {
  test("agent + model + effort come from the submission's own metadata", () => {
    const row = normalized()
    expect(row.agentLabel).toBe("Codex")
    expect(row.agentOrgLabel).toBe("OpenAI")
    expect(row.agentVersion).toBe("0.144.0")
    expect(row.modelLabel).toBe("GPT-5.6 Luna")
    expect(row.modelName).toBe("gpt-5.6-luna")
    expect(row.reasoningEffort).toBe("max")
    expect(row.date).toBe("2026-07-10")
    expect(row.displayDate).toBe("Jul 10, 2026")
  })

  test("accuracy ± SE, pass@2..5, trials, cost and duration are the CHECKED-IN values", () => {
    const row = normalized()
    expect(row.accuracy).toBe(71.24)
    expect(row.accuracyStderr).toBe(1.39)
    expect(row.displayAccuracy).toBe("**71.2%** ± 1.4%")
    expect(row.nTrials).toBe(445)
    expect(row.passAtK).toEqual({ 2: 0.7989, 3: 0.8416, 4: 0.8697, 5: 0.8876 })
    expect(row.totalCostUsd).toBe(218.28)
    expect(row.displayTotalCostUsd).toBe("$218.28")
    expect(row.avgTrialDurationSec).toBe(422)
    expect(row.uncachedInputTokens).toBe(40109860)
    expect(row.cachedInputTokens).toBe(1210200406)
    expect(row.outputTokens).toBe(9525636)
  })

  test("the reward-hack / disqualification metric carries its SOURCE LINK", () => {
    const row = normalized()
    expect(row.rewardHacks).toBe(7.42)
    expect(row.displayRewardHacks).toBe("-7.4%")
    expect(row.rewardHacksUrl).toBe(
      "https://github.com/harbor-framework/terminal-bench-2-1/pull/105#issuecomment-4942210978",
    )
    // The submission's own PR link, and the count of judge-disqualified trials.
    expect(row.submissionUrl).toBe(
      "https://github.com/harbor-framework/terminal-bench-2-1/pull/105",
    )
    expect(row.disqualifiedTrials).toBe(33)
  })

  test("PAIRED CONTROL: moving a fixture number moves the row (not frozen literals)", () => {
    const raw = fixture()
    const metrics = raw.metrics as Record<string, unknown>
    const row = normalized({ ...raw, metrics: { ...metrics, accuracy: 12.5, pass_at_3: 0.5 } })
    expect(row.accuracy).toBe(12.5)
    expect(row.passAtK[3]).toBe(0.5)
    // ...and everything untouched still reads the fixture.
    expect(row.nTrials).toBe(445)
  })

  test("a MISSING required metric is refused — never defaulted to 0", () => {
    const raw = fixture()
    const metrics = { ...(raw.metrics as Record<string, unknown>) }
    delete metrics.accuracy
    expect(() => normalized({ ...raw, metrics })).toThrow(/accuracy/)
    const noPass = { ...(raw.metrics as Record<string, unknown>) }
    delete noPass.pass_at_4
    expect(() => normalized({ ...raw, metrics: noPass })).toThrow(/pass_at_4/)
  })
})

// ---------------------------------------------------------------------------
// External data is hostile until validated.
// ---------------------------------------------------------------------------

describe("TB21-05 importer — external fields are validated before they are stored", () => {
  test("hostile markup survives as TEXT (the HTML boundary escapes it, not the store)", () => {
    const raw = fixture()
    const metadata = raw.metadata as Record<string, unknown>
    const row = normalized({
      ...raw,
      metadata: { ...metadata, agent_display: { label: HOSTILE, url: "https://openai.com/" } },
    })
    // Stored once, un-escaped: double-escaping would render `&amp;lt;script&amp;gt;`
    // in the page. The dashboard's `esc` is the ONE escaping boundary.
    expect(row.agentLabel).toBe(HOSTILE)
    expect(row.agentLabel).not.toContain("&lt;")
  })

  test("control characters are stripped and text is length-capped", () => {
    const raw = fixture()
    const metadata = raw.metadata as Record<string, unknown>
    const row = normalized({
      ...raw,
      metadata: {
        ...metadata,
        agent_display: { label: "Co\u0007d\u0000ex", url: "https://openai.com/" },
        model_display: { label: "M".repeat(5000), url: "https://openai.com/" },
      },
    })
    expect(row.agentLabel).toBe("Codex")
    expect(row.modelLabel.length).toBeLessThanOrEqual(200)
    expect(row.modelLabel.startsWith("MMMM")).toBe(true)
  })

  test("a javascript:/data: URL is REFUSED — esc() would not neutralise it in an href", () => {
    const raw = fixture()
    const metadata = raw.metadata as Record<string, unknown>
    for (const hostile of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      "data:text/html,<script>alert(1)</script>",
      "vbscript:msgbox(1)",
      "  javascript:alert(1)",
      "file:///etc/passwd",
    ]) {
      const row = normalized({
        ...raw,
        metadata: { ...metadata, pr_url: { url: hostile, label: "#105" } },
      })
      // Fails CLOSED: no link at all rather than a live hostile one.
      expect(row.submissionUrl).toBe("")
    }
    // PAIRED CONTROL: a real https URL survives.
    const ok = normalized({
      ...raw,
      metadata: { ...metadata, pr_url: { url: "https://example.org/x", label: "#1" } },
    })
    expect(ok.submissionUrl).toBe("https://example.org/x")
  })
})

// ---------------------------------------------------------------------------
// The payload carries its provenance, and NO per-task competitor matrix.
// ---------------------------------------------------------------------------

const comparison = (over: Record<string, unknown> = {}) =>
  buildOfficialComparison({
    upstreamRef: PINNED_REF,
    datasetRef: PINNED_DATASET_REF,
    refreshedAt: "2026-08-22T12:00:00.000Z",
    submissions: [normalized()],
    ...over,
  })

describe("TB21-05 importer — the stored payload is source-pinned", () => {
  test("source URLs, upstream commit, dataset ref and refresh timestamp ride along", () => {
    const payload = comparison()
    expect(payload.schemaVersion).toBe(OFFICIAL_COMPARISON_SCHEMA_VERSION)
    expect(payload.upstreamRepo).toBe(UPSTREAM_REPO)
    expect(payload.upstreamRef).toBe(PINNED_REF)
    expect(payload.datasetRef).toBe(PINNED_DATASET_REF)
    expect(payload.refreshedAt).toBe("2026-08-22T12:00:00.000Z")
    expect(payload.upstreamUrl).toBe(
      `https://github.com/${UPSTREAM_REPO}/tree/${PINNED_REF}/leaderboard/submissions`,
    )
    // ...and each row names the exact file it came from, at that exact commit.
    const row = payload.submissions[0]
    expect(row?.sourceFile).toBe(FIXTURE_NAME)
    expect(row?.sourceUrl).toBe(
      `https://github.com/${UPSTREAM_REPO}/blob/${PINNED_REF}/leaderboard/submissions/${FIXTURE_NAME}`,
    )
  })

  test("a mutable upstream ref cannot become a committed snapshot", () => {
    expect(() => comparison({ upstreamRef: "main" })).toThrow(/immutable/i)
  })

  test("per-task competitor data is OMITTED with a reason — never inferred from globals", () => {
    const payload = comparison()
    expect(payload.perTaskAvailable).toBe(false)
    expect(payload.perTaskOmittedReason).toMatch(/per-task/i)
    // Ground truth: the upstream submission's `trials` is a list of opaque trial
    // UUIDs with NO task mapping, so a per-task rate is not derivable from it.
    const trials = fixture().trials as unknown[]
    expect(Array.isArray(trials)).toBe(true)
    expect(trials.every((t) => typeof t === "string")).toBe(true)
    expect(payload).not.toHaveProperty("perTask")
  })
})

// ---------------------------------------------------------------------------
// The read-back boundary fails CLOSED.
// ---------------------------------------------------------------------------

describe("TB21-05 importer — decoding a stored payload validates it", () => {
  test("a payload the importer produced round-trips", () => {
    const decoded = decodeOfficialComparison(JSON.parse(JSON.stringify(comparison())))
    expect(decoded?.submissions[0]?.accuracy).toBe(71.24)
    expect(decoded?.upstreamRef).toBe(PINNED_REF)
  })

  test("a wrong-version / mutable-ref / malformed payload decodes to null (renders —)", () => {
    const good = JSON.parse(JSON.stringify(comparison())) as Record<string, unknown>
    expect(decodeOfficialComparison({ ...good, schemaVersion: "tb-official/v0" })).toBeNull()
    expect(decodeOfficialComparison({ ...good, upstreamRef: "main" })).toBeNull()
    expect(decodeOfficialComparison({ ...good, submissions: "nope" })).toBeNull()
    expect(decodeOfficialComparison(null)).toBeNull()
    expect(decodeOfficialComparison("not-json")).toBeNull()
    // NON-VACUITY: the untouched payload still decodes.
    expect(decodeOfficialComparison(good)).not.toBeNull()
  })
})

// ---------------------------------------------------------------------------
// The CLI: offline, deterministic, side-effect free.
// ---------------------------------------------------------------------------

interface Recorder {
  ports: OfficialImportPorts
  writes: { file: string; text: string }[]
  out: string[]
}

const recorder = (files: Record<string, string>): Recorder => {
  const writes: { file: string; text: string }[] = []
  const out: string[] = []
  return {
    writes,
    out,
    ports: {
      listDir: (dir) =>
        Object.keys(files)
          .filter((f) => f.startsWith(`${dir}/`))
          .map((f) => f.slice(dir.length + 1)),
      readText: (file) => {
        const text = files[file]
        if (text === undefined) throw new Error(`no such file ${file}`)
        return text
      },
      writeText: (file, text) => {
        writes.push({ file, text })
      },
      write: (line) => {
        out.push(line)
      },
      now: () => "2026-08-22T12:00:00.000Z",
    },
  }
}

const FILES = {
  "/subs/2026-07-10-gpt-5-6-luna-max-codex.json": readFileSync(FIXTURE_PATH, "utf8"),
  "/subs/README.md": "# not a submission",
}

describe("TB21-05 importer — the offline refresh CLI", () => {
  test("--dry-run reads and reports but writes NOTHING", () => {
    const rec = recorder(FILES)
    const code = runOfficialImport(
      [
        "--upstream-ref",
        PINNED_REF,
        "--submissions",
        "/subs",
        "--out",
        "/out/tb.json",
        "--dry-run",
      ],
      rec.ports,
    )
    expect(code).toBe(0)
    expect(rec.writes).toEqual([])
    const printed = rec.out.join("\n")
    expect(printed).toContain(PINNED_REF)
    expect(printed).toContain("1 submission")
  })

  test("a real refresh writes exactly ONE file, at --out, and nothing else", () => {
    const rec = recorder(FILES)
    expect(
      runOfficialImport(
        ["--upstream-ref", PINNED_REF, "--submissions", "/subs", "--out", "/out/tb.json"],
        rec.ports,
      ),
    ).toBe(0)
    expect(rec.writes.map((w) => w.file)).toEqual(["/out/tb.json"])
    const payload = JSON.parse(rec.writes[0]?.text ?? "{}") as Record<string, unknown>
    expect(payload.schemaVersion).toBe(OFFICIAL_COMPARISON_SCHEMA_VERSION)
    expect(payload.upstreamRef).toBe(PINNED_REF)
    expect(payload.refreshedAt).toBe("2026-08-22T12:00:00.000Z")
    expect((payload.submissions as unknown[]).length).toBe(1)
    // ...and the artifact it wrote is a *dashboard payload*, never a run report.
    expect(payload).not.toHaveProperty("perInstance")
    expect(payload).not.toHaveProperty("trials")
    expect(payload).not.toHaveProperty("benchmarkSuite")
  })

  test("a mutable ref is refused BEFORE anything is read or written", () => {
    const rec = recorder(FILES)
    expect(
      runOfficialImport(
        ["--upstream-ref", "main", "--submissions", "/subs", "--out", "/out/tb.json"],
        rec.ports,
      ),
    ).toBe(2)
    expect(rec.writes).toEqual([])
    expect(rec.out.join("\n")).toMatch(/immutable/i)
  })

  test("the refresh is NETWORK-FREE: it completes with fetch disabled", () => {
    const realFetch = globalThis.fetch
    let fetched = 0
    // Any network reach becomes a hard failure, so "it passed" means "it never tried".
    globalThis.fetch = (() => {
      fetched++
      throw new Error("the importer must not touch the network")
    }) as unknown as typeof fetch
    try {
      const rec = recorder(FILES)
      expect(
        runOfficialImport(
          ["--upstream-ref", PINNED_REF, "--submissions", "/subs", "--out", "/out/tb.json"],
          rec.ports,
        ),
      ).toBe(0)
      expect(fetched).toBe(0)
      expect(rec.writes).toHaveLength(1)
    } finally {
      globalThis.fetch = realFetch
    }
  })

  test("it is DETERMINISTIC: the same inputs produce byte-identical output", () => {
    const a = recorder(FILES)
    const b = recorder(FILES)
    const argv = ["--upstream-ref", PINNED_REF, "--submissions", "/subs", "--out", "/out/tb.json"]
    runOfficialImport(argv, a.ports)
    runOfficialImport(argv, b.ports)
    expect(a.writes[0]?.text).toBe(b.writes[0]?.text)
  })

  test("non-submission files in the directory are skipped, not parsed as submissions", () => {
    const rec = recorder(FILES)
    runOfficialImport(
      ["--upstream-ref", PINNED_REF, "--submissions", "/subs", "--out", "/out/tb.json"],
      rec.ports,
    )
    const payload = JSON.parse(rec.writes[0]?.text ?? "{}") as {
      submissions: { sourceFile: string }[]
    }
    expect(payload.submissions.map((s) => s.sourceFile)).toEqual([FIXTURE_NAME])
  })
})

// ---------------------------------------------------------------------------
// The checked-in dashboard payload is the importer's own output.
// ---------------------------------------------------------------------------

describe("TB21-05 importer — the checked-in rawdata payload is REPRODUCIBLE", () => {
  const CHECKED_IN = join(import.meta.dir, "..", "rawdata", "terminal-bench-official.json")

  test("rawdata/terminal-bench-official.json decodes and carries the pinned provenance", () => {
    const payload = decodeOfficialComparison(JSON.parse(readFileSync(CHECKED_IN, "utf8")))
    expect(payload).not.toBeNull()
    expect(payload?.upstreamRef).toBe(PINNED_REF)
    expect(payload?.datasetRef).toBe(PINNED_DATASET_REF)
    expect(payload?.submissions).toHaveLength(1)
    expect(payload?.submissions[0]?.accuracy).toBe(71.24)
    expect(payload?.perTaskAvailable).toBe(false)
  })

  test("the vendored submission is BYTE-IDENTICAL to TB21-04's checked-in fixture", () => {
    // The importer needs the file under its UPSTREAM name (the name is what the
    // `sourceUrl` deep-link is built from), so the submission is vendored beside
    // the dashboard under that name. This rail is what keeps the two copies from
    // becoming two different snapshots.
    const vendored = join(import.meta.dir, "..", "rawdata", "tb-official-submissions", FIXTURE_NAME)
    expect(readFileSync(vendored, "utf8")).toBe(readFileSync(FIXTURE_PATH, "utf8"))
  })

  test("re-running the importer over the same fixture reproduces it byte-for-byte", () => {
    const stored = JSON.parse(readFileSync(CHECKED_IN, "utf8")) as { refreshedAt: string }
    const rec = recorder(FILES)
    rec.ports = { ...rec.ports, now: () => stored.refreshedAt }
    runOfficialImport(
      ["--upstream-ref", PINNED_REF, "--submissions", "/subs", "--out", "/x.json"],
      rec.ports,
    )
    expect(rec.writes[0]?.text).toBe(readFileSync(CHECKED_IN, "utf8"))
  })
})
