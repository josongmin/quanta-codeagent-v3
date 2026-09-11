# TVH-06 — exact execution·capability receipt 무결성

- 우선순위: P0/P1
- 상태: P0 LANDED (나머지 진행 중)
- 소유 lane: receipt schema / proof consumers
- 선행: TVH-02. capability/cache closeout은 TVH-03, TVH-05 이후
- 후속: TVH-09, TVH-10

## 현재 결함

- local shard success는 Bun stdout의 실행 파일 수만 확인하며 exact path set을 검증하지 않는다.
- scan-reach consumer는 `suite=full`, tier, expected manifest를 확인하지 않는다. unit receipt를 허용하는 test도 있다.
- future reduced `full --tier=...`도 scan receipt를 발행할 수 있다.
- capability skip/run 상태가 receipt에 없어 skip green과 실제 실행 green을 구분할 수 없다.
- Chrome/bwrap/limactl/Docker daemon/image/Lima VM 상태 변경이 exact receipt를 invalidate하지 않는다.
- campaign HEAD는 lease 대기 전에 캡처되어 최대 90분 뒤 다른 HEAD에서 실행해도 diagnostic receipt가 옛 HEAD를 기록할 수 있다.
- matrix plan은 self-discovered population만 exact하게 증명하며 suite/tier floor가 없다.
- source-JS postflight 하나가 실패하면 원인 chunk를 특정하지 않고 기존 hit를 포함한 모든 chunk receipt를 삭제해 다음 실행을 전 chunk miss로 만든다.
- `aggregateRequiredNeeds`는 non-empty와 전달된 row의 conclusion만 검사하고 expected producer ID 집합을 모른다. `{static-code: success}` 하나도 PASS하므로 workflow에서 producer와 `needs` 항목을 함께 삭제하면 누락을 탐지하지 못한다.
- PTY/toolchain/contract job success에는 exact executed file/case floor가 없어 전부 capability skip인 zero-coverage success를 required가 구분하지 못한다.
- shard identity는 모든 외부 tool fingerprint를 전 chunk에 공통 적용해 unrelated capability drift도 global miss로 만든다.
- inherited lease token은 64-hex 형태와 live ancestor PID만 확인하고 실제 lease listener ownership/nonce에 bind되지 않는다. 모양이 맞는 fake token으로 shard runner의 repository lease 재취득을 우회할 수 있다.
- exact receipt TTL은 `expiresAtMs > now`만 확인해 issued→expiry 최대 6시간 계약을 검증하지 않는다. expiry를 임의 연장한 receipt도 승인될 수 있다.
- receipt context는 `HOME`과 `$HOME/go/bin/dlv` 같은 HOME-dependent capability, mutable comparison base `origin/main` OID를 포함하지 않는다. 같은 HEAD/status에서 HOME 또는 remote base가 바뀌어도 pre-lease receipt reuse가 가능하다.

## 작업

1. local runner도 JUnit의 exact executed file set을 manifest와 비교한다.
2. receipt에 suite, tier, policy digest, manifest digest, selected/excluded accounting, capability results, environment semantics를 필수화한다.
3. scan-reach receipt producer는 authoritative full/required tier에서만 발행한다.
4. consumer는 expected current manifest를 독립 재계산하고 suite/tier/policy/digest를 모두 비교한다.
5. capability result는 `executed`, `skipped-unsupported`, `blocked-missing`, `failed-setup`을 구분하고 minimum case floor를 포함한다.
6. campaign은 lease 취득 후 HEAD/status를 다시 freeze하고 종료 시 재검사한다. queued/start/end snapshot을 별도 필드로 기록한다.
7. matrix signed plan에도 universe floor와 tier membership digest를 넣는다.
8. postflight artifact에는 emitter chunk/path attribution을 넣고 해당 owner receipt만 폐기한다. attribution 불가 시 global invalidation 이유와 affected set을 명시한다.
9. required producer ID exact set을 manifest SSOT에서 생성하고 workflow `needs`, policy result, aggregator key set을 삼방향 비교한다. unknown과 missing 모두 fail closed한다.
10. capability job은 expected IDs, executed/skipped/blocked/setup-failed counts와 capability fingerprint artifact를 발행하고 required aggregator가 minimum executed floor를 확인한다.
11. inherited lease는 wrapper가 소유한 live listener와 nonce/digest handshake로 증명한다. ancestor PID+token 모양만으로 bypass하지 않는다.
12. receipt validator는 issued/expires duration과 future skew를 고정 schema로 검사하고 base OID, HOME-derived tool resolution 또는 해당 capability digest를 context에 포함한다.
13. dependency materialization receipt는 root와 web-frontend의 lockfile, Bun/platform, installed graph/executable digest를 bind한다. executable 존재만으로 stale node_modules를 ready로 보지 않는다.
14. manifest/policy projection은 현재 `needsQuietBox`와 향후 resources/capabilities/timeout/outputBudget 등 모든 dispatch-affecting field를 포함하고 unknown unhashed field를 거부한다. 현재 HEAD binding이 우연히 stale reuse를 막는 것에 의존하지 않는다.

## 수정 파일

- `tools/dev/run-test-shards.ts`
- `tools/dev/test-shard-receipt.ts`
- `tools/dev/scan-reach-baseline.ts`
- `tools/dev/verification-receipt.ts`
- `tools/dev/verification-receipt-probe.ts`
- `tools/dev/verification-campaign.ts`
- `tools/dev/verification-required-results.ts`
- `tools/dev/verification-matrix.ts`
- `tools/dev/verification-matrix-cli.ts`
- `tools/dev/test-shard-lease.ts`
- `tools/dev/verification-input-scope.ts`
- `tools/dev/verdict-env.ts`
- `tools/dev/gate-manifest.ts`
- `package.json`, `apps/web-frontend/package.json`, root/frontend lockfiles
- `tests/unit/_arch/scan-reach-cli-hellgate.test.ts`

## red-on-injection

- 같은 count지만 한 파일이 다른 JUnit은 RED.
- `suite=unit` scan receipt를 full consumer에 넣으면 RED.
- reduced tier receipt를 authoritative full consumer에 넣으면 RED.
- Chrome/Ollama/Docker capability가 skipped인 receipt는 capability-required gate에서 RED.
- lease wait 중 HEAD를 바꾸면 spawn 0 또는 invalid receipt.
- matrix discovery에서 파일 하나를 숨기면 universe floor/digest RED.
- 한 chunk가 stale source JS를 만들면 그 chunk만 invalid되고 기존 unrelated hit는 보존된다.
- contract/toolchain/full-suite/PTY key를 하나씩 삭제하거나 extra key를 주입하면 exact producer ID로 RED다.
- 8개 PTY 또는 contract cases 전부 skip인 success-shaped artifact는 required에서 RED다.
- live ancestor+fake token+no matching lease listener는 invalid이고 실제 wrapper handshake만 valid다.
- expiry를 30일로 연장하거나 `origin/main` OID/HOME tool 상태를 바꾸면 old receipt는 정확한 이유로 miss한다.
- lock A install 뒤 lock B checkout/no-install 상태는 test spawn 전에 stale-deps이며 receipt reuse가 불가능하다.
- gate의 `needsQuietBox`를 toggle하면 manifest/policy digest가 바뀌고 unknown execution field는 schema validation에서 RED다.

## 완료 기준

- [ ] receipt가 “몇 개”가 아니라 “정확히 어떤 파일/케이스가 어떤 capability로 실행됐는지” 증명한다.
- [ ] stale/wrong-suite/wrong-tier/wrong-capability receipt 재사용이 불가능하다.
- [ ] current-HEAD 외 receipt는 closeout 근거로 사용되지 않는다.
- [ ] required producer missing/extra 및 capability zero-execution이 green으로 집계되지 않는다.

## 진행 (2026-09-12)

- **LANDED `14348d545`** — required aggregator가 producer 개수만 보고 **어떤** producer인지 몰랐다.
  current HEAD 실측:

      $ QUANTA_REQUIRED_NEEDS='{"static-code":{"result":"success"}}' \
          bun tools/dev/verification-required-results.ts; echo $?
      0

  7-producer merge gate에 row 1개로 PASS. SSOT(`verification-required-producers.ts`)를 만들고
  SSOT ↔ `needs` 키 ↔ ci.yml `required.needs` 3-way exact 비교로 교체. missing/unknown/extra 모두
  fail closed하며 offending ID를 출력한다. all-skipped success-shaped envelope도 RED.
  receipt: issued→expires duration 계약(mint·validate 양쪽), `origin/main` base OID와 HOME 파생 capability
  digest를 context에 결합(각각 고유 miss 사유).
  **감사 정정**: future-skew 거부는 이미 있었다(`issuedAtMs > now + 60s`). 새 구멍이 아니었다.

- **LANDED `fbb536f62`** — producer 쪽 배선. `pty`/`toolchain`/`contract` lane이 JUnit을 내고,
  bounded reducer(`tools/dev/capability-result.ts`)가 `quanta.capability-result.v1`로 축약해 업로드하며
  `required`가 전부 다운로드한다. `if: always()`라 reporter 전에 죽은 lane은 침묵이 아니라 `failedSetup`을 낸다.
  end-to-end 실측: 전 case skip인 lane이 exit 0 + green row를 만들어도
  `capability producer "pty" executed 0 case(s), floor is 1`로 exit 1.

- **남은 항목**: exact executed file set 비교(local runner), scan-reach producer tier 제한,
  postflight attribution, matrix universe floor, inherited lease nonce handshake,
  dependency materialization receipt, manifest/policy projection의 unknown field 거부.
