/**
 * PMX-04 — THE GOLD BOUNDARY AT THE AGENT BOX, pinned independently of whether
 * the lane is open.
 *
 * ProMax's frozen bundle is gold-bearing: every row carries `patch` and
 * `test_patch`. So the agent's on-box environment must carry the upstream
 * COMMIT — an identity pin, which cannot be dereferenced into anything — and
 * never the bundle ROOT, which is a location one `cat` away from the answer key
 * and unprovable afterwards.
 *
 * That property is easy to hold while the remote lane refuses, because nothing
 * runs. These tests hold it by OBSERVATION rather than by the lane being closed,
 * so they keep their force on the day the lane opens. They pass today and must
 * pass unchanged afterwards; if opening the lane makes any of them red, the
 * opening moved the boundary.
 *
 * (Whether the lane admits at all is pinned by
 * `promax-bootstrap-phase-reachability.test.ts`, which also carries the clause
 * that BLOCKS opening it: ProMax declares 6 gold-bearing grader commands and 1
 * gold-bearing teardown, and no production caller executes either — so admitting
 * a box would leave the key on it for the next chunk's agent phase.)
 */
import { describe, expect, test } from "bun:test"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { loadFamilyCorpusRowsOrThrow } from "@/apps/bench/profiles/corpus-read"
import { resolveDatasetFamilyProfile } from "@/apps/bench/profiles/registry"
import type { PreflightInput } from "@/apps/bench/profiles/types"
import { PROMAX_V1_SNAPSHOT } from "@/apps/bench/promax/provenance/frozen-snapshot"
import { PROMAX_BUNDLE_ROOT_ENV, PROMAX_PYTHON_ENV } from "@/apps/bench/promax/settings"

const promax = () => resolveDatasetFamilyProfile("promax")

/** A CLEAN, correctly projected ProMax row: agent-visible fields only.
 *  `language` is ProMax-required — it is the column that makes a ProMax corpus
 *  distinguishable from a Verified/Pro-shaped one. */
const publicRow = (id: string) => ({
  instance_id: id,
  repo: "aws/s2n-tls",
  base_commit: "0".repeat(40),
  problem_statement: "something is broken",
  language: "c",
})

/** The same row with GOLD attached — what a mis-prepared chunk looks like. */
const goldBearingRow = (id: string) => ({
  ...publicRow(id),
  patch: "--- a/x\n+++ b/x\n@@ -1 +1 @@\n-a\n+b\n",
  test_patch: "--- a/t\n+++ b/t\n@@ -1 +1 @@\n-c\n+d\n",
})

const writeCorpus = (rows: readonly Record<string, unknown>[]): string => {
  const dir = mkdtempSync(join(tmpdir(), "promax-lane-"))
  const path = join(dir, "instances.json")
  writeFileSync(path, JSON.stringify(rows))
  return path
}

const preflightInput = (path: string): PreflightInput => ({
  datasetPath: path,
  surface: "full-remote",
  readRows: () =>
    loadFamilyCorpusRowsOrThrow({ datasetPath: path, surface: "full-remote", family: "promax" }),
})

describe("the agent box never receives grader material", () => {
  test("the env prefix carries the COMMIT, never the bundle root or its interpreter", () => {
    // The operator HAS set the grader knobs — the realistic case, since a
    // campaign resolves them for the grader phase. They must still not reach the
    // agent's environment.
    const bundleRoot = "/opt/promax-bundle/v1-170"
    const python = "/opt/promax-venv/bin/python3"
    const prefix = promax().onBoxEnvPrefix({
      datasetPath: "/campaign/public-tasks.json",
      env: {
        [PROMAX_BUNDLE_ROOT_ENV]: bundleRoot,
        [PROMAX_PYTHON_ENV]: python,
      } as NodeJS.ProcessEnv,
    })

    // the identity pin IS carried — else this test would pass on an empty string
    expect(prefix).toContain(PROMAX_V1_SNAPSHOT.upstream_git_commit)
    // RED-ON-INJECTION: re-emit either grader value here — as a literal, through
    // a spread of the resolved settings, or via the env key — and these fail.
    expect(prefix).not.toContain(bundleRoot)
    expect(prefix).not.toContain(python)
    expect(prefix).not.toContain(PROMAX_BUNDLE_ROOT_ENV)
    expect(prefix).not.toContain(PROMAX_PYTHON_ENV)
  })

  test("a malformed grader knob fails CLOSED at the agent boundary", () => {
    // A relative bundle root must throw rather than silently emit a prefix: the
    // knob is still RESOLVED here (not skipped) precisely so it fails closed.
    expect(() =>
      promax().onBoxEnvPrefix({
        datasetPath: "/campaign/public-tasks.json",
        env: { [PROMAX_BUNDLE_ROOT_ENV]: "relative/path" } as NodeJS.ProcessEnv,
      }),
    ).toThrow(/absolute/i)
  })
})

describe("preflight's corpus checks are real, and run before any box", () => {
  test("a gold-bearing corpus is REFUSED", () => {
    const path = writeCorpus([goldBearingRow("aws__s2n-tls-5464")])
    expect(() => promax().preflight(preflightInput(path))).toThrow(/patch|gold/i)
  })

  test("PAIRED CONTROL: a corpus missing a ProMax-required column is refused for a DIFFERENT reason", () => {
    // Proves the gold check above is not just "any promax row throws today"
    // (the lane refusal fires after these checks, so both paths throw — the
    // MESSAGE is what separates them).
    const { language: _omitted, ...noLanguage } = publicRow("aws__s2n-tls-5464")
    const path = writeCorpus([noLanguage])
    expect(() => promax().preflight(preflightInput(path))).toThrow(/ProMax-required columns/i)
  })
})
