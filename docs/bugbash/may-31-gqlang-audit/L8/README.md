# L8 Audit — Permission / Security / Sandbox / Plugin-Isolation

**Date:** 2026-05-31
**Scope:** Lane L8 (~14.4k TS LOC, non-test) — `src/permission` (6.9k) + `src/security` (3.2k) + `src/runtime` incl. `os-sandbox` (4.3k) + `src/plugin-isolation` (2.5k LOC ts+js)
**Lenses:** code quality, missing features, silent errors, error swallowing, 짜치는 코드, SOLID violations, race/cancellation, **fail-open vs fail-closed** (이 레인의 1순위 렌즈)
**Method:** 4 서브영역 × (객관 + 적대) = 8병렬 에이전트 dispatch. 서버측 rate-limit으로 6개가 생성 단계에서 죽고 **2개만 완주**(permission-core 객관 / persistence 객관). 나머지 — 특히 최고위험 영역인 **security(L8c) + runtime·sandbox(L8d)** — 는 Claude가 메인 스레드에서 핵심 파일을 직접 정독하여 객관+적대 둘 다 커버. 모든 wiring 주장은 `grep`으로 실증.

## Result summary

| | count |
|---|---|
| Confirmed CRITICAL/HIGH | 5 |
| Medium | 8 |
| Low / Info | 9 |
| 잘 된 것 (positive controls 기록) | 5 |

## Verification status legend

- **[확인됨]** — Claude 본인이 소스를 직접 정독 + wiring을 grep으로 실증
- **[검증됨]** — 완주한 objective finder 에이전트 보고 (permission-core / persistence), synthesis 중 일부 spot-check
- **[미배선-잠복]** — 결함은 실재하나 `grep`상 현재 production 호출처 없음. 배선되는 순간 활성화되는 지뢰

## Coverage 정직성 고지

permission **적대 렌즈 2바퀴**(우회 시나리오 — glob bypass / precedence confusion / ReDoS / auto-approval poisoning)는 rate-limit으로 **미완**. 본 문서의 permission findings는 객관 finder + Claude spot-check 기반이며, 적대 우회 전수조사는 후속 과제다. security·sandbox 적대 렌즈는 Claude 직독으로 커버됨.

## Documents

- [01-critical-high.md](01-critical-high.md) — 5 confirmed CRITICAL/HIGH, evidence/file:line/why/fix. **여기서 시작.**
- [02-medium-low.md](02-medium-low.md) — 8 medium + 9 low/info + positive controls + cross-cutting themes.

## Top-priority fix set (highest ROI)

| # | severity | issue | file:line | 상태 |
|---|---|---|---|---|
| 1 | HIGH | sandbox wrap 결과에서 `argv`만 취하고 `sandboxApplied`/`degradeReason` 폐기 → 백엔드 부재 시 조용히 비샌드박스 실행 (fail-open, fail-closed 옵션 부재) | [shell.ts:67-70](../../../../src/runtime/shell.ts#L67) | 확인됨 |
| 2 | HIGH | secret 미주입 시 소스에 박힌 공개 HMAC 키 `"test-secret"`로 폴백 → 토큰 위조 가능 | [bridge-attest/default-attestor.ts:50,134-143](../../../../src/security/bridge-attest/default-attestor.ts#L50) | 확인됨 (미배선-잠복) |
| 3 | HIGH | trust-scope 레이어 내 `deny`가 배열순서에 따라 안 이김 → docstring 계약 위반 fail-open | [trust-scope-store.ts:373-423](../../../../src/permission/trust-scope-store.ts#L373) | 검증됨 |
| 4 | HIGH | 보호 브랜치 위 `git reset --hard HEAD~N`이 차단 안 됨 | [branch-only.ts:131-154](../../../../src/permission/branch-only.ts#L131) | 검증됨 |
| 5 | HIGH | `pathPrefixMatches` 정규화 부재 → `..` 트래버설이 write allow-list 통과 | [access-check.ts:53-66](../../../../src/permission/access-check.ts#L53) | 검증됨 |

## Cross-cutting themes (요약 — 상세는 02 문서)

1. **Honest-degrade 철학의 함정**: os-sandbox 계층은 degrade 사유를 정직하게 *계산*하지만, 최상위 소비처(`runShell`)가 그 신호를 *폐기*한다. degrade가 per-command로 침묵 → "샌드박스 켰다" 오인.
2. **Default-OFF seam의 잠복 지뢰**: bridge-attest / jwks-identity는 잘 설계됐으나 production 미배선. 배선 전 secret-폴백·exp-검증 갭을 봉인해야 함.
3. **trust 영속화의 deny-우선 위반**: deny가 항상 이긴다는 문서 계약이 코드(배열 첫-매치)에서 안 지켜짐.
4. **observability 없는 안전-방향 swallow**: scanFile/jwks-fetch/classifier-port 예외가 무관측 삼킴. 안전 방향이긴 하나 "scanner 고장"과 "clean"이 구분 불가.
5. **잘 된 방어 자세**: guarded-spawn RAII, scrubEnv 근거, DockerSandbox fail-closed, seatbelt deny-default, plugin-host NO-THROW — positive controls로 기록.
