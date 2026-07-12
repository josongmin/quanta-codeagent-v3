# 05 — 즉시 수정 작업 계획서 (비-primitive)

2026-07-12. `00-final-rfc.md`(흡수 3 primitive, 미래 설계)가 **안 다루는** 영역의 즉시 착수 작업.
전부 adversarial+objective 어딧을 통과했고, 각 항목에 **걷어낸 함정**을 명시한다.
프로세스 leak 수정은 00-RFC R1(ResourceScope) 레인에 위임 — 여기선 R1이 놓친 사이트만 플래그(§WS1).

> 상태: 착수 전. 04-self-audit-and-comparison.md의 근거 기반.

## 어딧이 걷어낸 함정 4개 (먼저)

1. **정본 파괴포트는 `escalatingKill`(guarded-spawn.ts:112)이지 exec.ts:50이 아니다.** exec.ts:50은 그 자체가 반쪽 중복(signalTree+수제 grace, reaped 래치 없음). → "signalTree sprinkle" 금지, `escalatingKill` **수렴**.
2. **카세트 통째 redact = ADR-0539이 이름 대서 금지.** replay 해시가 저장된 request를 재해싱 → request scrub하면 replay 깨짐. 단 **events(응답)는 해시 대상 아님** → events-only scrubber는 hash-neutral 안전.
3. **RED 12개 중 우리 것은 1개뿐.** 나머지 11개는 t·Jo 동시세션이 driver HOT-PATH에 만든 선존 red. split하면 merge conflict/clobber. 우리 커밋(`1e7ad280f`)이 만든 건 `recordingLlmPort` 하나.
4. **observation 인터랙티브 배선은 cheap 아님** — REPL엔 issueText/localize phase 자체가 없어 seam 재사용 불가. evidence-ledger는 삭제하면 jul-5 P1 문서화 자산 낭비.

---

## WS1 — 프로세스 leak (→ 00-RFC R1에 위임, 추가 사이트만 플래그)

00-RFC Primitive A(ResourceScope)가 side-agent leak을 OS-containment로 재설계 중. **중복 구현 금지.** 이번 어딧이 찾은 것 중 R1 스코프에 **추가**할 것:

| 사이트 | 문제 | R1 반영 |
|---|---|---|
| `subagent/handlers-6.ts:377,386` exec_command | 단일-PID kill on `bash -lc` 트리. **라이브 6-tool BASE** (side-agent보다 임팩트 큼) | R1 스코프에 추가 요청 |
| `side-agent/registry.ts:195` | per-pass timeout 부재 → hang 시 슬롯 leak. 주입 `opts.setInterval`+`Promise.race([run, abortPromise])`, 새 knob 대신 `spec.passTimeoutMs?` | R1 stopgap 후보 |
| subagent 트리 토큰 예산 무한 | 누적/전파 0, depth cap만 | 별도 (예산 전파 설계) |

**stopgap(R1-full 전 즉시):** exec_command에 `escalatingKill(proc, defaultPpidWalkKiller())` drop-in. PTY-attach 정상경로는 kill 안 타니 안전, `finally`에 `disarm()`. 테스트=`process-tree-kill-hellgate.test.ts` 방식(주입 스파이 killer로 grandchild pid SIGTERM 수신 단언, fake-fork 금지).

---

## WS2 — 카세트 events-only redaction (secret, narrow)

- **seam:** `shared/trajectory.ts:194,300`의 `recordingLlmPort` 호출에 **events만 `redactValue` 적용하는 scrubber 주입**. request는 손대지 말 것(replay 해시 보존).
- **근거:** 해시 커버 필드=`messages/system/tools/thinking/toolChoice/promptCacheKey/promptCacheRetention`(jsonl-store.ts:98-106). `events`·`metadata`는 해시 밖 → redact 안전. 기존 `llm-replay-hellgate.test.ts:285`(test 12)가 이 패턴 실증.
- **안 하는 것:** request scrub(ADR-0539 금지), env-injected-secret(upstream에서 프롬프트에 secret 안 넣게 처리, 카세트 스코프 아님).
- **테스트:** events에 `sk-`/Bearer 넣고 disk 바이트 redact 확인 + `store.match(request)` 여전히 HIT(replay 결정성 보존) red-on-injection.

## WS3 — recordingLlmPort god-function split (우리 커밋만)

- `recording-llm.ts::recordingLlmPort` (113→167줄, 우리 tip `1e7ad280f`가 150 초과) — helper 추출 split. **WS2와 같은 함수**라 묶어서 처리(events-scrubber 주입 + split 동시, 우리 파일 conflict 낮음).
- god-split 워크플로(memory `god-code-ratchet-and-split-workflow`) 재사용.
- **나머지 11개 RED는 LEAVE** — t·Jo 소유 HOT-PATH(driver/·agent-arg-builder·handlers-6·run-main·brain-mode). 우리가 안 만든 선존 red, 건드리면 clobber. 소유 세션 조율 대상.
  - 저위험 예외(선택): `@/agent` control-poll.ts:125 + `@/tool` container-exec/tool.ts:50 env-boundary는 `slot.env ?? process.env` 문서화 seam → `envAllowFiles` allowlist 추가로 정직화 가능(코드 무변경). 단 Jo 소유 red를 config로 덮는 것이니 커밋에 "선존 red 정직화, 코드 미변경" 명시.

## WS4 — repo-rules 라이브 배선 (highest-ROI-lowest-risk)

- **seam:** `apps/agent/mode-presets/interactive.ts:61` `buildInteractiveBase`(async)에서
  `base.repoRules = await loadRepoRules(cwd).catch(() => undefined)`. cwd 이미 있음(`req.base.cwd ?? process.cwd()`).
- **재사용:** `loadRepoRules`(repo-rules.ts:103) 시그니처가 `AgentConfig.repoRules?`(types.ts:298)와 정확 일치. 하류(`context-assembler.ts:418`→prompt)는 이미 완결 — config만 채우면 프롬프트까지 자동.
- **검증 완료(회귀 없음):**
  - double-inject 없음: 글로벌 CLAUDE.md는 별개 `userAppend` 섹션(prompt.ts:647,681), reminder 이중주입은 `hasRepoRulesDynamic` 가드(prompt-reminders.ts:72)로 이미 억제.
  - budget 회귀 없음: project_md는 4-section 프리셋 기존 슬롯(prompt.ts:674, validateSectionsCacheBudget:685). 새 섹션 아님.
  - defang 충분: `escapeBoundary("system-reminder")`(prompt.ts:673) + loadRepoRules symlink 거부(repo-rules.ts:186).
- **갭=proof-test 부재:** interactive base 조립→`cfg.repoRules` 채워짐→context-assembler 전파→`systemLayout==="four_section"`+project_md 섹션 존재 assert. red-on-injection: 위조 `<system-reminder>` escape 확인.
- **비용:** ~5줄 + 테스트. 재발명 0.

## 명시적으로 안 하는 것 (이번 스코프)

- **evidence-ledger** — 삭제❌(jul-5 P1 문서화 자산 25 tests), 이번 wire도❌. `docs/plans/jul-5-sota-runtime-kernel/`의 P1 3-스텝(working-state digest / turn-closeout ingest / context-assembler render)으로 별도 티켓. wire 시 load-bearing seam=turn-closeout ingest→`contradictions()` 배너.
- **observation 인터랙티브 배선** — 전제(issueText/localize phase) 부재로 불가. 대신 bench에 `onObservationBundle` 공급자 배선해서 **efficacy 측정 레일부터**(config-build.ts/knobs-bench.ts). 측정 전 "차별점" 주장 중단.
- **11개 선존 RED / driver HOT-PATH split** — 동시세션 소유, clobber 위험.
- **카세트 request scrub** — ADR-0539 금지.

## 순서 & git-safety

1. **WS4 (repo-rules)** — 독립·저위험·유저가시효과 즉시. 먼저.
2. **WS1 stopgap (exec_command escalatingKill)** — 라이브 hot-path leak.
3. **WS2+WS3 (카세트 events-scrubber + recordingLlmPort split)** — 같은 함수, 묶어서.
4. WS1 registry timeout → side-agent(default-OFF)는 00-RFC R1 대기.

파일 disjoint(interactive / handlers-6 / trajectory·recording-llm)라 서로 conflict 없음.
**git:** main이면 브랜치부터, 커밋 직전 `git rev-parse HEAD` 재확인, `git add -u` 금지·내 파일만 명시 add,
착수 직전 handlers-6 `git log -1` 재확인(활발한 파일). ref rewrite 금지.

## Acceptance (전부 default-safe)

- WS4: repo AGENTS.md가 실제 모델 프롬프트에 등장(proof-test green), 기존 프롬프트 스냅샷 회귀 0.
- WS2: 카세트 events redact + replay 결정성 보존(match HIT).
- WS3: `bun test god-code-ratchet` 에서 recordingLlmPort 위반 해소(우리 것만), 나머지 11 RED는 unchanged(우리 소관 아님 명시).
- WS1 stopgap: exec_command timeout/abort 시 grandchild reap 증명(스파이 killer red-on-injection).
