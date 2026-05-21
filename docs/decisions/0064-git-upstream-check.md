# ADR-0064: git_upstream_check — upstream 분기 감지 read-only 도구 (v0.dev chat=branch 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-21
- **관련**: ADR-0025(git read-only 1급 도구), ADR-0053(git mutating 도구), `v0-dev-feature-review.md` §S급-8(chat = GitHub branch).

## 맥락

v0.dev는 chat을 GitHub branch에 매핑하고 `upstreamChanges`를 감지해 fork/sync 흐름을 제공한다(번들 string + `v0-git-base/head/org/repo` localStorage). v3 git 슬라이스는 status가 ahead/behind를 파싱하지만 upstream 분기를 명시적으로 "당겨야 한다"고 알려주는 액션 surface가 없었다.

## 결정

신규 read-only·concurrency-safe 도구 `git_upstream_check`(`src/tool/git/upstream.ts`), `status.ts` 형태 미러:

- `git rev-parse --abbrev-ref --symbolic-full-name @{upstream}` — upstream ref(미설정 graceful).
- `git rev-list --left-right --count HEAD...@{upstream}` — ahead/behind 카운트.
- 출력: `Branch X → upstream Y: ahead N, behind M` + behind>0 시 "upstream has N new commit(s); consider pulling".
- `gitTools()` 7번째 read-only로 등록. `MUTATING_TOOL_TABLE`에 `git_upstream_check: null`.

## 근거

- **fetch 안 함(의도적)**: read-only·concurrency-safe 유지 — 권한 게이트 무관. fetch는 사용자 별도 결정.
- **ahead/behind 액션화**: stale base 위에서 작업 방지(v0 upstreamChanges 의도).
- **table 등록 강제**: `mode-mutating-table.test.ts`가 모든 등록 도구의 명시 분류를 요구 — null로 등록.

## 대안

- **status에 통합**: 기각 — 관심사 분리, concurrency-safe 독립 호출.
- **fetch 후 비교**: 기각 — read-only 깨짐, 권한 게이트 필요.

## 결과·트레이드오프

- **얻은 것**: upstream 분기 가시화 + pull 액션 신호. 11 unit green. gitTools 7+2=9.
- **비용**: tool surface +1 (`QUANTA_GIT_TOOLS` 활성 시).

## 한계 (LIMITATIONS)

- (a) fetch 미수행 — 마지막 fetch 이후 원격 갱신 안 보임(의도적).
- (b) upstream 미설정 브랜치 graceful no-op.

## 불변식 영향

- **byte-identical default**: `QUANTA_GIT_TOOLS` 미설정 시 registry 무변경.
- **슬라이스 격리 유지**.
- **read-only 보존**: 네트워크·index mutation 0.
