# Long-tail 갭 — grep-검증 어딧 + 기능설명 + 작업거리 (jun-08)

**5병렬 어딧**(백로그 마커 불신, live src grep). 각 항목: verdict · file:line · 기능설명(경쟁사가 뭘/왜) · 작업거리. 백로그가 또 여럿 틀림(아래 ⚠️ 표시).

**Verdict 범례:** PARTIAL=있는데 일부빠짐(실작업) · NEW=완전부재 · N-A=아키텍처/플랫폼상 안함(작업불필요) · SOTA=완료.

---

## 🟡 PARTIAL — 있는데 일부 빠짐 (실제 작업거리)

### §4.3 side-agent process-daemon fleet · ROI 중
- **현재:** `src/side-agent/registry.ts:84` 인-프로세스 daemon registry(supervise loop+mailbox) 있음. **OS 프로세스 분리(child_process/socket/respawn) 없음** — `jun-4-background-side-agent.md:48`서 Phase-1 **명시적 non-goal**.
- **기능:** Codex side-agent를 별도 OS 프로세스로 spawn(launchctl/systemd 감독, socket IPC, crash respawn). quanta는 메인스레드 인-프로세스.
- **작업:** `child_process.fork()` 포트 추상화 + socket/pipe IPC(현 인메모리 mailbox 대체) + OS daemon 감독 + exponential-backoff respawn. **HIGH 비용(OS통합).**

### §10.4 file-tree 3-tree · ROI 중
- **현재:** `src/agent/env-context.ts:292` `probeRepoMap` = **cwd 단일트리만**(turn-1). `gitRootTree`/`userRootTree` 없음.
- **기능:** Codex는 cwd-tree + git-root-tree + user-home-tree 3개(monorepo 인식). quanta는 cwd 하나.
- **작업:** `TurnEnvContext`에 `gitRootTree?`/`userRootTree?` + `probeRepoMap`이 3 병렬 scan + 각 cap. **MED.**

### §5.2 image_gen plural ref + aspectRatio · ROI 저 ⚠️(거의 됨)
- **현재:** port `ImageGenRequest.referenceImages`(복수)는 **이미 있음**(`port.ts:53`). **input SCHEMA만 단수** `referenceImagePath`(`tool.ts:91`) + `aspectRatio` 없음.
- **작업:** input schema `referenceImagePath`→`referenceImagePaths: string[]` + `aspectRatio` enum 추가 + `buildRequest` 복수처리. **SMALL(포트는 이미 복수).**

### §7.4 3-way dirty checkout · ROI 저
- **현재:** `src/tool/git/branch-switch.ts:28` commit-wip(`autoWip`) OR reject(stash hint만). stash/discard 선택 없음.
- **기능:** 브랜치 전환시 dirty면 commit-wip/stash/discard 3-way 선택.
- **작업:** input에 `dirtyAction: "commit-wip"|"stash"|"discard"` + stash/discard 플로우. **SMALL.**

### §8.1 turn_context 필드 · ROI 저
- **현재:** `src/session/envelope.ts:198` 17필드+2확장 있음. **6개 부재:** developer_instructions/dynamic_tools/service_tier/model_provider/approvals_reviewer/base_instructions(service_tier는 LLM레이어엔 있는데 envelope엔 없음).
- **작업:** envelope schema에 6필드 추가 + capture 배선. **SMALL-MED.**

### §8.2 session_meta 필드 · ROI 저
- **현재:** `src/session/types.ts:17` id/title/cwd/ts/git-fingerprint/forkedFromId. **부재:** agent_nickname/dynamic_tools/originator/thread_source/model_provider(cli_version는 envelope엔 있고 snapshot엔 없음).
- **작업:** SessionMeta에 필드 추가. **SMALL.**

### §9.3 account dual-window ratelimit · ROI 저
- **현재:** `src/llm/ratelimit-snapshot/parse.ts:29` per-request HTTP헤더 read(requests/tokens remaining+reset). **`used_percent`/`window_minutes` per-account 윈도우 추적 없음.**
- **작업:** account-level dual-window 누적 구조 + used_percent 계산. **MED.**

### §13.1 corrupt-store aggregate 감지 + 복구안내 · ROI 저
- **현재:** `src/session/store.ts:215` per-file zod degrade(corrupt→undefined+warn). **aggregate(스토어 전체 unreadable) 감지/명시 복구가이드 없음.**
- **작업:** 스토어-레벨 corrupt 감지 + 운영자 복구 CLI 안내. **SMALL-MED.**

### §13.2 persisted interrupted-turn marker (crash resume) · ROI 중 ⚠️
- **현재:** `src/agent/interrupted-turn.ts`(jun-08 in-memory buffer) — **세션 내 resume만**, 프로세스 crash 후 복구 불가(transient).
- **기능:** crash로 죽은 mid-stream 턴을 재시작 후 resume(세션 JSONL/meta 영속 마커).
- **작업:** interrupted 상태를 session store에 persist + 재시작시 감지/offer. **MED**(jun-08 in-memory와 별개 층).

### §12.7 otelHeadersHelper dynamic OTLP · ROI 저
- **현재:** `src/observability/otel-exporter.ts:121` static headers만(construction시 1회). 로테이션 없음.
- **작업:** `getHeaders(): Promise<...>` 콜백 포트(OAuth OTLP 토큰 refresh). **SMALL.**

### §2.4 plugin manifest hooks/apps 포인터 · ROI 저
- **현재:** `repository`는 추가됨(ADR-0493). **`hooks`/`apps` 필드 없음**(command-hooks는 settings.json서 별도 로드).
- **작업:** PluginManifestSchema에 `hooks`/`apps` + 로더 배선. **SMALL.**

---

## 🔲 NEW — 완전 부재

- **§4.4 typed agent kind** (`subagent/types.ts:29` free-string `agentType`) — `SubagentType` enum화 + 경계검증. ROI 저. **MED.**
- **§10.2 rules argv-array** (`rules/parser.ts` string-prefix만) — `pattern=[...]` 토큰배열 매칭. ROI 저. **MED.**
- **§10.3 mentions folder/git kind** (`mention-injection/types.ts:50` 5종) — `@folder`/`@git` + resolver. ADR-0418 supersede 필요. ROI 저. **MED.**
- **§10.6 memory routing meta** (`memory/types.ts` flat) — `taskGroup`/`appliesTo`/`reuseRule` + recall 가중. ROI 중. **HIGH(ranking 수술).**
- **§5.4 gh PR code-tour** (`tool/gh/` 없음) — PR diff 가이드투어. ROI 저. **MED.**
- **§7.2 co-change/related-files** (`git/churn.ts:19` 단일파일 빈도만) — 동시변경 co-occurrence 행렬. ROI 중. **MED.**
- **§7.3 CI-investigation finding tool** (없음) — `CiFinding` 구조화 기록(vs prose skill). ROI 저. **MED.**
- **§6.5 listVoices** (`realtime/port.ts` 없음) — realtime voice 동적조회. ROI 저. **SMALL.**
- **§1.6 connector marketplace** (`connectors/mcp-connector-catalog.ts` flat catalog만) — DirectoryApp lifecycle/installUrl. ROI 저. **MED-HIGH.**
- **§2.5 marketplace.json 정책게이팅** (없음) — install/auth 정책 config. ROI 저(니치). **MED.**
- **§2.3 skill allow_implicit_invocation** (없음) — 스킬 자동호출 정책 플래그. ROI 저. **SMALL.**
- **§12.6 exclude_tmpdir 토글** (없음) — `/tmp` sandbox 제외 config knob. ROI 저. **SMALL.**
- **§9.6 opusplan preset + Message Batches API** (없음) — sticky preset + Anthropic batches. ROI 저. **MED.**
- **§13.3 compaction drop-oldest salvage** (`compaction.ts:657` fail-fast만) — 오버플로시 oldest drop 재시도(vs abort). ROI 저. **MED.**
- **§8.3 dynamic_tools session record** (없음) — 동적추가 도구 세션기록. ROI 저. **SMALL.**

---

## ⛔ N-A — 안 해도 됨 (아키텍처/플랫폼/설계상)

- **§3.3 Windows native sandbox** — `windows-native.ts`는 **의도적 degrade-stub**(helper exe=L3 backlog, T08 정직-degrade). 작업불필요(외부 빌드).
- **§10.5 server-side compaction** — quanta는 **100% client-side**(아키텍처 확정). N-A.
- **§5.3 team-shared cloud Canvas** — `artifact/registry.ts` session-local 인메모리(설계상 frozen). 클라우드는 대규모 별건.
- **§12.3 additionalDirectories** — `os-sandbox/types.ts` `extraReadPaths`/`extraWritePaths`로 **기능상 이미 존재**(tool-scoped), 이름만 다름. N-A(semantic).
- **§11.3 Vim mode** — refs/주석만, 코드 0. unstarted(라인에디터 라이브러리 교체 필요). ROI 저-니치.
- **§12.5 plan-mode-effort/verbosity config** — knob 미선언/미배선. (ticket-23 §9.5 verbosity와 일부 겹침). ROI 저.

---

## ⚠️ 스킵확정 정정 (어딧이 잡음)
- **P16 Windows shell** — `runtime/shell.ts:151` `["bash","-lc"]` 하드코딩 + **win32 분기/graceful 없음**(Windows서 silent 실패). darwin 검증불가는 맞지만 "의도적 스킵"이 아니라 **미처리**. 최소작업: `process.platform==="win32"` 가드 + 명시적 에러/cmd fallback. ROI 저(플랫폼).
- **P17 NotebookEdit** — read half SOTA(`read/ipynb.ts`), write 완전부재. 네가 쓸데없다 함 → skip 유지.

---

## 요약
**실작업 후보(PARTIAL+NEW, N-A 제외):** ~26개. 대부분 ROI 저+SMALL/MED. 눈에 띄는 것:
- **빠른 win(SMALL):** §5.2 image plural(포트 이미 복수), §8.1/8.2 envelope 필드, §6.5 listVoices, §2.3/2.4 skill/plugin 플래그, §12.6/12.7 config, §7.4 stash-3way, §8.3 dynamic_tools.
- **ROI 중(MED 비용):** §13.2 persisted interrupt-marker(crash resume), §10.4 3-tree, §7.2 co-change, §10.6 memory routing, §9.3 dual-window ratelimit, §4.3 side-agent daemon(HIGH).
- **정정:** §5.2/§12.3는 거의/이미 됨; §13.2는 jun-08이 in-memory만(persist 별도); P16은 미처리(스킵 아님).
