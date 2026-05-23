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
├── schema.ts        zod 스키마 + 로더
├── yaml.ts          in-house mini-YAML 파서/직렬화기
├── render.ts        YAML → MD 렌더러
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

## 스키마 요약

```ts
{
  id: string                  // kebab-case unique
  title: string
  section: 1..20              // (실제 매핑: 1..10)
  subsystem: string
  order?: number              // 같은 section/subsystem 내 정렬용
  maturity: "L1"|"L2"|"L3"|"L4"|"L5"
  status?: "stable"|"new"|"refined"|"hold"|"deprecated"
  purpose: string             // 1-3 lines, "what + why"
  evidence: {
    code: string[]            // 파일 경로 (검증 대상)
    adrs: number[]            // ADR 번호만
    tests: {
      unit: string[]
      integration: string[]
      contract: string[]
    }
  }
  knobs: string[]             // env 변수 이름
  deliberate_hold: null | { reason, promotion_path? }
  notes?: string
}
```

`section` 매핑:

| # | 이름 |
|---|---|
| 1 | 에이전트 코어 루프 (ReAct) |
| 2 | 도구 시스템 |
| 3 | 권한 & 안전 |
| 4 | 컨텍스트 관리 |
| 5 | 장기 메모리 |
| 6 | Tier-1 능력 |
| 7 | 복원력 |
| 8 | 관측성 |
| 9 | 통합 (MCP/LSP/Hooks) |
| 10 | 앱/영속/정책 |

## 작성 가이드

- `purpose`: 무엇을 + 왜. 1-3줄, 마침표로 끝나는 평서문.
- `evidence.code`: 핵심 파일 경로만 (첫 1-2개가 MD 요약에 노출됨).
- `evidence.adrs`: ADR 번호 정수만(예: `[11, 17]`). `docs/decisions/`에 실제로 있어야 합니다.
- `knobs`: env 변수 이름만 (예: `QUANTA_VERIFY_GUARD`). 기본값/주석은 `notes`로.
- `deliberate_hold`: L1/L2 의식적 보류일 때만. 그 외 `null`.

## CI 통합

```sh
bun fc validate     # PR 게이트
bun fc diff         # docs/10.feature-catalog.md가 stale인지 확인
```

`diff`는 mismatch 시 exit 1. CI에서 빌드 후 `git diff --exit-code docs/10.feature-catalog.md`로 stale 차단.
