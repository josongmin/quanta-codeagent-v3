# RFC — jun-7 Naive-Implementation Hardening (SOTA++)

> **출처**: `docs/backlog/jun-7-gap-other-agent.md` §26 (나이브-구현 어딧, 19바퀴). Codex 0.135 / Cursor 3.5.33 / Claude CLI 2.1.150 side-by-side 대조로 확인된 **있는데 얕게/틀리게 구현된** 8개. "없는 기능"이 아니라 **측정·배선·트리거·리소스 수명**의 결함.
> **원칙**: 알고리즘 코어(retry/classifier/edit-matcher/cost/compaction-strategy)는 이미 우위 — 건드리지 않는다. 이 RFC는 그 코어를 둘러싼 **나이브한 가장자리만** 구조적으로 교체한다.
> **관통 주제**: 8개 중 5개가 **공유 seam 3개**(프로세스 트리 수명 · 토큰 윈도우 측정 · EOL/라인 처리)로 수렴 — 개별 패치가 아니라 **포트 3개 신설 + 호출부 재배선**.

---

## 0. 결함 요약 + 분류

| # | 결함 | 클러스터 | 근거(파일:라인) | 심각도 | 종류 | 기본값 |
|---|---|---|---|---|---|---|
| D1 | 단일-PID kill → 프로세스 트리 orphan | exec/수명 | `runtime/guarded-spawn.ts:111` + `shell.ts:186`/`bash-bg-registry.ts:115`/`pty-backend.ts:134` | 🔴 HIGH | 리소스 누수 | ON (버그픽스) |
| D2 | bg-shell 출력버퍼 메모리 무제한 → OOM | exec/수명 | `bash-bg-registry.ts:337,340` | 🔴 HIGH | 리소스 누수 | ON |
| D3 | PTY env 미scrub (full `process.env` inherit) | exec/보안 | `pty-backend.ts:136` | 🔴 보안 | 크레덴셜 누수 | ON+opt-out |
| D4 | compaction threshold 모델-블라인드 `120_000` | compaction/측정 | `compaction.ts:35` + `loop/context-assembler.ts:287` (`max:0`) | 🔴 HIGH | 잘못된 상수 | ON+fallback |
| D5 | chars/4 추정이 authoritative API token 무시 | compaction/측정 | `compaction.ts:56,444` + `llm/live-usage/index.ts` | 🟠 MED-HIGH | 부정확 측정 | ON+fallback |
| D6 | CRLF fuzzy splice 드롭 → mixed-EOL silent corruption | edit/정확성 | `tool/edit/fuzzy.ts:25,31` | 🔴 corruption | silent 데이터손상 | ON (버그픽스) |
| D7 | V4A `@@` context-header 파싱하나 무시 | patch/기능 | `patch/parser.ts:224` + `patch/applier.ts:341` | 🟠 MED | dropped capability | ON (additive) |
| D8 | read per-line truncation 없음 → minified 범람 | read/IO | `tool/read/index.ts:53` | 🟠 MED | context 범람 | ON |

**시퀀싱**: D1·D2·D3(exec 클러스터, 공유 ProcessTreeKiller 포트) → D6·D7·D8(순수함수, 독립, 병렬가능) → D4·D5(compaction, 공유 TokenWindow seam, 가장 큰 수술). exec과 compaction은 hot-path라 1개씩 회귀검증(메모리 교훈: hot-path 배선은 수술).

---

## 1. 설계 원칙 (코드베이스 기존 패턴 준수)

1. **Closed-port DI, duck-typed seam** — 새 효과(process enumeration, env scrub)는 포트 뒤로. 슬라이스는 fence-clean 유지, 효과는 `@/host`/composition layer.
2. **No-heuristics** ([[no-heuristics-only-validated]]) — 모든 상수는 (a) 실측 신호 파생(window→threshold)이거나 (b) UPPER_SNAKE named const + 근거 주석. 매직넘버 금지. 런타임 스캐너가 bare timeout 이미 차단.
3. **Default-ON 단, unknown→byte-identical fallback** — 측정/정확성 픽스는 켜되, 신호 부재 시(unknown model / authoritative 없는 turn-1 / @@ 없는 patch / LF 파일) **기존 경로 byte-identical**. 전역 knob 대신 **signal-presence가 게이트**.
4. **red-on-injection 가드** — 각 픽스마다 결함을 주입하면 red되는 테스트. 추가로 **회귀 차단 ratchet**(소스 AST 스캔)으로 동일 결함 클래스 재발 방지.
5. **SSOT 테이블** — 흩어진 상수(window, EOL, env-allowlist)는 단일 owner. 양방향 drift-guard.
6. **공유 seam으로 수렴** — D1/D2/D3는 한 포트, D4/D5는 한 측정 seam. SOLID consolidation이 8개 패치를 3개 구조로.

---

## 2. 클러스터 A — 프로세스 수명 (D1·D2·D3)

### 2.1 공유 신설: `ProcessTreeKiller` 포트 (`@/runtime/process-tree`)

**문제 (D1)**: 모든 spawn site가 `Bun.spawn(argv, {...})` 후 `proc.kill()` = **직접 child PID에만** SIGTERM. `bash -lc "npm run dev"`는 bash→node→vite-worker 트리인데 bash만 죽고 자식은 init로 reparent돼 포트/CPU/락 점유. `escalatingKill`(`guarded-spawn.ts:96`)의 SIGKILL escalation도 이미 죽은 bash PID만 때림.

**경쟁사**: Codex `process-wrap` crate `ProcessGroup`+`kill_on_drop` → "kill ... process group" (그룹 전체). Cursor `cursor-proclist` 네이티브 process-tree 열거.

**근본원인**: Bun.spawn이 자식을 **자기 프로세스 그룹 리더로 안 만들고**(detached 미설정), kill이 PID-스코프.

**구조적 픽스** — 효과(프로세스 열거/그룹 시그널)를 닫힌 포트로 추출:

```ts
// src/runtime/process-tree.ts  (pure interface + 2 adapter)
export interface ProcessTreeKiller {
  /** 프로세스와 그 모든 자손에게 시그널. 멱등·no-throw(이미 죽음 OK). */
  signalTree(rootPid: number, signal: "SIGTERM" | "SIGKILL"): void
}
```

두 어댑터 (우선순위 fast→portable):

- **(A) process-group kill (POSIX fast-path)**: spawn 시 자식을 그룹 리더로 만들면 `pgid === pid`, `process.kill(-pid, sig)`가 그룹 전체. 단 Bun.spawn에 detached 옵션 유무 + macOS `setsid` 바이너리 부재(syscall은 있음) **구현 시 검증 필요** — 확정 못하면 (B)로.
- **(B) ppid-walk tree kill (portable 기본)**: 부모 먼저 SIGTERM(새 fork 중단)→`ps -A -o pid=,ppid=` 한 번 파싱해 자손 그래프 BFS→각 자손 SIGTERM→grace 후 생존자 SIGKILL. `ps`는 macOS/Linux 모두 존재, 신규 dep 0. 레이스(열거~kill 사이 새 자식)는 부모-먼저-kill로 최소화. Cursor·대다수 도구가 쓰는 방식.

**배선**: `escalatingKill(proc)` → `escalatingKill(proc, killer)`. `kill` 클로저가 `proc.kill()` 대신 `killer.signalTree(proc.pid, "SIGTERM")`, grace 후 `signalTree(pid, "SIGKILL")`. `KillableChild`에 `pid` 추가(이미 `BashSubprocess`엔 있음). 3 spawn site(`shell.ts:211`, `bash-bg-registry.ts:309`, `pty-backend` child)가 동일 killer 주입 — **한 곳이 트리 수명 소유**(SOLID). 포트 부재 시(테스트 fake) 단일-PID fallback = 기존 동작.

**기본값**: ON(버그픽스). composition root가 default adapter 주입, 테스트는 fake killer로 시그널 검증.

**가드**:
- red-on-injection: fake killer + 3단 트리(부모→자식→손자) 모의 spawn → abort → 손자까지 SIGTERM 받았는지 단언. 단일-PID로 되돌리면 red.
- **회귀 ratchet**: AST 스캔 — `Bun.spawn` 핸들에 직접 `.kill(` 호출하는 신규 site 금지(killer 포트 경유만 허용). allowlist는 file→count burn-down([[jun-06-permanent-guards]] 패턴).

---

### 2.2 D2 — bg-shell 출력버퍼 bounded ring (`@/runtime/bounded-buffer`)

**문제**: `bash-bg-registry.ts:337,340` `handle.stdout += chunk`/`stderr += chunk` **per-handle 바이트캡 없음**. LRU(`MAX_BG_SHELLS=16`)는 shell *개수*만. `tail -f`/`yes`/chatty server가 무한증식→agent OOM. LRU는 newest라 안 evict.

**경쟁사**: Codex `disable_output_cap`+`max_output_tokens` = **accumulator에 캡**(렌더뷰 아닌 버퍼 자체).

**구조적 픽스** — 순수 유틸 bounded head+tail 버퍼:

```ts
// src/runtime/bounded-buffer.ts
export interface BoundedBuffer {
  append(chunk: string): void
  /** head + "…(+N bytes elided)…" + tail. 캡 미만이면 elision 없이 verbatim. */
  value(): string
  droppedBytes(): number
}
export const createBoundedBuffer = (maxBytes: number): BoundedBuffer => /* head/tail ring */
```

- head/tail 분할은 **foreground `capToolOutput`(`tool/output-spill.ts`)의 8k-head+4k-tail 시맨틱 재사용** — 에러 tail 보존(에러는 끝에 나옴). 동일 정책 SSOT화.
- `BgShellHandle.stdout: string` → 내부 `BoundedBuffer`, snapshot 시 `.value()`. 외부 shape(`BgShellSnapshot.stdout: string`) 불변.
- 캡 `MAX_BG_BUFFER_BYTES` named const. 풀 출력 손실 방지: foreground가 이미 쓰는 `.quanta/tool-output/<uuid>.txt` disk-spill seam 재사용해 전체 출력 디스크로(선택, surrogate-safe).
- `awaitHandle`의 regex match는 `.value()`(bounded view) 대상 — 무한 문자열 정규식도 차단(ReDoS 표면 축소 부수효과).

**기본값**: ON. **가드**: fuzz — 10MB 스트림을 fake handle에 흘려도 `.value().length <= MAX_BG_BUFFER_BYTES + marker`, `droppedBytes > 0`. surrogate-safe truncation([[jun-06-permanent-guards]]) ratchet에 bg-buffer 편입.

---

### 2.3 D3 — PTY env scrub (`pty-backend.ts`)

**문제**: `pty-backend.ts:136` `env: { ...process.env, ...env }` = **전체 부모 env inherit**. `runShell`은 `scrubEnv()`(`*_API_KEY`/`*_TOKEN`/`*_SECRET` 드롭, ADR-0006)인데 PTY는 raw → 대화형 셸에 크레덴셜 노출(좁지만 실제 누수 벡터).

**구조적 픽스** — env scrub 단일 chokepoint를 PTY에도:

- `scrubEnv()`(`@/runtime/sandbox`)는 composition layer(`@/host/runtime`)서 import 가능(이미 `bash-bg-registry`가 씀). PTY spawn env = `applyLocalEnv(scrubEnv(), declaredOverlay, DEFAULT_ENV_ALLOWLIST)` — runShell과 **동일 env 파이프라인**(SSOT). secret-deny 기본 적용.
- **escape hatch**: PTY는 대화형이라 full env 정당 케이스 존재 → runShell의 `inheritEnv` 대칭으로 `QUANTA_PTY_INHERIT_ENV` opt-out. 기본 scrubbed.

**기본값**: ON(보안 픽스, scrubbed) + opt-out knob. **가드**: PTY factory에 `*_API_KEY`/`*_SECRET` 박은 env로 spawn → 자식 env에 부재 단언(opt-out 시 존재). **회귀 ratchet**: spawn env에 `...process.env`/`...process.env`-spread 직접 사용 금지(scrubEnv 경유만), allowlist file→count.

---

## 3. 클러스터 B — 순수함수 정확성 (D6·D7·D8, 독립·병렬)

### 3.1 D6 — CRLF EOL 보존 (`tool/edit/fuzzy.ts`)

**문제**: `splitLines = s.split("\n")`(`:25`)만. CRLF 파일서 haystack `"foo\r"` vs needle `"foo"`: exact rung 실패→whitespace-flex/anchored-trim의 `.trim()`이 `\r` 스트립해 **매치**→`spliceLines`(`:31`)가 `\r` 없는 newString으로 교체→이웃 줄은 `\r` 유지 = **mixed line-ending**. CRLF 파일 한 블록 fuzzy 편집이 편집줄만 LF로 무음변환.

**경쟁사**: Cursor `eolSequence`를 first-class param으로 splice 시 native EOL 보존.

**근본원인**: fuzzy 경로가 EOL-agnostic — `\n` split + `\n` join. (exact 경로 `applyExactEdit`는 byte-identical splice라 무사.)

**구조적 픽스** — EOL을 fuzzy splice의 1급 시민으로:

```ts
// src/tool/edit/eol.ts (pure leaf)
export type EolStyle = "\n" | "\r\n"
export const detectEol = (source: string): EolStyle => /* 지배적 EOL: \r\n 우세면 CRLF, else LF */
```

- `splitLines`를 `/\r?\n/` split로(`\r` 컨텍스트 비교서 제거하되 **원본 EOL 기억**).
- `spliceLines`가 replacement 줄을 **detected EOL로 join** — 파일이 균일 CRLF면 spliced 영역도 CRLF, LF면 LF. 모델이 LF로 준 newString은 파일 EOL로 정규화.
- **불변식**: fuzzy 편집은 mixed-EOL을 *도입하지 않는다*(균일 파일은 균일 유지). 이미 mixed인 병적 파일은 dominant로 수렴(악화 안 함).
- exact 경로 불변(byte-identical), LF 파일 불변(byte-identical) — **CRLF 파일에서만 동작 변경 = 정확히 corruption 막는 지점**.

**기본값**: ON(corruption 픽스). **가드**: hellgate — CRLF 파일 + whitespace-approx needle로 fuzzy 편집 → 결과에 lone-LF 줄 0개(또는 dominant-CRLF 유지) 단언. `\n`-only split 되돌리면 red. differential fuzz([[cursor-absorption-r1-r4-hardening]] 500-pair 패턴): 같은 편집을 LF판/CRLF판에 적용 → 의미동등 + EOL-일관 단언.

### 3.2 D7 — V4A `@@` context-header를 jump anchor로 (`patch/applier.ts`)

**문제**: `patch/parser.ts:224` `hunk.contextHeader = header` 저장하나 `locateBlock`(`applier.ts:341,361`)이 **never 참조** — whole-file 스캔으로 위치 → 모델이 `@@ class Foo`로 동일 메서드 바디 중 하나 disambiguate해도 무시→`Ambiguous context — N matches`(`:441`) throw. Codex 자기 포맷인데 못 씀(파싱은 해서 "되는 척").

**구조적 픽스** — `locateBlock`을 anchor-scoped:

- 매치 전: `contextHeader` 있으면 그것과 일치하는 **마지막 줄 이후로 검색 윈도우 narrow**(그 region 내에서 기존 tier 매칭). `line_ranges`(`tool/edit/line-range.ts`)의 scoping primitive 재사용.
- `@@` 매치 없거나 header 부재 → **whole-file fallback**(현 동작). 따라서 **strictly additive**: `@@` 없는 patch byte-identical, `@@` 있어 전엔 ambiguous-throw하던 게 이제 unique-apply.
- 멀티 `@@`(중첩 jump, Cursor 교육 패턴)는 순차 narrow.

**기본값**: ON(additive). **가드**: 동일 메서드 바디 2곳 + `@@ class A` anchor patch → A쪽만 적용, B 불변 단언. anchor 무시로 되돌리면 ambiguous-throw로 red. `@@`-없는 기존 patch 코퍼스 회귀 = byte-identical.

### 3.3 D8 — read per-line truncation + 토큰-aware nudge (`tool/read/index.ts`)

**문제**: `renderReadOk`(`:53`)가 `\n` split 후 줄단위 slice, **per-line char cap 없음**. 5MB minified 번들=1줄=limit에 1 카운트→200k 외곽캡까지 통째 방출(읽을수없는 단일줄, offset/limit은 줄단위라 페이징 불가).

**경쟁사**: Claude `Read`가 file-cap(2000줄)에 **더해 per-line ~2000자 truncate**. `$_H` 에러클래스 `tokenCount`/`maxTokens` "instead of reading the whole file".

**구조적 픽스**:
- `renderReadOk`에 **per-line char cap** `MAX_LINE_CHARS` + in-band `… (+N chars elided)` 마커. **동일 파일의 ipynb per-output 예산 패턴 재사용**(이미 이 파일에 있음 — `outlineNote` 인근). surrogate-safe 절단([[jun-06-permanent-guards]]).
- **토큰-aware**(soft): 파일 토큰 추정 > 예산이면 출력에 1줄 헤더 prepend("대용량 — offset/limit 또는 grep 권장"). **refuse 아님**(워크플로 안 깸) — nudge. Claude는 refuse지만 우린 conservative하게 advise.

**기본값**: per-line cap ON(범람 픽스), nudge-header ON(non-blocking). **가드**: 단일 200k-char 줄 read → 출력 줄길이 ≤ `MAX_LINE_CHARS + marker`, elision 마커 존재. surrogate-pair 경계서 cap fuzz.

---

## 4. 클러스터 C — compaction 측정 (D4·D5, 공유 TokenWindow seam, 최대 수술)

### 4.1 D4 — model→context-window SSOT + 파생 threshold

**문제**: `compaction.ts:35` `DEFAULT_THRESHOLD = 120_000` **모델-블라인드 상수**. 레포에 model→window 테이블 전무. `loop/context-assembler.ts:287`이 usage snapshot에 `max:0`("unknown window") 하드코딩. → 200k 모델서 40% 영구 미사용, **1M 모델서 12%만 사용(88% 버림)**, 32k 모델선 트리거 안 돼 provider가 먼저 reject.

**경쟁사**: Claude `threshold = window(model) − outputReserve − 13000`(+`CLAUDE_CODE_MAX_CONTEXT_TOKENS` override). Codex `model_context_window` + `model_auto_compact_token_limit` per-model catalog.

**구조적 픽스** — `provider-metadata.ts`(기존 metadata SSOT, plane-clean leaf)에 window 테이블:

```ts
// src/llm/provider-metadata.ts 확장
export interface ModelWindow { readonly contextWindow: number; readonly maxOutput: number }
/** 모델 id → window. 정확한 id 우선, 없으면 provider-family fallback(anthropic 200k 등),
 *  그래도 없으면 undefined(→ compaction이 120k legacy fallback). closed-ish:
 *  새 모델은 여기 등록(미등록은 안전한 보수값으로 degrade). 근거=공개 모델 스펙, dated. */
export const MODEL_CONTEXT_WINDOWS: Record<string, ModelWindow> = { /* opus/sonnet/haiku/gpt-*/... */ }
export const resolveModelWindow = (model: string): ModelWindow | undefined => /* exact→family→undefined */
```

- `resolveThreshold`(`compaction.ts:105`) 확장: 우선순위 **explicit override → env `compactTokens` → 파생(window−reserve−margin) → 120k legacy**. 즉 env override는 여전히 authoritative(불변), 신규는 그 **아래** 레이어.
- 파생: `threshold = window − OUTPUT_RESERVE_TOKENS − COMPACTION_SAFETY_MARGIN`. reserve는 모델 `maxOutput` 파생(추정 아님 — 테이블 값), margin은 named const(Claude 13000 참조, 근거주석).
- `CompactInput`에 `model?: string`(loop이 이미 앎) 추가 → `resolveThreshold(input.thresholdTokens, input.model)`.
- `context-assembler.ts:287`의 `max:0` → `resolveModelWindow(model)?.contextWindow ?? 0`. status-line/usage-breakdown이 실 window 받음(이미 max param 받는 plumbing 존재, `0` 먹는 중).

**기본값**: ON, **unknown model → 120k byte-identical**(테이블 미등록 모델 사용자 불변). known model만 개선 — signal-presence가 게이트, 전역 knob 불필요.

**가드**: 
- 단위: `resolveThreshold` 매트릭스 — {explicit, env, known-model, unknown-model} × 우선순위 단언. unknown→120k.
- **양방향 drift-guard**: `MODEL_CONTEXT_WINDOWS` 키가 `provider-metadata`의 모델 enum/카탈로그와 정합(stale 모델 검출). [[tool-surface-ssot]] 패턴.
- 회귀: 120k 가정 박힌 기존 compaction 테스트 = unknown-model 경로로 유지.

### 4.2 D5 — authoritative token baseline (live-usage → compaction)

**문제**: `compactIfNeeded`(`:444`)가 `estimateTokens(input.messages)`=`chars/4`로만 게이트. quanta는 provider authoritative count(`llm/live-usage/index.ts` `usage.inputTokens`, `exact` 플래그까지)를 **이미 받지만 display(output_progress)에만** 씀. chars/4는 code/JSON/identifier-dense서 **20~40% under-count** → 실 150k가 ~115k 추정돼 120k 게이트 통과 → 하드 `context_window_exceeded` → reactive PTL(더 lossy). 이미지/PDF는 고정 char proxy(IMAGE=6000/DOC=12000)라 20장 PDF=1장 동일.

**경쟁사**: Codex `total_token_usage`(authoritative) baseline + `estimated_tokens_..._since_last_successful_api_response`(델타만 추정). Claude 실측 %full.

**구조적 픽스** — authoritative를 baseline으로, 추정은 델타에만:

```ts
// CompactInput 확장
interface TokenBaseline {
  /** 직전 성공 응답서 provider가 보고한 input 토큰(authoritative). */
  readonly measuredInputTokens: number
  /** 그 측정 시점의 messages.length(이후 append분만 추정). */
  readonly measuredAtMessageCount: number
}
// 트리거 토큰 = baseline.measuredInputTokens + estimateTokens(messages.slice(measuredAtMessageCount))
```

- loop이 turn 완료 후 `usage.inputTokens` + 당시 `messages.length`를 baseline으로 기록(live-usage가 이미 authoritative 추출). 다음 `compactIfNeeded`에 주입.
- baseline 부재(turn-1 / authoritative 미보고 provider) → **`estimateTokens(all)` legacy byte-identical**. signal-presence 게이트.
- `exact` 플래그 활용: authoritative ≥ estimate일 때만 baseline 신뢰(live-usage가 이미 계산).
- D4와 합성: 정확한 `current`(D5) vs 정확한 `threshold`(D4) — 둘 다 있어야 chars/4+120k가 무는 지점이 닫힘.

**기본값**: ON, baseline 부재 시 byte-identical. **가드**: code-dense transcript(authoritative=150k, estimate=115k) fixture → baseline 주입 시 트리거 fire, 미주입 시 miss 단언(현 버그 재현). image-heavy fixture로 proxy under-count 회귀.

---

## 5. 공유 seam 요약 (SOLID consolidation)

| seam | 신설 위치 | 소비자 | 대체하는 나이브 |
|---|---|---|---|
| `ProcessTreeKiller` | `@/runtime/process-tree` | guarded-spawn(fg) · bash-bg-registry · pty-backend | 3곳 단일-PID `proc.kill()` |
| `BoundedBuffer` | `@/runtime/bounded-buffer` | bash-bg-registry(+향후 모든 출력 accumulator) | `+= chunk` 무한증식 |
| `scrubEnv` 재사용 | 기존 `@/runtime/sandbox` | runShell(기존) · bash-bg(기존) · **pty(신규)** | pty full-inherit |
| `MODEL_CONTEXT_WINDOWS` + `resolveModelWindow` | `@/llm/provider-metadata` | compaction · context-assembler · status-line | `120_000` 상수 · `max:0` |
| `TokenBaseline` | `CompactInput` 필드 | compaction trigger ← loop ← live-usage | chars/4-only 게이트 |
| `detectEol`/EOL-aware splice | `@/tool/edit/eol` | edit/fuzzy(+향후 read) | `\n`-only split/join |

**8 결함 → 6 seam → 3 클러스터.** 개별 패치 아닌 구조 교체.

---

## 6. 영구 가드 / ratchet (재발 차단, [[jun-06-permanent-guards]] 표준)

red-on-injection이 "가드 실효성" 표준. allowlist는 file→count burn-down.

1. **single-PID kill 금지**: AST 스캔 — `Bun.spawn` 핸들 `.kill(` 직접 호출 금지(ProcessTreeKiller 경유만). 신규 spawn site가 우회하면 red.
2. **unbounded accumulator 금지**: 레지스트리류서 `+= chunk`/`+= value` 무한 누적 패턴 스캔(BoundedBuffer 경유 강제). fuzz로 bound 증명.
3. **spawn env scrub 강제**: spawn `env`에 `...process.env` raw spread 금지(scrubEnv/applyLocalEnv 경유만). pty 포함 전 spawn site.
4. **window SSOT drift**: `MODEL_CONTEXT_WINDOWS` ↔ 모델 카탈로그 정합(stale/누락 양방향).
5. **EOL-도입 금지**: edit이 균일-EOL 파일을 mixed로 만들지 않는다 — differential fuzz ratchet.
6. **read per-line bound**: 단일줄 출력이 `MAX_LINE_CHARS` 초과 불가, surrogate-safe.

---

## 7. 롤아웃 / 리스크 / 시퀀싱

**순서**(hot-path 1개씩 회귀):
1. **클러스터 B 먼저**(D6/D7/D8 순수함수, 독립, 병렬 worktree 가능, 리스크 최저) — corruption(D6) 우선.
2. **클러스터 A**(D1→D2→D3): ProcessTreeKiller 포트 먼저, 어댑터 (B)ppid-walk 기본, (A)pgid는 검증되면 fast-path. 3 spawn site 1개씩 배선+스모크(실제 `npm run dev` orphan 재현 e2e).
3. **클러스터 C**(D4→D5): window 테이블(순수)→resolveThreshold 배선→TokenBaseline loop 배선. compaction은 in-flight 사용자 작업 인접(loop 분해) — git status 확인 후.

**리스크**:
- D1 (A)pgid-kill의 Bun detached/macOS setsid 불확실 → **(B)ppid-walk를 기본**으로 안전하게(신규 dep 0). (A)는 optional fast-path.
- D4 동작변경(컴팩션 시점 이동) → unknown-model fallback으로 blast radius를 known-model로 한정. 스모크 배터리(`tests/smoke/`)로 회귀.
- D5 baseline-message-count 매핑 오류 시 over/under-trigger → `exact` 플래그 게이트 + 부재 시 legacy로 fail-safe.
- exec/compaction hot-path = 사용자 in-flight 충돌 가능 → 착수 전 `git status`([[jun-04-backlog7-rfc-and-n1]] 교훈).

**검증 게이트**: tsc 0 / biome 0 / 신규 hellgate red-on-injection 증명 / 회귀 0 / 스모크 배터리 통과 / feature-catalog+ratchet 갱신.

---

## 8. 명시적 비범위 (안 건드림)

- 알고리즘 코어(retry full-jitter / permission classifier / edit-matcher 4-rung / cost null-proto / compaction-strategy orphan-aware) — **이미 우위, §26.12 확인**.
- 실 BPE 토크나이저 번들 — D5(이미 받은 authoritative 사용)가 더 싸고 정확. tiktoken dep+provider 분기 = 비용↑ROI↓.
- `microcompact/compactor.ts` dead FIFO — **삭제**(별도 cleanup, footgun 제거)지 수정 아님.
- Windows shell(§17.2) / hardcoded `bash -lc` — 별도 RFC(surface 결정 필요, 이 RFC는 POSIX 수명/측정만).
- D1 (A)pgid fast-path의 setsid 바이너리 — 검증 후 follow-up, (B)가 portable 기본.

---

## 부록 — 각 결함의 "왜 나이브였나" 한 줄

- D1: spawn이 그룹리더 안 만듦 → kill이 PID-스코프(트리 무지).
- D2: accumulator가 개수만 cap, 크기 무지(렌더뷰만 tail-cap).
- D3: env chokepoint를 PTY 경로가 우회(runShell만 scrub).
- D4: threshold가 모델 차원 무지(단일 전역 상수).
- D5: authoritative 신호를 display로만 소비(트리거는 추정).
- D6: splice가 EOL 차원 무지(`\n`-only).
- D7: parser가 anchor 저장만, applier가 소비 안 함(파싱≠사용).
- D8: render가 라인 *수*만 cap, 라인 *길이* 무지.

**공통**: 측정/수명/정확성의 한 차원을 무시 — 코어 로직은 맞으나 가장자리 차원이 빠짐. 이 RFC는 그 빠진 차원을 1급 시민으로 승격.
