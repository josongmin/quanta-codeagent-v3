# Terminal-Bench — 우리 vs 공개 리더보드 풀이 교차표 (2026-07-01)

우리가 실제로 돌린 10개 task를 **quanta+gpt-5.4/5.5 결과 + 공개 리더보드(어떤 모델/스캐폴드가 풀었나)**와 교차. per-task 풀이 이력·trajectory 덤프는 `<task>/` 폴더에.

> 데이터 출처: 우리 런(`/tmp/tb-results/run10`=5.4, `run55`=5.5) + 공개 trajectory(abacusai run-logs, terminal-bench-core) + tb-2 전용은 [tbench.ai 리더보드](https://www.tbench.ai/leaderboard/terminal-bench/2.0).

## 마스터 교차표

| task | 우리 5.4 | 우리 5.5 | 공개 리더보드 | 폴더 |
|---|:--:|:--:|---|---|
| [reshard-c4-data](reshard-c4-data/) | ✅ | ✅ | **0/17 (아무도 못 풂)** | rich |
| [pytorch-model-cli](pytorch-model-cli/) | ✅ | ✅ | 2/3 run(orchestrator: sonnet 5/5·opus 4/5·qwen 0/5) | rich |
| [log-summary-date-ranges](log-summary-date-ranges/) | ✅ | ✅ | tb-2 전용(tbench.ai) | ref |
| [break-filter-js-from-html](break-filter-js-from-html/) | ❌ | ✅ | tb-2 전용 | ref |
| [llm-inference-batching-scheduler](llm-inference-batching-scheduler/) | ❌ | ✅ | tb-2 전용 | ref |
| [merge-diff-arc-agi-task](merge-diff-arc-agi-task/) | ❌ | ✅ | tb-2 전용 | ref |
| [write-compressor](write-compressor/) | ❌ | ✅ | **0/17 (아무도 못 풂, agent_timeout)** | rich |
| [largest-eigenval](largest-eigenval/) | ❌ | ❌ | tb-2 전용 | ref |
| [gpt2-codegolf](gpt2-codegolf/) | ❌ | ❌ | **0/17 (진짜 천장, 아무도)** | rich |
| [winning-avg-corewars](winning-avg-corewars/) | ❌ | ?(미완) | tb-2 전용 | ref |

**우리 성적**: gpt-5.4 = 3/10 · gpt-5.5 = **7/10**(corewars 미완 제외). 5.5가 5.4 대비 +4 flip.

## 핵심 결론 (교차로 검증된 것)

1. **우리가 못 푼 게 = 아무도 못 푸는 것.** gpt2-codegolf: 공개 리더보드 **0/17**(cheap qwen-480B~frontier claude-4-5-sonnet/gpt-5 + orchestrator/droid/openhands/cursor/swe-agent/ante/apex/deepagent 전부). **cheap 모델이 우리 실패를 푼 사례 0** → 스캐폴드 갭 아님, 모델천장. (원 질문 답)

2. **우리가 공개 리더보드 전원(0/17)을 이긴 task 2개**: `reshard-c4-data`(우리 5.4+5.5 둘 다 ✅ vs 공개 전멸) · `write-compressor`(우리 5.5 ✅ vs 공개 전멸 agent_timeout).
   - ⚠️ **정직 caveat**: gpt-5.5는 리더보드 모델들(claude-4.x/gpt-5)보다 **신형** + 우리 5.4도 write-compressor 실패 → 대부분 **모델 세대 효과**지 "우리 스캐폴드가 저들 스캐폴드를 이겼다"는 증명 아님. n=1. reshard는 우리 5.4도 풀었으니 좀 더 유의미(하지만 공개 런이 약간 다른 instruction 표현으로 채점된 정황 있음 — 폴더 참조).

3. **pytorch-model-cli = 스캐폴드+모델 조합 예시**: 같은 orchestrator 스캐폴드인데 claude-4-sonnet 5/5, qwen-480B 0/5(C 컴파일 절반서 타임아웃). 모델 역량이 가름.

## ⚠️ 데이터 품질 한계 (덤프 읽을 때 유의)

- 공개 corpus의 **`commands.txt`는 harness tmux 키스트로크**(에이전트 실제 명령 아님) — 특히 orchestrator는 에이전트를 out-of-band로 돌려 실 명령 미기록. 실 흔적은 `sessions/agent.log`/`panes/post-test.txt`에 부분적. 각 `scaffolds/` 덤프는 그 실 흔적으로 대체함(폴더 README에 명시).
- 공개 `total_output_tokens`가 다수 null → 토큰 비교 제한적.
- **우리 brain은 자체 명령 trace 미캡처**(known gap) → "우리" 열은 결과·토큰만, 명령 덤프 없음. (serve 프레임 로깅하면 확보 가능 — follow-up.)
- tb-2 전용 6개는 공개 벌크 trajectory 없음(tbench.ai만) → ref 폴더는 정답 solve.sh + 우리 결과·실패이유만.
