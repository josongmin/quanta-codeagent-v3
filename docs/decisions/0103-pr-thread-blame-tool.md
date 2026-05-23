# ADR-0103: `gh_pr_blame` — PR review-thread blame (Cursor `StreamCodeTour.Blame` 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0104(gh PR typed tools, 같은 batch — review-diff/auto-merge/draft), ADR-0025(`git_blame` 도구), Cursor `StreamCodeTour.Blame`
- **참조**: `src/tool/gh/index.ts`(`ghPrBlameTool`), `tests/unit/gh-pr-tools-hellgate.test.ts`(HELL-1~10 = 10 적대)

## 맥락

`git blame`은 "이 라인을 누가 마지막에 만졌나"를 답한다. Cursor `StreamCodeTour.Blame`은 한 단계 더 — "이 라인에 대해 reviewer들이 뭐라고 했나" — PR review-thread 코멘트를 file:line 앵커에 매핑해서 보여준다. 큰 refactor PR에서 reviewer 부담이 크게 감소.

기존 우리 `git_blame`은 commit-only. PR 토론 thread 미연결.

## 결정

`src/tool/gh/index.ts`에 `ghPrBlameTool` 추가:

- 입력: `pr` (number 또는 URL), optional `file` 필터, optional `line` 필터(±5 라인 proximity)
- 호출: `gh pr view <ref> --json url,headRefName,baseRefName,reviewThreads`
- 파싱: 각 reviewThread에서 `path`/`line`/`originalLine`/`isResolved`/`isOutdated`/`comments[].author/body` 추출
- 출력: `[N] path:line (tags) \n  @author: body` 형식, attribution 명확

read-only, concurrency-safe. 기존 `GhRunner = (argv, cwd, timeoutMs) => Promise<{code, stdout, stderr}>` 함수형 runner 패턴 답습(slice 내 다른 도구와 일관).

PR ref normalization은 기존 `normalizeRef`(leading-`-` 거부 = 보안). 외부 GraphQL 호출은 안 함 — `gh pr view --json reviewThreads`가 GraphQL 우회해 단일 JSON 반환.

## 결과

- 10 hellgate 통과: argv 정확성 / 결과 렌더링 / tag 표시 / file 필터 / line proximity ±5 / 빈 thread / GraphQL connection shape(`nodes`) / non-JSON / gh stderr / leading-dash refspec 거부.
- `ghTools()` factory에 추가 — 9개로 확장(기존 6 + B1 1 + B2 2 신규).

## 한계

- ±5 라인 proximity는 hard-coded(설정 미지원). PR comment anchor가 이동했을 때 매치 누락 가능 — outdated tag로 surface.
- 이미지/file-level comment(라인 anchor 없음)는 미처리 — `(file unknown)` / `?` 출력.
- `gh` 인증 / 네트워크 의존 — 미인증 시 stderr 직접 노출.
