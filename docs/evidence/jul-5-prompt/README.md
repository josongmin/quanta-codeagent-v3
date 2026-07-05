# jul-5 실측 프롬프트 evidence

quanta가 실제 LLM에 보내는 프롬프트를 코드 실행으로 뽑은 것(추측 없음). 두 출처:
- **실제 벤치 실행 카세트**: SWE-bench `psf__requests-5414` (requests가 `http://.example.com`에서 UnicodeError) · model `gpt-5.5` · **12턴 · patch 586B · 133s · 159k in/1.8k out tokens · $0.56** · 결과 FAIL(completed_unresolved — 패치는 생성, gold 미해결). trajectory record(`QUANTA_TRAJECTORY=1`) + observe dir에서 추출.
- **3축 렌더 변형**: `buildSystemPrompt(...)` 직접 호출로 각 조합의 정적 system 프롬프트.

## 케이스 목록

| 파일 | 케이스 | 크기 |
|---|---|---|
| `00-main-coding-agent-turn1.txt` | 메인 코딩 에이전트, turn 1 실제 (system 24071B batch + user: Agentless issue-hints + issue) | 28KB |
| `02-main-coding-agent-turn12-full.txt` | 메인 에이전트 마지막 턴(12), 실제 12턴 누적 messages(tool_use/tool_result 포함) | 9.6KB |
| `01-localize-subagent.txt` | fault-localization sub-agent (system 492B 실체 + issue+filetree) | 2.8KB |
| `10-render-cli-interactive.txt` | 3축 렌더: CLI/interactive `{}` (frozen, no pack, no verify) | 23877B |
| `11-render-swe-batch.txt` | 3축 렌더: SWE `{promptPack:batch}` (frozen + R-NO-EXPLORE-OVER-EDIT) | 24071B |
| `12-render-tb-owned.txt` | 3축 렌더: TB `{envPosture:owned}` (R-ENV-OWNED, 설치 자유) | 23335B |
| `13-render-swe-reproduce-first.txt` | 3축 렌더: SWE + `{verifyStrategy:reproduce-first}` (R-REPRODUCE-FIRST) | 24524B |
| `14-render-cli-verify-after-edit.txt` | 3축 렌더: CLI + `{verifyStrategy:verify-after-edit}` (R-VERIFY-AFTER-EDIT) | 24172B |

## 파이프라인 (실측)

```
localize sub-agent (system 492B, 파일 지목)  →  "requests/models.py"
   └─► 메인 에이전트 user[0]에 "## Issue Hints (Agentless localization)" 로 주입
         → 메인 코딩 에이전트 (system 24071B 3축 SWE) 12턴
            edit models.py ×N → git diff → patch 586B
```

## 주의

- 메인 에이전트 system은 trajectory에 **마스킹**(sys=1)됨 — spot-resume canonicalizer가 캐시 프리픽스(정적 system)를 휘발성 마스킹하고 messages만 replay용으로 저장. 그래서 `00`/`02`의 system은 `buildSystemPrompt({promptPack:"batch"})` 재구성(= `11-render-swe-batch.txt`와 동일). trajectory엔 그 위 messages만 실체.
- 이 실행은 **verify 축 OFF**(reproduce-first knob 안 켬) — 켰다면 `00` system에 `13`처럼 R-REPRODUCE-FIRST 블록이 추가됨.
- 실제 LLM 입력 = `system[]`(정적·캐시) + `messages[]`(history + 맨 끝 `<system-reminder>` 동적: date/cwd/memory).
