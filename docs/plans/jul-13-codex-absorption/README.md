# Codex 5059(ChatGPT.app) 흡수 — RFC 인덱스 (HEAD 검증 리뷰 반영)

`.extracted_source/codex/`(build 5059 / codex-rs 0.144.0-alpha.4) 엔진 6후보를 각각 RFC로.
**전부 HEAD 실물 검증 완료(targeted rail 26 pass / 0 fail).** 각 RFC 상단 ⚠️정정 블록이 본문 우선.

## 후보별 판정 (정정 후)

| RFC | 판정 | 실제 델타 |
|---|---|---|
| [01 code_mode](01-code-mode.md) | **LANDED** (커널 이미 있음, 6월8일) | store/load 계약·출력예산(exact tokenizer 있을 때만). `text()/exit()`는 gap 아님. "no console"은 no-op console 존재로 정정. 별도-host = containment **backlog**(중복 아님) |
| [02 multi_agent](02-multi-agent-delta.md) | 델타 혼합 | **fork_turns = core already-have + XS schema activation gap**(6-tool `SpawnAgentInputSchema`가 필드 reject→모델경로 inert). slot=already-have. **delegation suppression = 유일 true gap** |
| [03 execpolicy amendment](03-execpolicy-amendment.md) | **NO-GO** | authorization model 변경. capability-grant지 prefix allowlist 아님. session-prefix로 pain 대부분 해결 |
| [04 time+sleep](04-current-time-sleep.md) | **BACKLOG** | short sleep vs durable wait 분리 필수. finite-turn 벤치선 미착수 |
| [05 budget/compaction](05-budget-compaction.md) | **record-and-skip** | budget=USD가 더 적합(superset 표현 금지). compaction=우리가 superset 아님(canonical log 부재). comp_hash 단독=detection만, recovery 불가 |

## 최종 우선순위 (정정)

1. **fork_turns 6-tool schema activation gap 수정** — `SpawnAgentInputSchema`에 optional `fork_turns` + end-to-end 테스트. (XS)
2. **system-level delegation suppression + topology-aware A/B** — 억제를 policy SSOT 1곳에, 두 tool surface 투영. metric = task success·tokens·wall time·duplicated exploration·write collision·error propagation. 외부근거(Google 180-config: sequential서 multi-agent 39–70% 악화)로 **default-ON 후보**(eval 회귀확인 후).
3. **code_mode ON/OFF 실측** — 효능 워크로드-dependent, A/B가 명분.
4. 효과 있으면 **bounded session store/load**(계약 필수: namespace·quota·serializable·redaction·deterministic clear·audit·proto 방어).
5. **max_output_tokens는 exact tokenizer port 있을 때만** — 없으면 max_output_bytes 유지.
6. **execpolicy amendment = no-go.**
7. **time/sleep = backlog.**
8. **compaction provenance** = long-horizon persistence가 실제 제품목표 될 때만 승격(versioned context projection + canonical log). hash 단독 비추천.

## 메타

OmO·Codex 흡수 스윕 둘 다 "가져올 거 거의 없음"으로 수렴. 실 착수감 = **#1 fork_turns 활성화 + #2 delegation suppression** 둘뿐(둘 다 저비용). 나머지는 이미 보유거나 backlog/no-go. 신호 = 경쟁사 베끼기 종료, 프론티어(북극성·oracle-loop·synthesis)로.
