#!/usr/bin/env bun
/**
 * Generate `knob-catalog.json` for the leaderboard dashboard's Knob/Profile tab.
 *
 *   bun run tools/leaderboard-dashboard/gen-knob-catalog.ts
 *
 * Pulls the GROUND TRUTH from source so the reference page never drifts:
 *   - `KNOB_PRESETS` (src/runner/knobs/presets.ts)  → preset → {knobId: value}
 *   - the framework knob registry (via gen-knob-docs)→ describe/envKey/unit/source
 *
 * Bench-driver knobs (delivered out of band by `benchPostureFromState`, not in
 * the framework registry) get curated one-line descriptions in CURATED below —
 * keep these accurate when a knob's behaviour changes. Re-run this script after
 * editing presets or adding knobs; the server only reads the emitted JSON so it
 * stays standalone.
 */
// Side-effect barrel import: registers EVERY bench/agent knob module so the
// registry is complete before we read it. Without this, env-only override knobs
// that no preset references (e.g. regression-max-tests, repro-exec-timeout)
// would be invisible to `collectKnobsForDocs` → silently dropped from the
// catalog. The drift-guard test (gen-knob-catalog.test.ts) pins this.
import "@/runner/knobs/knobs"
import type { AnyKnob, Surface } from "@/runner/knobs"
import { KNOB_PRESETS } from "@/runner/knobs/presets"
import { collectKnobsForDocs } from "../gen-knob-docs"

/** Surface whose knobs the leaderboard catalog documents. */
const CATALOG_SURFACE: Surface = "bench"

/** Group labels for the dashboard's Knob/Profile tab. Every value reachable as
 *  an entry's `group` (a curated group OR a fallthrough `category`) MUST have a
 *  label here, else it renders ungrouped. */
const GROUP_LABELS: Record<string, string> = {
  localize: "위치추정 (localize)",
  hint: "힌트 (hint)",
  verify: "검증 (verify)",
  select: "후보선택 (verify-select)",
  repair: "수리 (repair)",
  patch: "패치 품질 (patch)",
  structure: "구조 (structure)",
  exec: "실행 (exec)",
  // KnobCategory fallthroughs (used when a registered knob has no CURATED group)
  validation: "검증·게이트 (validation)",
  agent: "에이전트 (agent)",
  tool: "도구 (tool)",
  기타: "기타",
}

// Curated descriptions for bench-driver knobs absent from the framework
// registry (their effect is applied by the bench driver, not the knob `apply`).
const CURATED: Record<string, { desc: string; group: string }> = {
  lsp: {
    group: "localize",
    desc: "LSP 언어서버 켜기 — 정의/참조 점프 등 코드 네비게이션 도구 활성화",
  },
  "lsp-steer": {
    group: "localize",
    desc: "localize 단계에서 LSP nav(정의/참조 점프)를 쓰도록 모델을 유도하는 스티어",
  },
  "localize-phase": {
    group: "localize",
    desc: "결함 위치 추정(localization) 전용 단계 — 값=탐색 깊이/예산",
  },
  "repo-map": { group: "localize", desc: "레포 구조 맵(디렉토리/심볼 개요)을 컨텍스트로 제공" },
  "read-outline": {
    group: "localize",
    desc: "파일 심볼 아웃라인 먼저 읽기 — 전체 파일 덤프 대신 구조 파악",
  },
  "issue-hint": { group: "hint", desc: "이슈 본문을 localization 힌트로 사용(agentless 방식)" },
  "issue-hint-expected-actual": {
    group: "hint",
    desc: "이슈에서 기대동작/실제동작을 추출해 힌트로 주입",
  },
  "spec-fidelity-steer": {
    group: "hint",
    desc: "이슈 요구사항(스펙) 충실도를 지키도록 모델 스티어",
  },
  "fault-evidence": { group: "verify", desc: "패치 전에 결함 증거(어디가 왜 틀렸는지)를 요구" },
  "repro-test": {
    group: "verify",
    desc: "호스트 파이썬으로 재현 테스트를 만들어 돌리는 디렉티브 — 값=샘플 수",
  },
  "repro-vote": {
    group: "verify",
    desc: "재현셋을 패치 트리에서 재실행해 K-of-N RESOLVED 다수결 게이트",
  },
  "repro-doubt": {
    group: "verify",
    desc: "재현이 verify_loop_stuck일 때 repro 유효성을 의심하도록 스티어",
  },
  "verification-plan": {
    group: "verify",
    desc: "검증 계획 단계 — 패치 후 무엇을 어떻게 확인할지 계획",
  },
  "verify-select": {
    group: "select",
    desc: "verify-and-select — N개 후보 패치 생성 후 채점기준으로 1개 선택. 값=후보 수",
  },
  "verify-select-early-accept": {
    group: "select",
    desc: "후보가 명백히 통과면 조기 수락(나머지 후보 생성 생략)",
  },
  "verify-select-regression": {
    group: "select",
    desc: "regression(기존테스트 깸) 게이트를 후보 선택 기준에 포함",
  },
  "verify-select-repro": {
    group: "select",
    desc: "repro 정합성(재현테스트 결과)을 후보 선택 점수로 사용",
  },
  "closure-repair": {
    group: "repair",
    desc: "verify-first 클로저 기반 repair 실행기 — 값=최대 라운드 수",
  },
  "repair-escalation": {
    group: "repair",
    desc: "초기 패치 실패 시 더 강한 repair 전략으로 에스컬레이션",
  },
  "patch-budget": { group: "patch", desc: "패치 크기/시도 예산 — 과도하게 큰 변경 억제" },
  "patch-budget-strict": { group: "patch", desc: "패치 예산 엄격 모드(초과 시 하드 컷)" },
  "patch-hygiene": { group: "patch", desc: "패치 위생 — 무관한 변경/노이즈/디버그 잔재 제거" },
  "no-patch-breaker": {
    group: "patch",
    desc: "기존 통과 테스트(PASS_TO_PASS)를 깨는 패치를 차단하는 가드",
  },
  "primary-rail": {
    group: "structure",
    desc: "주 레일 — 하네스가 강제하는 구조적 실행 경로 활성화",
  },
  "round0-minimal": { group: "structure", desc: "라운드0를 최소 컨텍스트로 시작(점진적 확장)" },
  "test-runner": { group: "exec", desc: "인루프 test 실행 도구(run-tests) 노출" },
  "bench-in-loop-exec": {
    group: "exec",
    desc: "인루프 실행 권한 모드 — full=repo tests, repro-only=작은 재현만 허용, off=submit-only",
  },
  "retry-transient": { group: "exec", desc: "일시적(네트워크/throttle) 오류 재시도 횟수" },
}

/** Pull the contiguous `//` comment block immediately above each `"preset": {`
 *  line out of presets.ts source — that's the human rationale for the preset. */
const presetNameOf = (line: string): string | undefined =>
  line.match(/^\s*"([a-z0-9-]+)":\s*\{/)?.[1]

const commentBlockAbove = (lines: readonly string[], index: number): string[] => {
  const comments: string[] = []
  for (let j = index - 1; j >= 0; j--) {
    const candidate = lines[j]
    if (candidate === undefined) break
    const trimmed = candidate.trim()
    if (!trimmed.startsWith("//")) break
    comments.unshift(trimmed.replace(/^\/\/\s?/, ""))
  }
  return comments
}

async function presetDescriptions(): Promise<Record<string, string>> {
  const src = await Bun.file(`${import.meta.dir}/../../src/runner/knobs/presets.ts`).text()
  const lines = src.split("\n")
  const out: Record<string, string> = {}
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (line === undefined) continue
    const presetName = presetNameOf(line)
    if (presetName === undefined) continue
    const comments = commentBlockAbove(lines, i)
    if (comments.length === 0) continue
    out[presetName] = comments.join(" ").replace(/─+/g, "").trim()
  }
  return out
}

type PresetKnobValues = Readonly<Record<string, unknown>>

interface UsedByEntry {
  readonly preset: string
  readonly value: unknown
}

interface KnobCatalogEntry {
  readonly id: string
  readonly desc: string
  readonly group: string
  readonly category: string | null
  readonly envKey: string | null
  readonly unit: string | null
  readonly source: string | null
  readonly cost: number | null
  readonly conflicts: readonly string[] | null
  readonly inRegistry: boolean
  readonly usedBy: readonly UsedByEntry[]
}

interface PresetCatalogEntry {
  readonly name: string
  readonly knobs: PresetKnobValues
  readonly desc: string
  readonly knobCount: number
}

export interface KnobCatalog {
  readonly generatedAt: string
  readonly presets: Record<string, PresetCatalogEntry>
  readonly knobs: Record<string, KnobCatalogEntry>
  readonly presetOrder: readonly string[]
  readonly groupLabels: Record<string, string>
}

/** The id set the catalog must describe: every registered knob on the catalog
 *  surface UNION every id any preset references. The registry half catches
 *  env-only override knobs that no preset touches; the preset half catches any
 *  curated-only id that isn't a registered knob (e.g. driver-applied knobs). */
export const catalogKnobIds = (
  registry: ReadonlyMap<string, AnyKnob>,
  presetEntries: readonly [string, PresetKnobValues][],
): readonly string[] => {
  const ids = new Set<string>()
  for (const k of registry.values()) {
    if (k.surfaces.includes(CATALOG_SURFACE)) ids.add(k.id)
  }
  for (const [, preset] of presetEntries) for (const id of Object.keys(preset)) ids.add(id)
  return [...ids].sort()
}

/** PURE catalog builder — deterministic given (registry, presets, descriptions,
 *  timestamp). All I/O lives in {@link main}. Exported for the drift-guard test. */
export const buildCatalog = (args: {
  readonly registry: ReadonlyMap<string, AnyKnob>
  readonly presetEntries: readonly [string, PresetKnobValues][]
  readonly presetDesc: Record<string, string>
  readonly generatedAt: string
}): KnobCatalog => {
  const { registry, presetEntries, presetDesc, generatedAt } = args
  const knobs: Record<string, KnobCatalogEntry> = {}
  for (const id of catalogKnobIds(registry, presetEntries)) {
    const r = registry.get(id)
    const c = CURATED[id]
    knobs[id] = {
      id,
      desc: r?.describe ?? c?.desc ?? "(설명 미작성)",
      group: c?.group ?? r?.category ?? "기타",
      category: r?.category ?? null,
      envKey: r?.envKey ?? null,
      unit: r?.unit ?? null,
      source: r?.source ?? null,
      cost: r?.costMultiplier ?? null, // relative cost multiplier (repro-test=40!)
      conflicts: r?.conflicts ?? null,
      inRegistry: !!r,
      // every preset that sets this knob, with the value it sets → full lineage
      usedBy: presetEntries
        .filter(([, kv]) => id in kv)
        .map(([name, kv]) => ({ preset: name, value: kv[id] })),
    }
  }

  // Presets enriched with their source rationale + knob count.
  const presets: Record<string, PresetCatalogEntry> = {}
  for (const [name, kv] of presetEntries) {
    presets[name] = {
      name,
      knobs: kv,
      desc: presetDesc[name] ?? "",
      knobCount: Object.keys(kv).length,
    }
  }

  return {
    generatedAt,
    presets,
    knobs,
    presetOrder: presetEntries.map(([name]) => name),
    groupLabels: { ...GROUP_LABELS },
  }
}

async function main() {
  const reg = new Map<string, AnyKnob>()
  for (const k of await collectKnobsForDocs()) reg.set(k.id, k)
  const presetDesc = await presetDescriptions()
  const presetEntries = Object.entries(KNOB_PRESETS) as [string, PresetKnobValues][]

  const catalog = buildCatalog({
    registry: reg,
    presetEntries,
    presetDesc,
    generatedAt: new Date().toISOString(),
  })

  const out = `${import.meta.dir}/knob-catalog.json`
  await Bun.write(out, `${JSON.stringify(catalog, null, 2)}\n`)
  process.stdout.write(
    `wrote ${out} — ${Object.keys(catalog.presets).length} presets (${Object.values(presetDesc).length} described), ${Object.keys(catalog.knobs).length} knobs\n`,
  )
}

if (import.meta.main) await main()
