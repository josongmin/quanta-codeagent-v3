# ADR-0528: Crash-resume LIVE 배선 (§13.2 승급) — 턴-경계 마커 + 재시작 offer + 스트리밍 partial 신선도

- **상태**: Proposed
- **날짜**: 2026-06-09
- **슬라이스**: 배선만(NEW 슬라이스 없음) — `@/agent/loop/turn-iteration`(turn-start mark + interrupt mirror + clean-end clear) · `@/agent/loop/turn-loop`(완료-경계 clear) · `@/apps/cli/repl`(bootstrap: detect→offer→prompt→re-inject). 스트리밍 partial은 `@/agent/loop/stream-consume` seam 1곳.
- **게이트**: `QUANTA_CRASH_RESUME`(ADR-0525가 정의, default-OFF) 재사용 + 신규 `QUANTA_CRASH_RESUME_PARTIAL`(L3 스트리밍 partial 갱신, default-OFF).
- **관련**:
  - 승급 대상: **ADR-0525**(crash-resume 모듈 mark/clear/detect/offer/message + §13.2 승급경로 정의 — "현재 unwired (built-but-not-wired)" 명시). 본 ADR이 그 승급경로 ①②를 구현.
  - 재사용(신축 금지): `src/agent/interrupted-turn.ts`(§11.5 in-process 모델 — `captureInterruptedTurn`/`buildResumeMessage`) · `src/agent/loop/turn-iteration.ts:59`(in-process `interruptedTurnBuffer.capture` 사이트) · `src/agent/loop/turn-iteration.ts:123`(`turn_start` hook) · `src/agent/loop/control-poll.ts:39`(resume 재주입 선례) · `src/apps/cli/repl.ts`(`bootstrapSession`) · ADR-0494 elicitation / `confirmTrust` TTY-guarded readline(operator prompt seam)
  - 메모리: `jun-09-integration-audit-3round`(§13.2 built-not-wired 플래그), `agent-state-observability-northstar`(crash 후 "뭐 하다 멈췄나" = 북극성)

## Context

ADR-0525가 crash-resume 영속 레이어(`src/session/crash-resume.ts`)를 **모듈로 완성**했다: `markSessionInterrupted`/`clearSessionInterrupted`/`detectInterruptedSessions`/`buildCrashResumeOffer`/`buildCrashResumeMessage` — 전부 NEVER-throws·default-OFF·pure-where-possible, `tests/integration/crash-resume-hellgate.test.ts`로 봉인. **그러나 라이브 호출자가 0개 = dead code.** `grep -rn markSessionInterrupted src/` → crash-resume.ts/index.ts 외 매치 없음.

0525가 승급경로를 이미 적었다: ① 호스트 restart bootstrap이 `detectInterruptedSessions`→`buildCrashResumeOffer` 호출 + operator prompt, ② turn 경계서 mark/clear. 본 ADR은 그 배선을 SOTA++로 — **언제 mark/clear, partial 신선도를 어떻게 churn 없이 확보, operator에 어떻게 surface**를 결정한다.

§11.5 in-process `InterruptedTurnBuffer`는 단일 프로세스 내 interrupt만 복원한다. **하드 크래시**(SIGKILL/OOM/전원)는 그 버퍼를 통째로 잃는다 — 디스크 마커가 유일한 durability. 0525의 마커는 §11.5와 동형 데이터(`PersistedInterruptedTurn` = userText/partialAssistantText/reason/interruptedAt)를 `SessionMeta.interruptedTurn`에 piggyback한다(별도 파일 X).

경쟁사 베이스라인:
- **Codex**: rollout JSONL append-only — 크래시 시 마지막 이벤트까지 남고 resume가 replay. 항상-on, 세션당 파일, write 쌈.
- **Claude Code**: `--resume`/`--continue` — transcript 영속, 크래시 mid-turn 시 user 메시지는 있고 assistant 미완 → resume가 재실행.
- **흡수**: Codex의 durability(마커 영속) + CC의 깔끔한 re-injection(`role:"user"` continuation). quanta는 snapshot-piggyback(인덱스/백업/retention 한 경로 유지) + LLM-친화 resume 메시지로 둘을 합친다. 단 quanta snapshot은 **rewrite**(append 아님)라 write 비용이 Codex보다 커 → default-OFF opt-in이 정당.

## Decision

### L1 — 턴-경계 마커 (mark at start · clear at clean end · mirror at interrupt)

```
turn-loop.ts:65  for (turn = 1 .. maxTurns)
  └ turn-iteration.ts:123  turn_start hook
        ├─[NEW] markSessionInterrupted(sessionId, {userText, partial:"", reason:"in-progress", at:clock()})
        │        userText = latestUserTextFromWm(wm).  gate OFF ⇒ 즉시 no-op(0525 계약).
        ├ ... 스트리밍 ...
        └ turn-iteration.ts:59  finish_aborted(인터럽트)
              ├ interruptedTurnBuffer.capture(...)          ← 기존 in-process
              └─[NEW] markSessionInterrupted(sessionId, captureInterruptedTurn(...))  ← 디스크 mirror(partial 포함)
  └ 정상 종료(finish/완료 카테고리, turn-loop/entry.ts)
        └─[NEW] clearSessionInterrupted(sessionId)
```

- **turn START**: `turn_start` hook 직후 마커 박음 — userText는 이미 wm에 있어 task-intent durability가 가장 빠르고 단순. clock 주입(0525 계약).
- **clean turn END**: 루프가 정상 종료(error/aborted 아님)할 때 clear. 동일 sessionId.
- **interrupt mirror**: `finish_aborted` 분기서 in-process capture와 **같은 자리** 디스크 mirror — clean interrupt 직후 크래시해도 partial 포함 마커가 남는다.
- 비용: gate ON일 때 turn당 +1 snapshot save(시작) + 1(종료). **gate OFF ⇒ 0 write/0 read(byte-identical)**.

### L2 — 재시작 detection + operator offer (bootstrap 배선)

- `repl.ts` `bootstrapSession` 진입(세션 활성화 전): `detectInterruptedSessions(listSessions({includeArchived:false}), {env, provider})`. 결과 있으면 most-recent-first로 각 `buildCrashResumeOffer`.
- **operator prompt seam**: `confirmTrust`류 TTY-guarded readline(또는 ADR-0494 elicitation) 재사용. **headless/CI는 never block** — non-TTY면 offer 자동 skip(마커 보존, 다음 인터랙티브 세션에 재offer).
- accept ⇒ 해당 세션 로드 + `offer.resumeMessage`를 `role:"user"`로 첫 턴에 주입(control-poll resume 경로와 동형) + `clearSessionInterrupted`(consume). decline ⇒ 마커 유지. "discard" ⇒ clear.
- 다중 후보: most-recent 1개만 offer(나머지는 `/state`/`/sessions`에 배지) — 부팅을 prompt 폭탄으로 만들지 않음.

### L3 — 스트리밍 partial 신선도 (SOTA++, 별도 게이트 `QUANTA_CRASH_RESUME_PARTIAL`)

문제: L1은 turn-start에 `partial:""`만 박음 → 크래시 시 **task intent(userText)는 복구되나 진행분은 빈 채**. in-process 버퍼는 partial을 live로 들지만 디스크 per-token flush는 snapshot churn.

- 결정: **per-token flush 금지**(churn + 무의미). **이벤트-구동 debounced flush** — assistant 출력이 자연 경계를 넘을 때(직전 flush 이후 새 assistant *메시지* 완성, 또는 compaction 이벤트처럼 **이미 세션을 건드리는 write에 piggyback**)만 `marker.partialAssistantText` 갱신.
- **임의 N초/N토큰 임계값 금지**([[no-heuristics-only-validated]]) — 갱신 트리거는 기존 write 이벤트에 올라타거나, 주입된 `PartialFlushPolicy` 포트(테스트가 결정)로. 매직넘버 도입 시 ratchet RED.
- 별도 게이트 default-OFF: L1/L2만으로 task-intent 복구는 동작. partial 신선도는 write 비용 opt-in.

## 아키텍처 불변식 (ratchet으로 봉인)

1. **default-OFF byte-identity**: `QUANTA_CRASH_RESUME` OFF ⇒ mark/clear/detect 전부 0-write/0-read NO-OP(0525 계약). 게이트-off 회귀 테스트로 봉인.
2. **NEVER-throws on hot path**: mark/clear 실패가 라이브 턴을 못 깬다(마커는 durability지 correctness 아님, 0525). 배선부도 swallow.
3. **clear ⊇ mark (no stale marker)**: mark된 모든 경로는 대응 clear가 존재(정상종료 OR resume-consume OR operator-discard). hellgate: mark N회 → 정상종료 N회 후 `detectInterruptedSessions`=[]. 미스매치 = stale 마커 누적 → RED.
4. **headless never-block**: bootstrap offer는 TTY-guarded, non-TTY는 자동 skip + 마커 보존. CI 부팅 무행무크래시.
5. **resume 메시지 동형**: `buildCrashResumeMessage`(디스크) ≡ `buildResumeMessage`(§11.5 in-process)와 framing 동일 — 두 경로가 드리프트하면 ratchet RED.

## 단계

- **P0 (L1+L2, gate `QUANTA_CRASH_RESUME`)**: turn-경계 mark/clear + interrupt mirror + bootstrap detect→offer→prompt→re-inject. ~4파일 배선. TDD: `crash-resume-hellgate`(0525가 이미 보유)를 **LIVE 경로**로 확장 — interrupt→persist→CRASH(프로세스 시뮬)→restart→detect→offer→resume 풀경계 + headless-skip + clear-on-resume + clear⊇mark stale-가드. red-first.
- **P1 (operator UX)**: offer를 surface-agnostic 이벤트로(`/state` 배지 + web/IDE 카드). north-star(crash 후 "뭐 하다 멈췄나") 노출.
- **P2 (L3, gate `QUANTA_CRASH_RESUME_PARTIAL`)**: 이벤트-구동 partial flush + flush-policy 포트 + 매직넘버-금지 ratchet.

각 단계 독립 PR. P0이 단독으로 "크래시 후 끊긴 작업 이어받기"를 라이브화.

## Default posture / 안전성

- 전부 default-OFF. OFF면 ADR-0525와 byte-identical(세션 파일 pre-ticket 형태).
- 마커 = durability, NOT correctness — 실패해도 턴 안 깨짐.
- headless/CI: offer 자동 skip(블록 X), 마커는 다음 인터랙티브 세션까지 보존.
- 보안: resume 메시지는 신뢰된 자기-세션의 직전 user 입력 재주입(외부 입력 아님). 마커는 자기 세션 snapshot에만 기록.

## 대안 (기각)

- **별도 sidecar 마커 파일**(snapshot 대신): per-token flush를 싸게 → 하지만 0525가 "no new on-disk file"로 snapshot 재사용을 결정(인덱스·백업·retention 단일 경로). 유지.
- **LLM stream 시작 시 mark**(turn-start 대신): mark 직전 크래시 윈도우는 작아지나 userText는 이미 wm에 있어 turn-start mark가 더 단순+빠른 durability. turn-start 유지.
- **always-on(게이트 제거)**: 매 턴 +2 snapshot save = hot-path 비용. Codex는 append-only라 쌈, quanta snapshot은 rewrite라 비쌈 → default-OFF opt-in.
- **resume를 자동 재실행**(prompt 없이): 크래시 원인이 그 턴일 수 있어(OOM 유발 프롬프트) 자동 재실행은 크래시 루프 위험. operator offer 경유.
