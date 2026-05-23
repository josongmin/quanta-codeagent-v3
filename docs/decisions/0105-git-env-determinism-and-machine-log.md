# ADR-0105: Git env determinism + US-separator log format (Codex §18.7 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0107(`GitBudget` capture budget, 같은 batch), ADR-0025(git 1급 도구), Codex §18.7
- **참조**: `src/tool/git/runner.ts`(`buildGitEnv` + `DETERMINISTIC_ENV`), `src/tool/git/log.ts`(US-separator), `tests/unit/git-env-and-budget-hellgate.test.ts`(HELL-1~10)

## 맥락

Codex §18.7: "GIT_OPTIONAL_LOCKS=0 + 머신 파싱 log format"
- `GIT_OPTIONAL_LOCKS=0` — git의 advisory lock 회피(`git status`가 인덱스 refresh로 lock 잡음 ↔ 사용자 interactive shell과 contention)
- `GIT_PAGER=cat` / `PAGER=cat` — 비-TTY 자식 프로세스에서 `less` hang 회피
- `LC_ALL=C` — locale-independent 출력
- `TERM=dumb` — color escape 무력화
- `GIT_TERMINAL_PROMPT=0` — credential prompt 안 함 (clean fail)

또한 머신 파싱 format: `%H%x1f%ct%x1f%s` US-separator(`\x1f`, 0x1f). TAB은 commit subject에 합법(드물지만 가능)이라 split 위험.

기존 `git/runner.ts`는 env pass-through만 — 결정성 미보장.
기존 `git/log.ts`는 TAB-separator(`%x09`) — subject에 TAB이 있으면 parser break.

## 결정

### Part A — `src/tool/git/runner.ts`

`DETERMINISTIC_ENV` 정의(6 키 hard-set). `buildGitEnv()` 함수가 ALLOWED pass-through + deterministic 덮어쓰기. export 노출(테스트 접근).

### Part B — `src/tool/git/log.ts`

`buildArgs`에 `--no-textconv --no-ext-diff` 추가(`.gitattributes` textconv driver 영향 차단). format string `%H%x09...` → `%H%x1f%an%x1f%ai%x1f%s`. `formatLine`도 `\x1f` split. US_SEP 상수 export(format-string과 lock-step).

### Part C — hellgate

`buildGitEnv()` 직접 호출해 6 deterministic env 검증 + PATH/HOME pass-through 검증. log argv `--format=%H%x1f%an%x1f%ai%x1f%s` 매치 + US-separated 출력 파싱 + subject에 TAB 들어가도 break 안 함.

## 결과

- 17 hellgate(B3 6 env + B3 3 log + B5 8 budget) 통과.
- 기존 9 git 도구는 자동으로 deterministic env 받음(runner.ts 단일 변경점).
- `git_log` 출력 byte-identical near-identical(commit subject 형식만 변경 — TAB → US 내부 split).

## 한계

- US-separator(`\x1f`)는 거의 모든 텍스트에서 안 나타나지만 100% 보장 안 됨 — commit message에 의도적으로 0x1f 넣은 공격자는 conceivable but practically nil.
- `--no-textconv --no-ext-diff`는 `git log` 자체에는 영향 없음(default off) — 미래 attributes-based config에 대한 belt-and-suspenders.
- `GH_TOKEN` 같은 git-extension env는 본 module 비범위 — `gh` runner는 별도(`src/tool/gh/index.ts`).
