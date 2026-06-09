# jun-09 — 남은 흡수 후보 (경쟁사 갭, 결정 대기)

- **날짜**: 2026-06-09
- **출처**: `jun-7-gap-other-agent.md` §27 (코퍼스 2026-06-01 refresh content-diff) 에서 **아직 연동 안 된 것만** 추출 + 직전 reconcile의 진짜 잔여.
- **목적**: 흡수/defer/skip **결정 보드**. jun-7-gap-other-agent.md 본체는 jun-09에 reconcile 완료(닫힌 것 ✅ flip) — 이 문서는 그중 **남은 to-do만** 모은 라이브 결정판.
- **결정 범례**: ⬜ 미정 · ✅ 흡수 · ⏸ defer · ❌ skip(의식적). `결정` 칸 `rec:`=권장(override 가능).
- **신뢰도 주의**: 흡수-fleet이 throttle로 수회 전멸 → inline 단독 어딧. 읽기쉬운 소스(CC settings 123필드/slash/hooks · Codex config.toml/symbol덤프 · Cursor 확장)는 완독, **Codex/Desktop webview minified 로직(collaboration-mode/appgen/telepathy 깊은 메커니즘)은 부분만** — conf=中-低 항목은 content-diff 추가 패스 필요(3바퀴 워크플로우 `competitor-absorption-r3` 결과 도착 시 §F에 병합).

---

## §A 신규 기능 후보 (quanta 부재 — grep 확인)

| # | 후보 | 출처 (경쟁사 evidence) | quanta gap | 흡수 메커니즘 | ROI | effort | conf | 결정 |
|---|---|---|---|---|---|---|---|---|
| N1 | 어시스턴트 언어 자동감지 | Cursor `whichlang-node` (agent-exec, `assistant-language-tracking`, 16-lang) | grep 0 | 유저 입력언어 감지→system-prompt `respond in <lang>` | 중 | S-M | 高 | ⬜ rec:흡수 |
| N2 | Codex collaboration-mode | Codex 3390 webview `use-collaboration-mode`·`pending-request-item-panel` | multiagent 있으나 collab UX 별개 | 실시간 다자 협업 턴 + 승인대기 패널 | 중 | M | 中 | ⬜ rec:content-diff 후 |
| N3 | Codex appgen 앱생성 | Codex 3390 webview `appgen-page/share-dialog/access-mode` | 전무 | 배포가능 앱 생성 surface | 저-중 | L | 中 | ⬜ rec:defer |
| N4 | `/doctor` 환경 진단 | CC `_cli-symbols.txt` `/doctor` | slash 부재 | env/config/연결성/MCP 헬스 1샷 진단 | 중 | S | 高 | ⬜ rec:흡수 |
| N5 | `/catch-up` 세션간 변경요약 | CC `/catch-up` | 부재 | 마지막 세션 이후 repo/대화 변경 요약 | 저-중 | S-M | 中 | ⬜ |
| N6 | `/babysit-prs` 자율 PR 모니터 | CC `/babysit-prs` | 부재 | PR CI/리뷰 폴링 + 자동대응 루프 | 저-중 | M | 中 | ⬜ |
| N7 | 모델 personality 프리셋 | Codex config.toml `personality` | grep 0 | 응답 톤/페르소나 프리셋 system-prompt | 저-중 | S | 高 | ⬜ |
| N8 | request body gzip 압축 | Codex `enable_request_compression` | grep 0 | 대용량 컨텍스트 LLM 요청 gzip | 저 | S | 高 | ⬜ |
| N9 | `undo` 도구 (액션 되돌리기) | Codex `undo` tool | grep 0 | 직전 mutating 액션 되돌리기(file_history 위 일반화) | 중 | S-M | 高 | ⬜ rec:흡수 |
| N10 | `js_repl` 도구 | Codex `js_repl_tool` | grep 0 | 세션 영속 JS REPL (code-mode와 별개) | 저-중 | M | 高 | ⬜ |
| N11 | `chronicle` 세션 저널 | Codex `chronicle` | grep 0 | 세션 행적 연대기(무엇/왜, 시간순) | 중 | M | 中 | ⬜ rec:observability 북극성 정렬 |
| N12 | `telepathy` 에이전트간 도구 | Codex `telepathy` tool | grep 0 | 에이전트간 공유 컨텍스트 push | 저 | M | 低 | ⬜ |
| N13 | web_search cached 모드 | Codex `[features].web_search`=live\|cached\|disabled | cached 없음 | 캐시 검색결과 재사용(비용/속도) | 저 | S-M | 高 | ⬜ |

## §B 기존 기능 강화 후보 (quanta 얕음/부분)

| # | 후보 | 출처 | quanta 현재 | 강화점 | ROI | effort | conf | 결정 |
|---|---|---|---|---|---|---|---|---|
| E1 | managed-only 엔터프라이즈 락다운 | CC `allowManaged{Hooks,McpServers,PermissionRules}Only`·`strictPluginOnlyCustomization` | central-config+trust(ADR-0497) | 관리자가 managed 레이어만 강제(유저 loosening 차단) | 중(ent) | M | 高 | ⬜ rec:흡수 |
| E2 | MCP denylist + marketplace 거버넌스 | CC `deniedMcpServers`·`blockedMarketplaces`·`strictKnownMarketplaces` | allowed/enabled만 | denylist + known/blocked marketplace 정책 | 저-중 | S-M | 高 | ⬜ |
| E3 | `/rewind` 체크포인트 복원 슬래시 | CC `/rewind` | `file_history_rewind` 도구만, slash UX 없음 | 인터랙티브 파일 스냅샷 타임라인 복원 | 중 | S | 高 | ⬜ rec:흡수 |
| E4 | `/goal` 목표 추적 슬래시 | CC `/goal` | objective 시스템 있음, slash 없음 | objective set/show/clear slash | 저 | S | 高 | ⬜ |
| E5 | cursor-agent-worker startup prewarm | Cursor `cursor-agent-worker` | side-agent/attach-daemon 유사 | startup 상시대기 background agent prewarm | 중 | M | 中 | ⬜ rec:daemon 중복확인 |
| E6 | `claudeMdExcludes` 메모리 로드 제외 | CC `claudeMdExcludes` | CLAUDE.md 무조건 로드 | 거대/무관 메모리 제외 globs | 저 | S | 高 | ⬜ |
| E7 | `/hooks` 인터랙티브 관리 | CC `/hooks` | hook 11종 있음, 관리 slash 없음 | hook list/enable/disable/test slash | 저 | S | 高 | ⬜ |
| E8 | 메모리 lifecycle GC + 모델분리 | Codex `max_unused_days`·`consolidation_model`·`extract_model` | 2-phase distill, GC/모델선택 knob 없음 | 미사용 메모리 GC + consolidation/extract 모델 분리 | 저-중 | S-M | 高 | ⬜ |
| E9 | session rollout/store retention GC | Codex `max_rollout_age_days`·`min_rollout_idle_hours` + CC `cleanupPeriodDays` | session store, age/idle GC 없음 | 세션 보존 GC(나이/idle/startup당) | 저-중 | S-M | 高 | ⬜ |
| E10 | plan-mode 전용 reasoning effort | Codex `plan_mode_reasoning_effort` | 5-tier effort, plan-mode 별도 없음 | plan 모드 별도 effort tier | 저 | S | 高 | ⬜ |
| E11 | granular hook 포인트 | Cursor `beforeContext`·`beforeMCPExecution` | PreToolUse/beforeReadFile만 | `PreContext`·`PreMcpExecution` hook 추가 | 저 | M | 中 | ⬜ |
| E12 | per-agent usage-hint text | Codex `root_agent_usage_hint_text`·`subagent_usage_hint_text` | grep 0 | root vs subagent 별 사용힌트 주입 | 저 | S | 高 | ⬜ |
| E13 | `child_agents_md` 서브에이전트 instruction | Codex `child_agents_md` | AGENTS.md 있으나 child 전용 미확인 | 서브에이전트 별도 instruction 파일 | 저 | S | 中 | ⬜ |
| E14 | apply_patch streaming events | Codex `apply_patch_streaming_events` | V4A apply_patch, streaming 미확인 | 패치 적용 진행 streaming(대형 패치 UX) | 저 | M | 中 | ⬜ |

## §C 진짜 잔여 (의식적 defer / 외부차단 — 흡수대상 아님)

| 항목 | 상태 | 근거 |
|---|---|---|
| NotebookEdit (P17, §16.5) | ⏸ defer | ipynb write 도구 부재; 노트북 유저층 확인 시 |
| Windows `bash -lc` (P16, §17.2) | ⏸ defer | darwin서 테스트 불가, 플랫폼 수요 대기 |
| crash-RESUME interrupted-turn 마커 (§13.2) | 🟡 built-not-wired | same-turn interrupt-restore는 LANDED; 영속 마커만 미배선 |
| Codex computer-use (matured) | ⏸ RFC-defer | 최고 보안표면, Tauri/desktop-only |
| Mantle SDK 어댑터 | ❌ blocked | `@anthropic-ai/mantle-sdk` 미발행(외부) |
| jun-8-ide-plugin 플랜 (`/plugins` 표면 등 티켓 01-08) | 📐 design | 인프라 reuse✅, 티켓 미구현 — forward 작업(닫힌 백로그 아님) |

## §D 저ROI / skip 권장 (결정만)

CC UI 토글: `showThinkingSummaries`·`showTurnDuration`·`showMessageTimestamps`·`spinnerTips`·`terminalProgressBarEnabled`·`theme`·`prefersReducedMotion`(a11y) · `attribution`·`autoUpdatesChannel`/버전핀 · `skipWebFetchPreflight` · `isolatePeerMachines` · `feedbackSurveyRate` · `companyAnnouncements`. → surface polish/니치, quanta 모델과 결 다름. **결정: ⬜ (기본 ❌)**

## §E 우선순위 제안 (rec)

1. **싸고 체감 큼**: N4 `/doctor` · E3 `/rewind` · N9 `undo` · N1 언어자동감지 (전부 S-M, 高 conf)
2. **북극성 정렬**: N11 chronicle (agent-state observability)
3. **엔터프라이즈**: E1 managed-only 락다운
4. **content-diff 후 결정**: N2 collaboration-mode · N3 appgen · N12 telepathy (conf 中-低)

## §F 3바퀴 워크플로우 결과 (도착 시 병합)

> `competitor-absorption-r3` (jun-09, R1 딥리드 webview content-level + R2 grep-verify + R3 completeness) 결과는 도착 후 여기 병합. §A/§B와 dedup된 **추가 신규 후보**만.
>
> _(pending)_
