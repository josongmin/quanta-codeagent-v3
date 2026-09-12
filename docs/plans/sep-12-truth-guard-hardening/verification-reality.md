# 검증 레일의 실제 상태 — 어느 게이트가 실제로 돌았는가

이 캠페인의 관통선은 "레일은 있는데 게이트를 아무도 안 돌린다"였다. 3라운드는 게이트
**내용**을 감사했다. 4라운드는 게이트가 **실행되는지**를 감사했고, 결론이 더 나쁘다.

> **레일이 안 돌아가는 게 아니라, 돌릴 수 없다.** CI는 과금 차단으로 죽었고, 로컬에서
> 완주하는 유일한 티어(`precommit`)는 이 캠페인의 새 가드를 **하나도** 포함하지 않는다.

측정 시점 HEAD `7e554fea9`. 호스트 16코어/48GB, 측정 중 load 37.6 → 99.6.

---

## A. CI — 42일간 단 한 스텝도 실행되지 않았다

전체 런 이력 **1,845건**(2026-05-18 ~ 2026-09-12):

```
1835 failure    6 skipped    2 success    2 cancelled
```

실패 런은 전부 `steps=0`, 러너 없음. 최신 `ci` job의 check-run 주석 원문:

```
"The job was not started because recent account payments have failed or your
 spending limit needs to be increased. Please check the 'Billing & plans' section"
```

**이력 전체에서 스텝을 실행한 런은 7건뿐이고 7건 모두 실패했다.** 패턴은 월별
spending-limit 리셋이다 — 6/1, 7/1, 8/1 첫 예약 런이 러너를 받고 몇 시간 안에 다시
막혔다. **9월 리셋은 발화하지 않았다**(9/1~9/2의 34건 전부 `steps=0`).

마지막 스텝 실행: **2026-08-01T09:41:30Z**. `ci`의 마지막 실행: 2026-08-01T06:54:31Z,
실패.

두 가지가 "CI가 뒤처졌다"보다 나쁘다:

1. **`fc-gate.yml`은 생애 단 한 번도 스텝을 실행한 적이 없다.** 696런, 첫 런
   2026-05-24부터 같은 과금 주석. manifest가 머지 게이트로 선언한 **두 개 중 하나**다.
2. **현재 형태의 머지 게이트는 아예 실행된 적이 없다.** 마지막 실행 당시 `ci`는 4 job
   이었고 HEAD에서는 14 job이다. 10개(`full-plan`/`full-shard`/`full-aggregate`/
   `static-code`/`catalog`/`full-suite`/`pty`/`web`/`toolchain`/`required`)와
   `verification-nightly.yml` 전체가 **2026-09-10** 한 커밋에 들어왔다 — 마지막 러너로부터
   40일 뒤. 한 개도 실행된 적이 없다.

**그리고 2건의 "success"가 실패보다 나쁘다.** 런 34677870843(`ci`, schedule, 4초,
**success**)은 14 job 중 13개가 `skipped`이고 14번째(`eval`, 비차단)가 **실패**했는데
런은 녹색을 보고한다.

설계상 의도된 것이다 — schedule에서는 `eval`만 돌고 `continue-on-error: true`이며
`required` 집계는 `github.event_name != 'schedule'`로 아예 안 돈다. 하지만 결과적으로
**Actions 목록의 녹색 `ci` 런이 "아무것도 검증하지 않았다"와 구별되지 않는다.** 과금이
복구되는 날 이 녹색은 사람을 오도한다.

기타: `agent-auto-fix.yml`은 이력 전체에서 **런 0건**(라벨 트리거, 라벨이 붙은 적 없음).
`verification-nightly.yml`은 3런 전부 `steps=0`.

---

## B. 게이트 티어 — `pr`/`full`/`nightly`는 `prepush`의 별칭이다

`bun run tools/dev/gate.ts --list <tier>` 실측:

| 티어 | 게이트 수 | prepush와의 차이 |
|---|---|---|
| precommit | 9 | — |
| smoke | 8 | precommit − typecheck |
| prepush | 19 | — |
| pr | 19 | **동일** |
| full | 19 | **동일** |
| nightly | 19 | **동일** |

구조적이다: `SUITE_TIERS`와 `PREPUSH_STATIC_TIERS`가 둘 다
`["prepush","pr","full","nightly"]`다.

**티어가 실제로 의미를 갖는 곳은 다른 시스템이다** — shard 러너의 population
(`QUANTA_VERIFICATION_TIER`). `tools/dev/test-tier-population.json` 실측:

```
prepush 3925   pr 3925   full 3935   nightly 3948 (전 우주)
```

즉 라벨은 참이지만 게이트 목록 수준이 아니라 파일 population 수준에서만 참이다.
`--list full`이 `--list prepush`와 글자 그대로 같은데 어디에도 그 이유가 없다.

---

## C. capability 스킵 — 35개 중 11개가 이 호스트에서 실행 불가

```
absent: bwrap, chromium, chromium-browser, dlv, google-chrome,
        google-chrome-stable, gopls, limactl, lldb-dap
daemons: lima-vm <down>   ollama-daemon <down>   docker-daemon up
```

`CAPABILITY_GROUPS` 17그룹 / 선언된 멤버 35파일 중 **11파일이 실행 불가**:
`lsp-go`(1, pr-required), `native-debugger`(4), `browser`(3), `os-sandbox-bwrap`(1),
`docker-lima`(1), `local-model`(1).

**두 개의 프로버가 같은 호스트를 반대 방향으로 보고한다.** 게이트의 마감 줄은 PATH 기반
`missingExternalTools()`를, shard 러너의 `capability-receipt.v1`은 worker-shaped `HOME`
아래 프로브를 쓴다. 불일치:

- `lldb-dap`: 게이트 **absent** / 영수증 `xcrun -f`로 Xcode 안에서 **available**
- `cargo`, `debugpy`, `lancedb`: 게이트 **present** / 영수증 **unavailable**
  (worker HOME에서 `exit 1`) → `lsp-rust`(3파일)와 `contract-lsp-lance`가 조용히 막힌다

영수증은 11개 capability만 프로브하는데 `EXTERNAL_TOOLS`는 27개다. `bwrap`, `chromium`,
`gopls`, `dlv`, `limactl`, `go`, `npm`, `uv`, `ollama`, `docker`는 어느 영수증에도 없다.

이 두 항목은 **고치지 않았다** — 어느 프로버가 정본인지는 설계 결정이고, worker HOME
프로브는 의도적으로 문서화돼 있다.

---

## D. 영수증 — HEAD용은 없고, 있는 것은 222커밋 낡았다

`<git-common-dir>/quanta-verification-cache/prepush-exact-v1.json`:

```
head        561545c61  (HEAD로부터 222커밋 뒤)
issuedAt    2026-09-07T07:27:59Z    expiresAt 2026-09-07T13:27:59Z
```

repo 자신의 `probeExactVerificationReceipt`로 4티어 전부:
`{"ok":false,"reason":"receipt expired"}`. **Sep 7 이후 유효한 prepush 영수증이 없다.**

`last-campaign.json`: head `835b27175`, tier prepush, `outcome:"failed"`, exit 1,
3분 1초(`--bail`), load 45.8 → 69.81. `--bail` 3분은 풀스위트와 거리가 멀다.

마지막 풀스위트 시도(`failure-attempt.json`)는 chunk 36의 실제 red에서 죽었고
**그 red는 이 캠페인이 만든 것이었다** — `tests/unit/feature-catalog-baseline.test.ts`의
`readFile("tools/feature-catalog/baseline.json")` 상대경로. `6f2bff3b3`에서 고쳤다.
가드는 정확히 작동했고, 아무도 완주하지 않는 티어로 보고했다.

---

## E. 새 가드 49개 중 37개는 실행 증거가 없다

캠페인 첫 커밋(`831d032b2`)부터 HEAD까지 추가된 테스트 파일 49개. shard chunk 영수증
74개와 `test-timings-v2.json`으로 대조.

**12개는 실행 증거가 있다. 37개는 없다.**

정직한 한계: 영수증 캐시는 24h TTL이라 "최근 ~19시간의 shard 런에 없었다"만 증명한다.
단 **5개는 마지막 shard 런이 끝난 뒤 추가돼 물리적으로 포함될 수 없었다**:
`unguarded-source-window-ratchet`, `slice-between`, `idle-guards-coupling-hellgate`,
`knob-bool-vocabulary-parity-hellgate`, `slash-optin-token-parity-hellgate`.

나머지 32개가 실행 증거가 없는 이유는 **여기서 풀스위트가 완주한 적이 없다**는 것이다:
`full:prepush`는 3,925 중 1,641파일(42%), `full:nightly`는 3,948 중 297(7.5%)을
덮었고 캠페인 기록은 `failed`다.

`nightly`만이 유일한 home인 파일이 **15개**이고 그중 **14개는 어느 영수증에도 없다**.
결과적으로 미검증인 것: 세션 스트레스/동시성, bench sandbox cleanup, lint-debt reach
e2e, git conflict-parser differential fuzz, ipynb document caps, CLI goal quiet-window
pty 가드, 그리고 C++/Rust/Go/Python 네이티브 디버거 evidence 레인.

---

## F. 이번에 고친 것 / 고치지 않은 것

**고쳤다** (`b19fa651f`):

- `hostDependent`가 20개 게이트 중 **0개**에 설정돼 있었다. 필드는 선언·문서화·렌더
  되는데 아무 게이트도 안 썼고, 정작 자기 `why`에 "LOCALLY THIS PASSES BY SKIPPING"이라
  적은 `contract` 게이트가 안 썼다. `contract`와 `real-toolchain-e2e`에 설정했다.
- `[capabilities] absent` 줄이 **all-green 분기 안에서만** 출력됐다. red 런에서는
  레인 하나가 통째로 빠졌다는 사실을 아무도 듣지 못했다. 분기 밖으로 올렸고,
  `smoke-canary`를 강제 실패시켜 red에서도 출력되는 것을 확인했다.
- 풀스위트를 막고 있던 `repo-path-anchor-ratchet` red(위 §D).

**고치지 않았다 — 판단이 필요하다:**

1. **과금.** CI 복구는 repo 밖의 결정이다. 복구 전까지 머지 게이트는 존재하지 않는다.
2. **예약 `ci` 런의 녹색.** 설계상 의도지만 Actions 목록에서 검증 통과와 구별되지 않는다.
   최소 수정은 schedule 경로에 "nightly eval only — not a verification run" 이름의
   job을 추가해 녹색에 정보를 싣는 것이다. 차단 의미는 바뀌지 않는다.
3. **`pr`/`full`/`nightly` 라벨.** 게이트 목록이 같은 이유(차이는 shard population)를
   `gate-manifest.ts`에 적거나, `--list`가 population 수치를 같이 출력하게 한다.
4. **두 capability 프로버의 불일치.** 어느 쪽이 정본인지 결정해야 한다.
5. **37개 가드의 실행 증거.** 풀스위트가 한 번 완주하면 해결된다. 조용한 박스와
   깨끗한 트리가 필요하고, 지금 양쪽 다 아니다.

---

## G. 직접적인 답

> 오늘 누가 이 캠페인의 새 불변식 하나를 깨는 변경을 머지하면, 어느 게이트가 잡는가?

**아무 게이트도, 아무 머신에서도 잡지 않는다.**

- GitHub Actions는 42일간 죽어 있고, 선언된 머지 게이트 두 개 모두 4~7초 만에 `steps=0`
  으로 실패하는 런을 만든다. "success-shaped job over zero coverage"를 거부하기 위해
  쓰여진 `required` 집계 자체가 실행된 적 없는 job이다.
- 로컬에서 완주하는 것은 `precommit`(정적 9게이트)뿐이고, **새 테스트 파일 49개 중
  어느 것도 `precommit`에서 도달 불가**다. 47개는 `full-suite` 뒤에 있고 `full-suite`는
  보존된 영수증 창 안의 어느 HEAD에서도 완주하지 않았다.
- 즉 **사람이 `bun test <path>`를 직접 치는 것**만이 실질적 검증이다. 이 감사도 그렇게
  했고, §D의 red도 그렇게 발견됐다.
