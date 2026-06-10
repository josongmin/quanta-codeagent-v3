# T-05 — tracking + fc + ratchet + DoD CI 게이트

- **상태**: OPEN. 우선순위 1-동률(완성 유지 — CLOSE 경로면 이것만 돌리면 못박힘).
- **충돌주의**: feature-catalog(fc)는 동시 세션이 `surface_integration` 축 작업 중 → fc 엔트리 추가 시 reconcile.

## 기능 / 왜 / ROI
- **(기능)** 키스톤 16칸 + 3도구를 fc 엔트리/ADR로 등록하고, DoD §4를 **ratchet으로 영구 가드**(새 언어칸·새 파서 회귀 자동 적발). 언어 커버리지 매트릭스를 추적 SSOT로.
- **(왜)** 지금 "16/16 LIVE"는 e2e 1회 green으로 증명됐지만, **회귀 가드가 없으면** 다음 리팩터가 한 칸 깨도 모른다(memory `jun-09-integration-audit-3round`: slice-green≠tree-green). fc 미등록 도구는 drift 라쳇이 못 잡음.
- **(ROI)** 높음. 완성을 **유지**시키는 유일한 티켓. CLOSE 결정 시 이것만 돌려 못박고 종료.

## 접근 (grounded)
1. **fc 엔트리**: `collect_evidence`/`run_tests`/`debug_inspect` + 5파서/4LSP/4runtime을 feature-catalog에 등록(evidence.code+adrs+tests). `bun fc`로 검증.
2. **ADR**: 이번 세션 LANDED(D06~D11)에 ADR 번호 부여(D05=ADR-0533 이후 next-free; 충돌 시 user-deference renumber — memory `adr-collision-policy`).
3. **커버리지 매트릭스 가드**: detect/lsp-bridge/runtime dispatch의 언어셋이 §1 표와 일치하는지 **drift 라쳇**(독립 리터럴 앵커 — 비동어반복; memory `tool-surface-ssot` 패턴). 이미 있는 `.go→gopls`·`parser:"node"` 가드 확장.
4. **DoD CI 게이트**: §4 4항목을 1 커맨드로(`bun run typecheck` + 타겟 스위트 + ratchet) — 머지 전 체크리스트.
5. **manifest GATED**: 3 도구가 manifest GATED + knob trio 등록됐는지 확인(누락 시 보강).

## DoD (자기참조 — 이 티켓이 §4를 못박는다)
- fc 클로버 0(신규 도구 풀 evidence) · ratchet 0 위반 · 16칸 매트릭스 라쳇 green.
- ADR 등록 완료(D06~D11) · manifest/knob trio 완비.
- `docs/plans/jun-10-multilang-debug-coverage/00-index.md`가 상태 정본으로 유지(이 인덱스).
