# misc-jun-7 세션 핸드오프 (jun-08)

다음 세션이 바로 이어받기 위한 상태/맥락/다음수. **착수 전 grep 재검증 필수**(백로그 jun-07 마커가 여러 번 stale였음 — 아래 "함정" 참조).

---

## 1. 지금까지 (LANDED, main에 머지됨)

`main` = `1cfbf354` (origin/main보다 74 commits 앞섬, **push 안 됨**). 아래 전부 main에 들어있음:

**misc-jun-7 티켓 (00-index.md = 마스터 상태판):**
- ✅ **01** MCP proto-nego · **02** manifest codex-compat · **03** guardian per-action assessor · **06** model-based fast-apply — *이미 DONE이었음*(in-flight, 백로그 stale-flip을 재어딧으로 확인)
- ✅ **04a** circumvention tracker mint(comp-root서 죽어있던 것 부활) · **05** central-config trust(warn+prompt+managed-layer) · **07** summarize verb(죽은 verb 배선) · **08a** weave-race re-queue · **08b** mid-turn 입력 lane(scroll-region) · **09** MCP SSE resumption(transport+supervisor carry+unknown-id reset)
- ✅ **12** §20.4 **subagent FS owned/forbidden ENFORCEMENT** ← 이번 세션 메인. `src/agent/ownership-policy.ts` + dispatch gate + knob `QUANTA_FS_OWNERSHIP_ENFORCE` + buildChildConfig. 17 hellgate(pure+escape e2e+dispatch e2e).
- ⏭️ **10** NotebookEdit — user-skip("쓸데없음")

**그 외 이번 세션(초반):** §11.5 interrupt-restore(`interrupted-turn.ts`+resume verb), inbound 3-mode(queue/weave/interrupt), §25.1 workflow 엔진.

**3R 적대어딧 → ~15 실버그 수정**(surrogate backspace, 08b scroll-region 경쟁, trust TOCTOU read-once-merge-twice, fsReadText EACCES→absent, MCP empty/whitespace SSE-id, complexity 추출 등). 전부 default-OFF byte-identical.

---

## 2. 현재 브랜치 (미머지)

`longtail/jun08-small-wins`:
- ✅ **§5.2 image_gen plural reference images** — `referenceImagePaths` input + `collectReferences` 병합/dedup(포트는 이미 `referenceImages[]`). 4 hellgate(schema accept/cap + e2e 2-refs/dedup/singular/no-ref-reject), tsc0, 회귀0. (aspectRatio는 `size:"WxH"`가 커버 + adapter가 slice 밖이라 제외.)
- **main 머지 대기.** 나머지 long-tail은 미착수.

---

## 3. 남은 일 (전부 계획 완료, 구현만)

**IMPROVE 클러스터** (`11-15-improve-cluster.md` — 12만 DONE):
- **11 P8 worktree** 에이전트도구(`enter/exit_worktree`)+edit-fence(host `withWorktree()` 재사용) — **ROI 고**
- **13 §12.2 MITM header-rewrite** pure `applyHeaderRules`(strip/set/rewrite, redaction 우선) — 중
- **14 §11.6 /model 인터랙티브 피커**(`/effort` 패턴 미러) — 저
- **15 §11.7 scriptable statusLine + 색맹 팔레트** — 저

**NEW 클러스터** (`16-24-new-cluster.md` — 전부 미착수):
- **19 §22.3 reverse-MCP**(quanta가 MCP 서버, default read-only) — 고
- **17 §11.2 /agents fleet 뷰**(TaskRegistry 재사용, observability 북극성) — 중-고
- **24 §6.2/3/4 browser tabs/bbox/highlight**(CDP seam) — 중
- **16 /init · 23 reasoning summary/verbosity · 20/21 MCP templates/Tasks · 22 url-elicitation** — 저-중
- **18 §11.4 Ctrl+B background** — **제일 어려움(턴 lifecycle 수술, phased V1→V3)** — 중

**long-tail small wins** (`25-longtail-audit.md` — grep-검증 완료, §5.2만 DONE):
- 빠른(~5-8call): **§12.6** exclude_tmpdir knob · **§2.3** skill allow_implicit_invocation · **§2.4** plugin hooks/apps · **§8.2** session_meta 필드 · **§8.1** turn_context 필드
- 중간(~12-15call): **§12.7** OTLP dynamic headers · **§6.5** listVoices(provider) · **§7.4** git stash-3way · **§8.3** dynamic_tools record
- ⚠️ **§13.2** persisted interrupt-marker(crash resume) — jun-08은 in-memory만, 영속 별도층 — **ROI 중**
- N-A(안함): §3.3 Win-sandbox(degrade-stub) · §10.5 server-compaction(client-side) · §5.3 team-canvas · §12.3(이미 존재) · §11.3 Vim · P16 Windows shell(미처리지만 darwin 검증불가)

---

## 4. 🛑 함정 (반드시 숙지)

1. **백로그(`docs/backlog/jun-7-gap-other-agent.md`) jun-07 마커 STALE 다수** — 착수 전 **live src grep 재검증 필수**. 이번에 01/02/03/06/§9.1/§9.2/§10.1/§12.4/§23.2가 "OPEN"인데 실은 DONE이었음.
2. **circumvention `canonicalizeEffectPath`는 lexical-only**(symlink 미해소). FS 경로 비교시 `checkWriteEffects`처럼 `@/storage canonicalizePath`로 **재정규화**해야 symlink escape 막힘(안하면 macOS /var↔/private/var 우연일치 위험).
3. **신규 knob** → `src/shared/runtime-config-knobs.ts`에 declare(orphan ratchet) + `runtime-config.ts` 필드+read.
4. **신규 GATED 도구** → `src/tool/surface/manifest.ts` GATED 엔트리(zero-unwired ratchet) + comp-root 배선.
5. **테스트 위치**: `@/apps/cli` import 테스트는 `src/apps/cli/__tests__/`(noRestrictedImports). `@/apps/agent`는 tests/unit서 OK.
6. **pre-existing fail(내것 아님, 무시)**: `repl.ts <334 LOC`(현재 335) · `runSessionLoop` complexity 16>15(HEAD부터) · in-flight `QUANTA_SPAWN_AGENTS_CSV` orphan(가끔).
7. **default-OFF byte-identity** 철칙: 새 knob/slot absent ⇒ 기존과 바이트동일. 적대어딧이 이걸 명시 검증함.
8. **auto-commit "done" 워크플로** 있음 — 턴마다 작업이 "done" 커밋으로 들어감(73 commits가 그것). 작업트리가 깨끗해 보여도 본체는 커밋됨.
9. **worktree dispatch 위험**(메모리 scars) — 작은건 main-direct. 공유 레지스트리(knob/envelope/fc) 동시편집 = 충돌.

---

## 5. 검증 레시피 (bash classifier 간헐 불가시 read-only로)
- typecheck: `bunx tsc --noEmit` (느림, 290s). pre-existing 291 에러는 in-flight — 내 파일만 grep.
- test: `bun test <file>` · lint: `bunx biome check --write <file>`
- build: `bun run build`(transpile만, typecheck 안함) → `./dist/agent`
- knob ratchet: `tests/unit/knob-registry-completeness-ratchet-hellgate.test.ts`

---

## 6. 추천 다음 수
1. **§5.2 main 머지**(longtail 브랜치) — 검증 끝남.
2. 빠른 long-tail 5개 연속(§12.6/§2.3/§2.4/§8.1/§8.2 — 같은 결, 한 호흡) → 머지.
3. 그담 ROI 높은 티켓: **11 worktree → 19 reverse-MCP → 17 /agents → 24 browser**.
4. **18 Ctrl+B는 맨 마지막**(prototype-in-isolation 먼저).
- 매 티켓: red e2e 먼저 → 구현 → green → claim-100시 3R 적대어딧.
