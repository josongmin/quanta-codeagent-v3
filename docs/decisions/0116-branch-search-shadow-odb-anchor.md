# ADR-0116: Branch-search ↔ Shadow ODB 앵커 시밍 — 최초 wiring

- **상태**: Accepted (구현 + 18-case hellgate 봉인)
- **날짜**: 2026-05-24
- **관련 ADRs**: ADR-0084 (speculative branch search), ADR-0108 (Shadow git ODB foundation), ADR-0093 (closed-port effect channel)
- **참조**:
  - `src/storage/shadow-odb/{types.ts, default.ts}` — `diffWorkspaceSinceLast` 신규 메서드
  - `src/agent/branch-search/anchor.ts` — `BranchSearchAnchor` 포트 + `shadowOdbAnchor` 기본 구현
  - `src/agent/branch-search/{types.ts, search.ts, tool.ts, index.ts}` — 오케스트레이터/툴 통합
  - `src/agent/branch-search-runner.ts` — assembly 시점 wiring
  - `src/agent/types.ts` — `AgentConfig.shadowOdb` 상위 슬롯
  - `tests/unit/branch-search-anchor-hellgate.test.ts` — 18 case
  - `tests/unit/shadow-odb-hellgate.test.ts` — HELL-16~19 4 case 추가

## Context

오늘 branch-search (ADR-0084)는 N개의 후보를 isolated workspace에서 fan-out 후 verifier/scorer/selector로 winner를 고른다. 빠진 게 셋이다:

1. **공통 시작점 (anchor) 없음** — 모든 후보가 어디로부터 갈라졌는지 *ledger에 박힌 시점*이 없다. 후속 audit ("정말 minimal change로 좁혀졌는가?")이 불가.
2. **per-candidate divergence 측정 없음** — 후보가 base 대비 얼마나 *많이* 바꿨는지 (changedFiles/addedLines/removedLines) 정량화가 없다. 따라서 "smallest-delta tiebreak" 같은 future selector를 지원할 토대가 없음.
3. **rewind safety net 없음** — 후보들이 다 끝난 뒤 base cwd로 무언가 leak되었는지 비교할 기준점이 없다.

Shadow ODB (ADR-0108)는 사용자 `.git` 비침습 ledger를 제공하지만 **assembly wiring 0** 으로 박혀 있었다 (foundation only). 본 ADR은 **첫 wiring** — 다른 consumer (review/rewind/audit) 보다 먼저 branch-search 에 박는다.

## Decision

5 part. 모두 default-OFF (`AgentConfig.shadowOdb` 미설정 시 byte-identical).

### Part 1 — `ShadowOdb.diffWorkspaceSinceLast(anchorWorkspace, comparisonWorkspace)`

기존 `diffSinceLast(workspaceRoot)` 는 anchor와 비교 working tree가 동일 path 라고 가정한다. branch-search 는 anchor=parent cwd, comparison=candidate isolated workspace 가 *다른 경로* 이므로 신규 메서드가 필요. `--git-dir=<anchor's shadowDir>/.git --work-tree=<comparisonWorkspace>` argv로 라우팅. 양쪽 path는 기존 `validateWorkspaceRoot` (absolute + non-symlink-leaf)를 통과해야 한다.

git diff exit code: 0(=no diff) 또는 1(=differences)만 정상; 그 외 → `ShadowOdbError("git-failed")`. ref 없음 → `ShadowOdbError("uninitialized")`. 스폰 실패 → `ShadowOdbError("spawn-failed")`.

### Part 2 — `BranchSearchAnchor` closed-port + `shadowOdbAnchor` 기본 구현

```ts
interface BranchSearchAnchor {
  registerStart(): Promise<{ ok: true } | { ok: false; reason: string }>
  measureDelta(workspace: string): Promise<DeltaMeasurement | null>
}
```

**Hard invariant: NO-THROW.** 양 메서드 모두 anchor I/O 에러를 절대 search loop에 전파하지 않는다. `registerStart` 는 실패시 `{ok:false}`, `measureDelta` 는 실패시 `null`. fail-open: 측정이 안 되면 그냥 delta 미부착 (`"delta" in cand === false`)으로 진행, search 자체는 계속.

`shadowOdbAnchor(odb, baseCwd)` 는 첫 `registerStart` 만 실제로 `odb.registerHead` 를 부르고 (idempotent — 두 번째 호출은 즉시 `{ok:true}`), `measureDelta` 는 `odb.diffWorkspaceSinceLast(baseCwd, workspace)` 호출 후 `parseDiffMeasurement` 로 카운트.

`parseDiffMeasurement` 는 pure: `diff --git ` 헤더 수 = changedFiles, body 라인의 `+`/`-` prefix 카운트 = addedLines/removedLines. `+++ `/`--- ` 헤더 라인은 명시적으로 제외. tests 와 미래 다른 anchor 구현체가 재사용할 수 있도록 export.

### Part 3 — 오케스트레이터 통합 (`runBranchSearch`)

- `parallelPropose` *전에* `anchor.registerStart()` 호출. ok:false → `candidate-failed` trace (id="anchor") 발사 후 anchor 비활성화. 새 trace variant를 추가하지 않고 기존 variant를 재사용 (trace union 작게 유지).
- 각 *completed* 후보에 대해 `anchor.measureDelta(cand.workspace)` 호출. non-null → 신규 `BranchCandidate` 를 condition-spread (`{ ...cand, delta }`) 로 만들고 (input 후보는 readonly + 다른 trace event에 공유 — 절대 mutate 금지), `candidate-delta` trace 발사.
- null 또는 `outcome.kind === "failed"` → `delta` 슬롯 자체를 OMIT (exactOptionalPropertyTypes: `undefined` 도 절대 set하지 않는다).

### Part 4 — Assembly wiring (`branch-search-runner.ts`)

`buildBranchSearchTool(config)` 에 단일 분기 추가:
- `config.shadowOdb !== undefined` AND `config.branchSearch !== undefined` 모두 만족 시 → `shadowOdbAnchor(config.shadowOdb, config.cwd)` 생성 후 `deps.anchor` 로 주입.
- `config.cwd` 는 **parent (search 호출자) cwd** 임에 주의 — 후보 workspace가 아니다 (모든 후보가 *이 시점*으로부터 갈라진다).
- `AgentConfig.shadowOdb` 는 top-level 슬롯 (`branchSearch` 하위 nested 아님): 다음 ADR 들 (review/audit/rewind) 도 같은 슬롯을 읽을 예정 — 그때 한 번 더 옮기지 않으려는 사전 합의.

`FeaturesConfig` Pick union에 `shadowOdb` 추가 (assembly가 보는 narrow slice).

### Part 5 — 18-case hellgate

`tests/unit/branch-search-anchor-hellgate.test.ts` (신규) + `tests/unit/shadow-odb-hellgate.test.ts` (4 case 추가).

**A. parseDiffMeasurement (5)**: 빈 입력 zero / 3+2 카운트 / 3-파일 헤더 / `+++`/`---` 헤더 제외 / 빈 `+`·`-` 라인 카운트.

**B. shadowOdbAnchor (8)**: registerStart happy / 멱등 / no-throw on registerHead 실패 / measureDelta happy with 정확한 인자 / 미등록 시 null + odb 미호출 / no-throw on diffWorkspaceSinceLast 실패 → null / 빈 diff → `{0,0,0}` (NOT null) / 동시 measureDelta 독립 해결.

**C. runBranchSearch (5)**: anchor 부재 시 byte-identical (`"delta" in cand === false`) / anchor present + 전 후보 완료 → 전부 delta 부착 + N candidate-delta trace / registerStart ok:false → measureDelta 0 호출 + candidate-failed("anchor") trace / 후보 1개 failed → 해당 후보 measureDelta 호출 안됨 + delta OMIT, 나머지는 부착 / measureDelta가 1개에만 null 반환 → 해당만 OMIT.

**HELL-16~19 (shadow-odb)**: anchor=A diff=B 행복 경로 / 동일 workspace zero divergence / 미등록 → uninitialized / comparison leaf-symlink 거부 / comparison relative 거부.

## Default-OFF

`AgentConfig.shadowOdb` 미설정 시:
- `buildBranchSearchAnchor` 가 `undefined` 반환
- `branchSearchTool` deps에 `anchor` 슬롯 OMIT (condition-spread)
- `runBranchSearch` 의 `req.anchor === undefined` 분기로 `registerStart`/`measureDelta` 호출 0
- 모든 후보가 `delta` 슬롯 자체 없음 (`"delta" in cand === false`)
- HELL-C1 이 byte-identical을 직접 증명

소비자 와이어링 모양:
```ts
const config: AgentConfig = {
  /* ... 기존 필드 ... */
  branchSearch: { /* defaults */ },
  shadowOdb: defaultShadowOdb(),  // ← 옵트인 한 줄
}
```

## Hellgate (18 case 요약)

| 블록 | 케이스 수 | 봉인 invariant |
|---|---|---|
| A: parseDiffMeasurement | 5 | pure / `+++`·`---` header rejection / blank line counting |
| B: shadowOdbAnchor | 8 | NO-THROW / idempotent registerStart / null-on-failure measureDelta / empty diff ≠ null |
| C: runBranchSearch wiring | 5 | byte-identical no-anchor / condition-spread (`"delta" in cand`) / fail-open on anchor failure / no measure on failed candidates / per-candidate null isolation |
| shadow-odb (HELL-16~19) | 4 | cross-workspace diff happy / zero divergence / uninitialized / path-safety on comparison |

전부 hermetic: A는 pure, B는 fake `ShadowOdb`, C는 fake isolator/runCandidate/verifier. shadow-odb HELL-16~19는 실 git + tmpdir.

## Alternatives rejected

1. **각 후보 isolator 안에 anchor 저장**: `tmpdirIsolator` 는 매 후보마다 fresh clone — N 후보 간 공통 parent state 가 보존되지 않는다. invariant "공통 시작점" 위반.
2. **`git stash` 활용**: 사용자 stash stack 오염, 침습. ADR-0108 의 `gix-snapshot` 흡수 사유와 동일하게 거부.
3. **anchor 호출을 throw 가능하게**: search loop의 robustness contract 위반 — 한 후보의 verifier 크래시도 batch를 죽이지 않는데 anchor I/O 가 죽이면 안 됨. fail-open이 일관성.
4. **`delta` 를 always-set (`delta: undefined` allowed)**: `exactOptionalPropertyTypes: true` 위반. condition-spread + `"delta" in cand` 패턴으로 통일.
5. **`BranchSearchAnchor` 를 `shadowOdb` 없이도 항상 생성**: default-OFF 원칙 위반. 호출자가 명시적으로 `shadowOdb` 슬롯을 켜야 비용 (registerHead disk write + per-candidate spawn) 이 발생.
6. **새 trace variant `anchor-failed`**: trace union 비대화. 기존 `candidate-failed` 에 id="anchor" 로 재사용 — sink가 이미 처리하는 variant.
7. **delta 측정을 propose 안으로 합치기**: propose는 isolator+timeout만 책임. 측정은 verify/score와 같은 post-completion phase — 분리가 맞다.

## Follow-up

- **Minimal-change tiebreak selector**: 동점일 때 `delta.addedLines + delta.removedLines` 가 작은 후보를 winner로. delta 측정이 있는 지금 가능. 별도 ADR.
- **Rewind safety net**: search 종료 후 `odb.diffWorkspaceSinceLast(baseCwd, baseCwd)` 비공으로 base cwd가 변하지 않았는지 audit. non-empty면 경고.
- **Cross-search anchor stack**: 한 세션에서 branch-search가 여러 번 호출될 때 anchor를 stack (push/pop) 으로 관리. 현재는 새 search 마다 새 anchor (registerHead 가 새 commit 박음).
- **`registerHead` 실패 시의 stop conditions**: 현재 fail-open. follow-up에서 host에 `onAnchorFailure` 콜백을 expose하여 strict-mode 옵트인 가능.
- **OTel attribute**: `branch_search.candidate.delta.{files,added,removed}` 를 candidate span에 attach.

## SOTA++ 자리매김

- Cursor: branch-search 자체 없음.
- Codex: branch-search 자체 없음.
- Claude Code: branch-search 자체 없음.
- **quanta**: ADR-0084 N-best + ADR-0108 shadow ODB + 본 ADR (anchor seam + per-candidate delta) = OSS agent 최초의 *"branch-search + 사용자-git-비침습 anchor + 정량 delta 측정 + fail-open 헬게이트 봉인"* 통합. Tier 0 keystone — future minimal-change/rewind/audit 의 토대.
