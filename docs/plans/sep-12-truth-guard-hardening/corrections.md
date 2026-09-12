# 정정 기록 — 이 캠페인의 커밋 메시지가 틀린 것들

`e8795ac5e..2f7d67a22` 구간의 23커밋(truth-guard 캠페인)에 대해 5라운드 적대 어딧을
돌렸다. 회귀는 없었고 digest·ledger·partial-dead·manifest 같은 **검증 가능한 측정은
대부분 정확했다.** 거짓은 두 곳에 몰렸다: **자기 작업량 회계**와 **출하 순서 주장**.

히스토리는 재작성하지 않는다 — 이 repo에는 동시 세션이 커밋하고, ref rewrite는 그
세션의 작업을 파괴한다. 따라서 정정은 이 문서가 정본이다.

각 항목은 `커밋 — 주장 → 실측` 형식이고, **누가 측정했는지**를 명시한다. 서브에이전트
보고를 그대로 옮긴 것은 없다. 내가 직접 재측정하지 못한 항목은 그렇게 적었다.

---

## A. FALSE — 사실이 아니었던 주장

### A-1 `e71e717ae` — 빌드 스탬프 캡처 순서 (가장 심각: 문장만 아니라 기능이 그 실패에 있었다)

주장: *"The stamp is captured BEFORE anything else can touch the tree.
`install-quanta-cli.sh` bumps `package.json` and then builds; capturing after that
bump would make every single build read `dirty`, which is worse than no stamp because
it is a stamp that always lies in the same direction."*

실측: `tools/bin/install-quanta-cli.sh`가 88행에서 `package.json`을 **쓰고** 103행에서
`bun run build`를 호출한다. 그 커밋이 "피했다"고 적은 실패모드가 출하된 동작이었다.
게다가 `git status --porcelain`은 untracked까지 세므로, worktree의 `node_modules`
심볼릭(`.gitignore`의 `node_modules/`는 trailing slash라 디렉터리만 매치)만으로도
clean tracked tree가 dirty로 읽혔다. 그 커밋의 수동 검증 기록
`quanta 1.0.035 (6a82f65d1c9d-dirty)`를 나는 스탬프 성공으로 읽었다.

**직접 확인**했고 `023a03d6c`에서 고쳤다. 두 독립 어딧이 같은 결론에 도달했다.

### A-2 `40248e442` — "DECLARED, 19"

실측: `git diff cd1a84f6a..40248e442 -- src/`의 신규 `envKey:` 행 = **24**. 같은 커밋
메시지의 자기 항목 나열(14+2+4+2+2)도 이미 24다. **직접 확인.**

### A-3 `40248e442` — "EXCEPTED, 2"

실효 신규 예외는 **1건**이다. `QUANTA_TB_BEST_OF_N`은 `cd1a84f6a` 시점에 이미 예외로
있었고, 이 커밋이 **같은 Map 키를 두 번째로** 넣어 더 길고 정확한 기존 사유를 덮었다.
Map 리터럴은 중복 키를 조용히 마지막 것으로 접으므로, 같은 커밋이 추가한 세 개의
품질 테스트(inert / stale / has-a-reason) 전부가 Map을 읽기 때문에 **구조적으로 볼 수
없었다.** **직접 확인**했고 `eda90cd7b`에서 내 행을 삭제하고 리터럴 파싱 기반 중복
검출을 추가했다.

### A-4 `cd1a84f6a` — "Two EXCEPTIONS rows are inert — `QUANTA_OTEL_ENDPOINT` and `QUANTA_CONTEXT_1M`"

`QUANTA_CONTEXT_1M`은 `EXCEPTIONS`에 **없었다.** 파일 아래쪽 fixture 라인에만 나온다.
inert였던 것은 1행이다. 같은 거짓이 소스 docstring에도 박혀 있었다. **직접 확인**했고
`eda90cd7b`에서 고쳤다.

### A-5 `40248e442` — 예외 사유의 게이트 키 이름

*"the port is not even constructed unless `QUANTA_SUBAGENT_PROCESS` is on"* — 실제
게이트는 `QUANTA_SIDE_AGENT_PROCESS`다. `QUANTA_SUBAGENT_PROCESS`라는 철자는 그
문장 외에 트리 어디에도 없다. **직접 확인**했고 `eda90cd7b`에서 고쳤다.

### A-6 `cd1a84f6a` — scanner docstring이 없는 키를 인용

`intEnv("QUANTA_SHELL_SNAPSHOT_TIMEOUT_MS")` — 실제 키는
`QUANTA_SHELL_SNAPSHOT_TIMEOUT`이고 `_MS` 철자는 그 docstring에만 존재했다.
**직접 확인**했고 `eda90cd7b`에서 고쳤다.

### A-7 `1ac18b507` — "the runner path two functions below has warned correctly the whole time"

그 경로의 경고는 `saved for next session`으로 끝났고, 다음 세션은 오버라이드를 읽지
않는다. `readCliKnob`의 해석 체인에 config-file 레이어가 없고 `bootstrapKnobs`는
프로덕션 호출자가 0이다. **내가 correctness reference로 쓴 문장 자체가 같은 방향으로
거짓이었다.** 그리고 그 커밋이 넣은 대체 문장(`/knobs save` 후 재시작)도 절반 거짓이다.
**직접 확인**했고 `615355c69`에서 세 메시지를 고쳤다.

### A-8 `bb26bf9e1` — "that feature cites no tests at all (`evidence.tests` is empty)"

`real-api-smoke-eval`의 `evidence.tests.eval`에는 항목이 있다. 결론(그 뮤턴트가 red가
아니다)은 성립하지만 **이유가 다르다**: 가드의 subject가 unit/integration/contract뿐이다.
같은 테스트 파일의 docstring은 정반대를 적어 자기모순이었다. **어딧 보고 기준이며 나는
독립 재측정하지 않았다.**

### A-9 `7a79ea6df` — 푸터를 "고쳤다"는 주장

문장은 참이었지만(리터럴을 제거하고 `baseline.json`에서 렌더) **결과가 반대 방향의
거짓**이었다. 그 baseline은 2026-05-29 측정이고, 렌더 시점의 트리는 `tsc exit 0 /
0 errors`, `biome exit 0 / 0 errors`다. 생성 문서가 **존재하지 않는 툴체인 실패 2건을
주장**하게 됐고 `fc-ci` diff 게이트가 그걸 byte 단위로 고정했다. **직접 측정**했고
`ff2363436`에서 provenance(`measured_at_commit`) 기반 STALE 렌더로 고쳤다.

### A-10 `a2f50a23e` — "enrolled where each one already belongs … none of the three has a surface of its own"

`cli-single-binary-build` feature가 존재하고, 그 purpose가 바로 그 빌드 명령을
서술하며, evidence에 `package.json`을 이미 갖고 있었다. **직접 확인**했고 `023a03d6c`
에서 `tools/bin/build-cli.ts`를 그쪽으로 옮겼다.

### A-11 `1ac18b507` — "Measured: exactly ONE row is `hotToggleable: true`"

같은 커밋이 그 한 행(`QUANTA_PERSONA`)을 `false`로 바꿨으므로 **쓰는 순간 0이었다.**
같은 커밋이 추가한 hellgate의 헤더도 "exactly ONE"이라 적고 그 파일 69행은 `[]`를
어설션한다 — 추가된 한 파일 안에서 자기모순. **직접 확인**했고 `789f8b805`에서
두 문장을 과거 시제로 고치고 현재 count를 0으로 명시했다.

### A-12 `db4e5f7` — 어휘를 넓혔지만 자기 help는 안 고침

게이트를 canonical truthy set으로 넓힌 이유가 *"힌트가 거짓말을 멈추게"*였는데,
`/cron`의 `describe`는 `Opt-in: QUANTA_AUTOMATION=on`으로 남았다. 같은 스위치에 대한
두 operator-facing 문자열이 두 파일에서 불일치. **직접 확인**했고 `789f8b805`에서
고치고 `slash-optin-token-parity-hellgate`로 고정했다.

### A-13 `49005aa60` — "8 needles across 3 plan docs updated atomically"

라쳇이 고정하는 8개는 옮겼다. **같은 파일, 일부는 같은 표 셀 안의 6개 figure가 남았다**:
`71 measure-first`(→72), `39 deliberate holds`(→40), `175 eligible rows`×2(→184; 175는
wired 수), `1,028 features`(→1,071), `남은 8행`(→9), `measure-first 67행`(→72).
eligible/wired 혼동이 그중 최악이다 — 분모를 분자로 보고해 ledger가 완전히 닫힌 것처럼
읽힌다. **직접 실측**했고 `f23e08453`에서 고치고 6개 전부 파생 needle로 만들었다.

---

## B. DRIFTED / UNREPRODUCIBLE — 거짓은 아니지만 그 숫자로는 재현되지 않는다

### B-1 `ca6812fa4` — "this one fires on its own first run"

ceiling을 실측치(83/105)에 맞췄으므로 **첫 실행에서 어설션은 발화하지 않는다.** 같은
메시지 두 줄 아래가 `5 pass / 0 fail [83/83]`을 보여준다. 뮤턴트로만 red다.
"print한다"는 뜻이면 참이지만 문장은 과장이다. **직접 확인.**

### B-2 `ca6812fa4` — fan-in "5,398 entries / 2,763 distinct"

독립 파서로 **5,314 / 2,716**(비율 1.957), 다른 어딧은 **5,409 / 2,738**. 셋 다 다르다 —
`code:` 블록이 `evidence:`에 속하는지 판정하는 방식에 따라 달라진다. 논지에 필요한 것은
비율(≈1.96, "약 2배")이므로 소스 docstring에서 정확한 쌍을 지우고 비율만 남겼다.
**직접 실측.**

### B-3 `cd1a84f6a` — read census "984 sites / 622 distinct"

그 커밋의 scanner 버전 전용 수치다. `40248e442`가 const-key call-arg 해석을 넓혔고,
HEAD scanner로는 **1,036 sites / 650 distinct**다. "reproducible"이라 적으려면 어느
scanner인지 명시해야 했다. **직접 실측.**

### B-4 `cd1a84f6a` — "orphan post-exception 28 (production 26, test 2)"

산술이 닫히지 않는다. 독립 재구성은 **27 (25, 2)**다. 나는 그 커밋 시점 코퍼스를
재구성하지 않았으므로 **어딧 보고 기준**으로 기록한다.

### B-5 `6a82f65d1` — "`--help` 13 flags"

실측 **14**. `--help` 출력의 `Common flags:` 이하 행 수. **직접 실측.**

### B-6 `5f8f14609` — "the 16 test files my commits touch"

커밋이 범위를 적지 않아 재구성이 불가능하다. `e8795ac5e..5f8f14609`의 `.test.ts` 변경은
30개지만 그 구간에는 동시 세션 커밋이 섞여 있다. **숫자를 정정하지 않고
UNREPRODUCIBLE로 남긴다** — 어떤 재구성도 16을 주지 않는다는 것만 확실하다.

### B-7 `b0cce0938` / `f5a34dc2d` — "51 of 102 tools/dev files referenced"

현재 실측 **104 tracked / 53 referenced / 51 not**. 51은 referenced가 아니라
not-referenced 수와 일치한다. 어느 쪽이든 그 커밋의 문장은 지금 성립하지 않는다.
**직접 실측.** (이 숫자는 계속 움직이므로 소스 주석에 박지 않았다.)

### B-8 `5f8f14609` — 풀 유닛 "41,271 pass / 131 fail / 17 err / 2,381s"

부하 의존. 그 커밋 자신이 receipt가 아니라고 적었다. 동시 세션 캠페인이 돌던 중의
40분 런은 상호 오염이라 재현 불가. `3,255 files`, bare-catch `1194/1194`,
silent-failure ratchet 4 fail은 독립 재현됐다.

### B-9 `5f8f14609` — "23 suites, 291 pass / 0 fail"

스위트 집합을 명시하지 않아 정확 재현 불가. `0 fail` 방향은 확인됐다.

### B-10 `b0c042bb6` (receipt) — `precommit 9 of 9 passed`

오늘 HEAD에서는 8/9인 적이 있었고, 유일한 red는 동시 세션의 미커밋 변경이 원인으로
소스 추적됐다. 이 23커밋 귀속이 아니다.

---

## C. 확인했고 참이었던 것 (재어딧 금지)

- `lspDiagnosticsTool()` → `diagnosticsTool(...)`, 실제 이름 `diagnostics`,
  `lsp_diagnostics`는 존재한 적 없음. (형제 `lsp_references` /
  `lsp_workspace_symbol`은 실존 — 이름 하나만 틀렸다.)
- `bun build`에 `--define` 없음(주면 exit 0로 조용히 미치환), `--env='QUANTA_BUILD_*'`는
  동작. 실제 빌드로 확인.
- `QUANTA_HUNK_MUTATION_RECEIPT=1` 단독으로는 영수증이 안 써진다(co-gate 결함, 미해결).
- `parseEnvFlag` 빈 문자열 = true → `export QUANTA_X=`가 default-OFF를 켠다.
- `QUANTA_UNTRUSTED_ENVELOPE`가 strict `=== "1"`이라 공유 힌트의 어휘 나열은 그 knob에
  대해 거짓이 된다 — `=1`만 보편적으로 참인 토큰.
- `allKnobs()`는 등록 모듈 import 전에 0. static census로 바꾼 판단은 옳았다.
- HEAD declared 674 / orphans 0/0, ORPHAN_CEILING 0 유지.
- ledger 179→184 / wired 171→175 / 95.5→95.1% / repair-first 0→2 / dormant 8→9 전부 일치.
- partial-dead 83 features / 105 files, `.d.ts` 제외 없으면 85/107. 정확.
- manifest 스캔 194(self 포함) / 193(제외), 차집합은 `lsp_diagnostics` 단 하나.
- gate producer 19 / consumer 20 / 차이 `smoke-canary`, digest 두 개 앞 16자 일치.
- raw-env 43/43, CEILING 불변(exemption만 추가).
- `--help`가 광고했던 phantom 3개(`--lsp-tools` / `--git-tools` / `--metrics`)는 실제로
  top-level 파서가 안 읽고, 숨겼던 6개는 실제로 읽는다.
- 새 가드 9개 전부 `prepush+pr+full+nightly` tier에서 도달 가능.
- 신규 knob 24개 전부 CLI `/knobs` 674행에 등장.

---

## D. 패턴 — 왜 거짓이 이 두 곳에 몰렸는가

검증 가능한 측정은 정확했다. 틀린 것은 **내가 방금 한 일을 세는 문장**과 **다른 파일의
순서를 서술하는 문장**이다. 둘의 공통점은 **재측정 없이 서술했다**는 것이다. 게이트를
돌려 나온 숫자는 맞았고, 내가 머리로 센 숫자는 틀렸다.

같은 세션 안에서 다음 세 가지가 반복됐고, 이 캠페인이 잡으려던 결함 클래스와 동일하다:

1. **가드를 만들면서 그 가드가 잡아야 할 결함을 같은 커밋에 심었다** — 중복 예외 키,
   자기모순 hotToggleable 문장, 반대 방향이 된 푸터.
2. **디텍터를 교체하면서 형제를 두고 갔다** — completeness는 AST census로, readsite는
   regex로. 결과는 14개 false positive와 막힌 게이트.
3. **"고쳤다"는 메시지가 여전히 실행 불가능한 지시를 담았다** — `/knobs save` 후 재시작.

교정 장치로 이번 보완에서 넣은 것: 뮤테이션을 돌리기 전에 **뮤턴트가 실제로 적용됐는지
확인**한다. 이번에 무효 뮤테이션이 6건 나왔고(문법 오류, 들여쓰기 불일치, biome 재포맷),
그중 몇은 "생존"이나 "red"로 잘못 읽힐 수 있었다. `0 pass 1 fail`은 어설션 발화가 아니다.

---

## E. 보완 작업(remediation) 자체의 거짓 주장 — 3라운드 적대 검증 결과

§A–D는 원래 23커밋에 대한 것이다. 그 보완으로 landed한 커밋들도 같은 방식으로 검증했고,
**같은 두 곳에서 같은 종류로 틀렸다**: 회귀 프로브의 결과 판정, 그리고 전수 열거.

### E-1 `dd1c2c1af` — "`--tool-profile=full` … all exit 0, unchanged" (FALSE)

실측:

```
$ bun run src/apps/cli/index.ts --tool-profile=full
[error] --tool-profile must be one of write|ask|minimal|code-only, got 'full'
exit 64
```

`full`은 유효한 profile이 아니다(`agent-args.ts`의 선존 validator). "unchanged"는
참이지만 "exit 0"은 거짓이고, **회귀 프로브가 실패하는 명령을 통과로 기록했다**.
= `=value` 형태가 성공 경로에서 한 번도 실행되지 않았다는 뜻이다. **직접 확인.**

### E-2 `dd1c2c1af` — "The only forms that change are slash commands typed WITHOUT the slash" (INCOMPLETE)

두 형태가 더 바뀐다:

1. 인용 없는 `--word`를 포함한 one-shot 프롬프트 — `quanta explain the --verbose flag`가
   exit 64. 이전엔 `"explain the flag"`로 조용히 변형돼 청구되는 호출이 나갔다. 개선이지만
   **문서화된 `quanta [PROMPT]` 형태가 영향을 받았고** 그걸 적지 않았다.
2. `--`로 시작하는 valued-flag 값 전부 — 이게 `400d31171`에서 고친 회귀다.

**직접 확인.**

### E-3 `e8c39f6b7` — "The six default-ON wrappers are in [6 files]" (INCOMPLETE)

`parseEnvFlag(…, true)`를 포함한 파일은 **11개**다(정의/선언 파일 포함). 내가 센 것은
"본문이 `parseEnvFlag(x, true)`인 wrapper 정의" 6개였고, 문장은 그걸 구분하지 않았다.
누락된 것 중 하나가 `runner/assemble/memory-factory.ts` — **같은 세션 H-1의 주제 파일**이다.
그리고 sweep이 `readBool(…, true)`를 제외했는데, `env-flag.ts`가 두 형태를 **동등하다고
문서화**한다. 즉 "정확히 이 둘뿐"이라는 결론은 자기 SSOT보다 좁은 범위에 의존했다.
독립 어딧이 그 범위가 놓치는 hit 하나를 추적했고 결함이 아님을 확인했다 — **결론은
살아남지만 열거는 아니다.** **직접 확인.**

### E-4 `eda90cd7b` 뮤테이션 표 — "read corpus starved → 0 pass 1 fail" (DRIFTED)

실측 **5 pass 2 fail**(`reads.size > 400` 바닥과 stale-EXCEPTIONS 테스트가 둘 다 발화).
방향은 맞고 숫자가 틀렸다 — 7-테스트 파일에서 `0 pass 1 fail`은 불가능하다. 같은 표의
`no-raw-env` 행("the matcher broken → 2 pass 0 fail → now 43/43 held")은 **사이트가
사라진 뮤테이션**을 기록한 것이라 모호하다. 실제 단일 `RAW` 소스를 깨면 **1 pass 1 fail**이고
paired control은 진짜로 load-bearing이다.

### E-5 `ff2363436` — "matching commits (control) — asserts the verdict, no STALE"

순수 함수에 대해서만 참이었다. 실제 표면(`fc build`/`fc diff`)으로는 도달 불가였고,
`bc46375b1`에서 설계 자체를 걷어냈다(§A-9 후속).

---

## F. 반복된 메타 결함 — 무효 뮤테이션

이 세션에서 **무효 뮤턴트가 6건** 나왔다. 원인은 문법 오류(3), 들여쓰기 불일치(1),
biome 재포맷으로 앵커 소실(2)이다. 그중 몇은 `0 pass 1 fail`로 나타나 "발화"로,
몇은 무변경이라 "생존"으로 오독될 수 있었다.

교정 규칙: **뮤테이션을 실행하기 전에 뮤턴트가 적용됐는지 확인한다.** 치환 후 문자열
존재를 assert하거나 diff를 출력한다. `0 pass 1 fail`은 어설션 발화가 아니라 로드 실패다.

그리고 가드 하나는 **첫 시도가 한쪽 방향만 봤다.** POSIX `--` 불변식을 "플래그 모양
토큰이 프롬프트에 안 닿아야 한다"로만 썼더니, 마커를 지우면 **닿는 토큰이 줄어들어서**
안 잡혔다. 도착을 어설션해야 했다. 한쪽 방향 어설션은 반대 방향 회귀에 무력하다.

## G. 라운드 6 — 도구표면/HITL 축 (sep-13)

R6-A(도구표면 SSOT regex 구멍)가 보고한 것을 직접 재현·확정하고 전량 수정했다.
아래는 **수정 전에 측정된 사실**이며, 각 항목은 red-on-injection으로 닫혔다.

### G-1 완전성 가드가 grep이었고, 네 구멍 모두 실측됐다 — 구멍 하나는 LIVE

`tests/unit/tool-surface-manifest-hellgate.test.ts`의
`grep -rhoE 'name: "[a-z_]+"'`:

| 구멍 | 측정 |
|---|---|
| `[a-z_]`가 숫자·대문자 제외 | `apply_patch_v2`(`isReadOnly:false` + `hitlTier:"none"`)가 38 pass / 0 fail, precommit 9 of 9 |
| grep이 주석을 읽음 | 주석만으로 `zz_ghost_stale_tool`을 "찾아" stale row를 마스킹; 삭제된 도구를 언급한 산문은 **거짓 RED**를 만들고 그 자연스러운 수리는 고스트 row 추가 |
| `--exclude`가 basename 매칭 | 오늘 점유자 없음 |
| root 목록 수작업 + 확장자 무시 | 추적 중인 `src/tool/lsp_nav/code-action.ts.tmp`가 `lsp_code_action`을 기여 |

세 도구가 첫 구멍에 살아 있었다: `Skill`·`ToolSearch`(CLI·web **default-ON**),
`branch_search`(write-capable). 셋 다 tier-1 빌더가 `extraTools`로 민팅하고
`session-resources.ts`에서 라이브 레지스트리에 들어간다. plan-mode SSOT
(`MUTATING_TOOL_TABLE`)는 셋 다 알고 있었고 **도구-접근 SSOT만 못 보고 있었다**.

인과 증명: `buildSkillBlock`은 도구 셋을 민팅하는데 `skill_create`만 카탈로그에
있었다 — `src/skill/skill-creator.ts`가 **이전 탈출 이후** grep root 목록에
덧붙여졌기 때문. 같은 빌더·같은 디렉토리의 형제 둘은 추가되지 않았고, 대문자라서
root만 넓혀도 안 보였다.

### G-2 write-capable 도구가 HITL을 선언으로 빠져나갈 수 있었다

`inferToolTierDetailed`는 `explicit` tier를 `isReadOnly()` fail-closed 분기
**앞에서** 반환한다. `"none"`은 truthy이므로 명시적 `hitlTier: () => "none"`이
바로 위 분기를 단락시킨다. fail-closed 기본값은 `hitlTier`를 **생략한** 도구만
보호한다.

측정: `isReadOnly:false` + `hitlTier:"none"` 프로브가 HITL/permission/tool
테스트 파일 125개에서 **2419 pass, 1 skip, 0 fail**, `precommit ok — 9 of 9`.
기존 단정은 모두 per-tool이고 집합을 도는 것이 하나도 없었다.

오늘 짝은 일치한다(tier-none 12곳 전부 `isReadOnly: () => true`). 없던 것은
**그 상태를 유지시키는 불변식**이다.

### G-3 port bag이 탈출 벡터였다 — `satisfies`로는 못 잡는다

`wired-tools-dispatch-permission-r3-hellgate`는 30개 포트 중 **9개**만 배선했다.
`notebookEdit`(bag 밖) 기반 프로브는 살아남고 `structuredPatch`(bag 안) 기반은
red였다 — 저항이 "누가 어떤 포트를 기억했는가"의 우연이었다. 지금은
`Record<keyof DefaultToolPorts, PortPlan>`(30 entries, unwired 3 + 사유 + 개수 핀)
이므로 새 포트는 컴파일 에러다. `satisfies`는 존재하는 값만 검사하고 모든 키가
있는지는 검사하지 않는다.

### G-4 plan-mode 표에 열 개가 없었고, 그걸 약속한 가드가 9/30만 봤다

전 포트 배선 시 `automation_update` `threads_handoff` `ask_user` `reflect`
`fetch_rules` `notebook_edit` `debug_inspect` `run_tests` `collect_evidence`
`projects_kb` 열 개가 어떤 row에도 없었다 → plan-mode dispatch가
`UnknownToolError`. R3 closeout이 정확히 이걸 막겠다고 추가한 가드가
9/30 포트만 배선했기 때문.

거짓-RED 방향도 실측했다. `notebook_edit` row 삭제 시:

| fixture | 결과 |
|---|---|
| broad | 512 pass / 4 fail — 도구가 MISSING으로 보고됨 |
| bare | 8 pass / 1 fail — 삭제는 **안 보이고**, 형제 row 9개가 ORPHAN으로 보고됨 |

즉 bare fixture에서 diff는 정당한 row 9개를 가리키며 지우라고 말한다. 그래서
allowlist를 키우지 않고 **fixture를 옮겼다**.

### G-5 내 보완 작업 자체의 거짓 주장 — 이번에도 둘

- **Skill row에 `env: "QUANTA_SKILLS"`를 썼다.** CLI seed 단정이 정확히 red를
  냈다: `shouldSeedOn`은 env를 가진 config-slot 게이트를 **CLI seed로 만들고**,
  CLI는 seed된 게이트를 자식 프로세스로 내보낸다 → `skillsConfig: undefined`인
  표면에서도 skills가 켜진다. `QUANTA_SKILLS`는 이 슬롯의 **opt-OUT**이다
  (`readCliKnob(...) ?? true`, `parseEnvFlag(env.QUANTA_SKILLS, true)`).
  `search_codebase`와 같은 모양으로 고치고 되돌아오지 못하게 가드를 붙였다.
- **SSOT 제외가 "제외할 것이 있다"는 floor를 50으로 썼다.** `Received: 0`으로
  실패했다. shape 좁히기(`TOOL_SHAPE_KEYS`) 아래서 path 제외는 **inert**다:
  `gated-tools.ts`는 raw `name:` 리터럴 73개를 갖지만 추출기는 0개를 받아들인다
  (manifest row의 형제는 `origin`/`gate`/`default`/`risk`/`note`). 측정된 사실로
  다시 썼고 path 제외는 이중 방어로 남겼다.

### G-6 내 새 census도 total이 아니었다 (자기 어딧)

선언 불변식은 `name` **문자열 리터럴**에 걸려 있어, 계산된 이름으로 빌드되는
도구는 안 보인다. `src/subagent/agent-tools-6.ts`의
`make(name, description, schema, readOnly, …)`가 라우터 6도구를 그렇게 만든다.
그 6개는 **구조적으로** 안전하다(그 팩토리는 `hitlTier` 파라미터가 없다) — 운이
좋아서가 아니다. 하지만 팩토리에 `hitlTier`를 주면 한 줄로 6개가 동시에 뚫린다.
그래서 census가 **자기 사각지대를 열거**하게 만들었다:
`scanUnattributedTierDeclarations` = 리터럴 이름 없이 `hitlTier`를 선언하는 객체
리터럴 전부. 실측 2개, 둘 다 permission **inspector** 메타데이터.

### G-7 남의 라이브 RED 하나 — 귀속하고 고쳤다

`tests/unit/tools/test-resilience-diagnosis-hellgate.test.ts`의
"with no artifact the tool FAILS CLOSED"가 red였다. 내 것이 아니다(내 src 변경
두 개를 되돌려도 24 pass / 1 fail). 결함 둘:

1. **비-hermetic.** `diagnose`의 기본 artifact는 **공유** verification cache에서
   해석되므로(의도적 — 이전 어딧이 러너가 쓰지 않는 경로를 읽는 걸 잡았다),
   이 repo의 어떤 실행이 남긴 artifact든 이 케이스를 실제 진단으로 만든다.
   실측 exit 3, `children=1 observed-isolation-pass=1`.
2. **단정한 메시지가 도달 불가 분기의 것.** fail-closed 분기 셋 중 첫째만
   "no longer runs a suite of its own"을 출력하고, 거기 가려면 빈 artifact 경로가
   필요한데 `failureAttemptPath()`는 빈 문자열을 절대 반환하지 않는다. 공유
   캐시가 비어 있어도 둘째 분기("cannot read")로 가고 메시지가 다르다.

두 분기를 각자 의도적으로 실행하게 고쳤다.

### G-8 열어둔 것 (결정 필요, 임의로 좁히거나 넓히지 않았다)

- `test_runner`는 프로젝트 자체 스위트 실행을 이유로 `null`인데, `run_tests`와
  `collect_evidence`는 같은 일을 하면서 mutating으로 분류됐다. 맞추려면 plan mode를
  넓히거나 `test_runner`를 좁혀야 하고, 둘 다 `UnknownToolError` 수정에 얹을 일이
  아니다.
- 도구표면 완전성의 **최종** 권위는 조립된 레지스트리여야 한다. 현재 소스 census가
  권위이고 런타임 arm이 교차검증이다. 조립 가능한 최대 집합은 193 중 66이며,
  나머지를 덮으려면 60개 origin 모듈 fixture가 필요하다. MCP 브릿지 도구는 어느
  소스 계측으로도 보이지 않는다.
