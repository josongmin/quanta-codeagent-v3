# feature-catalog

YAML 기반 feature-catalog 도구 chain. `docs/10.feature-catalog.md`는 이 디렉토리에서 자동 생성됩니다.

## 빠른 시작

```sh
bun fc build              # docs/10.feature-catalog.md 재생성
bun fc validate           # zod + cross-feature + evidence 파일 검증
bun fc list --maturity L5 # 필터링 출력
bun fc show <id>          # 단일 feature dump (YAML)
bun fc add 1 my-feature   # 템플릿 스캐폴드
bun fc diff               # 현 MD vs fresh render (mismatch → exit 1)
bun fc check-evidence     # evidence 파일이 실제 존재하는지
bun fc audit              # 4-lens sweep (orphan ADR / orphan src / empty stub)
bun fc lint               # ratchet: empty stub 카운트 + orphan Accepted ADR 증가 차단
bun fc lint --update-baseline  # 의식적으로 baseline 갱신 (개선 잠금 또는 의도된 raise)
bun fc check-changed <ref>     # PR-time: ADDED 된 src/*.ts 가 fc.evidence.code 에 있는지
```

## Drift 방지 게이트 (CI)

`validate` / `diff` / `lint` 는 `.github/workflows/ci.yml`의 pyramid 잡에 박혀
있어 매 push/PR 마다 자동 실행. `check-changed` 는 PR 전용 잡으로 분리됨 — 새
파일이 fc 에 없으면 머지 차단. baseline은 `baseline.json` 의 `fc:` 서브오브젝트에
저장되며 `bun fc lint --update-baseline` 로만 변경된다.

### Ratchet 정책

- **empty stub 카운트** — HARD: `baseline.empty_stubs_max` 보다 늘면 CI fail.
  줄어들면 warn (baseline 잠그라는 알림).
- **orphan Accepted ADR** — HARD: grandfather list 에 없는 새 orphan 은 CI fail.
- **orphan src 카운트** — SOFT: 보고만, 차단 안 함 (leaf helpers 자연 증가).

## 파일 레이아웃

```
tools/feature-catalog/
├── cli.ts           CLI entrypoint (bun shebang)
├── schema.ts        zod 스키마 + 로더 + 채점/판정 함수
├── yaml.ts          in-house mini-YAML 파서/직렬화기
├── render.ts        YAML → MD 렌더러
├── audit.ts         4-lens audit (orphan ADR / orphan src / empty stub)
├── lint.ts          ratchet 검사 + baseline I/O
├── check-changed.ts PR-time gate (ADDED src ↔ fc.evidence.code)
├── prose/
│   ├── 00-intro.md           헤더 다음에 삽입
│   ├── 50-*.md / 99-*.md     trailer 산문 (정렬된 순서로 삽입)
├── baseline.json             검증 베이스라인 메타데이터 (footer에 표시)
└── features/
    ├── 01-agent-loop/
    │   └── <id>.yaml
    ├── 02-tool-system/
    │   └── ...
    └── ... 10-app/
```

## YAML subset

본 도구는 **외부 yaml lib 의존 없이** `yaml.ts`에서 미니 YAML subset을 구현합니다 (~400 LOC). 지원:

- 스칼라: string (quoted/unquoted), number, boolean, null
- 멀티라인 block scalar: `key: |` + 들여쓴 라인들 (preserve newlines)
- block sequence: `- item`
- block mapping: `key: value`
- flow sequence: `[a, b, c]` (스칼라 원소만)
- 들여쓰기: 2 spaces (탭 금지 → 명시적 에러)
- 주석: `# ...` (라인 끝까지, 문자열 내부 제외)

미지원 (lib YAML과의 의도적 차이):
- anchors / aliases / tags
- flow mappings `{a: b}`
- folded block scalars `>`
- multi-document `---`

round-trip 단언: `parseYaml(stringifyYaml(x))` 가 스키마-형식 객체에 대해 deep-equal 입력. 자세한 건 `tests/unit/feature-catalog-yaml.test.ts`.

## 스키마 필드

`FeatureSchema` 전체 필드 (정본은 `schema.ts`). 모든 optional 필드는 default가
있어 YAML 에서 생략 가능. enum 값을 벗어나면 `validate` 가 exit 1.

| 필드 | 타입 | 기본값 | 설명 |
|---|---|---|---|
| `id` | `string` (kebab-case) | — | feature 고유 id (필수, 유니크) |
| `title` | `string` | — | 사람 읽기 용 1행 제목 (필수) |
| `section` | `1..20` (실효 1..10) | — | 카탈로그 섹션 번호 (필수) |
| `subsystem` | `string` | — | 섹션 내 하위 그룹 라벨 (필수) |
| `order` | `int` | `0` | 같은 section/subsystem 내 정렬 키 |
| `maturity` | `L1\|L2\|L3\|L4\|L5` | — | 성숙도 (필수). gate 규칙은 `cli.ts` `GATES` |
| `status` | `stable\|new\|refined\|hold\|deprecated` | `stable` | 현재 상태 |
| `owners` | `string[]` | `[]` | 메인테이너 (L5 게이트에 필요) |
| `labels` | `string[]` | `[]` | 자유 형식 태그 (query 용) |
| `depends_on` | `string[]` (feature id) | `[]` | DAG edge (`graph` 명령 입력) |
| `lifecycle_stage` | `proposed\|active\|deprecated\|sunset\|removed` | `active` | 라이프사이클 단계 |
| `supersedes` | `string[]` (feature id) | `[]` | 이 feature 가 대체하는 이전 id 들 |
| `superseded_by` | `string` (feature id) | — | 이 feature 를 대체한 후속 id |
| `sunset_date` | `string` (ISO date) | — | sunset/removed 예정일 |
| `ui_surfaces` | `(cli\|web\|ide\|tauri\|api\|none\|n-a)[]` | `[]` | 노출 surface (wiring 축 입력) |
| `monitoring` | `integrated\|partial\|planned\|none\|n-a` | `n-a` | 관측 wired 상태 (monitoring 축 입력) |
| `modes` | `(interactive\|headless\|batch\|daemon\|ide\|ci-bot\|n-a)[]` | `[]` | 동작 모드 매트릭스 |
| `configurable` | `integrated\|partial\|planned\|static\|none\|n-a` | `n-a` | 설정/knob 노출 상태 (wiring 축 입력) |
| `telemetry_keys` | `string[]` | `[]` | 방출하는 OTel/log attribute key |
| `config_refs` | `{env,runtime,cli,prefs: string[]}` | `{}` | 분류된 설정 ref (env var / runtime flag / CLI flag / pref key) |
| `purpose` | `string` (1-3줄) | — | "무엇 + 왜" (필수). 평서문 |
| `evidence.code` | `string[]` (path) | `[]` | 핵심 파일 경로. `validate` 가 디스크 존재 확인 |
| `evidence.adrs` | `(number\|string)[]` | `[]` | ADR 번호 또는 path. `docs/decisions/NNNN-*.md` 존재 검증 |
| `evidence.tests.unit` | `string[]` | `[]` | 단위 테스트 path |
| `evidence.tests.integration` | `string[]` | `[]` | 통합 테스트 path |
| `evidence.tests.contract` | `string[]` | `[]` | 계약 테스트 path |
| `knobs` | `string[] \| {name,where?,default?,purpose?}[]` | `[]` | env 변수 / 런타임 토글. 객체 형식이면 풍부한 메타데이터 |
| `deliberate_hold` | `{reason, promotion_path?} \| null` | `null` | L1/L2 의식적 보류일 때만 채움. `judge` 가 `deliberate-hold` verdict 발급 |
| `notes` | `string` | — | 자유 형식 메모 (L2/L4 게이트 fallback 으로 활용) |

`section` 매핑:

| # | 이름 | 슬러그 |
|---|---|---|
| 1 | 에이전트 코어 루프 (ReAct) | `agent-loop` |
| 2 | 도구 시스템 | `tool-system` |
| 3 | 권한 & 안전 | `permission-safety` |
| 4 | 컨텍스트 관리 | `context-management` |
| 5 | 장기 메모리 | `memory` |
| 6 | Tier-1 능력 | `tier1` |
| 7 | 복원력 | `resilience` |
| 8 | 관측성 | `observability` |
| 9 | 통합 (MCP/LSP/Hooks) | `integration` |
| 10 | 앱/영속/정책 | `app` |

## CLI 명령

`cli.ts` 전체 서브커맨드 (exit: 0=ok / 1=error / 2=usage).

| 명령 | 인자 / 플래그 | 동작 |
|---|---|---|
| `build` | — | YAML → `docs/10.feature-catalog.md` 렌더 |
| `validate` | — | zod + cross-feature + evidence 파일 존재 검증 |
| `list` | `--maturity X` `--status X` `--section N` | `id\ttitle\tmaturity` TSV |
| `show` | `<id>` | 단일 feature 의 정규화된 YAML dump |
| `add` | `<section> <slug>` | `features/<NN>-<slug>/<id>.yaml` 스캐폴드 |
| `diff` | — | 현 MD vs fresh render line-diff (mismatch → exit 1) |
| `check-evidence` | — | `validate` 와 동일 (스펙 parity) |
| `audit` | — | 4-lens 보고 (orphan ADR / orphan src / empty stub) |
| `lint` | `--update-baseline` | ratchet: empty stub 카운트 + orphan Accepted ADR 증가 차단 |
| `check-changed` | `[<base-ref>]` (기본 `origin/main`) | PR-time: ADDED src/*.ts 가 어딘가의 `evidence.code` 에 있는지 |
| `grade` | `[<letter>]` | 모든 feature 의 A-F 채점 + 분포. letter 인자는 해당 등급만 |
| `judge` | `--min=L4` `--section=N` `--verbose` `--overclaimed` | 4축 composite (monitoring/hellgate/wiring/structure) → solid/thin/overclaimed verdict |
| `stale` | — | source 가 yaml 보다 7일 이상 새것이면 staleness 보고 (git ctime) |
| `query` | `key:value ...` (AND 결합) | label/owner/section/maturity/depends/lifecycle/grade/ui/monitoring/mode/configurable 필터 |
| `gates` | `--strict` | maturity-promotion-gate 감사. `--strict` 면 위반 시 exit 1 |
| `graph` | `--section N` `--id X` `--depth N` | `depends_on` DAG 를 DOT 로 stdout. `--id` 는 ancestor+descendant subgraph |
| `surface` | `--gap web\|cli\|any` `--audited` `--id X` `--json` | `surface_integration` 의 CLI/web 통합 coverage + gap 백로그 리포트 |

## surface_integration — CLI/web 통합 트래킹 (증거 포함)

`ui_surfaces` 는 *의도된* surface 태그일 뿐이라 신뢰할 수 없다 (2026-06-09 어딧: 933 중 ~13개만 web 표기인데 실제 웹앱은 훨씬 많이 노출, 일부 `[cli]` 는 웹 슬래시 stub 이 실행 안 돼서 "우연히" 맞음). `surface_integration` 은 이를 **surface별 AUDITED 상태 + file:line 증거** 로 대체한다. **"X 가 CLI/웹앱에 실제로 배선됐나?"를 트리 re-grep 없이 카탈로그에서 답한다.**

```yaml
surface_integration:
  cli: full          # full | partial | missing | na | unknown
  web: missing       # 좌동
  method: audited    # audited(사람/에이전트가 파일 열어봄) | derived(코드 SSOT서 계산) | unverified(기본)
  verified: "2026-06-09"
  evidence:
    cli: "src/apps/cli/...:NN — 무엇이 렌더/제어하는지"
    web: "dropped at context-binding.ts:1061 default arm — 왜 missing 인지"
```

- 미기입 feature 는 `unknown/unverified` 기본값 (byte-identical, 레거시 무영향).
- **Ratchet** (`tests/unit/feature-catalog-surface-integration.test.ts`): ① `audited/derived` 면 full/partial/missing 상태에 evidence 필수(맨주장 금지) ② surface_integration 이 `missing/na` 인데 ui_surfaces 가 그 surface 를 present 로 주장하면 fail(레거시는 lag 허용, 단방향) ③ **웹 도달성 SSOT 핀**: 유일 AgentEvent→web 브리지 `toSessionHostTurnEvent`(context-binding.ts) 가 정확히 6개 이벤트만 매핑함을 고정 — 누가 웹 브리지 넓히면 CI red 로 web 재어딧 강제.
- 대량 채우기: `tools/feature-catalog/surface-populate.workflow.js` (disjoint 배치 병렬 + 3대 병목 ground-truth 박음).

## 채점 (`grade`)

`computeGrade(feature)` — evidence 양만으로 A-F 산출 (정본은 `schema.ts`).

```
evidenceCount = code.length
              + tests.unit.length + tests.integration.length + tests.contract.length
hasAdr   = evidence.adrs.length > 0
hasOwner = owners.length > 0
```

| Grade | 규칙 |
|---|---|
| **A** | `evidenceCount >= 6` ∧ `hasAdr` ∧ `hasOwner` |
| **B** | `evidenceCount >= 6` (A 조건 부족) **또는** `evidenceCount in {4,5}` ∧ (`hasAdr` ∨ `hasOwner`) |
| **C** | `evidenceCount in {2,3}` **또는** `evidenceCount in {4,5}` ∧ ¬`hasAdr` ∧ ¬`hasOwner` |
| **D** | `evidenceCount == 1` |
| **F** | `evidenceCount == 0` |

## 4-축 판정 (`judge`)

`computeJudgment(feature)` — 운영 wiring 까지 본 composite verdict
(정본은 `schema.ts` `computeAxisScores` / `computeJudgment`).

각 축 0..3, 합계 0..12.

| 축 | 0 | 1 | 2 | 3 |
|---|---|---|---|---|
| **monitoring** | `n-a`/`none` | `planned` | `partial` | `integrated` |
| **hellgate** | 0개 | 1개 | 2개 | ≥3개 (evidence.tests.* 의 `hellgate` 포함 path 카운트, cap 3) |
| **wiring** | surface 없음 / `[none]`/`[n-a]` | non-CLI surface 만, 또는 `[cli]`+`configurable=planned` | `[cli]`+`configurable in {static, partial}` | `[cli]`+`configurable=integrated` |
| **structure** | `code` 비어있음 | 1 file | 2..4 files | ≥5 files **또는** slice barrel (`src/<slice>/index.ts`) 감지 |

Composite letter (`compositeLetter(total)`):

| 합계 | Letter |
|---|---|
| 10..12 | A |
| 7..9 | B |
| 4..6 | C |
| 2..3 | D |
| 0..1 | F |

Verdict matrix (`computeJudgment`, 위에서 아래로 우선 평가):

| 우선 | Verdict | 조건 |
|---|---|---|
| 1 | `deliberate-hold` | `deliberate_hold != null` |
| 2 | `overclaimed` | `maturity in {L4, L5}` ∧ `evidence.code.length == 0` ∧ `deliberate_hold == null` |
| 3 | `solid` | `axes.total >= 7` |
| 4 | `appropriate` | `axes.total >= 4` **또는** (`code.length >= 2` ∧ `axes.total >= 2`) |
| 5 | `thin` | 그 외 |

AUDIT-1 (2026-05-24) 정정: code 가 존재하는데 운영 축이 thin 한 것은
"appropriate-thin" 이지 "overclaimed" 가 아니다. 진짜 overclaim 신호는
**L4+ + code 없음** 단 하나만 사용 — 휴리스틱 없음.

## Lifecycle 단계

`lifecycle_stage` 는 schema 상 enum, 다음 5 단계의 단방향 진행:

| 단계 | 의미 | 부수 필드 |
|---|---|---|
| `proposed` | 도입 합의 전, 스펙 단계 | — |
| `active` | 운영 중 (기본값) | — |
| `deprecated` | 권장 안 함, 호환 유지 | `superseded_by`, `sunset_date` 채울 것 |
| `sunset` | 제거 예정, sunset_date 도래 임박 | `sunset_date` 필수적으로 채움 |
| `removed` | 코드 삭제됨, 카탈로그 기록만 보존 | `superseded_by` 또는 `notes` 로 종결 사유 |

`maturity` (성숙도, L1-L5) 와는 독립 — 예: `maturity=L4` 이면서
`lifecycle_stage=deprecated` 가능 (성숙했으나 후속에 의해 대체).

## 쿼리 예시 (`query`)

`bun fc query <key:value> [<key:value> ...]` — 모든 필터는 AND. 출력은
`grade\tid\tmaturity\ttitle`.

```sh
# L4 이상 + 관측 통합된 feature
bun fc query maturity:L5 monitoring:integrated

# 섹션 2 의 D/F 등급 (evidence 부족)
bun fc query section:2 grade:D
bun fc query section:2 grade:F

# 특정 feature 에 의존하는 후속 feature
bun fc query depends:agent-loop-react

# IDE surface 노출 + daemon 모드 동작
bun fc query ui:ide mode:daemon

# deprecated 진행 중인 항목
bun fc query lifecycle:deprecated

# owner / label
bun fc query owner:@alice
bun fc query label:security

# configurable 가 아직 planned 인 후보 (wiring 갭)
bun fc query configurable:planned
```

## 작성 가이드

- `purpose`: 무엇을 + 왜. 1-3줄, 마침표로 끝나는 평서문.
- `evidence.code`: 핵심 파일 경로만 (첫 1-2개가 MD 요약에 노출됨).
- `evidence.adrs`: ADR 번호 정수만(예: `[11, 17]`). `docs/decisions/`에 실제로 있어야 합니다.
- `knobs`: env 변수 이름만 (예: `QUANTA_VERIFY_GUARD`). 기본값/주석은 `notes`로.
- `deliberate_hold`: L1/L2 의식적 보류일 때만. 그 외 `null`.
- `owners` / `labels` / `depends_on` / `ui_surfaces` / `monitoring` / `modes` /
  `configurable` / `telemetry_keys` / `config_refs`: 비워두면 default 사용.
  채울 때만 `judge` 축 점수에 기여.

## CI 통합

```sh
bun fc validate     # PR 게이트
bun fc diff         # docs/10.feature-catalog.md가 stale인지 확인
```

`diff`는 mismatch 시 exit 1. CI에서 빌드 후 `git diff --exit-code docs/10.feature-catalog.md`로 stale 차단.
