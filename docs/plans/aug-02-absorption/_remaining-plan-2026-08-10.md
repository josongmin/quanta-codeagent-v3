# 남은 작업 계획 — 2026-08-10 현재기준

원천: 5영역 backlog 2-바퀴 감사(`_backlog-audit-{rfc01,rfc04,rfc05,rfc06,flake-residuals}.md`) + 이번 landing(`b12f5a9bd` 4 dead-seam 배선). 결론: **흡수 backlog 거의 소진**. RFC-01~10 + 6321 delta 전부 ALREADY-BUILT/DROP/landed. 남은 건 아래 leftover뿐.

## 완료 (이번 세션)
- ✅ worktree salvage: 70 누수 → 0 (SAFE 19 rm · 중복 UNIQUE 6 rm · dirty/locked 42 rm · W4 patch 보존 · main만 잔존)
- ✅ RFC-01 A2 crash-recovery 배선 · RFC-06 B3 worktree reconcile 배선 · RFC-06 B4 @thread lineage-scope · flake-pool bench-closure 구조fix(ratchet 2→1)

## 남은 것 (ROI 순, 전부 현재코드 grounding됨)

### 🟢 Small wiring/safety — 착수가능, LOW effort
| # | 항목 | 왜 | ROI | 근거 |
|---|---|---|---|---|
| 1 | **RFC-01 A2 expectedFileHashes 채우기** | 지금 `{}`(TOCTOU 가드 미populate) — rollback이 drift된 파일 위에 복원할 위험 | S/안전 | audit-rfc01 |
| 2 | **RFC-01 A1 revision rehydrate** | resume 시 `revision` 미복원(seq만) → 편집 카운터 불연속 | S | audit-rfc01 |
| 3 | **RFC-06 A4.3 usage_limited live producer** | objective budget이 model self-report로만 먹임 — 측정된 provider usage 미연결이라 `usage_limited` dead-in-prod | MED | audit-rfc06 |
| 4 | **RFC-04 guardian risk-tier** | `riskLevelFor` binary(read-only?low:high) — `medium` 도달불가·`critical` 없음(Codex 4-tier 대비). advisory-only로 graded화 | S/optional | audit-rfc04 |

### 🟡 Larger / needs design
| # | 항목 | 왜 | ROI |
|---|---|---|---|
| 5 | **RFC-01 A1 full-fidelity checkpoint** | 현 rehydrate=transcript-only(tool-pair/approval/artifact roundtrip 없음). 진짜 durable-resume엔 full snapshot schema 필요 | L, DESIGN-FIRST |
| 6 | **RFC-06 B4 browser-tab mention + autocomplete 확장** | mention 소스가 아직 file+symbol만(agent/mcp/thread는 landed) | MED |
| 7 | **flake-pool 잔여** | node-repl 1 entry(per-test child isolation) + 58 shared-knob env de-globalize(광역) | M-L, 저ROI/점진 |

### 🔴 Measure-first — **진짜 남은 큰 질문**
| # | 항목 | 왜 |
|---|---|---|
| 8 | **default-OFF 흡수기능 전량 효능 A/B** | RFC-01~13 전부 built+gated-OFF. **아무도 default-ON이 SWE/품질 개선하는지 측정 안 함.** 흡수의 의미는 여기서 결정 — bench A/B 없이 flip 금지(measure-first 원칙) |

### ⛔ 착수금지 (의도적 deferred)
- A6 WS 턴전송 — measure-first 전 금지, separate track
- ExecPolicy TOML — 중복 front-end, external fixture 전 DROP

## 권장 순서
- **Wave A (즉시, 안전 leftover)**: #1 expectedFileHashes · #2 revision rehydrate · #4 guardian risk-tier — 전부 S, 파일-disjoint, hellgate
- **Wave B**: #3 usage_limited producer(측정 usage 연결) · #6 browser-tab mention
- **Wave C (측정)**: #8 효능 A/B — 이게 사실 최우선 전략질문(빌드는 다 됐고 효능이 미지수). bench 인프라 필요, 별도 캠페인
- **보류**: #5(design 먼저) · #7(저ROI) · A6

**관통**: 코드 흡수는 사실상 끝. 남은 실질 작업 = 소수 안전 wiring(Wave A) + **효능 측정(#8)**. #8이 "흡수한 게 실제로 도움되나"의 답이고 가장 전략적.
