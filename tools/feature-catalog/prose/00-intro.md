quanta-codeagent-v3에 **구현·배선된** 기능 전수 목록. **대**(주요 시스템) → **중**(하위 능력) → **소**(구체 기능/노브) 3단.

근거: RFC `rfc/0001-architecture.md`, ADR `docs/decisions/0001~0027`. cross-import는 `@/agent`만(슬라이스 격리). 운영 reference: [docs/runbooks/agent-loop-reference.md](docs/runbooks/agent-loop-reference.md).

## 성숙도 5단계 척도

있다/없다 이분이 아니라 **구현 폐쇄도(closure)** 를 5단계로:

| 등급 | 의미 |
|---|---|
| **L5 ●●●●●** | 완성·검증 — 구현·배선·단위+통합테스트, **실 LLM 스모크 또는 e2e 폐쇄** 확인됨 |
| **L4 ●●●●○** | 견고 — 구현·배선·단위+통합테스트(실 runAgent, mock LLM). 실 LLM 스모크는 미실시 |
| **L3 ●●●○○** | 동작 — 구현·배선됨, **단위테스트 위주**(통합 미검증) |
| **L2 ●●○○○** | 부분/한계 — 동작하나 **의도적 제약·advisory·옵셔널 미도달** |
| **L1 ●○○○○** | 골격/보류 — **타입/API만 노출**, 루프 미배선, 의식적 후속 |

`⚙️` = env/config 노브(기본 OFF·behavior-preserving).
