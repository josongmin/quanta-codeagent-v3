# jul-6 스모크 프롬프트 evidence

2026-07-06 두 스모크 런에서 실제 나간 SYSTEM 프롬프트. trajectory가 messages를 redact하므로
system은 `buildSystemPrompt`/`composeSystemPromptForSurface`로 **재구성**(결정적 → byte-faithful,
[jul-5-prompt](../jul-5-prompt/) evidence와 동일 방법론).

## 두 런

| 런 | 위치 | model | 결과 |
|---|---|---|---|
| **SWE 스모크** | 로컬, picks-3, `QUANTA_BENCH_PROMPT_SECTIONED=1` | gpt-5.4 | 1/3 pass (sympy PASS · requests/pylint completed_unresolved), 패치 3/3, 크래시 0, $0.52 |
| **TB 스모크** | 원격 박스 i-04ca, harbor terminal-bench, 3-task | gpt-5.5 | guard 1/1 green(fix-git) · targets 0/2 (polyglot-c-py·sam-cell-seg) |

## 파일

| 파일 | 내용 |
|---|---|
| `01-swe-sectioned-graderonly-system.txt` | SWE system — `batch + grader-only + sectioned` (16 `##` + 1 `###`). 3 인스턴스 공통 |
| `02-tb-brain-owned-system.txt` | TB brain system — owned posture, flat (`##` 0, 콜론-라벨). 3 태스크 공통 |
| `03-swe-per-instance-issues.md` | SWE 3 인스턴스 issue (public) — user 메시지 실체 |

## 실제 config (report.json knobs 기준)

- **SWE**: `promptPack=batch` · `verifyStrategy=grader-only`(preset `bench-in-loop-exec=off` → config-build 자동)
  · `promptStyle=sectioned`(env knob) · `envPosture=frozen`. sectioned라 헤더가 `##`(F1/F2/F3 정리 반영);
  grader-only라 Verification report(`###`)+Completion bar **suppress** → `##16 + ###1`(sectioned 기본은 `##15+###2`).
- **TB**: brain-mode 경로(`TERMINAL_SURFACE_PROFILE`) — **SWE의 sectioned/grader-only 안 탐.** flat + `envPosture=owned`.

## 주의

- system은 재구성(trajectory redact). user 메시지(issue+Agentless 힌트+grader hard-rules 프리앰블)는
  런타임 조립분이라 issue 본문(public)만 `03`에 보존.
- TB brain은 로컬 src로 재구성 — 박스 src(Jul-4)와 미세 차이 가능(brain profile은 안정적).
- ⚠️ **효능 미측정**: SWE는 sectioned 단독 스모크("안 깨진다"만), flat 대비 resolved A/B 아님. TB는 sectioned 무관(brain 경로).
