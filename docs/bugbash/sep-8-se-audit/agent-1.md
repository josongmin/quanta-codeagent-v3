# Sep-08 SE audit — agent-1 재검증 결과

> 기준: `f5f4875799141068af73e604129c8b9a09f76007` (`origin/main`과 동일)
> 범위: lane G (`src/apps`, `src/host`, `src/sdk`, `src/ui`, `src/workflow`, `src/scheduler`, `src/reactor`, `src/observability`, `src/radar`)
> 처분 원칙: 현재 소스에서 실제 producer → consumer 경로와 실패 효과가 확인되는 미해결 항목만 유지한다.

## 유지 항목

| ID | Sev | 실제 실패 효과 |
|---|---:|---|
| G-F5 | P1 | ProMax 박스 bootstrap이 family setup 전에 반환되고, 그 박스는 warm-box probe도 영구 통과하지 못한다. |
| G-F9 | P1 | 제품 CLI가 Docker/Lima runner seam을 주입하지 않아 두 backend를 선택해도 항상 `remote-not-configured`가 된다. |
| G-F4 | P2 | 프로세스가 claim 후 죽으면 automation row가 `running`에 영구 고정된다. |
| G-F6 | P2 | eval만 `.env` precedence가 다른 실행 surface와 반대다. |
| G-F11 | P2 | CLI/web skill authority에서 조직 admin policy와 admin skills가 영구 비활성이다. |
| G-F12 | P2 | 소켓을 유지한 turn abort가 pending `request_user_input`/`ask_user` resolver를 남긴다. |
| G-F15 | P2 | unpriced eval usage가 보고서에서 실제 `$0` 측정값처럼 표시된다. |
| G-F8 | P3 | CLI permission-store load 실패가 무경고 in-memory posture fallback으로 바뀐다. |
| G-F13 | P3 | `apps/agent`의 repo-rules load 실패가 무경고로 규칙 없는 prompt를 만든다. |

### G-F5 [P1] ProMax bootstrap과 warm-box readiness 계약 분열

- 근거: `src/apps/bench/remote/box-session/ec2-lifecycle.ts:483-491`의 `boxGrade` 분기가 반환하므로 `setupBoxForFamily`(`:520-526`)를 건너뛴다. 동시에 `isBootstrapped`(`:711-715`)는 모든 family에 `~/swebench-python`을 요구한다.
- 도달 경로: `src/apps/bench/remote/full.ts:542-549`와 `src/apps/bench/remote/pool/launch-window.ts:80-92`가 `findIdleBox`; `ec2-lifecycle.ts:785-792`가 위 probe 실패 박스를 제외한다.
- 트리거/영향: ProMax 신규 provision은 family setup 미실행. 살아 있는 박스는 재사용되지 않으면서 single-box guard는 신규 launch를 거부한다.
- 최소 수정/rail: grading shim skip만 family-aware하게 유지하고 family setup을 반환 밖에서 실행한다. readiness probe도 family profile 기준으로 만들고 `boxGrade` family bootstrap + warm reuse를 RED로 고정한다.

### G-F9 [P1] Docker/Lima remote backend의 production seam 미배선

- 근거: 유일한 production 선택자는 `src/apps/cli/index.ts:95-101`에서 `selectRemoteRunner(process.env, {})`를 호출한다. registry는 Docker에는 `dockerProcess`, Lima에는 `limaProcess`와 `limaVm`이 없으면 `null`을 반환한다(`src/remote/runner/registry.ts:47-52,62-78`).
- 트리거/영향: `QUANTA_REMOTE_RUNNER=docker|lima`로 `quanta remote` 실행 시 backend adapter에 도달하지 않고 exit 64 `remote-not-configured`.
- 최소 수정/rail: CLI composition root에서 Node process adapter와 Lima VM 설정을 주입한다. 실제 route가 각 factory를 선택하는 integration rail을 추가한다.

### G-F4 [P2] live ticker의 stale claim 복구 미사용

- 근거: engine port는 `claim(now, { reclaimBefore })`를 지원한다(`src/scheduler/automation-engine/port.ts:205-220,232-235`). `TickOpts`에는 reclaim 입력이 없고 실제 ticker는 `engine.claim(now)`만 호출한다(`src/scheduler/automation-engine/ticker.ts:77-90,110-123`).
- 트리거/영향: claim과 finalize 사이 프로세스 종료 시 durable row가 `running`으로 남고 이후 tick에서 다시 선택되지 않는다.
- 최소 수정/rail: composition에서 정한 stale window를 ticker의 claim에 전달한다. restart 후 stale row는 재claim되고 fresh/live claim은 건드리지 않는 engine+ticker rail이 필요하다.

### G-F6 [P2] eval dotenv precedence 역전

- 근거: CLI와 agent는 `.env.dev → .env.local → .env` first-wins(`src/apps/cli/index.ts:30`, `src/apps/agent/index.ts:31`), bench도 동일하다(`src/apps/bench/run-main.ts:831-834`). eval만 `.env → .env.local → .env.dev`다(`src/apps/eval/index.ts:165-174`).
- 트리거/영향: 같은 checkout과 shell에서 eval provider/model/credential 설정이 다른 surface와 다르게 해석된다.
- 최소 수정/rail: eval도 shared env loader/동일 순서를 사용하고, 세 파일에 충돌 값을 둔 precedence test를 추가한다.

### G-F11 [P2] CLI/web skill org policy 미배선

- 근거: 두 composition root 모두 `snapshotInputs`에 user dir만 전달한다(`src/apps/cli/repl/session-setup.ts:350-363`, `src/apps/web-daemon/authority-readouts.ts:97-110`). builder는 입력이 없으면 `orgConfigDir`를 `null`로 내려 admin policy를 비활성화한다(`src/runner/assemble/session-authorities/build-skills.ts:68-80`).
- 트리거/영향: `QUANTA_ORG_CONFIG_DIR` 또는 기본 org 디렉터리에 `org-policy.json`/`admin-skills`가 있어도 CLI/web active skill set과 banned/required enforcement에 반영되지 않는다.
- 최소 수정/rail: composition root에서 org dir을 한 번 resolve해 `snapshotInputs.orgConfigDir`에 전달한다. 실제 temp org policy가 CLI/web authority의 active/policy projection을 바꾸는 integration rail을 추가한다.

### G-F12 [P2] turn abort 시 web user-input resolver 누수

- 근거: requester는 신호 입력 없이 resolver를 Map에 저장한다(`src/apps/web-daemon/web-user-input-port.ts:118-137`). `cancelAll()` production 호출은 socket close 경로뿐이며 소스도 turn-abort 잔여를 명시한다(`src/apps/web-daemon/server/ws-handlers.ts:500-510`).
- 트리거/영향: 연결을 유지한 상태에서 pending `request_user_input`/`ask_user` turn을 abort하면 promise와 pending entry가 다음 answer/close까지 남는다.
- 최소 수정/rail: shared-session의 `turn.aborted|failed|completed` terminal event에서 해당 turn의 pending request를 cancel한다. 소켓 유지 + abort 후 promise settled/pendingCount 0을 검증한다.

### G-F15 [P2] eval unpriced usage를 `$0`로 표시

- 근거: token이 있으면 record count는 증가하지만 `costUsd`가 없으면 합산만 생략한다(`src/apps/eval/report/coverage-matrix.ts:123-135`). rollup 기본은 0(`:185-195`)이고 markdown/headline은 항상 `$...`를 출력한다(`src/apps/eval/report/markdown.ts:41-49,71-75`).
- 트리거/영향: price table에 없는 model의 실제 token usage가 `Estimated cost: $0.0000`로 표시되어 미측정과 무비용을 구분할 수 없다.
- 최소 수정/rail: `unpricedRecords` 또는 pricing completeness를 rollup에 보존하고, 전부/일부 unpriced인 보고서가 `$0` 단독 표기를 하지 않게 고정한다.

### G-F8 [P3] CLI permission-store fallback 무관측

- 근거: CLI loader는 모든 예외를 무경고 `undefined`로 바꾼다(`src/apps/cli/repl.ts:288-295`). 동일 store를 쓰는 web loader는 durable posture가 사라졌음을 경고한다(`src/apps/web-daemon/runtime-factory.ts:272-282`).
- 트리거/영향: 권한/읽기 실패 시 CLI는 durable permission posture 대신 seed를 쓰지만 운영자가 그 전환을 알 수 없다.
- 최소 수정/rail: fail-soft는 유지하고 오류와 store path를 경고한다. loader rejection → warning 1회 + `undefined`를 고정한다.

### G-F13 [P3] agent preset repo-rules fallback 무관측

- 근거: `resolveModePresetRepoRules`는 `loadRepoRules(cwd)` 실패를 무경고로 삼킨다(`src/apps/agent/mode-presets/system.ts:42-49`). web의 같은 interactive-class 경로는 cwd와 오류를 경고한다(`src/apps/web-daemon/runtime-factory/agent-config-base.ts:228-238`).
- 트리거/영향: 읽기/parse 실패 시 agent prompt에서 repo 규칙이 사라져도 로그가 없다.
- 최소 수정/rail: fail-open 정책은 유지하고 경고 sink를 주입/호출한다. 실패 시 규칙 없음 + 경고 1회를 고정한다.

## 검증

- `git rev-parse HEAD` → `f5f4875799141068af73e604129c8b9a09f76007`
- `git diff --name-only 9b05cd33..HEAD -- src` → 없음. 최초 dump 이후 현재 HEAD까지 제품 소스는 동일하다.
- 정적 producer/consumer census: `selectRemoteRunner`, `findIdleBox`, `claim(reclaimBefore)`, `buildSkillRuntimeAuthority`, `cancelAll`, eval cost rollup, permission/repo-rule loaders.
