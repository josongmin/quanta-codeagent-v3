---
instance_id: django__django-10097
repo: django/django
base_commit: b9cf764be62e77b4777b3a75ec256f6209a57671
version: 2.2
difficulty: <15 min fix
created_at: 2018-06-26T23:30:51Z
fail_to_pass: 438
pass_to_pass: 1432
gold_files: [django/core/validators.py]
primary_type: T-ConstraintReason
tier: T3
loc_axis: L0
repair_strategy: S2 (+S4)
knowledge: K-Gen
flags: [overfit-risk, regression-trap]
---

# django__django-10097

## 문제 요약
`core.validators.URLValidator`가 #20003 이후 `user:pass` 인증 정보를 가진 URL을 허용하는데, RFC 1738 §3.1이 요구하는 "user/password 필드 내의 `:`, `@`, `/`는 %-인코딩되어야 한다"를 강제하지 않는다. 그 결과 `http://foo/bar@example.com` 같은 잘못된 URL이 통과하고, 임의의 invalid URL에 `?m=foo@example.com` 같은 쿼리스트링을 붙이면 (탐욕적 매칭이 경로의 `@`를 authority로 흡수해) valid로 둔갑한다. 사용자는 인코딩 안 된 특수문자가 든 authority 부분을 검증 실패로 거부하길 기대한다.

## 유형 (정형화)
3축 점수:

- **L (Localization) = L0 (Pinpointed).** 근거: problem_statement가 `core.validators.URLValidator`를 클래스·파일경로 수준으로 명시하고 "user and password field", "validation regex"를 직접 언급. `django/core/validators.py`의 `URLValidator.regex` 안 `# user:pass authentication` 주석이 달린 단 한 줄로 grep 한 방에 수렴. cross-module 추적 0, 후보 1곳.
- **S (Repair Strategy) = S2 Constraint-Reasoning (+S4 Counterexample-Guided).** 근거: 고칠 위치는 자명하지만 픽스는 기계적 가드/상수 변경이 아니라 **정규식 문자 클래스를 추론으로 합성**해야 한다 — "user/pass가 직접 포함하면 안 되는 문자 집합"이 정확히 무엇인지(공백·`:`·`@`·`/`)를 RFC 불변식과 매칭 메커니즘으로 따져야 한다. 이게 S2의 본질(많이 시도가 아니라 "조건을 생각으로 합성"). S4를 보조로 다는 이유: 주어진 FAIL_TO_PASS는 6개 invalid fixture뿐이라 **과소명세**다 — 더 좁은 클래스(`[a-z0-9]`)나 더 넓은 클래스로도 그 6개는 통과시킬 수 있어, 제시된 음성 케이스 너머로 "정당한 %-인코딩 user:pass는 허용"이라는 양성 일반화까지 동시에 맞춰야 한다(valid fixture가 그 구별용 반례 역할). 그래서 overfit 고위험 결합.
- **K (Knowledge) = K-Gen.** 근거: django 내부 ORM/compiler/migrations 지식 불요. 필요한 건 정규식 의미론 + RFC 1738 authority 문법이라는 **일반 지식**이다. 도메인은 "URL 검증"이지 "django 프레임워크 내부"가 아니므로 K-Domain 아님.

**Primary type = T-ConstraintReason.** 한줄 근거: 위치는 명확(L0)하나 픽스가 S1 템플릿(None가드/기본값/상수)이 아니라 올바른 문자 클래스 `[^\s:@/]`를 불변식 추론으로 합성해야 하는 S2가 dominant. APR 관점에서 이건 SemFix/Angelix 계열의 의미적 수리(synthesize-a-condition)이지 PAR/TBar식 패턴 매칭(T-DirectMap)이 아니다 — "어디"가 아니라 "정확히 어떤 식"이 난점.

## 난이도 티어
**Tier = T3 (중간).** 공식 difficulty 라벨은 `<15 min fix`(T1/T2 prior).

이 티어로 미는 구조적 피처:
- **patch scope는 최소**: 1파일·1라인(`django/core/validators.py` 정규식 한 줄). 이 축만 보면 T1~T2.
- **localize 직접성은 trivial(L0)**: 이슈가 심볼·경로를 다 적어줌. 이 축도 낮음.
- 하지만 **repair가 S2+S4**라 시간라벨에 안 잡히는 난점이 둘: (1) 올바른 문자 클래스를 추론으로 합성해야 함(constraint-reasoning), (2) FAIL_TO_PASS 음성 케이스만 보고 고치면 정당한 인코딩 user:pass를 깨서 valid_urls 회귀(overfit-risk + regression-trap). test_patch가 **fixture 텍스트 파일**이라 어떤 케이스가 추가됐는지 코드 테스트로 안 드러나는 점도 추론 부담을 키운다.

공식 라벨(`<15 min`)과 다른 이유: 시간라벨은 "정답을 아는 개발자의 구현시간"이다 — 정규식 한 줄이라 구현은 15분 미만이 맞다. 그러나 tier는 **오라클 없는 에이전트 관점의 구조적 난이도**다. localize는 쉬워도 "어느 문자를 막고 어느 양성 케이스를 보존할지"의 constraint+overfit 축은 시간라벨에 포착되지 않으므로 T1이 아니라 T3로 올린다. (L0·1파일이라 T4까지는 안 감 — S2 추론과 overfit이 핵심 단일 난점이고 멀티파일/깊은 도메인은 없으므로 T3가 적정.)

## 골드패치 분석
- **건드린 파일/함수**: `django/core/validators.py` → `URLValidator.regex` (user:pass 인증 서브패턴). 단일 라인.
- **근본 원인**: 기존 패턴 `(?:\S+(?::\S*)?@)?`이 user/pass를 `\S+`(공백 아닌 모든 문자)로 매칭. `\S`는 `:`·`@`·`/`를 포함하므로 인코딩 안 된 이 문자들이 user/pass에 들어가도 통과. 게다가 탐욕적 매칭이라 `?m=foo@example.com`처럼 경로/쿼리에 등장하는 `@`까지 authority 그룹이 빨아들여 invalid URL을 valid로 만든다.
- **수정 요지**: user/pass 문자 클래스를 `\S`에서 `[^\s:@/]`로 교체 — 즉 `(?:[^\s:@/]+(?::[^\s:@/]*)?@)?`. 이제 user와 pass 각 필드는 공백·`:`·`@`·`/`를 리터럴로 포함할 수 없고(반드시 %-인코딩), 구분자 역할의 `:`(user/pass 분리)와 종료 `@`만 패턴 구조상 허용된다. pass 그룹은 `*`로 유지(빈 비밀번호 허용)해 기존 동작 보존. 한 줄로 RFC 1738 §3.1 준수.

## 검증 (test_patch)
- **FAIL_TO_PASS(=438) 동작**: `tests/validators/invalid_urls.txt`에 6개 케이스 추가 — `http://foo@bar@example.com`, `http://foo/bar@example.com`, `http://foo:bar:baz@example.com`, `http://foo:bar@baz@example.com`, `http://foo:bar/baz@example.com`, `http://invalid-.com/?m=foo@example.com`. 모두 `ValidationError`로 거부되어야 함. (FAIL_TO_PASS가 438로 큰 것은 `tests.test_validators`가 fixture 파일 전체를 데이터-드리븐으로 한 줄=한 테스트씩 도는 구조라 카운트가 부풀려진 것이지 변경 범위가 넓은 게 아님.)
- **픽스 증명**: 새 invalid 케이스들은 user/pass에 인코딩 안 된 `:`·`@`·`/`를 끼운 형태라 새 클래스 `[^\s:@/]`에서 매칭 실패 → ValidationError 발생(픽스 전엔 `\S`가 다 먹어 통과했으므로 RED). 동시에 `valid_urls.txt`의 회귀 케이스를 `http://-.~_!$&'()*+,;=:%40:80%2f::::::@example.com`에서 `http://-.~_!$&'()*+,;=%40:80%2f@example.com`로 수정 — 기존 valid 케이스가 비현실적으로 인코딩 안 된 `:`/`@`를 남발했던 것을 RFC 준수 형태로 정정해, 픽스가 **정당하게 인코딩된 user:pass는 계속 허용**함을 양성으로 증명.
- **overfit 관점(flag: overfit-risk)**: FAIL_TO_PASS 6 케이스만 통과시키는 더 좁은 패치(예: `@`만 한 번으로 제한)도 음성 케이스는 통과하지만 정당한 special-char user/pass를 깰 수 있다. valid_urls fixture의 수정 라인이 이 overfit을 잡는 **구별용 양성 반례** 역할 — 즉 음성+양성 양쪽으로 일반화를 강제한다.
- **regression 관점(flag: regression-trap, PASS_TO_PASS=1432)**: valid_urls.txt의 나머지 케이스(IDN, %-인코딩 경로/쿼리, 포트 등)가 전부 계속 valid여야 한다. `[^\s:@/]`는 "공백/구분자/경로구분자만 배제"라는 최소 변경이라 percent-encoded 문자·기타 special char는 그대로 허용 → 광범위 P2P 보존.

## 모범답안 (오라클 기반)
1. **Localize 경로**: 이슈가 `core.validators.URLValidator` + "user and password field" + "validation regex"를 직접 신호 → `django/core/validators.py` 열어 `URLValidator.regex`로 직행 → `# user:pass authentication` 주석 달린 라인 `(?:\S+(?::\S*)?@)?`이 유일 타겟. 다른 파일·함수 볼 필요 없음(L0).
2. **픽스와 올바른 일반화 이유**: `\S`(공백 외 전부)를 `[^\s:@/]`로 좁힌다. 왜 이게 정답인가 — RFC 1738 §3.1에서 user/password 안의 `:`·`@`·`/`는 구조적 구분자이므로 리터럴로 등장하면 안 되고 %-인코딩되어야 한다. 따라서 "공백 + 이 세 구분자"만 배제하는 게 **최소이자 정확한** 제약이다. 더 좁히면(`[a-z0-9]` 등) 정당한 `~_!$&'()*+,;=` 같은 sub-delim·percent를 깨고(overfit→valid 회귀), `\S`를 그대로 두면 버그 잔존. 골드가 정확히 이 경계를 택한 게 양쪽을 동시에 만족하는 일반화다. pass 그룹은 `*`로 빈 비번 허용을 유지해야 함도 잊지 말 것.
3. **Regression 안전**: PASS_TO_PASS 1432개 중 핵심은 valid_urls.txt의 percent-encoded·IDN·sub-delim·포트 케이스 — 이들이 valid를 유지해야 한다. `[^\s:@/]`는 percent-encoded 시퀀스(`%40` 등)와 sub-delim을 건드리지 않으므로 안전. 또한 authority가 없는 평범한 `http://example.com/path?x=1`류는 `(?:...@)?`가 옵셔널이라 영향 없음.
4. **함정 회피(오라클 없는 에이전트가 틀릴 지점)**:
   - **(a) test_patch가 fixture 텍스트라 코드가 아님** — 어떤 음성 케이스가 추가됐는지 못 보면 "어느 문자를 막아야 하는지"의 핵심 신호를 놓쳐 부분 픽스에 그친다. invalid_urls.txt 추가 줄을 반드시 분석할 것.
   - **(b) 탐욕적 매칭 메커니즘 미이해** — `?m=foo@example.com` 케이스가 통과하는 이유는 경로/쿼리의 `@`를 authority 그룹이 흡수하기 때문. 이걸 모르면 user/pass 클래스에서 `@`·`/`를 배제할 동기를 못 잡고 `:`만 손대는 불완전 픽스를 낸다.
   - **(c) overfit으로 너무 좁히기** — 6개 음성만 보고 `[a-z0-9]`처럼 과도하게 제한하면 valid_urls 회귀. 음성+양성 양쪽을 보고 최소 배제 집합으로 일반화해야 한다.
   - **(d) valid_urls fixture 정정 누락 혼동** — 골드는 valid_urls.txt의 비현실적 한 줄도 고치지만 이는 **test_patch에 포함**된다. 제품 코드 변경은 정규식 한 줄이면 충분하다는 점을 헷갈려 product 코드를 과하게 건드리지 말 것.
