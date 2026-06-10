# E2E 헬게이트 확장 백로그 (2026-06-10)

베이스라인: [e2e-test-catalog.md](e2e-test-catalog.md) 195개. 4렌즈 병렬 갭사냥(미커버 모듈 / 조합 매트릭스 / 표면 격차 / 적대패턴 비대칭) 후 **각 주장을 grep+read로 교차검증**해 거짓양성을 제거한 결과만 수록.

## 검증으로 쳐낸 거짓양성 (착수 금지)
- **crash-resume e2e 없음** → 거짓. `tests/integration/crash-resume-wire-hellgate.test.ts`가 10케이스(LIVE chokepoint·auto-reinject·L3 partial·default-OFF)로 이미 봉인.
- **cross-platform shell discovery(ADR-0529)** → `src/runtime/shell-discovery.ts` 미존재. 빌드 안 된 기능은 테스트 대상 아님.
- **notebook-edit·DAP·language-detect "0 테스트"** → 과장. 셋 다 unit+hellgate 보유. 단 **에이전트 루프 통합 e2e**는 부재(아래 P2에 정확히 반영).

---

## P0 — 보안/데이터무결성, 실재 확인됨

### H1. trust-scope 파일 레지스트리 2-프로세스 동시 grant (TOCTOU)
- **실재 근거**: `tests/unit/permission/trust-scope-store-hell.test.ts`에 `Promise.all`/`fork`/`spawn` 전무 — 순차 쓰기만 검증. 권한 grant 영속은 read-modify-write.
- **시나리오**: 두 자식 프로세스가 동시에 `grant(actionKey-A)`/`grant(actionKey-B)` → 부모 rehydrate → **둘 다 persist됐는지**(atomic rename/락) 검증. last-write-wins면 권한 결정 유실 → 게이트 우회.
- **잡을 버그**: 권한 결정 TOCTOU 유실.

### H2. config 마이그레이션 .claude 트리 심링크 탈출
- **실재 근거**: `config-migration-persist-harden-hellgate`는 code-exec guard·atomic write·corrupt-target만. 심링크 traversal 케이스 없음. fs-jail/mention은 심링크 방어가 있는데 마이그레이션 쓰기경로는 비대칭.
- **시나리오**: `.claude/hooks.json`을 `/tmp/evil` 또는 `~/.ssh/`로 심링크 → migrate persist → **jail되어 follow 안 하는지**. 따라가면 임의 파일 overwrite.
- **잡을 버그**: 설정 트리 심링크를 통한 path-traversal write.

### H3. 네트워크 프록시 env가 MCP stdio 자식에 미도달
- **실재 근거**: `src/mcp/transports/stdio.ts`는 "full parent env intentionally NOT inherited"라 PATH만 명시 구성 — `proxyEnv` 주입 경로 없음. bash/docker는 `ToolContext.proxyEnv`로 게이팅되는데 MCP 서버 자식은 프록시 우회.
- **시나리오**: `QUANTA_NETWORK_PROXY` ON + MCP 서버가 외부 fetch → 자식 소켓이 프록시 경유하는지 / off-list 차단되는지. 현재는 프록시 무시 의심.
- **잡을 버그**: MCP stdio 서버의 이그레스 게이트 우회(설계 의도면 "off-list도 통과" 회귀가드, 아니면 실버그).

---

## P1 — 조합 매트릭스 구멍, chokepoint 공유 확인됨

### H4. fallback LLM 스왑 × abort 미체크 (좀비 stdio)
- **실재 근거**: `src/llm/fallback.ts` provider 루프가 attempt 사이 signal 체크 없음. subagent abort 체인은 `subagent-runner`에서 거는데 fallback 협상 중이면 중간 provider 자식이 SIGTERM 못 받음.
- **시나리오**: subagent가 primary 호출→타임아웃→fallback이 secondary로 스왑하는 순간 parent가 task abort → secondary 채널/자식 정리되는지.
- **잡을 버그**: per-child abort가 fallback provider 협상에 전파 안 됨 → 리소스 릭.

### H5. fallback 스왑 × 멀티툴 턴 tool_use/result 페어링
- **실재 근거**: `streaming-dispatch.ts`가 `stream_reset`(fallback tombstone)에 in-flight dispatch reset 처리는 하지만, 같은 턴에 microcompaction이 이미 tool_result content를 비운 상태에서 스왑되면 새 어셈블리 정합성 미검증.
- **시나리오**: 멀티툴 턴 중 microcompact로 tier-1 result 제거 → primary 실패 → fallback 스왑 → 새 stream의 tool_use↔result 페어링이 model-valid한지.
- **잡을 버그**: fallback 스왑 후 끊긴 페어로 provider 400.

### H6. verify-guard 강제턴 × compaction-breaker strike
- **실재 근거**: `breaker-x-recovery-hell`은 recovery+breaker 인터리브만. verify가 강제하는 고출력 턴이 PTL→no-progress strike를 의도치 않게 누적시키는 경로 미검증.
- **시나리오**: edit→guard가 verify 강제→큰 test 출력으로 PTL→reactive compact(strike+1)→다음 verify도 PTL→cap 도달이 **사용자 의도 아닌 verify-forced 흐름**으로 트립되는지.
- **잡을 버그**: verify 강제가 breaker 거짓트립.

### H7. plan-queue 드레인 × microcompaction 컨텍스트 유실
- **실재 근거**: `plan-queue`는 턴경계에서 follow-up 드레인. 드레인된 턴이 microcompaction 트리거하면 follow-up이 참조할 직전 tool_result가 먼저 evict됨.
- **시나리오**: 턴1 plan+edit enqueue→턴2 드레인→bash 대용량 출력→microcompact가 그 출력 제거→follow-up이 빈 placeholder 참조.
- **잡을 버그**: 드레인 follow-up의 prior-turn 컨텍스트 유실.

---

## P2 — 신규 슬라이스의 "에이전트 루프 통합" e2e 부재 (unit은 있음)

### H8. notebook_edit 루프 디스패치 통합
- **실재 근거**: `tests/integration/`에 notebook_edit 0건(unit/hellgate만). 루프에서 dispatch→atomic write-back→stale-guard→git-write-guard→write-budget 전체경로 미검증.
- **시나리오**: 에이전트가 notebook_edit로 cell str_replace(uniqueness)→nbformat round-trip 보존→atomic rename→stale-read 차단.

### H9. github webhook ingest→event-source→dispatch 통합
- **실재 근거**: `tests/integration/`에 github 0건. unit은 attack-hellgate(서명/URL injection)만. webhook→dedup→PR context load→output sink write-back 풀파이프 미검증.
- **시나리오**: 서명검증된 webhook→event dedup→실 PR API context→sink write-back→retry 멱등성.

---

## P3 — 적대패턴 비대칭(있으면 좋음, blast radius 중)

| ID | 모듈 | 빠진 패턴 | 시나리오 한 줄 |
|---|---|---|---|
| H10 | memory sqlite store | SIGKILL mid-distill | distill 트랜잭션 중 부모 SIGKILL→재오픈 시 embedding BLOB 무결성/우아한 degrade |
| H11 | subagent IPC(os-fork) | SIGKILL mid-result JSON | 자식이 finding JSON 쓰는 중 kill→부모가 truncated JSON에 uncaught throw 안 하는지 |
| H12 | worktree slot | enter 후 exit 전 크래시 | 세션 재수화 시 stale slot이 새 bash cwd 오염 안 하는지(세션경계 클리어) |
| H13 | sqlite GC sweep | SIGKILL mid-DELETE | 기존 e2e는 writer 크래시만 봉인; GC sweep 중 kill→half-deleted/orphan 없이 all-or-none |
| H14 | pty/tmux adapter | 세션명 ANSI escape 주입 | capture-pane 출력의 CSI/OSC가 transcript 경계로 새지 않는지 |
| H15 | xlsx/docx READ | DEFLATE bomb(읽기방향) | 합법 .xlsx의 압축헤더를 10GB로 패치→read가 cap/typed-error vs OOM |

---

## 구현 상태 (2026-06-10 완료)
**15/15 전부 SOTA++ 헬게이트로 랜딩, 94 tests / 8353 expects GREEN.** 병렬 디스패치(서버 throttle로 2웨이브) + 각 테스트 red-on-injection 치아검증.

실버그 4건 발견·수정:
- **H1** trust-scope 2-프로세스 동시 grant **TOCTOU lost-update** — `mergeFiles` baseline-diff가 peer 레코드를 "내가 삭제"로 오판 + O_EXCL 락 부재. tombstone set + advisory 락으로 수정. (src/permission, 동시 sweep이 커밋)
- **H2** config 마이그레이션 **심링크 write-traversal** — persist 경로에 O_NOFOLLOW 가드 부재(read는 있는데 write만 비대칭). 심링크 destination fail-closed. (src/migration, 커밋됨)
- **H3** MCP stdio **proxyEnv dead-arg** — `start()`가 `buildEnv(config.env)`로 두번째 인자 `this.proxyEnv` 누락 → 저장된 proxyEnv가 데드코드, MCP 서버 자식이 이그레스 게이트 우회. 1줄 wire-fix. ⚠️잔여: 라이브 팩토리 `client.ts:321`가 아직 proxyEnv 미전달 — transport 계약만 봉인, 팩토리 배선은 over-wire 회피로 보류(6번째 케이스로 회귀가드).
- **H11** side-agent IPC **half-built finding leak** — SIGKILL mid-result가 complete frame에 non-string summary 전달 → `SideAgentFinding.summary:string` 계약 위반 로그 오염. typed 가드로 drop. (src/side-agent)

나머지 11건은 **회귀가드(이미 안전)**: H4 fallback abort(3중 throwIfAborted 존재), H5 페어링(evict가 페어 보존), H6 verify×breaker(strike가 re-stream 이유에 blind=정당), H7 plan-queue(user-text≠tool_result 구조적 보존), H8 notebook 루프통합, H9 github webhook, H10 memory WAL, H12 worktree 슬롯 세션경계 mint, H13 sqlite GC FK-cascade autocommit, H14 pty escape(BIDI/surrogate 스트립 존재), H15 xlsx READ deflate cap.

## 권장 착수 순서 (원안, 참고용)
1. **P0 H1·H2·H3** — 보안 회귀가드, blast radius 최대. 각 1파일 hellgate.
2. **P1 H4·H5** — fallback×abort/멀티툴은 좀비·400 둘 다 production 라이브.
3. **P2 H8·H9** — 신규 슬라이스 루프배선 봉인(랜딩 직후라 회귀 신선).
4. P1 H6·H7, P3는 ROI 보고 batch.
