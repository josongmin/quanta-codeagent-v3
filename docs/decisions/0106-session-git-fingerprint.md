# ADR-0106: SessionMeta git fingerprint (Codex §18.9 흡수)

- **상태**: Accepted
- **날짜**: 2026-05-23
- **관련 ADRs**: ADR-0034(SessionMeta 스키마), ADR-0102(turn_diff_updated event — git SHA 활용 사촌), Codex §18.9
- **참조**: `src/session/types.ts`(`SessionMeta` 확장), `src/session/envelope.ts`(`SessionMetaRecordSchema` 확장), `src/session/git-fingerprint.ts`(`captureGitFingerprint`), `tests/unit/git-fingerprint-hellgate.test.ts`(10 적대)

## 맥락

Codex Desktop은 `threads` 테이블에 `git_sha + git_branch + git_origin_url` 컬럼을 영구화 — 모든 thread가 어느 commit에서 시작됐는지, 어느 branch였는지, 어느 origin remote였는지 기록한다. trajectory replay / debugging / reproducibility의 기반.

quanta `SessionMeta`는 `cwd`만 — git 컨텍스트 부재. 동일 cwd에서 다른 branch checkout / rebase / commit 이력은 session 메타만으로 복원 불가.

## 결정

### Part A — `SessionMeta` 확장(`src/session/types.ts`)

3 optional 필드 추가:
- `gitSha?: string`
- `gitBranch?: string`
- `gitOriginUrl?: string`

각 필드 독립 — 분리된 HEAD는 SHA 있되 branch 없고, local-only repo는 branch 있되 originUrl 없고, non-git cwd는 셋 다 없음. 누락 ≠ 에러.

### Part B — `SessionMetaRecordSchema` 확장(`src/session/envelope.ts`)

`.strict()` schema에 `git_sha`/`git_branch`/`git_origin_url` optional 추가. `.strict()`은 unknown key 거부지만 optional missing은 OK — backward compat 유지.

### Part C — `captureGitFingerprint` 모듈(`src/session/git-fingerprint.ts`)

closed-port — injected `GitRunner`. 3 query 독립 실행:
- `git rev-parse HEAD` → sha
- `git rev-parse --abbrev-ref HEAD` → branch (`HEAD` 리터럴은 detached 신호 → drop)
- `git config --get remote.origin.url` → originUrl

각 query try/catch 별도 — 한 query 실패가 나머지를 cancel 안 함. signal 전파.

## 결과

- 10 hellgate 통과: full fingerprint / detached HEAD / no remote / not a git repo / spawn error 격리 / 빈 stdout / whitespace trim / `HEAD` literal drop / 3 query 모두 issue / signal 전달.
- session start 시 wiring은 follow-up — 본 ADR은 contract만(loop M state 회피).

## 한계

- `origin` 이외 remote(예: `upstream`, `myfork`)는 미커버 — 첫 remote만 봄.
- worktree 환경에서 `git rev-parse HEAD`는 worktree의 HEAD 반환(메인 repo와 다를 수 있음) — 의도된 동작.
- session 메타는 한 번 캡처되고 변하지 않음 — turn 중간 branch switch / commit은 별도 `turn_diff_updated` event(ADR-0102)가 추적.
- privacy: origin URL은 종종 SSH/HTTPS auth 포함 — schema는 raw string 그대로(scrubbing은 사용자 책임).
