# ADR-0025: Git 1급 도구 (diff/status/log/blame)

- **상태**: Accepted
- **날짜**: 2026-05-20
- **관련**: RFC-0001 §3·§6.2, ADR-0011(SOTA++ 흡수), Codex `may-20-codex-signal.md` §5/§6.1(trust ladder)

## 맥락

Codex `may-20-codex-signal.md` §6.1은 신호 trust ladder를
`source > runtime/test/build > **diff** > repo-rules > search > artifact/UI >
docs/memory`로 명시한다 — `git diff`/`git status`는 signal-trust 2위
근접인데 v3는 1급 도구가 없고 `bash`로만 도달 가능했다. 결과: model이
patch-scoping 단계에서 diff를 자주 본다고 prompt에 적시했음에도 `bash`로
가는 호출은 HARD_DENY/HITL 게이트의 path-independent 검증을 더 무겁게 받고
output cap/spill의 결정 경로가 일관되지 않았다.

## 결정

`@/tool/git/` 새 슬라이스에 4개 read-only 도구 추가:
- `git_diff({base?, paths?, staged?})` — working/staged/base 비교, exit 1
  (diff 존재) 도 ok:true로 인정
- `git_status({})` — porcelain v2 → 사람-읽기 가능한 branch + 파일 플래그
- `git_log({file?, n?})` — `hash8 (author, YYYY-MM-DD) subject`, n 기본 10,
  max 200, file 지정 시 `--follow`
- `git_blame({file, line})` — porcelain frame 파싱 → hash + author + ISO date
  + summary + line content

모두 `isReadOnly=true`, `isConcurrencySafe=true` — git의 자체 locking이
read concurrency를 보장. 의존성 주입: `GitRunner` interface — 기본
`defaultGitRunner`는 `Bun.spawn(['git', ...args])`, env scrub (API 키 미전달),
30s wall-clock. 테스트는 fake runner로 입출력 골든 + tmpdir + `git init`
fixture로 진짜 git 통합 검증.

Mutating git 작업(`commit`/`restore`/`checkout`/`push`/`reset`)은 의도적으로
**`bash`에 잔류** — HARD_DENY(`git -c`/`--exec-path`/`--config-env`) +
HITL `always-confirm` tier가 계속 게이팅. 1급 도구화는 read 4종만.

CLI 노브 `QUANTA_GIT_TOOLS=1` — 기본 OFF. 미설정 ⇒ registry byte-identical.
`git` binary 부재 시 graceful (`Bun.spawn` 실패 → `ok:false` with reason).

## 근거

- Codex trust ladder에서 diff가 signal 2위 → typed surface로 1급화 시
  output cap/spill, HARD_DENY 통과, HITL tier 결정이 도구 단위로 명확해짐.
- `bash`로의 git 호출은 셸 escaping 위험 + output 매번 재포맷팅 →
  결정론적 schema-validated tool이 안전·재현 가능.
- 신규 npm dep 0: `Bun.spawn` + `git` CLI 직접.

## 대안

- **`bash`로 유지**: 기각 — model이 매번 동일 명령 재포맷, schema 부재로
  잘못된 인자 조합 가능, output cap 경로 다름.
- **`isomorphic-git` 같은 JS git 라이브러리**: 기각 — 신규 dep 추가, native
  git의 porcelain v2/blame 포맷과 1:1 동등성 확보 비용 큼.
- **mutating git도 1급화**: 기각 — HARD_DENY/HITL 게이트는 `bash`+command
  pattern 검증으로 동작; mutating을 도구화하면 게이트 우회로(`git_commit`이
  HARD_DENY 패턴을 안 탄다) 새로 만들어야 함. read-only만 안전.

## 결과·트레이드오프

- **얻은 것**: signal-trust 2위 (`git diff`)의 1급 surface. patch-scoping
  단계의 도구 호출이 schema-검증되고 output cap의 결정 경로가 일관. 4 도구
  단위 + 통합 테스트(tmpdir + 진짜 git init) 45/0 green.
- **비용**: tool surface +4 (knob ON 시). `git` binary 부재 시 ok:false로
  graceful — 사용자에게는 명확한 reason 반환.

## 한계 (LIMITATIONS)

- **(a) read-only 한정**: mutating git은 `bash` 잔류. 도구 surface로
  치환되지 않음 — 의도적 (게이트 일관성 + HARD_DENY 패턴 보존).
- **(b) `git_diff` truncation 50_000 chars**: output-cap layer가 spill을 처리
  하지만 큰 diff는 인라인에서 먼저 잘림. paths/base 좁히기를 prompt에서
  유도.
- **(c) `git_log -n` cap 200**: 무한대 log 회수 방지. 200 초과 필요 시 `bash`로.

## 불변식 영향

- **슬라이스 격리 유지**: `@/tool/git`는 `@/shared`/`zod`만 import.
- **RFC/ADR 동기**: RFC §6.2 갱신 (4 도구 추가).
- **신규 npm dep 0**.
- **byte-identical default-OFF**: 미설정 시 registry 동형.
