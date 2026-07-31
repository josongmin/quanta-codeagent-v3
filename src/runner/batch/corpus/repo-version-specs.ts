/**
 * (repo, version) -> SWE-bench ENVIRONMENT/test recipe. GENERATED from the official
 * `MAP_REPO_VERSION_TO_SPECS[repo][v]` (swebench PyPI) -- GROUND TRUTH, not guessed,
 * and the SAME source `repo-version-python.ts` derives `.python` from.
 *
 * Why (jun-27): per-framework repro/test execution was hand-ported inline
 * (`if repo === "django/django"` -> `runtests.py --settings=test_sqlite`), a
 * heuristic that ALSO ignored version (django 1.9 has NO --settings=test_sqlite,
 * 1.10 does) and duplicated a value the spec already owns. Competitors (agentless,
 * trae) run repro INSIDE this spec env, never an inline branch. This table is that
 * env, derived once from the SSOT so every repo/version is covered, zero inline
 * framework branches.
 *
 * GOLD-FREE: testCmd is the BARE runner template (no instance test names). The
 * per-instance FAIL_TO_PASS directives are the ANSWER KEY and live ONLY in the
 * grading oracle -- NEVER append them on an agent path. Multi-command test_cmd/
 * install (go/js/rust repos) are joined with " && " at generation time.
 *
 * DO NOT EDIT BY HAND. Regenerate: `bun tools/dev/regen-repo-version-specs.ts`
 */

export interface RepoVersionSpec {
  readonly testCmd?: string
  readonly install?: string
  readonly preInstall?: readonly string[]
  readonly evalCommands?: readonly string[]
  /** Official `pip_packages` — the era-correct dependency PINS the SWE-bench env
   *  installs (e.g. sphinx 3.5: `Jinja2==3.0.3`). Applied as uv `--with` so the
   *  repro/test env resolves these instead of latest — fixes old instances whose
   *  free-resolved deps broke their own API (RCA jun-29). */
  readonly pipPackages?: readonly string[]
}

const REPO_VERSION_SPECS: Readonly<Record<string, Readonly<Record<string, RepoVersionSpec>>>> = {
  "Automattic/wp-calypso": {
    "0.8": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "10.10.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "10.12.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "10.13.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "10.14.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "10.15.2": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "10.16.3": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "10.4.1": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "10.5.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "10.6.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "10.9.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "4.2.3": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "4.3.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "5.10.1": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "5.11.1": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "6.1.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "6.10.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "6.10.2": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "6.10.3": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "6.11.1": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "6.11.2": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "6.11.5": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "6.7.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "6.9.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "6.9.1": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "6.9.4": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "8.11.0": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "8.11.2": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "8.9.1": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "8.9.3": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
    "8.9.4": { testCmd: "npm run test-client", install: "npm install --unsafe-perm" },
  },
  "apache/druid": {
    "13704": {
      testCmd:
        "mvnd test -B -pl processing -Dtest=org.apache.druid.query.aggregation.post.ArithmeticPostAggregatorTest#testPow && mvnd test -B -pl processing -Dtest=org.apache.druid.query.aggregation.post.ArithmeticPostAggregatorTest#testDiv && mvnd test -B -pl processing -Dtest=org.apache.druid.query.aggregation.post.ArithmeticPostAggregatorTest#testQuotient",
      install:
        "sed -i 's/<resourceBundle>org.apache.apache.resources:apache-jar-resource-bundle:1.5-SNAPSHOT<\\/resourceBundle>/<resourceBundle>org.apache.apache.resources:apache-jar-resource-bundle:1.5<\\/resourceBundle>/' pom.xml && mvn clean install -B -pl processing -DskipTests -am",
    },
    "14092": {
      testCmd:
        "mvnd test -B -T 1C -pl server -Dtest=org.apache.druid.discovery.DruidLeaderClientTest#test503ResponseFromServerAndCacheRefresh && mvnd test -B -T 1C -pl server -Dtest=org.apache.druid.discovery.DruidLeaderClientTest#testServerFailureAndRedirect",
      install:
        "mvn clean install -B -pl processing,cloud/aws-common,cloud/gcp-common -DskipTests -am",
    },
    "14136": {
      testCmd:
        "mvnd test -B -T 1C -pl processing -Dtest=org.apache.druid.timeline.VersionedIntervalTimelineTest#testOverlapSecondContainsFirstZeroLengthInterval && mvnd test -B -T 1C -pl processing -Dtest=org.apache.druid.timeline.VersionedIntervalTimelineTest#testOverlapSecondContainsFirstZeroLengthInterval2 && mvnd test -B -T 1C -pl processing -Dtest=org.apache.druid.timeline.VersionedIntervalTimelineTest#testOverlapSecondContainsFirstZeroLengthInterval3 && mvnd test -B -T 1C -pl processing -Dtest=org.apache.druid.timeline.VersionedIntervalTimelineTest#testOverlapSecondContainsFirstZeroLengthInterval4 && mvnd test -B -T 1C -pl processing -Dtest=org.apache.druid.timeline.VersionedIntervalTimelineTest#testOverlapFirstContainsSecond && mvnd test -B -T 1C -pl processing -Dtest=org.apache.druid.timeline.VersionedIntervalTimelineTest#testOverlapSecondContainsFirst",
      install: "mvn clean install -B -pl processing -DskipTests -am",
    },
    "15402": {
      testCmd:
        "mvnd test -B -T 1C -pl processing -Dtest=org.apache.druid.query.groupby.GroupByQueryQueryToolChestTest#testCacheStrategy && mvnd test -B -T 1C -pl processing -Dtest=org.apache.druid.query.groupby.GroupByQueryQueryToolChestTest#testResultLevelCacheKeyWithSubTotalsSpec && mvnd test -B -T 1C -pl processing -Dtest=org.apache.druid.query.groupby.GroupByQueryQueryToolChestTest#testMultiColumnCacheStrategy",
      install: "mvn clean install -B -pl processing -DskipTests -am",
    },
    "16875": {
      testCmd:
        "mvnd test -B -pl server -Dtest=org.apache.druid.server.metrics.WorkerTaskCountStatsMonitorTest#testMonitorWithPeon && mvnd test -B -pl server -Dtest=org.apache.druid.server.metrics.WorkerTaskCountStatsMonitorTest#testMonitorWithNulls && mvnd test -B -pl server -Dtest=org.apache.druid.server.metrics.WorkerTaskCountStatsMonitorTest#testMonitorIndexer",
      install: "mvn clean install -B -pl server -DskipTests -am",
    },
  },
  "apache/lucene": {
    "11760": {
      testCmd: "./gradlew test --tests org.apache.lucene.queries.intervals.TestIntervalBuilder",
      preInstall: [
        "sed -i '\n/testLogging {/,/}/{\n  /testLogging {/r /dev/stdin\n  d\n}\n' gradle/testing/defaults-tests.gradle << 'EOF'\ntestLogging {\n  showStandardStreams = true\n  // set options for log level LIFECYCLE\n  events TestLogEvent.FAILED,\n         TestLogEvent.PASSED,\n         TestLogEvent.SKIPPED,\n         TestLogEvent.STANDARD_OUT\n  exceptionFormat TestExceptionFormat.FULL\n  showExceptions true\n  showCauses true\n  showStackTraces true\n\n  // set options for log level DEBUG and INFO\n  debug {\n      events TestLogEvent.STARTED,\n             TestLogEvent.FAILED,\n             TestLogEvent.PASSED,\n             TestLogEvent.SKIPPED,\n             TestLogEvent.STANDARD_ERROR,\n             TestLogEvent.STANDARD_OUT\n      exceptionFormat TestExceptionFormat.FULL\n  }\n  info.events = debug.events\n  info.exceptionFormat = debug.exceptionFormat\n\n  afterSuite { desc, result ->\n      if (!desc.parent) { // will match the outermost suite\n          def output = \"Results: ${result.resultType} (${result.testCount} tests, ${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped)\"\n          def startItem = '|  ', endItem = '  |'\n          def repeatLength = startItem.length() + output.length() + endItem.length()\n          println('\\n' + ('-' * repeatLength) + '\\n' + startItem + output + endItem + '\\n' + ('-' * repeatLength))\n      }\n  }\n}\nEOF",
      ],
    },
    "12022": {
      testCmd: "./gradlew test --tests org.apache.lucene.document.TestLatLonShape",
      preInstall: [
        "sed -i '\n/testLogging {/,/}/{\n  /testLogging {/r /dev/stdin\n  d\n}\n' gradle/testing/defaults-tests.gradle << 'EOF'\ntestLogging {\n  showStandardStreams = true\n  // set options for log level LIFECYCLE\n  events TestLogEvent.FAILED,\n         TestLogEvent.PASSED,\n         TestLogEvent.SKIPPED,\n         TestLogEvent.STANDARD_OUT\n  exceptionFormat TestExceptionFormat.FULL\n  showExceptions true\n  showCauses true\n  showStackTraces true\n\n  // set options for log level DEBUG and INFO\n  debug {\n      events TestLogEvent.STARTED,\n             TestLogEvent.FAILED,\n             TestLogEvent.PASSED,\n             TestLogEvent.SKIPPED,\n             TestLogEvent.STANDARD_ERROR,\n             TestLogEvent.STANDARD_OUT\n      exceptionFormat TestExceptionFormat.FULL\n  }\n  info.events = debug.events\n  info.exceptionFormat = debug.exceptionFormat\n\n  afterSuite { desc, result ->\n      if (!desc.parent) { // will match the outermost suite\n          def output = \"Results: ${result.resultType} (${result.testCount} tests, ${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped)\"\n          def startItem = '|  ', endItem = '  |'\n          def repeatLength = startItem.length() + output.length() + endItem.length()\n          println('\\n' + ('-' * repeatLength) + '\\n' + startItem + output + endItem + '\\n' + ('-' * repeatLength))\n      }\n  }\n}\nEOF",
      ],
    },
    "12196": {
      testCmd:
        "./gradlew test --tests org.apache.lucene.queryparser.classic.TestMultiFieldQueryParser",
      preInstall: [
        "sed -i '\n/testLogging {/,/}/{\n  /testLogging {/r /dev/stdin\n  d\n}\n' gradle/testing/defaults-tests.gradle << 'EOF'\ntestLogging {\n  showStandardStreams = true\n  // set options for log level LIFECYCLE\n  events TestLogEvent.FAILED,\n         TestLogEvent.PASSED,\n         TestLogEvent.SKIPPED,\n         TestLogEvent.STANDARD_OUT\n  exceptionFormat TestExceptionFormat.FULL\n  showExceptions true\n  showCauses true\n  showStackTraces true\n\n  // set options for log level DEBUG and INFO\n  debug {\n      events TestLogEvent.STARTED,\n             TestLogEvent.FAILED,\n             TestLogEvent.PASSED,\n             TestLogEvent.SKIPPED,\n             TestLogEvent.STANDARD_ERROR,\n             TestLogEvent.STANDARD_OUT\n      exceptionFormat TestExceptionFormat.FULL\n  }\n  info.events = debug.events\n  info.exceptionFormat = debug.exceptionFormat\n\n  afterSuite { desc, result ->\n      if (!desc.parent) { // will match the outermost suite\n          def output = \"Results: ${result.resultType} (${result.testCount} tests, ${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped)\"\n          def startItem = '|  ', endItem = '  |'\n          def repeatLength = startItem.length() + output.length() + endItem.length()\n          println('\\n' + ('-' * repeatLength) + '\\n' + startItem + output + endItem + '\\n' + ('-' * repeatLength))\n      }\n  }\n}\nEOF",
      ],
    },
    "12212": {
      testCmd: "./gradlew test --tests org.apache.lucene.facet.TestDrillSideways",
      preInstall: [
        "sed -i '\n/testLogging {/,/}/{\n  /testLogging {/r /dev/stdin\n  d\n}\n' gradle/testing/defaults-tests.gradle << 'EOF'\ntestLogging {\n  showStandardStreams = true\n  // set options for log level LIFECYCLE\n  events TestLogEvent.FAILED,\n         TestLogEvent.PASSED,\n         TestLogEvent.SKIPPED,\n         TestLogEvent.STANDARD_OUT\n  exceptionFormat TestExceptionFormat.FULL\n  showExceptions true\n  showCauses true\n  showStackTraces true\n\n  // set options for log level DEBUG and INFO\n  debug {\n      events TestLogEvent.STARTED,\n             TestLogEvent.FAILED,\n             TestLogEvent.PASSED,\n             TestLogEvent.SKIPPED,\n             TestLogEvent.STANDARD_ERROR,\n             TestLogEvent.STANDARD_OUT\n      exceptionFormat TestExceptionFormat.FULL\n  }\n  info.events = debug.events\n  info.exceptionFormat = debug.exceptionFormat\n\n  afterSuite { desc, result ->\n      if (!desc.parent) { // will match the outermost suite\n          def output = \"Results: ${result.resultType} (${result.testCount} tests, ${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped)\"\n          def startItem = '|  ', endItem = '  |'\n          def repeatLength = startItem.length() + output.length() + endItem.length()\n          println('\\n' + ('-' * repeatLength) + '\\n' + startItem + output + endItem + '\\n' + ('-' * repeatLength))\n      }\n  }\n}\nEOF",
      ],
    },
    "12626": {
      testCmd: "./gradlew test --tests org.apache.lucene.index.TestIndexWriter",
      preInstall: [
        "sed -i '\n/testLogging {/,/}/{\n  /testLogging {/r /dev/stdin\n  d\n}\n' gradle/testing/defaults-tests.gradle << 'EOF'\ntestLogging {\n  showStandardStreams = true\n  // set options for log level LIFECYCLE\n  events TestLogEvent.FAILED,\n         TestLogEvent.PASSED,\n         TestLogEvent.SKIPPED,\n         TestLogEvent.STANDARD_OUT\n  exceptionFormat TestExceptionFormat.FULL\n  showExceptions true\n  showCauses true\n  showStackTraces true\n\n  // set options for log level DEBUG and INFO\n  debug {\n      events TestLogEvent.STARTED,\n             TestLogEvent.FAILED,\n             TestLogEvent.PASSED,\n             TestLogEvent.SKIPPED,\n             TestLogEvent.STANDARD_ERROR,\n             TestLogEvent.STANDARD_OUT\n      exceptionFormat TestExceptionFormat.FULL\n  }\n  info.events = debug.events\n  info.exceptionFormat = debug.exceptionFormat\n\n  afterSuite { desc, result ->\n      if (!desc.parent) { // will match the outermost suite\n          def output = \"Results: ${result.resultType} (${result.testCount} tests, ${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped)\"\n          def startItem = '|  ', endItem = '  |'\n          def repeatLength = startItem.length() + output.length() + endItem.length()\n          println('\\n' + ('-' * repeatLength) + '\\n' + startItem + output + endItem + '\\n' + ('-' * repeatLength))\n      }\n  }\n}\nEOF",
      ],
    },
    "13170": {
      testCmd:
        "./gradlew test --tests org.apache.lucene.analysis.opennlp.TestOpenNLPSentenceBreakIterator",
      preInstall: [
        "sed -i '\n/testLogging {/,/}/{\n  /testLogging {/r /dev/stdin\n  d\n}\n' gradle/testing/defaults-tests.gradle << 'EOF'\ntestLogging {\n  showStandardStreams = true\n  // set options for log level LIFECYCLE\n  events TestLogEvent.FAILED,\n         TestLogEvent.PASSED,\n         TestLogEvent.SKIPPED,\n         TestLogEvent.STANDARD_OUT\n  exceptionFormat TestExceptionFormat.FULL\n  showExceptions true\n  showCauses true\n  showStackTraces true\n\n  // set options for log level DEBUG and INFO\n  debug {\n      events TestLogEvent.STARTED,\n             TestLogEvent.FAILED,\n             TestLogEvent.PASSED,\n             TestLogEvent.SKIPPED,\n             TestLogEvent.STANDARD_ERROR,\n             TestLogEvent.STANDARD_OUT\n      exceptionFormat TestExceptionFormat.FULL\n  }\n  info.events = debug.events\n  info.exceptionFormat = debug.exceptionFormat\n\n  afterSuite { desc, result ->\n      if (!desc.parent) { // will match the outermost suite\n          def output = \"Results: ${result.resultType} (${result.testCount} tests, ${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped)\"\n          def startItem = '|  ', endItem = '  |'\n          def repeatLength = startItem.length() + output.length() + endItem.length()\n          println('\\n' + ('-' * repeatLength) + '\\n' + startItem + output + endItem + '\\n' + ('-' * repeatLength))\n      }\n  }\n}\nEOF",
      ],
    },
    "13301": {
      testCmd:
        "./gradlew test --tests TestXYPoint.testEqualsAndHashCode -Dtests.seed=3ABEFE4D876DD310 -Dtests.nightly=true -Dtests.locale=es-419 -Dtests.timezone=Asia/Ulaanbaatar -Dtests.asserts=true -Dtests.file.encoding=UTF-8",
      preInstall: [
        "sed -i '\n/testLogging {/,/}/{\n  /testLogging {/r /dev/stdin\n  d\n}\n' gradle/testing/defaults-tests.gradle << 'EOF'\ntestLogging {\n  showStandardStreams = true\n  // set options for log level LIFECYCLE\n  events TestLogEvent.FAILED,\n         TestLogEvent.PASSED,\n         TestLogEvent.SKIPPED,\n         TestLogEvent.STANDARD_OUT\n  exceptionFormat TestExceptionFormat.FULL\n  showExceptions true\n  showCauses true\n  showStackTraces true\n\n  // set options for log level DEBUG and INFO\n  debug {\n      events TestLogEvent.STARTED,\n             TestLogEvent.FAILED,\n             TestLogEvent.PASSED,\n             TestLogEvent.SKIPPED,\n             TestLogEvent.STANDARD_ERROR,\n             TestLogEvent.STANDARD_OUT\n      exceptionFormat TestExceptionFormat.FULL\n  }\n  info.events = debug.events\n  info.exceptionFormat = debug.exceptionFormat\n\n  afterSuite { desc, result ->\n      if (!desc.parent) { // will match the outermost suite\n          def output = \"Results: ${result.resultType} (${result.testCount} tests, ${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped)\"\n          def startItem = '|  ', endItem = '  |'\n          def repeatLength = startItem.length() + output.length() + endItem.length()\n          println('\\n' + ('-' * repeatLength) + '\\n' + startItem + output + endItem + '\\n' + ('-' * repeatLength))\n      }\n  }\n}\nEOF",
      ],
    },
    "13494": {
      testCmd: "./gradlew test --tests org.apache.lucene.facet.TestStringValueFacetCounts",
      preInstall: [
        "sed -i '\n/testLogging {/,/}/{\n  /testLogging {/r /dev/stdin\n  d\n}\n' gradle/testing/defaults-tests.gradle << 'EOF'\ntestLogging {\n  showStandardStreams = true\n  // set options for log level LIFECYCLE\n  events TestLogEvent.FAILED,\n         TestLogEvent.PASSED,\n         TestLogEvent.SKIPPED,\n         TestLogEvent.STANDARD_OUT\n  exceptionFormat TestExceptionFormat.FULL\n  showExceptions true\n  showCauses true\n  showStackTraces true\n\n  // set options for log level DEBUG and INFO\n  debug {\n      events TestLogEvent.STARTED,\n             TestLogEvent.FAILED,\n             TestLogEvent.PASSED,\n             TestLogEvent.SKIPPED,\n             TestLogEvent.STANDARD_ERROR,\n             TestLogEvent.STANDARD_OUT\n      exceptionFormat TestExceptionFormat.FULL\n  }\n  info.events = debug.events\n  info.exceptionFormat = debug.exceptionFormat\n\n  afterSuite { desc, result ->\n      if (!desc.parent) { // will match the outermost suite\n          def output = \"Results: ${result.resultType} (${result.testCount} tests, ${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped)\"\n          def startItem = '|  ', endItem = '  |'\n          def repeatLength = startItem.length() + output.length() + endItem.length()\n          println('\\n' + ('-' * repeatLength) + '\\n' + startItem + output + endItem + '\\n' + ('-' * repeatLength))\n      }\n  }\n}\nEOF",
      ],
    },
    "13704": {
      testCmd: "./gradlew test --tests org.apache.lucene.search.TestLatLonDocValuesQueries",
      preInstall: [
        "sed -i '\n/testLogging {/,/}/{\n  /testLogging {/r /dev/stdin\n  d\n}\n' gradle/testing/defaults-tests.gradle << 'EOF'\ntestLogging {\n  showStandardStreams = true\n  // set options for log level LIFECYCLE\n  events TestLogEvent.FAILED,\n         TestLogEvent.PASSED,\n         TestLogEvent.SKIPPED,\n         TestLogEvent.STANDARD_OUT\n  exceptionFormat TestExceptionFormat.FULL\n  showExceptions true\n  showCauses true\n  showStackTraces true\n\n  // set options for log level DEBUG and INFO\n  debug {\n      events TestLogEvent.STARTED,\n             TestLogEvent.FAILED,\n             TestLogEvent.PASSED,\n             TestLogEvent.SKIPPED,\n             TestLogEvent.STANDARD_ERROR,\n             TestLogEvent.STANDARD_OUT\n      exceptionFormat TestExceptionFormat.FULL\n  }\n  info.events = debug.events\n  info.exceptionFormat = debug.exceptionFormat\n\n  afterSuite { desc, result ->\n      if (!desc.parent) { // will match the outermost suite\n          def output = \"Results: ${result.resultType} (${result.testCount} tests, ${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped)\"\n          def startItem = '|  ', endItem = '  |'\n          def repeatLength = startItem.length() + output.length() + endItem.length()\n          println('\\n' + ('-' * repeatLength) + '\\n' + startItem + output + endItem + '\\n' + ('-' * repeatLength))\n      }\n  }\n}\nEOF",
      ],
    },
  },
  "astral-sh/ruff": {
    "15309": {
      testCmd: "cargo test --package ruff_linter 'f52'",
      install: "RUSTFLAGS=-Awarnings cargo test --package ruff_linter --no-run",
    },
    "15330": {
      testCmd: "cargo test --package ruff_linter --lib rules::eradicate",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package ruff_linter --lib rules::eradicate --no-run",
    },
    "15356": {
      testCmd: "cargo test --package ruff_linter --lib rules::pycodestyle",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package ruff_linter --lib rules::pycodestyle --no-run",
    },
    "15394": {
      testCmd: "cargo test --package ruff_linter --lib rules::flake8_pie",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package ruff_linter --lib rules::flake8_pie --no-run",
    },
    "15443": {
      testCmd: "cargo test --package ruff_linter --lib rules::flake8_bandit",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package ruff_linter --lib rules::flake8_bandit --no-run",
    },
    "15543": {
      testCmd: "cargo test --package ruff_linter --lib rules::pyupgrade",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package ruff_linter --lib rules::pyupgrade --no-run",
    },
    "15626": {
      testCmd: "cargo test --package ruff_linter --lib rules::flake8_simplify::tests",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package ruff_linter --lib rules::flake8_simplify::tests --no-run",
    },
  },
  "astropy/astropy": {
    "0.1": {
      testCmd: "pytest -rA -vv -o console_output_style=classic --tb=no",
      install: "python -m pip install -e .[test] --verbose",
      pipPackages: [
        "attrs==17.3.0",
        "exceptiongroup==0.0.0a0",
        "execnet==1.5.0",
        "hypothesis==3.44.2",
        "cython==0.27.3",
        "jinja2==2.10",
        "MarkupSafe==1.0",
        "numpy==1.16.0",
        "packaging==16.8",
        "pluggy==0.6.0",
        "psutil==5.4.2",
        "pyerfa==1.7.0",
        "pytest-arraydiff==0.1",
        "pytest-astropy-header==0.1",
        "pytest-astropy==0.2.1",
        "pytest-cov==2.5.1",
        "pytest-doctestplus==0.1.2",
        "pytest-filter-subpackage==0.1",
        "pytest-forked==0.2",
        "pytest-mock==1.6.3",
        "pytest-openfiles==0.2.0",
        "pytest-remotedata==0.2.0",
        "pytest-xdist==1.20.1",
        "pytest==3.3.1",
        "PyYAML==3.12",
        "sortedcontainers==1.5.9",
        "tomli==0.2.0",
      ],
    },
    "0.2": {
      testCmd: "pytest -rA -vv -o console_output_style=classic --tb=no",
      install: "python -m pip install -e .[test] --verbose",
      pipPackages: [
        "attrs==17.3.0",
        "exceptiongroup==0.0.0a0",
        "execnet==1.5.0",
        "hypothesis==3.44.2",
        "cython==0.27.3",
        "jinja2==2.10",
        "MarkupSafe==1.0",
        "numpy==1.16.0",
        "packaging==16.8",
        "pluggy==0.6.0",
        "psutil==5.4.2",
        "pyerfa==1.7.0",
        "pytest-arraydiff==0.1",
        "pytest-astropy-header==0.1",
        "pytest-astropy==0.2.1",
        "pytest-cov==2.5.1",
        "pytest-doctestplus==0.1.2",
        "pytest-filter-subpackage==0.1",
        "pytest-forked==0.2",
        "pytest-mock==1.6.3",
        "pytest-openfiles==0.2.0",
        "pytest-remotedata==0.2.0",
        "pytest-xdist==1.20.1",
        "pytest==3.3.1",
        "PyYAML==3.12",
        "sortedcontainers==1.5.9",
        "tomli==0.2.0",
      ],
    },
    "0.3": {
      testCmd: "pytest -rA -vv -o console_output_style=classic --tb=no",
      install: "python -m pip install -e .[test] --verbose",
      pipPackages: [
        "attrs==17.3.0",
        "exceptiongroup==0.0.0a0",
        "execnet==1.5.0",
        "hypothesis==3.44.2",
        "cython==0.27.3",
        "jinja2==2.10",
        "MarkupSafe==1.0",
        "numpy==1.16.0",
        "packaging==16.8",
        "pluggy==0.6.0",
        "psutil==5.4.2",
        "pyerfa==1.7.0",
        "pytest-arraydiff==0.1",
        "pytest-astropy-header==0.1",
        "pytest-astropy==0.2.1",
        "pytest-cov==2.5.1",
        "pytest-doctestplus==0.1.2",
        "pytest-filter-subpackage==0.1",
        "pytest-forked==0.2",
        "pytest-mock==1.6.3",
        "pytest-openfiles==0.2.0",
        "pytest-remotedata==0.2.0",
        "pytest-xdist==1.20.1",
        "pytest==3.3.1",
        "PyYAML==3.12",
        "sortedcontainers==1.5.9",
        "tomli==0.2.0",
      ],
    },
    "0.4": {
      testCmd: "pytest -rA -vv -o console_output_style=classic --tb=no",
      install: "python -m pip install -e .[test] --verbose",
      pipPackages: [
        "attrs==17.3.0",
        "exceptiongroup==0.0.0a0",
        "execnet==1.5.0",
        "hypothesis==3.44.2",
        "cython==0.27.3",
        "jinja2==2.10",
        "MarkupSafe==1.0",
        "numpy==1.16.0",
        "packaging==16.8",
        "pluggy==0.6.0",
        "psutil==5.4.2",
        "pyerfa==1.7.0",
        "pytest-arraydiff==0.1",
        "pytest-astropy-header==0.1",
        "pytest-astropy==0.2.1",
        "pytest-cov==2.5.1",
        "pytest-doctestplus==0.1.2",
        "pytest-filter-subpackage==0.1",
        "pytest-forked==0.2",
        "pytest-mock==1.6.3",
        "pytest-openfiles==0.2.0",
        "pytest-remotedata==0.2.0",
        "pytest-xdist==1.20.1",
        "pytest==3.3.1",
        "PyYAML==3.12",
        "sortedcontainers==1.5.9",
        "tomli==0.2.0",
      ],
    },
    "1.1": {
      testCmd: "pytest -rA -vv -o console_output_style=classic --tb=no",
      install: "python -m pip install -e .[test] --verbose",
      pipPackages: [
        "attrs==17.3.0",
        "exceptiongroup==0.0.0a0",
        "execnet==1.5.0",
        "hypothesis==3.44.2",
        "cython==0.27.3",
        "jinja2==2.10",
        "MarkupSafe==1.0",
        "numpy==1.16.0",
        "packaging==16.8",
        "pluggy==0.6.0",
        "psutil==5.4.2",
        "pyerfa==1.7.0",
        "pytest-arraydiff==0.1",
        "pytest-astropy-header==0.1",
        "pytest-astropy==0.2.1",
        "pytest-cov==2.5.1",
        "pytest-doctestplus==0.1.2",
        "pytest-filter-subpackage==0.1",
        "pytest-forked==0.2",
        "pytest-mock==1.6.3",
        "pytest-openfiles==0.2.0",
        "pytest-remotedata==0.2.0",
        "pytest-xdist==1.20.1",
        "pytest==3.3.1",
        "PyYAML==3.12",
        "sortedcontainers==1.5.9",
        "tomli==0.2.0",
      ],
    },
    "1.2": {
      testCmd: "pytest -rA -vv -o console_output_style=classic --tb=no",
      install: "python -m pip install -e .[test] --verbose",
      pipPackages: [
        "attrs==17.3.0",
        "exceptiongroup==0.0.0a0",
        "execnet==1.5.0",
        "hypothesis==3.44.2",
        "cython==0.27.3",
        "jinja2==2.10",
        "MarkupSafe==1.0",
        "numpy==1.16.0",
        "packaging==16.8",
        "pluggy==0.6.0",
        "psutil==5.4.2",
        "pyerfa==1.7.0",
        "pytest-arraydiff==0.1",
        "pytest-astropy-header==0.1",
        "pytest-astropy==0.2.1",
        "pytest-cov==2.5.1",
        "pytest-doctestplus==0.1.2",
        "pytest-filter-subpackage==0.1",
        "pytest-forked==0.2",
        "pytest-mock==1.6.3",
        "pytest-openfiles==0.2.0",
        "pytest-remotedata==0.2.0",
        "pytest-xdist==1.20.1",
        "pytest==3.3.1",
        "PyYAML==3.12",
        "sortedcontainers==1.5.9",
        "tomli==0.2.0",
      ],
    },
    "1.3": {
      testCmd: "pytest -rA -vv -o console_output_style=classic --tb=no",
      install: "python -m pip install -e .[test] --verbose",
      pipPackages: [
        "attrs==17.3.0",
        "exceptiongroup==0.0.0a0",
        "execnet==1.5.0",
        "hypothesis==3.44.2",
        "cython==0.27.3",
        "jinja2==2.10",
        "MarkupSafe==1.0",
        "numpy==1.16.0",
        "packaging==16.8",
        "pluggy==0.6.0",
        "psutil==5.4.2",
        "pyerfa==1.7.0",
        "pytest-arraydiff==0.1",
        "pytest-astropy-header==0.1",
        "pytest-astropy==0.2.1",
        "pytest-cov==2.5.1",
        "pytest-doctestplus==0.1.2",
        "pytest-filter-subpackage==0.1",
        "pytest-forked==0.2",
        "pytest-mock==1.6.3",
        "pytest-openfiles==0.2.0",
        "pytest-remotedata==0.2.0",
        "pytest-xdist==1.20.1",
        "pytest==3.3.1",
        "PyYAML==3.12",
        "sortedcontainers==1.5.9",
        "tomli==0.2.0",
      ],
    },
    "3.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[test] --verbose",
      pipPackages: [
        "attrs==23.1.0",
        "exceptiongroup==1.1.3",
        "execnet==2.0.2",
        "hypothesis==6.82.6",
        "iniconfig==2.0.0",
        "numpy==1.25.2",
        "packaging==23.1",
        "pluggy==1.3.0",
        "psutil==5.9.5",
        "pyerfa==2.0.0.3",
        "pytest-arraydiff==0.5.0",
        "pytest-astropy-header==0.2.2",
        "pytest-astropy==0.10.0",
        "pytest-cov==4.1.0",
        "pytest-doctestplus==1.0.0",
        "pytest-filter-subpackage==0.1.2",
        "pytest-mock==3.11.1",
        "pytest-openfiles==0.5.0",
        "pytest-remotedata==0.4.0",
        "pytest-xdist==3.3.1",
        "pytest==7.4.0",
        "PyYAML==6.0.1",
        "setuptools==68.0.0",
        "sortedcontainers==2.4.0",
        "tomli==2.0.1",
      ],
    },
    "3.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[test] --verbose",
      pipPackages: [
        "attrs==23.1.0",
        "exceptiongroup==1.1.3",
        "execnet==2.0.2",
        "hypothesis==6.82.6",
        "iniconfig==2.0.0",
        "numpy==1.25.2",
        "packaging==23.1",
        "pluggy==1.3.0",
        "psutil==5.9.5",
        "pyerfa==2.0.0.3",
        "pytest-arraydiff==0.5.0",
        "pytest-astropy-header==0.2.2",
        "pytest-astropy==0.10.0",
        "pytest-cov==4.1.0",
        "pytest-doctestplus==1.0.0",
        "pytest-filter-subpackage==0.1.2",
        "pytest-mock==3.11.1",
        "pytest-openfiles==0.5.0",
        "pytest-remotedata==0.4.0",
        "pytest-xdist==3.3.1",
        "pytest==7.4.0",
        "PyYAML==6.0.1",
        "setuptools==68.0.0",
        "sortedcontainers==2.4.0",
        "tomli==2.0.1",
      ],
    },
    "3.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[test] --verbose",
      pipPackages: [
        "attrs==23.1.0",
        "exceptiongroup==1.1.3",
        "execnet==2.0.2",
        "hypothesis==6.82.6",
        "iniconfig==2.0.0",
        "numpy==1.25.2",
        "packaging==23.1",
        "pluggy==1.3.0",
        "psutil==5.9.5",
        "pyerfa==2.0.0.3",
        "pytest-arraydiff==0.5.0",
        "pytest-astropy-header==0.2.2",
        "pytest-astropy==0.10.0",
        "pytest-cov==4.1.0",
        "pytest-doctestplus==1.0.0",
        "pytest-filter-subpackage==0.1.2",
        "pytest-mock==3.11.1",
        "pytest-openfiles==0.5.0",
        "pytest-remotedata==0.4.0",
        "pytest-xdist==3.3.1",
        "pytest==7.4.0",
        "PyYAML==6.0.1",
        "setuptools==68.0.0",
        "sortedcontainers==2.4.0",
        "tomli==2.0.1",
      ],
    },
    "4.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[test] --verbose",
      preInstall: [
        'sed -i \'s/requires = \\["setuptools",/requires = \\["setuptools==68.0.0",/\' pyproject.toml',
      ],
      pipPackages: [
        "attrs==23.1.0",
        "exceptiongroup==1.1.3",
        "execnet==2.0.2",
        "hypothesis==6.82.6",
        "iniconfig==2.0.0",
        "numpy==1.25.2",
        "packaging==23.1",
        "pluggy==1.3.0",
        "psutil==5.9.5",
        "pyerfa==2.0.0.3",
        "pytest-arraydiff==0.5.0",
        "pytest-astropy-header==0.2.2",
        "pytest-astropy==0.10.0",
        "pytest-cov==4.1.0",
        "pytest-doctestplus==1.0.0",
        "pytest-filter-subpackage==0.1.2",
        "pytest-mock==3.11.1",
        "pytest-openfiles==0.5.0",
        "pytest-remotedata==0.4.0",
        "pytest-xdist==3.3.1",
        "pytest==7.4.0",
        "PyYAML==6.0.1",
        "setuptools==68.0.0",
        "sortedcontainers==2.4.0",
        "tomli==2.0.1",
      ],
    },
    "4.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[test] --verbose",
      preInstall: [
        'sed -i \'s/requires = \\["setuptools",/requires = \\["setuptools==68.0.0",/\' pyproject.toml',
      ],
      pipPackages: [
        "attrs==23.1.0",
        "exceptiongroup==1.1.3",
        "execnet==2.0.2",
        "hypothesis==6.82.6",
        "iniconfig==2.0.0",
        "numpy==1.25.2",
        "packaging==23.1",
        "pluggy==1.3.0",
        "psutil==5.9.5",
        "pyerfa==2.0.0.3",
        "pytest-arraydiff==0.5.0",
        "pytest-astropy-header==0.2.2",
        "pytest-astropy==0.10.0",
        "pytest-cov==4.1.0",
        "pytest-doctestplus==1.0.0",
        "pytest-filter-subpackage==0.1.2",
        "pytest-mock==3.11.1",
        "pytest-openfiles==0.5.0",
        "pytest-remotedata==0.4.0",
        "pytest-xdist==3.3.1",
        "pytest==7.4.0",
        "PyYAML==6.0.1",
        "setuptools==68.0.0",
        "sortedcontainers==2.4.0",
        "tomli==2.0.1",
      ],
    },
    "4.3": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[test] --verbose",
      preInstall: [
        'sed -i \'s/requires = \\["setuptools",/requires = \\["setuptools==68.0.0",/\' pyproject.toml',
      ],
      pipPackages: [
        "attrs==23.1.0",
        "exceptiongroup==1.1.3",
        "execnet==2.0.2",
        "hypothesis==6.82.6",
        "iniconfig==2.0.0",
        "numpy==1.25.2",
        "packaging==23.1",
        "pluggy==1.3.0",
        "psutil==5.9.5",
        "pyerfa==2.0.0.3",
        "pytest-arraydiff==0.5.0",
        "pytest-astropy-header==0.2.2",
        "pytest-astropy==0.10.0",
        "pytest-cov==4.1.0",
        "pytest-doctestplus==1.0.0",
        "pytest-filter-subpackage==0.1.2",
        "pytest-mock==3.11.1",
        "pytest-openfiles==0.5.0",
        "pytest-remotedata==0.4.0",
        "pytest-xdist==3.3.1",
        "pytest==7.4.0",
        "PyYAML==6.0.1",
        "setuptools==68.0.0",
        "sortedcontainers==2.4.0",
        "tomli==2.0.1",
      ],
    },
    "5.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[test] --verbose",
      preInstall: [
        'sed -i \'s/requires = \\["setuptools",/requires = \\["setuptools==68.0.0",/\' pyproject.toml',
      ],
      pipPackages: [
        "attrs==23.1.0",
        "exceptiongroup==1.1.3",
        "execnet==2.0.2",
        "hypothesis==6.82.6",
        "iniconfig==2.0.0",
        "numpy==1.25.2",
        "packaging==23.1",
        "pluggy==1.3.0",
        "psutil==5.9.5",
        "pyerfa==2.0.0.3",
        "pytest-arraydiff==0.5.0",
        "pytest-astropy-header==0.2.2",
        "pytest-astropy==0.10.0",
        "pytest-cov==4.1.0",
        "pytest-doctestplus==1.0.0",
        "pytest-filter-subpackage==0.1.2",
        "pytest-mock==3.11.1",
        "pytest-openfiles==0.5.0",
        "pytest-remotedata==0.4.0",
        "pytest-xdist==3.3.1",
        "pytest==7.4.0",
        "PyYAML==6.0.1",
        "setuptools==68.0.0",
        "sortedcontainers==2.4.0",
        "tomli==2.0.1",
      ],
    },
    "5.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[test] --verbose",
      preInstall: [
        'sed -i \'s/requires = \\["setuptools",/requires = \\["setuptools==68.0.0",/\' pyproject.toml',
      ],
      pipPackages: [
        "attrs==23.1.0",
        "exceptiongroup==1.1.3",
        "execnet==2.0.2",
        "hypothesis==6.82.6",
        "iniconfig==2.0.0",
        "numpy==1.25.2",
        "packaging==23.1",
        "pluggy==1.3.0",
        "psutil==5.9.5",
        "pyerfa==2.0.0.3",
        "pytest-arraydiff==0.5.0",
        "pytest-astropy-header==0.2.2",
        "pytest-astropy==0.10.0",
        "pytest-cov==4.1.0",
        "pytest-doctestplus==1.0.0",
        "pytest-filter-subpackage==0.1.2",
        "pytest-mock==3.11.1",
        "pytest-openfiles==0.5.0",
        "pytest-remotedata==0.4.0",
        "pytest-xdist==3.3.1",
        "pytest==7.4.0",
        "PyYAML==6.0.1",
        "setuptools==68.0.0",
        "sortedcontainers==2.4.0",
        "tomli==2.0.1",
      ],
    },
    "5.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[test] --verbose",
      preInstall: [
        'sed -i \'s/requires = \\["setuptools",/requires = \\["setuptools==68.0.0",/\' pyproject.toml',
      ],
      pipPackages: [
        "attrs==23.1.0",
        "exceptiongroup==1.1.3",
        "execnet==2.0.2",
        "hypothesis==6.82.6",
        "iniconfig==2.0.0",
        "numpy==1.25.2",
        "packaging==23.1",
        "pluggy==1.3.0",
        "psutil==5.9.5",
        "pyerfa==2.0.0.3",
        "pytest-arraydiff==0.5.0",
        "pytest-astropy-header==0.2.2",
        "pytest-astropy==0.10.0",
        "pytest-cov==4.1.0",
        "pytest-doctestplus==1.0.0",
        "pytest-filter-subpackage==0.1.2",
        "pytest-mock==3.11.1",
        "pytest-openfiles==0.5.0",
        "pytest-remotedata==0.4.0",
        "pytest-xdist==3.3.1",
        "pytest==7.4.0",
        "PyYAML==6.0.1",
        "setuptools==68.0.0",
        "sortedcontainers==2.4.0",
        "tomli==2.0.1",
      ],
    },
    "v5.3": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[test] --verbose",
      preInstall: [
        'sed -i \'s/requires = \\["setuptools",/requires = \\["setuptools==68.0.0",/\' pyproject.toml',
      ],
      pipPackages: [
        "attrs==23.1.0",
        "exceptiongroup==1.1.3",
        "execnet==2.0.2",
        "hypothesis==6.82.6",
        "iniconfig==2.0.0",
        "numpy==1.25.2",
        "packaging==23.1",
        "pluggy==1.3.0",
        "psutil==5.9.5",
        "pyerfa==2.0.0.3",
        "pytest-arraydiff==0.5.0",
        "pytest-astropy-header==0.2.2",
        "pytest-astropy==0.10.0",
        "pytest-cov==4.1.0",
        "pytest-doctestplus==1.0.0",
        "pytest-filter-subpackage==0.1.2",
        "pytest-mock==3.11.1",
        "pytest-openfiles==0.5.0",
        "pytest-remotedata==0.4.0",
        "pytest-xdist==3.3.1",
        "pytest==7.4.0",
        "PyYAML==6.0.1",
        "setuptools==68.0.0",
        "sortedcontainers==2.4.0",
        "tomli==2.0.1",
      ],
    },
  },
  "axios/axios": {
    "4731": {
      testCmd: "npx mocha -R tap test/unit/adapters/http.js -g 'body length'",
      install: "npm install",
    },
    "4738": {
      testCmd: "timeout 10s npx mocha -R tap test/unit/adapters/http.js -g 'timeout'",
      install: "npm install",
    },
    "5085": { testCmd: "npx mocha -R tap test/unit/regression/bugs.js", install: "npm install" },
    "5316": {
      testCmd: "npx mocha test/unit/adapters/http.js -R tap -g 'FormData'",
      install: "npm install",
    },
    "5892": {
      testCmd: "npx mocha test/unit/adapters/http.js -R tap -g 'compression'",
      install: "npm install",
    },
    "6539": {
      testCmd: "npx mocha -R tap test/unit/regression/SNYK-JS-AXIOS-7361793.js",
      install: "npm install",
    },
  },
  "babel/babel": {
    "13928": { testCmd: 'yarn jest babel-parser -t "arrow" --verbose', install: "make bootstrap" },
    "14532": { testCmd: "yarn jest babel-generator --verbose", install: "make bootstrap" },
    "15445": {
      testCmd: 'yarn jest packages/babel-generator/test/index.js -t "generation " --verbose',
      install: "make bootstrap",
    },
    "15649": {
      testCmd: "yarn jest packages/babel-traverse/test/scope.js --verbose",
      install: "make bootstrap",
    },
    "16130": { testCmd: "yarn jest babel-helpers --verbose", install: "make bootstrap" },
  },
  "briannesbitt/carbon": {
    "2665": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/Carbon/RoundTest.php",
      install: "composer update && composer install",
    },
    "2752": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/CarbonImmutable/IsTest.php",
      install: "composer update && composer install",
    },
    "2762": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/CarbonInterval/RoundingTest.php",
      install: "composer update && composer install",
    },
    "2813": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/Factory/FactoryTest.php",
      install: "composer update && composer install",
    },
    "2981": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/CarbonInterval/TotalTest.php",
      install: "composer update && composer install",
    },
    "3005": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/CarbonInterval/ConstructTest.php",
      install: "composer update && composer install",
    },
    "3041": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/CarbonPeriod/CreateTest.php",
      install: "composer update && composer install",
    },
    "3073": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/CarbonInterval/TotalTest.php",
      install: "composer update && composer install",
    },
    "3098": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/CarbonInterval/ConstructTest.php",
      install: "composer update && composer install",
    },
    "3103": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/CarbonImmutable/SettersTest.php",
      install: "composer update && composer install",
    },
  },
  "burntsushi/ripgrep": {
    "2209": {
      testCmd:
        "RUSTFLAGS=-Awarnings cargo test --package ripgrep --test integration -- regression::r2208 --exact",
      install: "RUSTFLAGS=-Awarnings cargo test --package ripgrep --test integration --no-run",
    },
    "2576": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package ripgrep --test integration -- regression",
      install: "RUSTFLAGS=-Awarnings cargo test --package ripgrep --test integration --no-run",
    },
  },
  "caddyserver/caddy": {
    "4774": {
      testCmd: 'go test -v ./caddytest/integration -run "TestCaddyfileAdapt*"',
      install: 'go test -c ./caddytest/integration -run "TestCaddyfileAdapt*"',
    },
    "4943": { testCmd: "go test -v ./modules/logging", install: "go test -c ./modules/logging" },
    "5404": {
      testCmd: "go test -v ./caddyconfig/caddyfile",
      install: "go test -c ./caddyconfig/caddyfile",
    },
    "5626": {
      testCmd: 'go test -v ./caddyconfig/httpcaddyfile -run "Test.*Import"',
      install: 'go test -c ./caddyconfig/httpcaddyfile -run "Test.*Import"',
    },
    "5761": {
      testCmd: 'go test -v ./caddyconfig/caddyfile -run "TestLexer.*"',
      install: 'go test -c ./caddyconfig/caddyfile -run "TestLexer.*"',
    },
    "5870": {
      testCmd: 'go test -v . -run "TestUnsyncedConfigAccess"',
      install: 'go test -c . -run "TestUnsyncedConfigAccess"',
    },
    "5995": {
      testCmd: 'go test -v ./caddytest/integration -run "^TestUriReplace"',
      install: 'go test -c ./caddytest/integration -run "^TestUriReplace"',
    },
    "6051": {
      testCmd: "go test -v ./caddyconfig/caddyfile",
      install: "go test -c ./caddyconfig/caddyfile",
    },
    "6115": {
      testCmd: "go test -v ./modules/caddyhttp/reverseproxy",
      install: "go test -c ./modules/caddyhttp/reverseproxy",
    },
    "6288": {
      testCmd: 'go test -v ./caddytest/integration -run "TestCaddyfileAdapt*"',
      install: 'go test -c ./caddytest/integration -run "TestCaddyfileAdapt*"',
    },
    "6345": {
      testCmd: "go test -v ./caddytest/integration",
      install: "go test -c ./caddytest/integration",
    },
    "6350": {
      testCmd: 'go test -v ./caddytest/integration -run "TestCaddyfileAdapt*"',
      install: 'go test -c ./caddytest/integration -run "TestCaddyfileAdapt*"',
    },
    "6370": { testCmd: "go test -v ./cmd", install: "go test -c ./cmd" },
    "6411": { testCmd: 'go test -v . -run "TestReplacerNew*"', install: "go mod tidy" },
  },
  "chartjs/Chart.js": {
    "2.0": {
      testCmd:
        'npm install && gulp build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "gulp test"',
      install: "npm install && npm install -g gulp-cli",
    },
    "2.1": {
      testCmd:
        'npm install && gulp build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "gulp test"',
      install: "npm install && npm install -g gulp-cli",
    },
    "2.2": {
      testCmd:
        'npm install && gulp build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "gulp test"',
      install: "npm install && npm install -g gulp-cli",
    },
    "2.3": {
      testCmd:
        'npm install && gulp build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "gulp test"',
      install: "npm install && npm install -g gulp-cli",
    },
    "2.4": {
      testCmd:
        'npm install && gulp build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "gulp test"',
      install: "npm install && npm install -g gulp-cli",
    },
    "2.5": {
      testCmd:
        'npm install && gulp build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "gulp test"',
      install: "npm install && npm install -g gulp-cli",
    },
    "2.6": {
      testCmd:
        'npm install && gulp build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "gulp test"',
      install: "npm install && npm install -g gulp-cli",
    },
    "2.7": {
      testCmd:
        'npm install && gulp build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "gulp test"',
      install: "npm install && npm install -g gulp-cli",
    },
    "2.8": {
      testCmd:
        'npm install && gulp build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "gulp test"',
      install: "npm install && npm install -g gulp-cli",
    },
    "2.9": {
      testCmd:
        'npm install && gulp build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "gulp test"',
      install: "npm install && npm install -g gulp-cli",
    },
    "3.0": {
      testCmd:
        'npm install && npm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.js --single-run --coverage --grep --auto-watch false"',
      install: "npm install",
    },
    "3.1": {
      testCmd:
        'npm install && npm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.js --single-run --coverage --grep --auto-watch false"',
      install: "npm install",
    },
    "3.2": {
      testCmd:
        'npm install && npm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.js --single-run --coverage --grep --auto-watch false"',
      install: "npm install",
    },
    "3.3": {
      testCmd:
        'npm install && npm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.js --single-run --coverage --grep --auto-watch false"',
      install: "npm install",
    },
    "3.4": {
      testCmd:
        'npm install && npm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.js --single-run --coverage --grep --auto-watch false"',
      install: "npm install",
    },
    "3.5": {
      testCmd:
        'npm install && npm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.js --single-run --coverage --grep --auto-watch false"',
      install: "npm install",
    },
    "3.6": {
      testCmd:
        'npm install && npm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.js --single-run --coverage --grep --auto-watch false"',
      install: "npm install",
    },
    "3.7": {
      testCmd:
        'npm install && npm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.js --single-run --coverage --grep --auto-watch false"',
      install: "npm install",
    },
    "3.8": {
      testCmd:
        'npm install && npm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.js --single-run --coverage --grep --auto-watch false"',
      install: "npm install",
    },
    "4.0": {
      testCmd:
        'pnpm install && pnpm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.cjs --single-run --coverage --grep --auto-watch false"',
      install: "pnpm install && pnpm run build",
    },
    "4.1": {
      testCmd:
        'pnpm install && pnpm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.cjs --single-run --coverage --grep --auto-watch false"',
      install: "pnpm install && pnpm run build",
    },
    "4.2": {
      testCmd:
        'pnpm install && pnpm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.cjs --single-run --coverage --grep --auto-watch false"',
      install: "pnpm install && pnpm run build",
    },
    "4.3": {
      testCmd:
        'pnpm install && pnpm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.cjs --single-run --coverage --grep --auto-watch false"',
      install: "pnpm install && pnpm run build",
    },
    "4.4": {
      testCmd:
        'pnpm install && pnpm run build && xvfb-run --server-args="-screen 0 1280x1024x24 -ac :99" su chromeuser -c "./node_modules/.bin/cross-env NODE_ENV=test ./node_modules/.bin/karma start ./karma.conf.cjs --single-run --coverage --grep --auto-watch false"',
      install: "pnpm install && pnpm run build",
    },
  },
  "dbt-labs/dbt-core": {
    "0.13": { install: "python -m pip install -e ." },
    "0.14": { install: "python -m pip install -e ." },
    "0.15": { install: "python -m pip install -e ." },
    "0.16": { install: "python -m pip install -e ." },
    "0.17": { install: "python -m pip install -e ." },
    "0.18": { install: "python -m pip install -e ." },
    "0.19": { install: "python -m pip install -e ." },
    "0.20": { install: "python -m pip install -e ." },
    "0.21": { install: "python -m pip install -e ." },
    "1.0": { install: "python -m pip install -e ." },
    "1.1": { install: "python -m pip install -e ." },
    "1.2": { install: "python -m pip install -e ." },
    "1.3": { install: "python -m pip install -e ." },
    "1.4": { install: "python -m pip install -e ." },
    "1.5": { install: "python -m pip install -e ." },
    "1.6": { install: "python -m pip install -e ." },
    "1.7": { install: "python -m pip install -e ." },
  },
  "diegomura/react-pdf": {
    "1.0": {
      testCmd: "./node_modules/.bin/jest --no-color",
      install: "npm install && npm install cheerio@1.0.0-rc.3",
    },
    "1.1": {
      testCmd: "./node_modules/.bin/jest --no-color",
      install: "npm install && npm install cheerio@1.0.0-rc.3",
    },
    "1.2": {
      testCmd: "./node_modules/.bin/jest --no-color",
      install: "npm install && npm install cheerio@1.0.0-rc.3",
    },
    "2.0": {
      testCmd: 'NODE_OPTIONS="--experimental-vm-modules" ./node_modules/.bin/jest --no-color',
      install: "npm i -g yarn && yarn install",
    },
  },
  "django/django": {
    "1.10": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python setup.py install",
      preInstall: [
        "apt-get update && apt-get install -y locales",
        "echo 'en_US UTF-8' > /etc/locale.gen",
        "locale-gen en_US.UTF-8",
      ],
      evalCommands: [
        "export LANG=en_US.UTF-8",
        "export LC_ALL=en_US.UTF-8",
        "export PYTHONIOENCODING=utf8",
        "export LANGUAGE=en_US:en",
      ],
      pipPackages: ["setuptools"],
    },
    "1.11": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python setup.py install",
      preInstall: [
        "apt-get update && apt-get install -y locales",
        "echo 'en_US UTF-8' > /etc/locale.gen",
        "locale-gen en_US.UTF-8",
      ],
      evalCommands: [
        "export LANG=en_US.UTF-8",
        "export LC_ALL=en_US.UTF-8",
        "export PYTHONIOENCODING=utf8",
        "export LANGUAGE=en_US:en",
      ],
      pipPackages: ["setuptools"],
    },
    "1.4": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python setup.py install",
    },
    "1.5": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python setup.py install",
    },
    "1.6": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python setup.py install",
    },
    "1.7": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python setup.py install",
      preInstall: [
        "apt-get update && apt-get install -y locales",
        "echo 'en_US UTF-8' > /etc/locale.gen",
        "locale-gen en_US.UTF-8",
      ],
      evalCommands: [
        "export LANG=en_US.UTF-8",
        "export LC_ALL=en_US.UTF-8",
        "export PYTHONIOENCODING=utf8",
        "export LANGUAGE=en_US:en",
      ],
      pipPackages: ["setuptools"],
    },
    "1.8": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python setup.py install",
      preInstall: [
        "apt-get update && apt-get install -y locales",
        "echo 'en_US UTF-8' > /etc/locale.gen",
        "locale-gen en_US.UTF-8",
      ],
      evalCommands: [
        "export LANG=en_US.UTF-8",
        "export LC_ALL=en_US.UTF-8",
        "export PYTHONIOENCODING=utf8",
        "export LANGUAGE=en_US:en",
      ],
      pipPackages: ["setuptools"],
    },
    "1.9": {
      testCmd: "./tests/runtests.py --verbosity 2",
      install: "python setup.py install",
      preInstall: [
        "apt-get update && apt-get install -y locales",
        "echo 'en_US UTF-8' > /etc/locale.gen",
        "locale-gen en_US.UTF-8",
      ],
      evalCommands: [
        "export LANG=en_US.UTF-8",
        "export LC_ALL=en_US.UTF-8",
        "export PYTHONIOENCODING=utf8",
        "export LANGUAGE=en_US:en",
      ],
      pipPackages: ["setuptools"],
    },
    "2.0": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python setup.py install",
      preInstall: [
        "apt-get update && apt-get install -y locales",
        "echo 'en_US UTF-8' > /etc/locale.gen",
        "locale-gen en_US.UTF-8",
      ],
      evalCommands: [
        "export LANG=en_US.UTF-8",
        "export LC_ALL=en_US.UTF-8",
        "export PYTHONIOENCODING=utf8",
        "export LANGUAGE=en_US:en",
      ],
      pipPackages: ["setuptools"],
    },
    "2.1": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python setup.py install",
      preInstall: [
        "apt-get update && apt-get install -y locales",
        "echo 'en_US UTF-8' > /etc/locale.gen",
        "locale-gen en_US.UTF-8",
      ],
      evalCommands: [
        "export LANG=en_US.UTF-8",
        "export LC_ALL=en_US.UTF-8",
        "export PYTHONIOENCODING=utf8",
        "export LANGUAGE=en_US:en",
      ],
      pipPackages: ["setuptools"],
    },
    "2.2": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python setup.py install",
      preInstall: [
        "apt-get update && apt-get install -y locales",
        "echo 'en_US UTF-8' > /etc/locale.gen",
        "locale-gen en_US.UTF-8",
      ],
      evalCommands: [
        "export LANG=en_US.UTF-8",
        "export LC_ALL=en_US.UTF-8",
        "export PYTHONIOENCODING=utf8",
        "export LANGUAGE=en_US:en",
      ],
      pipPackages: ["setuptools"],
    },
    "3.0": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python -m pip install -e .",
      evalCommands: [
        "sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen",
        "export LANG=en_US.UTF-8",
        "export LANGUAGE=en_US:en",
        "export LC_ALL=en_US.UTF-8",
      ],
    },
    "3.1": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python -m pip install -e .",
      evalCommands: [
        "sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen",
        "export LANG=en_US.UTF-8",
        "export LANGUAGE=en_US:en",
        "export LC_ALL=en_US.UTF-8",
      ],
    },
    "3.2": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python -m pip install -e .",
      evalCommands: [
        "sed -i '/en_US.UTF-8/s/^# //g' /etc/locale.gen && locale-gen",
        "export LANG=en_US.UTF-8",
        "export LANGUAGE=en_US:en",
        "export LC_ALL=en_US.UTF-8",
      ],
    },
    "4.0": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python -m pip install -e .",
    },
    "4.1": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python -m pip install -e .",
    },
    "4.2": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python -m pip install -e .",
    },
    "5.0": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python -m pip install -e .",
    },
    "5.1": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python -m pip install -e .",
    },
    "5.2": {
      testCmd: "./tests/runtests.py --verbosity 2 --settings=test_sqlite --parallel 1",
      install: "python -m pip install -e .",
    },
  },
  "facebook/docusaurus": {
    "10130": {
      testCmd: "yarn test packages/docusaurus/src/server/__tests__/brokenLinks.test.ts --verbose",
      install: "yarn install",
    },
    "10309": {
      testCmd:
        "yarn test packages/docusaurus-plugin-content-docs/src/client/__tests__/docsClientUtils.test.ts --verbose",
      install: "yarn install",
    },
    "8927": {
      testCmd: "yarn test packages/docusaurus-utils/src/__tests__/markdownLinks.test.ts --verbose",
      install: "yarn install",
    },
    "9183": {
      testCmd:
        "yarn test packages/docusaurus-theme-classic/src/__tests__/options.test.ts --verbose",
      install: "yarn install",
    },
    "9897": {
      testCmd: "yarn test packages/docusaurus-utils/src/__tests__/markdownUtils.test.ts --verbose",
      install: "yarn install",
    },
  },
  "faker-ruby/faker": {
    "2705": {
      testCmd: "bundle exec ruby test/faker/default/test_faker_internet.rb -v -n '/password/'",
      install: "bundle install",
    },
    "2970": {
      testCmd: "bundle exec ruby test/faker/default/test_faker_internet.rb -v -n '/email/'",
      install: "bundle install",
    },
  },
  "fastlane/fastlane": {
    "19207": {
      testCmd:
        "FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./fastlane/spec/actions_specs/zip_spec.rb --no-color --format json | tail -n +2 | jq -r '.examples[] | \"\\(.description) - \\(.id) - \\(.status)\"'",
      install: "bundle install --jobs=$(nproc)",
    },
    "19304": {
      testCmd:
        "FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./fastlane/spec/actions_specs/zip_spec.rb --no-color --format json | tail -n +2 | jq -r '.examples[] | \"\\(.description) - \\(.id) - \\(.status)\"'",
      install: "bundle install --jobs=$(nproc)",
    },
    "19765": {
      testCmd:
        "FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./fastlane/spec/actions_specs/download_dsyms_spec.rb --no-color --format json | tail -n +2 | jq -r '.examples[] | \"\\(.description) - \\(.id) - \\(.status)\"'",
      install: "bundle install --jobs=$(nproc)",
    },
    "20642": {
      testCmd:
        "FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./frameit/spec/device_spec.rb --no-color --format json | tail -n +2 | jq -r '.examples[] | \"\\(.description) - \\(.id) - \\(.status)\"'",
      install: "bundle install --jobs=$(nproc)",
    },
    "20958": {
      testCmd:
        "FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./fastlane/spec/actions_specs/import_from_git_spec.rb --no-color --format json | tail -n +2 | jq -r '.examples[] | \"\\(.description) - \\(.id) - \\(.status)\"'",
      install: "bundle install --jobs=$(nproc)",
    },
    "20975": {
      testCmd:
        "FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./match/spec/storage/s3_storage_spec.rb --no-color --format json | tail -n +2 | jq -r '.examples[] | \"\\(.description) - \\(.id) - \\(.status)\"'",
      install: "bundle install --jobs=$(nproc)",
    },
    "21857": {
      testCmd:
        "FASTLANE_SKIP_UPDATE_CHECK=1 bundle exec rspec ./fastlane/spec/lane_manager_base_spec.rb --no-color --format json | tail -n +2 | jq -r '.examples[] | \"\\(.description) - \\(.id) - \\(.status)\"'",
      install: "bundle install --jobs=$(nproc)",
    },
  },
  "fluent/fluentd": {
    "3328": {
      testCmd:
        "bundle exec ruby test/plugin/test_in_tail.rb -v -n '/test_ENOENT_error_after_setup_watcher/'",
      install: "bundle install",
    },
    "3466": {
      testCmd:
        "bundle exec ruby test/plugin/test_in_tail.rb -v -n '/test_should_replace_target_info/'",
      install: "bundle install",
    },
    "3608": {
      testCmd:
        "bundle exec ruby test/plugin/test_output_as_buffered_retries.rb -v -n '/retry_max_times/'",
      install: "bundle install",
    },
    "3616": {
      testCmd: "bundle exec ruby test/plugin/test_in_http.rb -v -n '/test_application/'",
      install: "bundle install",
    },
    "3631": {
      testCmd: "bundle exec ruby test/test_event_router.rb -v -n '/handle_emits_error/'",
      install: "bundle install",
    },
    "3640": {
      testCmd:
        "bundle exec ruby test/plugin_helper/test_retry_state.rb -v -n '/exponential backoff/'",
      install: "bundle install",
    },
    "3641": { testCmd: "bundle exec ruby test/test_supervisor.rb -v", install: "bundle install" },
    "3917": { testCmd: "bundle exec ruby test/test_config.rb -v", install: "bundle install" },
    "4030": {
      testCmd: "bundle exec ruby test/plugin/out_forward/test_ack_handler.rb -v",
      install: "bundle install",
    },
    "4311": {
      testCmd: "bundle exec ruby test/config/test_system_config.rb -v -n '/rotate_age/'",
      install: "bundle install",
    },
    "4598": {
      testCmd: "bundle exec ruby test/plugin_helper/test_http_server_helper.rb -v -n '/mount/'",
      install: "bundle install",
      preInstall: ["echo \"gem 'console', '1.29'\" >> Gemfile"],
    },
    "4655": {
      testCmd: "bundle exec ruby test/plugin/test_in_http.rb -v -n '/test_add/'",
      install: "bundle install",
    },
  },
  "fmtlib/fmt": {
    "1683": { testCmd: "ctest --test-dir build -V -R printf-test" },
    "2310": { testCmd: "ctest --test-dir build -V -R format-test" },
    "2317": { testCmd: "ctest --test-dir build -V -R format-test" },
    "2457": { testCmd: "ctest --test-dir build -V -R ranges-test" },
    "3158": { testCmd: "ctest --test-dir build -V -R ranges-test" },
    "3248": { testCmd: "ctest --test-dir build -V -R format-test" },
    "3272": { testCmd: "ctest --test-dir build -V -R xchar-test" },
    "3729": { testCmd: "ctest --test-dir build -V -R std-test" },
    "3750": { testCmd: "ctest --test-dir build -V -R format-test" },
    "3863": { testCmd: "ctest --test-dir build -V -R ranges-test" },
    "3901": { testCmd: "ctest --test-dir build -V -R format-test" },
  },
  "gin-gonic/gin": {
    "1805": { testCmd: 'go test -v . -run "^Test.*Router"', install: "go test -c ." },
    "1957": { testCmd: 'go test -v . -run "^TestContext.*Bind"', install: "go test -c ." },
    "2121": { testCmd: 'go test -v ./... -run "^Test.*Reader"', install: "go test -c ./..." },
    "2755": { testCmd: 'go test -v . -run "^TestTree"', install: "go test -c ." },
    "3227": { testCmd: 'go test -v . -run "^TestRedirect"', install: "go test -c ." },
    "3741": { testCmd: 'go test -v . -run "^TestColor"', install: "go test -c ." },
    "3820": {
      testCmd: 'go test -v ./binding -run "^TestMapping"',
      install: "go test -c ./binding",
    },
    "4003": { testCmd: 'go test . -v -run "TestMethodNotAllowedNoRoute"', install: "go test -c ." },
  },
  "gohugoio/hugo": {
    "12171": {
      testCmd: 'go test -v ./hugolib -run "^Test.*Pages"',
      install: "go test -c ./hugolib",
    },
    "12204": {
      testCmd: 'go test -v ./tpl/tplimpl -run "^TestEmbedded"',
      install: "go test -c ./tpl/tplimpl",
    },
    "12343": {
      testCmd: 'go test -v ./resources/page/... -run "^Test.*Permalink"',
      install: "go test -c ./resources/page/...",
    },
    "12448": {
      testCmd: 'go test -v ./hugolib/... -run "^TestRebuild"',
      install: "go test -c ./hugolib/...",
    },
    "12562": {
      testCmd: 'go test -v ./hugolib/... -run "^TestGetPage[^/]"',
      install: "go test -c ./hugolib/...",
    },
    "12579": {
      testCmd: 'go test -v ./resources/page -run "^TestGroupBy"',
      install: "go test -c ./resources/page",
    },
    "12768": {
      testCmd: "go test -v ./markup/goldmark/blockquotes/...",
      install: "go test -c ./markup/goldmark/blockquotes/...",
    },
  },
  "google/gson": {
    "1014": {
      testCmd:
        "mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.internal.bind.JsonTreeReaderTest#testSkipValue_emptyJsonObject && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.internal.bind.JsonTreeReaderTest#testSkipValue_filledJsonObject",
      install: "mvn clean install -B -pl gson -DskipTests -am",
    },
    "1093": {
      testCmd:
        "mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.stream.JsonWriterTest#testNonFiniteDoublesWhenLenient && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.stream.JsonWriterTest#testNonFiniteBoxedDoublesWhenLenient && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.stream.JsonWriterTest#testNonFiniteDoubles && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.stream.JsonWriterTest#testNonFiniteBoxedDoubles && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.stream.JsonWriterTest#testDoubles",
      install: "mvn clean install -B -pl gson -DskipTests -am",
    },
    "1100": {
      testCmd:
        "mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.DefaultDateTypeAdapterTest#testNullValue && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.DefaultDateTypeAdapterTest#testDatePattern && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.DefaultDateTypeAdapterTest#testInvalidDatePattern",
      install: "mvn clean install -B -pl gson -DskipTests -am",
    },
    "2024": {
      testCmd:
        "mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.FieldNamingTest#testUpperCaseWithUnderscores && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.NamingPolicyTest#testGsonWithUpperCaseUnderscorePolicySerialization && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.NamingPolicyTest#testGsonWithUpperCaseUnderscorePolicyDeserialiation",
      install: "mvn clean install -B -pl gson -DskipTests -am",
    },
    "2061": {
      testCmd:
        "mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.stream.JsonReaderTest#testHasNextEndOfDocument && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.internal.bind.JsonTreeReaderTest#testHasNext_endOfDocument && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.stream.JsonReaderTest#testReadEmptyObject && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.stream.JsonReaderTest#testReadEmptyArray && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.internal.bind.JsonTreeReaderTest#testSkipValue_emptyJsonObject && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.internal.bind.JsonTreeReaderTest#testSkipValue_filledJsonObject",
      install: "mvn clean install -B -pl gson -DskipTests -am",
    },
    "2134": {
      testCmd:
        "mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.internal.bind.util.ISO8601UtilsTest#testDateParseInvalidDay && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.internal.bind.util.ISO8601UtilsTest#testDateParseInvalidMonth && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.internal.bind.util.ISO8601UtilsTest#testDateParseWithDefaultTimezone",
      install: "mvn clean install -B -pl gson -DskipTests -am",
    },
    "2158": {
      testCmd:
        "mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testByteSerialization && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testShortSerialization && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testIntSerialization && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testLongSerialization && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testFloatSerialization && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testDoubleSerialization && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testPrimitiveIntegerAutoboxedSerialization && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testPrimitiveIntegerAutoboxedInASingleElementArraySerialization && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testReallyLongValuesSerialization && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.functional.PrimitiveTest#testPrimitiveLongAutoboxedSerialization",
      install: "mvn clean install -B -pl gson -DskipTests -am",
    },
    "2311": {
      testCmd:
        "mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.JsonPrimitiveTest#testEqualsIntegerAndBigInteger && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.JsonPrimitiveTest#testLongEqualsBigInteger && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.JsonPrimitiveTest#testEqualsAcrossTypes",
      install: "mvn clean install -B -pl gson -DskipTests -am",
    },
    "2479": {
      testCmd:
        "mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.GsonBuilderTest#testRegisterTypeAdapterForObjectAndJsonElements && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.GsonBuilderTest#testRegisterTypeHierarchyAdapterJsonElements && mvnd test -B -T 1C -pl gson -Dtest=com.google.gson.GsonBuilderTest#testModificationAfterCreate",
      install: "mvn clean install -B -pl gson -DskipTests -am",
    },
  },
  "hashicorp/terraform": {
    "34580": {
      testCmd: 'go test -v ./internal/command -run "^TestFmt"',
      install: "go test -c ./internal/command",
    },
    "34814": {
      testCmd: "go test -v ./internal/builtin/provisioners/remote-exec",
      install: "go test -c ./internal/builtin/provisioners/remote-exec",
    },
    "34900": {
      testCmd:
        'go test -v ./internal/terraform -run "(^TestContext2Apply|^TestContext2Plan).*[Ss]ensitive"',
      install: "go test -c ./internal/terraform",
    },
    "35543": {
      testCmd: 'go test -v ./internal/terraform -run "^TestContext2Plan_import"',
      install: "go test -c ./internal/terraform",
    },
    "35611": {
      testCmd: 'go test -v ./internal/terraform -run "^TestContext2Apply_provisioner"',
      install: "go test -c ./internal/terraform",
    },
  },
  "immutable-js/immutable-js": {
    "2005": {
      testCmd:
        'npx jest __tests__/OrderedMap.ts __tests__/OrderedSet.ts --silent --json | jq -r \'.testResults[].assertionResults[] | "[" + (.status | ascii_upcase) + "] " + ((.ancestorTitles | join(" > ")) + (if .ancestorTitles | length > 0 then " > " else "" end) + .title)\'',
      install: "npm install",
    },
    "2006": { testCmd: "npx jest __tests__/Range.ts --verbose", install: "npm install" },
  },
  "javaparser/javaparser": {
    "4538": {
      testCmd:
        "./mvnw test -B -pl javaparser-core-testing -Dtest=NodeTest && ./mvnw test -B -pl javaparser-core-testing -Dtest=NodePositionTest",
    },
    "4561": {
      testCmd:
        "./mvnw test -B -pl javaparser-symbol-solver-testing -Dtest=Issue4560Test && ./mvnw test -B -pl javaparser-symbol-solver-testing -Dtest=JavaSymbolSolverTest",
    },
  },
  "jekyll/jekyll": {
    "8047": {
      testCmd: 'bundle exec ruby -I test test/test_filters.rb -v -n "/where_exp filter/"',
      install: "script/bootstrap && bundle add webrick",
      preInstall: ["sed -i '/^[[:space:]]*install_if.*mingw/,/^[[:space:]]*end/d' Gemfile"],
    },
    "8167": {
      testCmd: 'bundle exec ruby -I test test/test_utils.rb -v -n "/Utils.slugify/"',
      install: "script/bootstrap && bundle add webrick",
    },
    "8761": {
      testCmd:
        "bundle exec cucumber --publish-quiet --format progress --no-color features/post_data.feature:6 features/post_data.feature:30",
      install: "script/bootstrap",
    },
    "8771": {
      testCmd:
        "bundle exec cucumber --publish-quiet --format progress --no-color features/incremental_rebuild.feature:27 features/incremental_rebuild.feature:70",
      install: "script/bootstrap",
    },
    "9141": {
      testCmd: 'bundle exec ruby -I test test/test_site.rb -v -n "/static files/"',
      install: "script/bootstrap",
    },
  },
  "jordansissel/fpm": {
    "1829": {
      testCmd:
        "bundle exec rspec spec/fpm/package/deb_spec.rb --no-color --format json | sed -n '/^{/,$p' | jq -r '.examples[] | \"\\(.description) - \\(.status)\"'",
      install: "bundle install",
    },
    "1850": {
      testCmd:
        "bundle exec rspec spec/fpm/package/empty_spec.rb --no-color --format json | sed -n '/^{/,$p' | jq -r '.examples[] | \"\\(.description) - \\(.status)\"'",
      install: "bundle install",
    },
  },
  "jqlang/jq": {
    "2235": { testCmd: "make check" },
    "2598": { testCmd: "make check" },
    "2650": { testCmd: "make check" },
    "2658": { testCmd: "make check" },
    "2681": { testCmd: "make check" },
    "2728": { testCmd: "make check" },
    "2750": { testCmd: "make check" },
    "2839": { testCmd: "make check" },
    "2919": { testCmd: "make check" },
  },
  "laravel/framework": {
    "46234": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Routing/RoutingUrlGeneratorTest.php",
      install: "composer require laravel/prompts --no-update && composer install",
    },
    "48573": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/Cache/CacheArrayStoreTest.php",
      install: "composer require laravel/prompts --no-update && composer install",
    },
    "48636": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Database/DatabaseEloquentModelTest.php",
      install: "composer require laravel/prompts --no-update && composer install",
    },
    "51195": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/View/Blade/BladeVerbatimTest.php",
      install:
        "composer require laravel/prompts --no-update && composer require orchestra/testbench-core --no-update && composer install",
    },
    "51890": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Validation/ValidationValidatorTest.php --filter 'attribute'",
      install:
        "composer require laravel/prompts --no-update && composer require orchestra/testbench-core --no-update && composer install",
    },
    "52451": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Validation/ValidationValidatorTest.php --filter 'custom'",
      install:
        "composer require laravel/prompts --no-update && composer require orchestra/testbench-core --no-update && composer install",
    },
    "52680": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Database/DatabaseEloquentInverseRelationTest.php",
      install:
        "composer require laravel/prompts --no-update && composer require orchestra/testbench-core --no-update && composer install",
    },
    "52684": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/Support/SupportStrTest.php",
      install:
        "composer require laravel/prompts --no-update && composer require orchestra/testbench-core --no-update && composer install",
    },
    "52866": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Container/ContextualAttributeBindingTest.php",
      install:
        "composer require laravel/prompts --no-update && composer require orchestra/testbench-core --no-update && composer install",
    },
    "53206": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/Support/SupportJsTest.php",
      install: "composer require orchestra/testbench-core --no-update && composer install",
    },
    "53696": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Database/DatabaseSchemaBlueprintTest.php",
      install: "composer require orchestra/testbench-core --no-update && composer install",
    },
    "53914": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Integration/Database/DatabaseConnectionsTest.php",
      install: "composer require orchestra/testbench-core --no-update && composer install",
    },
    "53949": {
      testCmd: "vendor/bin/phpunit --testdox --colors=never tests/Support/OnceTest.php",
      install: "composer require orchestra/testbench-core --no-update && composer install",
    },
  },
  "markedjs/marked": {
    "0.3": {
      testCmd: "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
      install: "npm install",
    },
    "0.5": {
      testCmd: "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
      install: "npm install",
    },
    "0.6": {
      testCmd: "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
      install: "npm install",
    },
    "0.7": {
      testCmd: "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
      install: "npm install",
    },
    "1.0": {
      testCmd: "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
      install: "npm install",
    },
    "1.1": {
      testCmd: "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
      install: "npm install",
    },
    "1.2": {
      testCmd: "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
      install: "npm install",
    },
    "2.0": {
      testCmd: "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
      install: "npm install",
    },
    "3.9": {
      testCmd: "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
      install: "npm install",
    },
    "4.0": {
      testCmd: "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
      install: "npm install",
    },
    "4.1": {
      testCmd: "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
      install: "npm install",
    },
    "5.0": {
      testCmd: "./node_modules/.bin/jasmine --no-color --config=jasmine.json",
      install: "npm install",
    },
  },
  "marshmallow-code/marshmallow": {
    "2.18": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "2.19": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "2.20": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.0": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.1": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.10": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.11": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.12": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.13": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.15": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.16": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.19": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.2": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.4": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.8": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
    "3.9": { testCmd: "pytest -rA", install: "python -m pip install -e '.[dev]'" },
  },
  "matplotlib/matplotlib": {
    "1.0": {
      testCmd: "pytest -rA",
      install: "python setup.py build; python setup.py install",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && && apt-get install -y imagemagick ffmpeg",
      ],
      pipPackages: ["pytest"],
    },
    "1.1": {
      testCmd: "pytest -rA",
      install: "python setup.py build; python setup.py install",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && && apt-get install -y imagemagick ffmpeg",
      ],
      pipPackages: ["pytest"],
    },
    "1.2": {
      testCmd: "pytest -rA",
      install: "python setup.py build; python setup.py install",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && && apt-get install -y imagemagick ffmpeg",
      ],
      pipPackages: ["pytest"],
    },
    "1.3": {
      testCmd: "pytest -rA",
      install: "python setup.py build; python setup.py install",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && && apt-get install -y imagemagick ffmpeg",
      ],
      pipPackages: ["pytest"],
    },
    "1.4": {
      testCmd: "pytest -rA",
      install: "python setup.py build; python setup.py install",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && && apt-get install -y imagemagick ffmpeg",
      ],
      pipPackages: ["pytest"],
    },
    "1.5": {
      testCmd: "pytest -rA",
      install: "python setup.py build; python setup.py install",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && && apt-get install -y imagemagick ffmpeg",
      ],
      pipPackages: ["pytest"],
    },
    "2.0": {
      testCmd: "pytest -rA",
      install: "python setup.py build; python setup.py install",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && && apt-get install -y imagemagick ffmpeg",
      ],
      pipPackages: ["pytest"],
    },
    "2.1": {
      testCmd: "pytest -rA",
      install: "python setup.py build; python setup.py install",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && && apt-get install -y imagemagick ffmpeg",
      ],
      pipPackages: ["pytest"],
    },
    "2.2": {
      testCmd: "pytest -rA",
      install: "python setup.py build; python setup.py install",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && && apt-get install -y imagemagick ffmpeg",
      ],
      pipPackages: ["pytest"],
    },
    "3.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && apt-get install -y imagemagick ffmpeg libfreetype6-dev pkg-config",
        'QHULL_URL="http://www.qhull.org/download/qhull-2020-src-8.0.2.tgz"',
        'QHULL_TAR="/tmp/qhull-2020-src-8.0.2.tgz"',
        'QHULL_BUILD_DIR="/testbed/build"',
        'wget -O "$QHULL_TAR" "$QHULL_URL"',
        'mkdir -p "$QHULL_BUILD_DIR"',
        'tar -xvzf "$QHULL_TAR" -C "$QHULL_BUILD_DIR"',
      ],
      pipPackages: ["pytest"],
    },
    "3.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && DEBIAN_FRONTEND=noninteractive apt-get install -y imagemagick ffmpeg libfreetype6-dev pkg-config texlive texlive-latex-extra texlive-fonts-recommended texlive-xetex texlive-luatex cm-super",
        'QHULL_URL="http://www.qhull.org/download/qhull-2020-src-8.0.2.tgz"',
        'QHULL_TAR="/tmp/qhull-2020-src-8.0.2.tgz"',
        'QHULL_BUILD_DIR="/testbed/build"',
        'wget -O "$QHULL_TAR" "$QHULL_URL"',
        'mkdir -p "$QHULL_BUILD_DIR"',
        'tar -xvzf "$QHULL_TAR" -C "$QHULL_BUILD_DIR"',
      ],
      pipPackages: ["pytest", "ipython"],
    },
    "3.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && DEBIAN_FRONTEND=noninteractive apt-get install -y imagemagick ffmpeg libfreetype6-dev pkg-config texlive texlive-latex-extra texlive-fonts-recommended texlive-xetex texlive-luatex cm-super",
        'QHULL_URL="http://www.qhull.org/download/qhull-2020-src-8.0.2.tgz"',
        'QHULL_TAR="/tmp/qhull-2020-src-8.0.2.tgz"',
        'QHULL_BUILD_DIR="/testbed/build"',
        'wget -O "$QHULL_TAR" "$QHULL_URL"',
        'mkdir -p "$QHULL_BUILD_DIR"',
        'tar -xvzf "$QHULL_TAR" -C "$QHULL_BUILD_DIR"',
      ],
      pipPackages: ["pytest", "ipython"],
    },
    "3.3": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && DEBIAN_FRONTEND=noninteractive apt-get install -y imagemagick ffmpeg libfreetype6-dev pkg-config texlive texlive-latex-extra texlive-fonts-recommended texlive-xetex texlive-luatex cm-super",
        'QHULL_URL="http://www.qhull.org/download/qhull-2020-src-8.0.2.tgz"',
        'QHULL_TAR="/tmp/qhull-2020-src-8.0.2.tgz"',
        'QHULL_BUILD_DIR="/testbed/build"',
        'wget -O "$QHULL_TAR" "$QHULL_URL"',
        'mkdir -p "$QHULL_BUILD_DIR"',
        'tar -xvzf "$QHULL_TAR" -C "$QHULL_BUILD_DIR"',
      ],
      pipPackages: ["pytest", "ipython"],
    },
    "3.4": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && DEBIAN_FRONTEND=noninteractive apt-get install -y imagemagick ffmpeg libfreetype6-dev pkg-config texlive texlive-latex-extra texlive-fonts-recommended texlive-xetex texlive-luatex cm-super",
        'QHULL_URL="http://www.qhull.org/download/qhull-2020-src-8.0.2.tgz"',
        'QHULL_TAR="/tmp/qhull-2020-src-8.0.2.tgz"',
        'QHULL_BUILD_DIR="/testbed/build"',
        'wget -O "$QHULL_TAR" "$QHULL_URL"',
        'mkdir -p "$QHULL_BUILD_DIR"',
        'tar -xvzf "$QHULL_TAR" -C "$QHULL_BUILD_DIR"',
      ],
      pipPackages: ["pytest", "ipython"],
    },
    "3.5": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && DEBIAN_FRONTEND=noninteractive apt-get install -y imagemagick ffmpeg texlive texlive-latex-extra texlive-fonts-recommended texlive-xetex texlive-luatex cm-super dvipng",
        'QHULL_URL="http://www.qhull.org/download/qhull-2020-src-8.0.2.tgz"',
        'QHULL_TAR="/tmp/qhull-2020-src-8.0.2.tgz"',
        'QHULL_BUILD_DIR="/testbed/build"',
        'wget -O "$QHULL_TAR" "$QHULL_URL"',
        'mkdir -p "$QHULL_BUILD_DIR"',
        'tar -xvzf "$QHULL_TAR" -C "$QHULL_BUILD_DIR"',
      ],
      pipPackages: [
        "contourpy==1.1.0",
        "cycler==0.11.0",
        "fonttools==4.42.1",
        "ghostscript",
        "kiwisolver==1.4.5",
        "numpy==1.25.2",
        "packaging==23.1",
        "pillow==10.0.0",
        "pikepdf",
        "pyparsing==3.0.9",
        "python-dateutil==2.8.2",
        "six==1.16.0",
        "setuptools==68.1.2",
        "setuptools-scm==7.1.0",
        "typing-extensions==4.7.1",
      ],
    },
    "3.6": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && DEBIAN_FRONTEND=noninteractive apt-get install -y imagemagick ffmpeg texlive texlive-latex-extra texlive-fonts-recommended texlive-xetex texlive-luatex cm-super dvipng",
        'QHULL_URL="http://www.qhull.org/download/qhull-2020-src-8.0.2.tgz"',
        'QHULL_TAR="/tmp/qhull-2020-src-8.0.2.tgz"',
        'QHULL_BUILD_DIR="/testbed/build"',
        'wget -O "$QHULL_TAR" "$QHULL_URL"',
        'mkdir -p "$QHULL_BUILD_DIR"',
        'tar -xvzf "$QHULL_TAR" -C "$QHULL_BUILD_DIR"',
      ],
      pipPackages: [
        "contourpy==1.1.0",
        "cycler==0.11.0",
        "fonttools==4.42.1",
        "ghostscript",
        "kiwisolver==1.4.5",
        "numpy==1.25.2",
        "packaging==23.1",
        "pillow==10.0.0",
        "pikepdf",
        "pyparsing==3.0.9",
        "python-dateutil==2.8.2",
        "six==1.16.0",
        "setuptools==68.1.2",
        "setuptools-scm==7.1.0",
        "typing-extensions==4.7.1",
      ],
    },
    "3.7": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && DEBIAN_FRONTEND=noninteractive apt-get install -y imagemagick ffmpeg texlive texlive-latex-extra texlive-fonts-recommended texlive-xetex texlive-luatex cm-super dvipng",
        'QHULL_URL="http://www.qhull.org/download/qhull-2020-src-8.0.2.tgz"',
        'QHULL_TAR="/tmp/qhull-2020-src-8.0.2.tgz"',
        'QHULL_BUILD_DIR="/testbed/build"',
        'wget -O "$QHULL_TAR" "$QHULL_URL"',
        'mkdir -p "$QHULL_BUILD_DIR"',
        'tar -xvzf "$QHULL_TAR" -C "$QHULL_BUILD_DIR"',
      ],
      pipPackages: [
        "contourpy==1.1.0",
        "cycler==0.11.0",
        "fonttools==4.42.1",
        "ghostscript",
        "kiwisolver==1.4.5",
        "numpy==1.25.2",
        "packaging==23.1",
        "pillow==10.0.0",
        "pikepdf",
        "pyparsing==3.0.9",
        "python-dateutil==2.8.2",
        "six==1.16.0",
        "setuptools==68.1.2",
        "setuptools-scm==7.1.0",
        "typing-extensions==4.7.1",
      ],
    },
    "3.8": {
      testCmd: "pytest -rA",
      install: 'python -m pip install --no-build-isolation -e ".[dev]"',
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && DEBIAN_FRONTEND=noninteractive apt-get install -y imagemagick ffmpeg texlive texlive-latex-extra texlive-fonts-recommended texlive-xetex texlive-luatex cm-super dvipng",
        'QHULL_URL="http://www.qhull.org/download/qhull-2020-src-8.0.2.tgz"',
        'QHULL_TAR="/tmp/qhull-2020-src-8.0.2.tgz"',
        'QHULL_BUILD_DIR="/testbed/build"',
        'wget -O "$QHULL_TAR" "$QHULL_URL"',
        'mkdir -p "$QHULL_BUILD_DIR"',
        'tar -xvzf "$QHULL_TAR" -C "$QHULL_BUILD_DIR"',
      ],
      pipPackages: [
        "contourpy==1.1.0",
        "cycler==0.11.0",
        "fonttools==4.42.1",
        "ghostscript",
        "kiwisolver==1.4.5",
        "numpy==1.25.2",
        "packaging==23.1",
        "pillow==10.0.0",
        "pikepdf",
        "pyparsing==3.0.9",
        "python-dateutil==2.8.2",
        "six==1.16.0",
        "setuptools==68.1.2",
        "setuptools-scm==7.1.0",
        "typing-extensions==4.7.1",
      ],
    },
    "3.9": {
      testCmd: "pytest -rA",
      install: 'python -m pip install --no-build-isolation -e ".[dev]"',
      preInstall: [
        "apt-get -y update && apt-get -y upgrade && DEBIAN_FRONTEND=noninteractive apt-get install -y imagemagick ffmpeg texlive texlive-latex-extra texlive-fonts-recommended texlive-xetex texlive-luatex cm-super dvipng",
        'QHULL_URL="http://www.qhull.org/download/qhull-2020-src-8.0.2.tgz"',
        'QHULL_TAR="/tmp/qhull-2020-src-8.0.2.tgz"',
        'QHULL_BUILD_DIR="/testbed/build"',
        'wget -O "$QHULL_TAR" "$QHULL_URL"',
        'mkdir -p "$QHULL_BUILD_DIR"',
        'tar -xvzf "$QHULL_TAR" -C "$QHULL_BUILD_DIR"',
      ],
      pipPackages: [
        "contourpy==1.1.0",
        "cycler==0.11.0",
        "fonttools==4.42.1",
        "ghostscript",
        "kiwisolver==1.4.5",
        "numpy==1.25.2",
        "packaging==23.1",
        "pillow==10.0.0",
        "pikepdf",
        "pyparsing==3.0.9",
        "python-dateutil==2.8.2",
        "six==1.16.0",
        "setuptools==68.1.2",
        "setuptools-scm==7.1.0",
        "typing-extensions==4.7.1",
      ],
    },
  },
  "micropython/micropython": {
    "10095": {
      testCmd:
        "cd tests && MICROPY_CPYTHON3=python3 MICROPY_MICROPYTHON=../ports/unix/build-standard/micropython ./run-tests.py -i basics/fun",
      preInstall: [
        "python -m venv .venv",
        "source .venv/bin/activate",
        "sed -i 's/uint mp_import_stat/mp_import_stat_t mp_import_stat/' mpy-cross/main.c",
      ],
    },
    "12158": {
      testCmd:
        "cd tests && MICROPY_CPYTHON3=python3 MICROPY_MICROPYTHON=../ports/unix/build-standard/micropython ./run-tests.py -d thread",
      preInstall: ["python -m venv .venv", "source .venv/bin/activate"],
    },
    "13039": {
      testCmd:
        "cd tests && MICROPY_CPYTHON3=python3 MICROPY_MICROPYTHON=../ports/unix/build-standard/micropython ./run-tests.py -i slice",
      preInstall: ["python -m venv .venv", "source .venv/bin/activate"],
    },
    "13569": {
      testCmd:
        "cd tests && MICROPY_CPYTHON3=python3 MICROPY_MICROPYTHON=../ports/unix/build-standard/micropython ./run-tests.py -i try",
      preInstall: ["python -m venv .venv", "source .venv/bin/activate"],
    },
    "15898": {
      testCmd:
        "cd tests && MICROPY_CPYTHON3=python3 MICROPY_MICROPYTHON=../ports/unix/build-standard/micropython ./run-tests.py -i string_format",
      preInstall: ["python -m venv .venv", "source .venv/bin/activate"],
    },
  },
  "mrdoob/three.js": {
    "25687": {
      testCmd: 'npx qunit test/unit/src/core/Object3D.tests.js -f "/json|clone|copy/i"',
      install: "npm install --ignore-scripts",
    },
    "26589": {
      testCmd:
        "npx qunit test/unit/src/objects/Line.tests.js test/unit/src/objects/Mesh.tests.js test/unit/src/objects/Points.tests.js",
      install: "npm install --ignore-scripts",
    },
    "27395": {
      testCmd: "npx qunit test/unit/src/math/Sphere.tests.js",
      install: "npm install --ignore-scripts",
    },
  },
  "mwaskom/seaborn": {
    "0.11": {
      testCmd: "pytest --no-header -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "contourpy==1.1.0",
        "cycler==0.11.0",
        "fonttools==4.42.1",
        "importlib-resources==6.0.1",
        "kiwisolver==1.4.5",
        "matplotlib==3.7.2",
        "numpy==1.25.2",
        "packaging==23.1",
        "pandas==1.3.5",
        "pillow==10.0.0",
        "pyparsing==3.0.9",
        "pytest",
        "python-dateutil==2.8.2",
        "pytz==2023.3.post1",
        "scipy==1.11.2",
        "six==1.16.0",
        "tzdata==2023.1",
        "zipp==3.16.2",
      ],
    },
    "0.12": {
      testCmd: "pytest --no-header -rA",
      install: "python -m pip install -e .[dev]",
      pipPackages: [
        "contourpy==1.1.0",
        "cycler==0.11.0",
        "fonttools==4.42.1",
        "importlib-resources==6.0.1",
        "kiwisolver==1.4.5",
        "matplotlib==3.7.2",
        "numpy==1.25.2",
        "packaging==23.1",
        "pandas==2.0.0",
        "pillow==10.0.0",
        "pyparsing==3.0.9",
        "pytest",
        "python-dateutil==2.8.2",
        "pytz==2023.3.post1",
        "scipy==1.11.2",
        "six==1.16.0",
        "tzdata==2023.1",
        "zipp==3.16.2",
      ],
    },
    "0.13": {
      testCmd: "pytest --no-header -rA",
      install: "python -m pip install -e .[dev]",
      pipPackages: [
        "contourpy==1.1.0",
        "cycler==0.11.0",
        "fonttools==4.42.1",
        "importlib-resources==6.0.1",
        "kiwisolver==1.4.5",
        "matplotlib==3.7.2",
        "numpy==1.25.2",
        "packaging==23.1",
        "pandas==2.0.0",
        "pillow==10.0.0",
        "pyparsing==3.0.9",
        "pytest",
        "python-dateutil==2.8.2",
        "pytz==2023.3.post1",
        "scipy==1.11.2",
        "six==1.16.0",
        "tzdata==2023.1",
        "zipp==3.16.2",
      ],
    },
    "0.14": {
      testCmd: "pytest --no-header -rA",
      install: "python -m pip install -e .[dev]",
      pipPackages: [
        "contourpy==1.1.0",
        "cycler==0.11.0",
        "fonttools==4.42.1",
        "importlib-resources==6.0.1",
        "kiwisolver==1.4.5",
        "matplotlib==3.7.2",
        "numpy==1.25.2",
        "packaging==23.1",
        "pandas==2.0.0",
        "pillow==10.0.0",
        "pyparsing==3.0.9",
        "pytest",
        "python-dateutil==2.8.2",
        "pytz==2023.3.post1",
        "scipy==1.11.2",
        "six==1.16.0",
        "tzdata==2023.1",
        "zipp==3.16.2",
      ],
    },
  },
  "nlohmann/json": {
    "4237": { testCmd: "./build/tests/test-udt_cpp11 -s -r=xml" },
  },
  "nushell/nushell": {
    "12901": {
      testCmd: "cargo test --no-fail-fast shell::env",
      install: "cargo test --no-run shell::env",
    },
    "12950": {
      testCmd: "cargo test external_arguments --no-fail-fast",
      install: "cargo test external_arguments --no-run",
    },
    "13246": {
      testCmd: "cargo test -p nu-command --no-fail-fast --test main find::",
      install: "cargo test -p nu-command --no-run --test main find::",
    },
    "13605": {
      testCmd: "cargo test -p nu-command --no-fail-fast ls::",
      install: "cargo test -p nu-command --no-run ls::",
    },
    "13831": {
      testCmd: "cargo test -p nu-command --no-fail-fast split_column",
      install: "cargo test -p nu-command --no-run split_column",
    },
  },
  "pallets/flask": {
    "2.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "setuptools==70.0.0",
        "Werkzeug==2.3.7",
        "Jinja2==3.0.1",
        "itsdangerous==2.1.2",
        "click==8.0.1",
        "MarkupSafe==2.1.3",
      ],
    },
    "2.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "setuptools==70.0.0",
        "click==8.1.3",
        "itsdangerous==2.1.2",
        "Jinja2==3.1.2",
        "MarkupSafe==2.1.1",
        "Werkzeug==2.3.7",
      ],
    },
    "2.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "setuptools==70.0.0",
        "click==8.1.3",
        "itsdangerous==2.1.2",
        "Jinja2==3.1.2",
        "MarkupSafe==2.1.1",
        "Werkzeug==2.3.7",
      ],
    },
    "2.3": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "setuptools==70.0.0",
        "click==8.1.3",
        "itsdangerous==2.1.2",
        "Jinja2==3.1.2",
        "MarkupSafe==2.1.1",
        "Werkzeug==2.3.7",
      ],
    },
    "3.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "setuptools==70.0.0",
        "click==8.1.3",
        "itsdangerous==2.1.2",
        "Jinja2==3.1.2",
        "MarkupSafe==2.1.1",
        "Werkzeug==2.3.7",
      ],
    },
    "3.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "setuptools==70.0.0",
        "click==8.1.3",
        "itsdangerous==2.1.2",
        "Jinja2==3.1.2",
        "MarkupSafe==2.1.1",
        "Werkzeug==2.3.7",
      ],
    },
  },
  "php-cs-fixer/php-cs-fixer": {
    "7523": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Fixer/Operator/BinaryOperatorSpacesFixerTest.php",
      install: "composer update && composer install",
    },
    "7635": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Fixer/Import/FullyQualifiedStrictTypesFixerTest.php",
      install: "composer update && composer install",
    },
    "7663": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Fixer/Whitespace/StatementIndentationFixerTest.php",
      install: "composer update && composer install",
    },
    "7875": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Fixer/Whitespace/StatementIndentationFixerTest.php",
      install: "composer update && composer install",
    },
    "7998": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Fixer/Casing/ConstantCaseFixerTest.php",
      install: "composer update && composer install",
    },
    "8064": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Fixer/StringNotation/SimpleToComplexStringVariableFixerTest.php",
      install: "composer update && composer install",
    },
    "8075": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Fixer/PhpUnit/PhpUnitAttributesFixerTest.php",
      install: "composer update && composer install",
    },
    "8256": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Fixer/PhpTag/BlankLineAfterOpeningTagFixerTest.php",
      install: "composer update && composer install",
    },
    "8331": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Fixer/LanguageConstruct/NullableTypeDeclarationFixerTest.php",
      install: "composer update && composer install",
    },
    "8367": {
      testCmd:
        "vendor/bin/phpunit --testdox --colors=never tests/Fixer/Import/FullyQualifiedStrictTypesFixerTest.php",
      install: "composer update && composer install",
    },
  },
  "phpoffice/phpspreadsheet": {
    "3463": {
      testCmd:
        "./vendor/bin/phpunit --testdox --colors=never tests/PhpSpreadsheetTests/Writer/Xlsx/FunctionPrefixTest.php",
      install: "composer update && composer install",
    },
    "3469": {
      testCmd:
        "./vendor/bin/phpunit --testdox --colors=never tests/PhpSpreadsheetTests/Style/StyleTest.php",
      install: "composer update && composer install",
    },
    "3570": {
      testCmd:
        "./vendor/bin/phpunit --testdox --colors=never tests/PhpSpreadsheetTests/Calculation/Functions/LookupRef/VLookupTest.php",
      install: "composer update && composer install",
    },
    "3659": {
      testCmd:
        "./vendor/bin/phpunit --testdox --colors=never tests/PhpSpreadsheetTests/Worksheet/Table/Issue3635Test.php",
      install: "composer update && composer install",
    },
    "3903": {
      testCmd:
        "./vendor/bin/phpunit --testdox --colors=never tests/PhpSpreadsheetTests/Shared/StringHelperTest.php",
      install: "composer update && composer install",
    },
    "3940": {
      testCmd:
        "./vendor/bin/phpunit --testdox --colors=never tests/PhpSpreadsheetTests/Worksheet/WorksheetTest.php",
      install: "composer update && composer install",
    },
    "4114": {
      testCmd:
        "./vendor/bin/phpunit --testdox --colors=never tests/PhpSpreadsheetTests/Worksheet/Issue4112Test.php",
      install: "composer update && composer install",
    },
    "4186": {
      testCmd:
        "./vendor/bin/phpunit --testdox --colors=never tests/PhpSpreadsheetTests/Writer/Xlsx/FunctionPrefixTest.php",
      install: "composer update && composer install",
    },
    "4214": {
      testCmd:
        "./vendor/bin/phpunit --testdox --colors=never tests/PhpSpreadsheetTests/Calculation/Functions/MathTrig/RoundDownTest.php",
      install: "composer update && composer install",
    },
    "4313": {
      testCmd:
        "./vendor/bin/phpunit --testdox --colors=never tests/PhpSpreadsheetTests/Reader/Ods/FormulaTranslatorTest.php",
      install: "composer update && composer install",
    },
  },
  "preactjs/preact": {
    "2757": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/render.test.js"',
      install: "npm install",
    },
    "2896": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="compat/test/browser/memo.test.js"',
      install: "npm install",
    },
    "2927": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/render.test.js"',
      install: "npm install",
    },
    "3010": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/render.test.js"',
      install: "npm install",
    },
    "3062": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/render.test.js"',
      install: "npm install",
    },
    "3345": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="hooks/test/browser/useEffect.test.js"',
      install: "npm install",
    },
    "3454": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/svg.test.js"',
      install: "npm install",
    },
    "3562": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="compat/test/browser/render.test.js"',
      install: "npm install",
    },
    "3567": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="hooks/test/browser/useEffect.test.js"',
      install: "npm install",
    },
    "3689": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="hooks/test/browser/errorBoundary.test.js"',
      install: "npm install",
    },
    "3739": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="hooks/test/browser/useState.test.js"',
      install: "npm install",
    },
    "3763": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/lifecycles/componentDidMount.test.js"',
      install: "npm install",
    },
    "4152": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/components.test.js"',
      install: "npm install",
    },
    "4182": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="hooks/test/browser/errorBoundary.test.js"',
      install: "npm install",
    },
    "4245": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="hooks/test/browser/useId.test.js"',
      install: "npm install",
    },
    "4316": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/events.test.js"',
      install: "npm install",
    },
    "4436": {
      testCmd:
        'COVERAGE=false BABEL_NO_MODULES=true npx karma start karma.conf.js --single-run --grep="test/browser/refs.test.js"',
      install: "npm install",
    },
  },
  "processing/p5.js": {
    "0.10": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "0.2": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "0.4": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install: "npm install && ./node_modules/.bin/grunt yui",
    },
    "0.5": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install: "npm install && ./node_modules/.bin/grunt yui",
    },
    "0.6": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install: "npm install && ./node_modules/.bin/grunt yui",
    },
    "0.7": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "0.8": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "0.9": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "1.0": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "1.1": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "1.2": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "1.3": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "1.4": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "1.5": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "1.6": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "1.7": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "1.8": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
    "1.9": {
      testCmd:
        "sed -i 's/concurrency:[[:space:]]*[0-9][0-9]*/concurrency: 1/g' Gruntfile.js\nstdbuf -o 1M ./node_modules/.bin/grunt test --quiet --force",
      install:
        "npm install && PUPPETEER_SKIP_CHROMIUM_DOWNLOAD='' node node_modules/puppeteer/install.js && ./node_modules/.bin/grunt yui",
    },
  },
  "projectlombok/lombok": {
    "2792": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3009": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3042": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3052": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3215": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3312": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3326": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3350": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3371": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3422": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3479": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3486": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3571": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3594": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3602": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.bytecode.TestPostCompiler" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3674": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
    "3697": {
      testCmd: "ant test.instance",
      preInstall: [
        '{ head -n -1 buildScripts/tests.ant.xml; echo \'<target name="test.instance" depends="test.compile, test.formatter.compile" description="Runs test cases for the swe-bench instance">\n      <junit printsummary="yes" fork="true" forkmode="once" haltonfailure="no">\n        <formatter classname="lombok.ant.SimpleTestFormatter" usefile="false" unless="tests.quiet" />\n        <classpath location="build/ant" />\n        <classpath refid="cp.test" />\n        <classpath refid="cp.stripe" />\n        <classpath refid="packing.basedirs.path" />\n        <classpath location="build/tests" />\n        <classpath location="build/teststubs" />\n        <test name="lombok.transform.TestWithDelombok" />\n      </junit>\n    </target>\'; tail -n 1 buildScripts/tests.ant.xml; } > temp_file && mv temp_file buildScripts/tests.ant.xml',
      ],
    },
  },
  "prometheus/prometheus": {
    "10633": {
      testCmd: 'go test -v ./discovery/puppetdb -run "TestPuppetDBRefreshWithParameters"',
      install: "go test -c ./discovery/puppetdb",
    },
    "10720": {
      testCmd: 'go test -v ./promql -run "^TestEvaluations"',
      install: "go test -c ./promql",
    },
    "11859": { testCmd: 'go test -v ./tsdb -run "^TestSnapshot"', install: "go test -c ./tsdb" },
    "12874": { testCmd: 'go test -v ./tsdb -run "^TestHead"', install: "go test -c ./tsdb" },
    "13845": {
      testCmd: 'go test -v ./promql ./model/labels -run "^(TestRangeQuery|TestLabels)"',
      install: "go test -c ./promql ./model/labels",
    },
    "14861": { testCmd: 'go test -v ./promql -run "^TestEngine"', install: "go test -c ./promql" },
    "15142": { testCmd: 'go test -v ./tsdb -run "^TestHead"', install: "go test -c ./tsdb" },
    "9248": {
      testCmd: 'go test -v ./promql -run "^TestEvaluations"',
      install: "go test -c ./promql",
    },
  },
  "psf/requests": {
    "0.11": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "0.13": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "0.14": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "0.7": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "0.8": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "0.9": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "1.1": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "1.2": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.0": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.10": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.11": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.12": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.17": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.18": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.19": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.2": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.22": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.25": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.26": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.27": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.3": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.31": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.4": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.5": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.7": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.8": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "2.9": { testCmd: "pytest -rA", install: "python -m pip install ." },
    "3.0": { testCmd: "pytest -rA", install: "python -m pip install ." },
  },
  "pvlib/pvlib-python": {
    "0.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[all]",
      pipPackages: ["jupyter", "ipython", "matplotlib", "pytest", "flake8"],
    },
    "0.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[all]",
      pipPackages: ["jupyter", "ipython", "matplotlib", "pytest", "flake8"],
    },
    "0.3": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[all]",
      pipPackages: ["jupyter", "ipython", "matplotlib", "pytest", "flake8"],
    },
    "0.4": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[all]",
      pipPackages: ["jupyter", "ipython", "matplotlib", "pytest", "flake8"],
    },
    "0.5": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[all]",
      pipPackages: ["jupyter", "ipython", "matplotlib", "pytest", "flake8"],
    },
    "0.6": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[all]",
      pipPackages: ["jupyter", "ipython", "matplotlib", "pytest", "flake8"],
    },
    "0.7": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[all]",
      pipPackages: ["jupyter", "ipython", "matplotlib", "pytest", "flake8"],
    },
    "0.8": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[all]",
      pipPackages: ["jupyter", "ipython", "matplotlib", "pytest", "flake8"],
    },
    "0.9": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .[all]",
      pipPackages: ["jupyter", "ipython", "matplotlib", "pytest", "flake8"],
    },
  },
  "pydata/xarray": {
    "0.12": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "numpy==1.23.0",
        "packaging==23.1",
        "pandas==1.5.3",
        "pytest==7.4.0",
        "python-dateutil==2.8.2",
        "pytz==2023.3",
        "six==1.16.0",
        "scipy==1.11.1",
        "setuptools==68.0.0",
        "dask==2022.8.1",
      ],
    },
    "0.18": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "numpy==1.23.0",
        "packaging==23.1",
        "pandas==1.5.3",
        "pytest==7.4.0",
        "python-dateutil==2.8.2",
        "pytz==2023.3",
        "six==1.16.0",
        "scipy==1.11.1",
        "setuptools==68.0.0",
        "dask==2022.8.1",
      ],
    },
    "0.19": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "numpy==1.23.0",
        "packaging==23.1",
        "pandas==1.5.3",
        "pytest==7.4.0",
        "python-dateutil==2.8.2",
        "pytz==2023.3",
        "six==1.16.0",
        "scipy==1.11.1",
        "setuptools==68.0.0",
        "dask==2022.8.1",
      ],
    },
    "0.20": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "numpy==1.23.0",
        "packaging==23.1",
        "pandas==1.5.3",
        "pytest==7.4.0",
        "python-dateutil==2.8.2",
        "pytz==2023.3",
        "six==1.16.0",
        "scipy==1.11.1",
        "setuptools==68.0.0",
        "dask==2022.8.1",
      ],
    },
    "2022.03": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "numpy==1.23.0",
        "packaging==23.1",
        "pandas==1.5.3",
        "pytest==7.4.0",
        "python-dateutil==2.8.2",
        "pytz==2023.3",
        "six==1.16.0",
        "scipy==1.11.1",
        "setuptools==68.0.0",
        "dask==2022.8.1",
      ],
    },
    "2022.06": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "numpy==1.23.0",
        "packaging==23.1",
        "pandas==1.5.3",
        "pytest==7.4.0",
        "python-dateutil==2.8.2",
        "pytz==2023.3",
        "six==1.16.0",
        "scipy==1.11.1",
        "setuptools==68.0.0",
        "dask==2022.8.1",
      ],
    },
    "2022.09": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "numpy==1.23.0",
        "packaging==23.1",
        "pandas==1.5.3",
        "pytest==7.4.0",
        "python-dateutil==2.8.2",
        "pytz==2023.3",
        "six==1.16.0",
        "scipy==1.11.1",
        "setuptools==68.0.0",
        "dask==2022.8.1",
      ],
    },
    "2023.07": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "numpy==1.23.0",
        "packaging==23.1",
        "pandas==1.5.3",
        "pytest==7.4.0",
        "python-dateutil==2.8.2",
        "pytz==2023.3",
        "six==1.16.0",
        "scipy==1.11.1",
        "setuptools==68.0.0",
        "dask==2022.8.1",
      ],
    },
    "2024.05": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "numpy==1.23.0",
        "packaging==23.1",
        "pandas==1.5.3",
        "pytest==7.4.0",
        "python-dateutil==2.8.2",
        "pytz==2023.3",
        "six==1.16.0",
        "scipy==1.11.1",
        "setuptools==68.0.0",
        "dask==2022.8.1",
      ],
    },
  },
  "pydicom/pydicom": {
    "1.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "1.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "1.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "1.3": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "1.4": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.3": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.4": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "3.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
  },
  "pylint-dev/astroid": {
    "2.10": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.12": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.13": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.14": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.15": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.16": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.5": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.6": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.7": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.8": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "2.9": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "3.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
  },
  "pylint-dev/pylint": {
    "2.10": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "2.11": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "2.13": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "2.14": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "2.15": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "2.16": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "2.17": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "2.8": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y libenchant-2-dev hunspell-en-us"],
      pipPackages: ["pyenchant==3.2"],
    },
    "2.9": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "3.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["astroid==3.0.0a6", "setuptools"],
    },
    "3.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["astroid==3.0.0a6", "setuptools"],
    },
    "3.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["astroid==3.0.0a6", "setuptools"],
    },
    "3.3": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["astroid==3.0.0a6", "setuptools"],
    },
    "4.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["astroid==3.0.0a6", "setuptools"],
    },
  },
  "pytest-dev/pytest": {
    "4.4": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "atomicwrites==1.4.1",
        "attrs==23.1.0",
        "more-itertools==10.1.0",
        "pluggy==0.13.1",
        "py==1.11.0",
        "setuptools==68.0.0",
        "six==1.16.0",
      ],
    },
    "4.5": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "atomicwrites==1.4.1",
        "attrs==23.1.0",
        "more-itertools==10.1.0",
        "pluggy==0.11.0",
        "py==1.11.0",
        "setuptools==68.0.0",
        "six==1.16.0",
        "wcwidth==0.2.6",
      ],
    },
    "4.6": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "atomicwrites==1.4.1",
        "attrs==23.1.0",
        "more-itertools==10.1.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
        "six==1.16.0",
        "wcwidth==0.2.6",
      ],
    },
    "5.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "atomicwrites==1.4.1",
        "attrs==23.1.0",
        "more-itertools==10.1.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
        "wcwidth==0.2.6",
      ],
    },
    "5.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "atomicwrites==1.4.1",
        "attrs==23.1.0",
        "more-itertools==10.1.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
        "wcwidth==0.2.6",
      ],
    },
    "5.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "atomicwrites==1.4.1",
        "attrs==23.1.0",
        "more-itertools==10.1.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
        "wcwidth==0.2.6",
      ],
    },
    "5.3": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "attrs==23.1.0",
        "more-itertools==10.1.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
        "wcwidth==0.2.6",
      ],
    },
    "5.4": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "py==1.11.0",
        "packaging==23.1",
        "attrs==23.1.0",
        "more-itertools==10.1.0",
        "pluggy==0.13.1",
      ],
    },
    "6.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "attrs==23.1.0",
        "iniconfig==2.0.0",
        "more-itertools==10.1.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
        "toml==0.10.2",
      ],
    },
    "6.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "attrs==23.1.0",
        "iniconfig==2.0.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
        "toml==0.10.2",
      ],
    },
    "6.3": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["sed -i 's/>=>=/>=/' setup.cfg"],
      pipPackages: [
        "attrs==23.1.0",
        "iniconfig==2.0.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
        "toml==0.10.2",
      ],
    },
    "7.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "attrs==23.1.0",
        "iniconfig==2.0.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
      ],
    },
    "7.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "attrs==23.1.0",
        "iniconfig==2.0.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
        "tomli==2.0.1",
      ],
    },
    "7.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "attrs==23.1.0",
        "iniconfig==2.0.0",
        "packaging==23.1",
        "pluggy==0.13.1",
        "py==1.11.0",
        "tomli==2.0.1",
      ],
    },
    "7.4": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "iniconfig==2.0.0",
        "packaging==23.1",
        "pluggy==1.3.0",
        "exceptiongroup==1.1.3",
        "tomli==2.0.1",
      ],
    },
    "8.0": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "iniconfig==2.0.0",
        "packaging==23.1",
        "pluggy==1.3.0",
        "exceptiongroup==1.1.3",
        "tomli==2.0.1",
      ],
    },
    "8.1": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "iniconfig==2.0.0",
        "packaging==23.1",
        "pluggy==1.3.0",
        "exceptiongroup==1.1.3",
        "tomli==2.0.1",
      ],
    },
    "8.2": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "iniconfig==2.0.0",
        "packaging==23.1",
        "pluggy==1.3.0",
        "exceptiongroup==1.1.3",
        "tomli==2.0.1",
      ],
    },
    "8.3": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "iniconfig==2.0.0",
        "packaging==23.1",
        "pluggy==1.3.0",
        "exceptiongroup==1.1.3",
        "tomli==2.0.1",
      ],
    },
    "8.4": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: [
        "iniconfig==2.0.0",
        "packaging==23.1",
        "pluggy==1.3.0",
        "exceptiongroup==1.1.3",
        "tomli==2.0.1",
      ],
    },
  },
  "pyvista/pyvista": {
    "0.20": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "0.21": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "0.22": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "0.23": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      pipPackages: ["pytest"],
    },
    "0.24": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.25": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.26": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.27": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.28": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.29": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.30": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.31": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.32": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.33": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.34": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.35": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.36": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.37": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.38": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.39": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.40": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.41": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.42": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
    "0.43": {
      testCmd: "pytest -rA",
      install: "python -m pip install -e .",
      preInstall: ["apt-get update && apt-get install -y ffmpeg libsm6 libxext6 libxrender1"],
      pipPackages: ["pytest"],
    },
  },
  "reactivex/rxjava": {
    "7597": {
      testCmd:
        "./gradlew test --tests io.reactivex.rxjava3.internal.operators.observable.ObservableSwitchTest",
      preInstall: [
        "sed -i '\n/testLogging {/,/}/{\n  /testLogging {/r /dev/stdin\n  d\n}\n' build.gradle << 'EOF'\ntestLogging {\n    outputs.upToDateWhen { false }\n    showStandardStreams = true\n    showStackTraces = true\n\n    // Show output for all logging levels\n    events = ['passed', 'skipped', 'failed', 'standardOut', 'standardError']\n\n    // set options for log level LIFECYCLE\n    events org.gradle.api.tasks.testing.logging.TestLogEvent.FAILED,\n           org.gradle.api.tasks.testing.logging.TestLogEvent.PASSED,\n           org.gradle.api.tasks.testing.logging.TestLogEvent.SKIPPED,\n           org.gradle.api.tasks.testing.logging.TestLogEvent.STANDARD_OUT,\n           org.gradle.api.tasks.testing.logging.TestLogEvent.STANDARD_ERROR\n    exceptionFormat org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL\n    showExceptions true\n    showCauses true\n    showStackTraces true\n\n    // set options for log level DEBUG and INFO\n    debug {\n        events org.gradle.api.tasks.testing.logging.TestLogEvent.STARTED,\n               org.gradle.api.tasks.testing.logging.TestLogEvent.FAILED,\n               org.gradle.api.tasks.testing.logging.TestLogEvent.PASSED,\n               org.gradle.api.tasks.testing.logging.TestLogEvent.SKIPPED,\n               org.gradle.api.tasks.testing.logging.TestLogEvent.STANDARD_ERROR,\n               org.gradle.api.tasks.testing.logging.TestLogEvent.STANDARD_OUT\n        exceptionFormat org.gradle.api.tasks.testing.logging.TestExceptionFormat.FULL\n    }\n    info.events = debug.events\n    info.exceptionFormat = debug.exceptionFormat\n\n    afterSuite { desc, result ->\n        if (!desc.parent) { // will match the outermost suite\n            def output = \"Results: ${result.resultType} (${result.testCount} tests, ${result.successfulTestCount} passed, ${result.failedTestCount} failed, ${result.skippedTestCount} skipped)\"\n            def startItem = '|  ', endItem = '  |'\n            def repeatLength = startItem.length() + output.length() + endItem.length()\n            println('\\n' + ('-' * repeatLength) + '\\n' + startItem + output + endItem + '\\n' + ('-' * repeatLength))\n        }\n    }\n}\nEOF",
      ],
    },
  },
  "redis/redis": {
    "10068": {
      testCmd: 'TERM=dumb ./runtest --durable --single unit/type/stream --only "/*XTRIM*"',
    },
    "10095": {
      testCmd: 'TERM=dumb ./runtest --durable --single unit/type/list --only "/.*(LPOP|RPOP)"',
    },
    "10764": { testCmd: 'TERM=dumb ./runtest --durable --single unit/type/zset --only "BZMPOP"' },
    "11279": { testCmd: "TERM=dumb ./runtest --durable --single unit/acl" },
    "11510": {
      testCmd: 'TERM=dumb ./runtest --durable --single unit/introspection --only "/.*MONITOR.*"',
    },
    "11631": {
      testCmd: 'TERM=dumb ./runtest --durable --single unit/geo --only "/.*GEOSEARCH .*"',
    },
    "11734": { testCmd: "TERM=dumb ./runtest --durable --single unit/bitops" },
    "12272": {
      testCmd:
        'TERM=dumb ./runtest --durable --single unit/type/string --only "/.*(GETRANGE|SETRANGE).*"',
    },
    "12472": {
      testCmd: 'TERM=dumb ./runtest --durable --single unit/acl --only "/.*ACL GETUSER.*"',
    },
    "13115": { testCmd: "TERM=dumb ./runtest --durable --single unit/scripting" },
    "13338": { testCmd: "TERM=dumb ./runtest --durable --single unit/type/stream-cgroups" },
    "9733": { testCmd: "TERM=dumb ./runtest --durable --single unit/introspection-2" },
  },
  "rubocop/rubocop": {
    "13362": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/style/redundant_freeze_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13375": {
      testCmd:
        'bundle exec rspec spec/rubocop/cli_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13393": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/style/guard_clause_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13396": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/style/redundant_parentheses_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13424": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/style/safe_navigation_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13431": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/layout/empty_lines_around_method_body_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13479": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/layout/leading_comment_space_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13503": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/style/dig_chain_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13560": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/style/file_null_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13579": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/layout/line_continuation_spacing_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13627": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/style/multiple_comparison_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13653": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/style/access_modifier_declarations_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13668": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/style/sole_nested_conditional_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13680": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/style/redundant_line_continuation_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13687": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/lint/safe_navigation_chain_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
    "13705": {
      testCmd:
        'bundle exec rspec spec/rubocop/cop/lint/out_of_range_regexp_ref_spec.rb --no-color --format json | sed -n \'/^{/,$p\' | \\\n  jq -r \'.examples | group_by(.description) | .[] |\n    if any(select(.status == "failed")) then\n      (.[0] | "\\(.description) - failed")\n    else\n      (.[0] | "\\(.description) - \\(.status)")\n    end\'',
      install: "bundle install",
    },
  },
  "scikit-learn/scikit-learn": {
    "0.20": {
      testCmd: "pytest -rA",
      install: "python -m pip install -v --no-use-pep517 --no-build-isolation -e .",
      pipPackages: ["cython", "numpy==1.19.2", "setuptools", "scipy==1.5.2"],
    },
    "0.21": {
      testCmd: "pytest -rA",
      install: "python -m pip install -v --no-use-pep517 --no-build-isolation -e .",
      pipPackages: ["cython", "numpy==1.19.2", "setuptools", "scipy==1.5.2"],
    },
    "0.22": {
      testCmd: "pytest -rA",
      install: "python -m pip install -v --no-use-pep517 --no-build-isolation -e .",
      pipPackages: ["cython", "numpy==1.19.2", "setuptools", "scipy==1.5.2"],
    },
    "1.3": {
      testCmd: "pytest -rA",
      install: "python -m pip install -v --no-use-pep517 --no-build-isolation -e .",
      pipPackages: ["cython", "setuptools", "numpy", "scipy"],
    },
    "1.4": {
      testCmd: "pytest -rA",
      install: "python -m pip install -v --no-use-pep517 --no-build-isolation -e .",
      pipPackages: ["cython", "setuptools", "numpy", "scipy"],
    },
    "1.5": {
      testCmd: "pytest -rA",
      install: "python -m pip install -v --no-use-pep517 --no-build-isolation -e .",
      pipPackages: ["cython", "setuptools", "numpy", "scipy"],
    },
    "1.6": {
      testCmd: "pytest -rA",
      install: "python -m pip install -v --no-use-pep517 --no-build-isolation -e .",
      pipPackages: ["cython", "setuptools", "numpy", "scipy"],
    },
  },
  "sharkdp/bat": {
    "1892": {
      testCmd:
        "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests ignored_suffix_arg",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests ignored_suffix_arg --no-run",
    },
    "2201": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests pag",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests pag --no-run",
    },
    "2260": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests syntax",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests syntax --no-run",
    },
    "2393": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests cache_",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests cache_ --no-run",
    },
    "2650": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests map_syntax",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests map_syntax --no-run",
    },
    "2835": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests header",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests header --no-run",
    },
    "3108": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests pag",
      install:
        "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests pag --no-run",
    },
    "562": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package bat --test integration_tests cache",
    },
  },
  "sphinx-doc/sphinx": {
    "1.5": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "1.6": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "1.7": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "1.8": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "2.0": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "2.1": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "2.2": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "2.3": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "2.4": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "3.0": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py",
        "sed -i 's/sphinxcontrib-applehelp/sphinxcontrib-applehelp<=1.0.7/' setup.py",
        "sed -i 's/sphinxcontrib-devhelp/sphinxcontrib-devhelp<=1.0.5/' setup.py",
        "sed -i 's/sphinxcontrib-qthelp/sphinxcontrib-qthelp<=1.0.6/' setup.py",
        "sed -i 's/alabaster>=0.7,<0.8/alabaster>=0.7,<0.7.12/' setup.py",
        "sed -i \"s/'packaging',/'packaging', 'markupsafe<=2.0.1',/\" setup.py",
        "sed -i 's/sphinxcontrib-htmlhelp/sphinxcontrib-htmlhelp<=2.0.4/' setup.py",
        "sed -i 's/sphinxcontrib-serializinghtml/sphinxcontrib-serializinghtml<=1.1.9/' setup.py",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "3.1": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py",
        "sed -i 's/sphinxcontrib-applehelp/sphinxcontrib-applehelp<=1.0.7/' setup.py",
        "sed -i 's/sphinxcontrib-devhelp/sphinxcontrib-devhelp<=1.0.5/' setup.py",
        "sed -i 's/sphinxcontrib-qthelp/sphinxcontrib-qthelp<=1.0.6/' setup.py",
        "sed -i 's/alabaster>=0.7,<0.8/alabaster>=0.7,<0.7.12/' setup.py",
        "sed -i \"s/'packaging',/'packaging', 'markupsafe<=2.0.1',/\" setup.py",
        "sed -i 's/sphinxcontrib-htmlhelp/sphinxcontrib-htmlhelp<=2.0.4/' setup.py",
        "sed -i 's/sphinxcontrib-serializinghtml/sphinxcontrib-serializinghtml<=1.1.9/' setup.py",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "3.2": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py",
        "sed -i 's/sphinxcontrib-applehelp/sphinxcontrib-applehelp<=1.0.7/' setup.py",
        "sed -i 's/sphinxcontrib-devhelp/sphinxcontrib-devhelp<=1.0.5/' setup.py",
        "sed -i 's/sphinxcontrib-qthelp/sphinxcontrib-qthelp<=1.0.6/' setup.py",
        "sed -i 's/alabaster>=0.7,<0.8/alabaster>=0.7,<0.7.12/' setup.py",
        "sed -i \"s/'packaging',/'packaging', 'markupsafe<=2.0.1',/\" setup.py",
        "sed -i 's/sphinxcontrib-htmlhelp/sphinxcontrib-htmlhelp<=2.0.4/' setup.py",
        "sed -i 's/sphinxcontrib-serializinghtml/sphinxcontrib-serializinghtml<=1.1.9/' setup.py",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "3.3": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py",
        "sed -i 's/sphinxcontrib-applehelp/sphinxcontrib-applehelp<=1.0.7/' setup.py",
        "sed -i 's/sphinxcontrib-devhelp/sphinxcontrib-devhelp<=1.0.5/' setup.py",
        "sed -i 's/sphinxcontrib-qthelp/sphinxcontrib-qthelp<=1.0.6/' setup.py",
        "sed -i 's/alabaster>=0.7,<0.8/alabaster>=0.7,<0.7.12/' setup.py",
        "sed -i \"s/'packaging',/'packaging', 'markupsafe<=2.0.1',/\" setup.py",
        "sed -i 's/sphinxcontrib-htmlhelp/sphinxcontrib-htmlhelp<=2.0.4/' setup.py",
        "sed -i 's/sphinxcontrib-serializinghtml/sphinxcontrib-serializinghtml<=1.1.9/' setup.py",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "3.4": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py",
        "sed -i 's/sphinxcontrib-applehelp/sphinxcontrib-applehelp<=1.0.7/' setup.py",
        "sed -i 's/sphinxcontrib-devhelp/sphinxcontrib-devhelp<=1.0.5/' setup.py",
        "sed -i 's/sphinxcontrib-qthelp/sphinxcontrib-qthelp<=1.0.6/' setup.py",
        "sed -i 's/alabaster>=0.7,<0.8/alabaster>=0.7,<0.7.12/' setup.py",
        "sed -i \"s/'packaging',/'packaging', 'markupsafe<=2.0.1',/\" setup.py",
        "sed -i 's/sphinxcontrib-htmlhelp/sphinxcontrib-htmlhelp<=2.0.4/' setup.py",
        "sed -i 's/sphinxcontrib-serializinghtml/sphinxcontrib-serializinghtml<=1.1.9/' setup.py",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "3.5": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py",
        "sed -i 's/sphinxcontrib-applehelp/sphinxcontrib-applehelp<=1.0.7/' setup.py",
        "sed -i 's/sphinxcontrib-devhelp/sphinxcontrib-devhelp<=1.0.5/' setup.py",
        "sed -i 's/sphinxcontrib-qthelp/sphinxcontrib-qthelp<=1.0.6/' setup.py",
        "sed -i 's/alabaster>=0.7,<0.8/alabaster>=0.7,<0.7.12/' setup.py",
        "sed -i \"s/'packaging',/'packaging', 'markupsafe<=2.0.1',/\" setup.py",
        "sed -i 's/sphinxcontrib-htmlhelp/sphinxcontrib-htmlhelp<=2.0.4/' setup.py",
        "sed -i 's/sphinxcontrib-serializinghtml/sphinxcontrib-serializinghtml<=1.1.9/' setup.py",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "4.0": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py",
        "sed -i 's/sphinxcontrib-applehelp/sphinxcontrib-applehelp<=1.0.7/' setup.py",
        "sed -i 's/sphinxcontrib-devhelp/sphinxcontrib-devhelp<=1.0.5/' setup.py",
        "sed -i 's/sphinxcontrib-qthelp/sphinxcontrib-qthelp<=1.0.6/' setup.py",
        "sed -i 's/alabaster>=0.7,<0.8/alabaster>=0.7,<0.7.12/' setup.py",
        "sed -i \"s/'packaging',/'packaging', 'markupsafe<=2.0.1',/\" setup.py",
        "sed -i 's/sphinxcontrib-htmlhelp/sphinxcontrib-htmlhelp<=2.0.4/' setup.py",
        "sed -i 's/sphinxcontrib-serializinghtml/sphinxcontrib-serializinghtml<=1.1.9/' setup.py",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "4.1": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py",
        "sed -i 's/sphinxcontrib-applehelp/sphinxcontrib-applehelp<=1.0.7/' setup.py",
        "sed -i 's/sphinxcontrib-devhelp/sphinxcontrib-devhelp<=1.0.5/' setup.py",
        "sed -i 's/sphinxcontrib-qthelp/sphinxcontrib-qthelp<=1.0.6/' setup.py",
        "sed -i 's/alabaster>=0.7,<0.8/alabaster>=0.7,<0.7.12/' setup.py",
        "sed -i \"s/'packaging',/'packaging', 'markupsafe<=2.0.1',/\" setup.py",
        "grep -q 'sphinxcontrib-htmlhelp>=2.0.0' setup.py && sed -i 's/sphinxcontrib-htmlhelp>=2.0.0/sphinxcontrib-htmlhelp>=2.0.0,<=2.0.4/' setup.py || sed -i 's/sphinxcontrib-htmlhelp/sphinxcontrib-htmlhelp<=2.0.4/' setup.py",
        "grep -q 'sphinxcontrib-serializinghtml>=1.1.5' setup.py && sed -i 's/sphinxcontrib-serializinghtml>=1.1.5/sphinxcontrib-serializinghtml>=1.1.5,<=1.1.9/' setup.py || sed -i 's/sphinxcontrib-serializinghtml/sphinxcontrib-serializinghtml<=1.1.9/' setup.py",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "4.2": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py",
        "sed -i 's/sphinxcontrib-applehelp/sphinxcontrib-applehelp<=1.0.7/' setup.py",
        "sed -i 's/sphinxcontrib-devhelp/sphinxcontrib-devhelp<=1.0.5/' setup.py",
        "sed -i 's/sphinxcontrib-qthelp/sphinxcontrib-qthelp<=1.0.6/' setup.py",
        "sed -i 's/alabaster>=0.7,<0.8/alabaster>=0.7,<0.7.12/' setup.py",
        "sed -i \"s/'packaging',/'packaging', 'markupsafe<=2.0.1',/\" setup.py",
        "sed -i 's/sphinxcontrib-htmlhelp>=2.0.0/sphinxcontrib-htmlhelp>=2.0.0,<=2.0.4/' setup.py",
        "sed -i 's/sphinxcontrib-serializinghtml>=1.1.5/sphinxcontrib-serializinghtml>=1.1.5,<=1.1.9/' setup.py",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "4.3": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py",
        "sed -i 's/sphinxcontrib-applehelp/sphinxcontrib-applehelp<=1.0.7/' setup.py",
        "sed -i 's/sphinxcontrib-devhelp/sphinxcontrib-devhelp<=1.0.5/' setup.py",
        "sed -i 's/sphinxcontrib-qthelp/sphinxcontrib-qthelp<=1.0.6/' setup.py",
        "sed -i 's/alabaster>=0.7,<0.8/alabaster>=0.7,<0.7.12/' setup.py",
        "sed -i \"s/'packaging',/'packaging', 'markupsafe<=2.0.1',/\" setup.py",
        "sed -i 's/sphinxcontrib-htmlhelp>=2.0.0/sphinxcontrib-htmlhelp>=2.0.0,<=2.0.4/' setup.py",
        "sed -i 's/sphinxcontrib-serializinghtml>=1.1.5/sphinxcontrib-serializinghtml>=1.1.5,<=1.1.9/' setup.py",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "4.4": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "sed -i 's/Jinja2>=2.3/Jinja2<3.0/' setup.py",
        "sed -i 's/sphinxcontrib-applehelp/sphinxcontrib-applehelp<=1.0.7/' setup.py",
        "sed -i 's/sphinxcontrib-devhelp/sphinxcontrib-devhelp<=1.0.5/' setup.py",
        "sed -i 's/sphinxcontrib-qthelp/sphinxcontrib-qthelp<=1.0.6/' setup.py",
        "sed -i 's/alabaster>=0.7,<0.8/alabaster>=0.7,<0.7.12/' setup.py",
        "sed -i \"s/'packaging',/'packaging', 'markupsafe<=2.0.1',/\" setup.py",
        "sed -i 's/sphinxcontrib-htmlhelp>=2.0.0/sphinxcontrib-htmlhelp>=2.0.0,<=2.0.4/' setup.py",
        "sed -i 's/sphinxcontrib-serializinghtml>=1.1.5/sphinxcontrib-serializinghtml>=1.1.5,<=1.1.9/' setup.py",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "4.5": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "5.0": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "5.1": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "5.2": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "5.3": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "6.0": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "6.2": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "7.0": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "7.1": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: ["sed -i 's/pytest/pytest -rA/' tox.ini"],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "7.2": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "apt-get update && apt-get install -y graphviz",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "7.3": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "apt-get update && apt-get install -y graphviz",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "7.4": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "apt-get update && apt-get install -y graphviz",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "8.0": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "apt-get update && apt-get install -y graphviz",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
    "8.1": {
      testCmd: "tox --current-env -epy39 -v --",
      install: "python -m pip install -e .[test]",
      preInstall: [
        "sed -i 's/pytest/pytest -rA/' tox.ini",
        "apt-get update && apt-get install -y graphviz",
      ],
      pipPackages: ["tox==4.16.0", "tox-current-env==0.0.11", "Jinja2==3.0.3"],
    },
  },
  "sqlfluff/sqlfluff": {
    "0.10": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "0.11": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "0.12": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "0.13": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "0.4": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "0.5": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "0.6": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "0.8": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "0.9": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "1.0": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "1.1": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "1.2": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "1.3": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "1.4": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "2.0": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "2.1": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
    "2.2": { testCmd: "pytest -rA", install: "python -m pip install -e ." },
  },
  "swe-bench/humaneval": {
    "1.0": { testCmd: "python" },
  },
  "sympy/sympy": {
    "0.7": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
    "1.0": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
    "1.1": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
    "1.10": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
    "1.11": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
    "1.12": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
    "1.13": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0"],
    },
    "1.14": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0"],
    },
    "1.2": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
    "1.4": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
    "1.5": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
    "1.6": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
    "1.7": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
    "1.8": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
    "1.9": {
      testCmd: "PYTHONWARNINGS='ignore::UserWarning,ignore::SyntaxWarning' bin/test -C --verbose",
      install: "python -m pip install -e .",
      pipPackages: ["mpmath==1.3.0", "flake8-comprehensions"],
    },
  },
  "tokio-rs/axum": {
    "1119": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package axum --lib slash",
      install: "RUSTFLAGS=-Awarnings cargo test --package axum --lib slash --no-run",
    },
    "1730": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package axum --lib -- routing::tests::mod state",
      install: "RUSTFLAGS=-Awarnings cargo test --package axum --lib --no-run",
    },
    "1934": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package axum --lib -- routing::tests::fallback",
      install: "RUSTFLAGS=-Awarnings cargo test --package axum --lib --no-run",
    },
    "2096": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package axum --lib -- routing::tests::fallback",
      install: "RUSTFLAGS=-Awarnings cargo test --package axum --lib --no-run",
    },
    "682": {
      testCmd:
        "RUSTFLAGS=-Awarnings cargo test --package axum --lib trailing -- with_trailing_slash_post without_trailing_slash_post",
      install: "RUSTFLAGS=-Awarnings cargo test --package axum --lib trailing --no-run",
    },
    "691": {
      testCmd:
        "RUSTFLAGS=-Awarnings cargo test --package axum --lib -- routing::tests::nest::nesting_router_at_root --exact",
      install: "RUSTFLAGS=-Awarnings cargo test --package axum --lib --no-run",
    },
    "734": {
      testCmd: "RUSTFLAGS=-Awarnings cargo test --package axum --lib -- routing::tests::head",
      install: "RUSTFLAGS=-Awarnings cargo test --package axum --lib --no-run",
    },
  },
  "tokio-rs/tokio": {
    "4384": {
      testCmd:
        "RUSTFLAGS=-Awarnings cargo test --package tokio --test net_types_unwind --features full --no-fail-fast",
    },
    "4867": {
      testCmd: "cargo test --test sync_broadcast --no-fail-fast",
      install: "cargo test --test sync_broadcast --no-fail-fast --no-run",
    },
    "4898": {
      testCmd: 'RUSTFLAGS="--cfg tokio_unstable" cargo test --features full --test rt_metrics',
      install:
        'RUSTFLAGS="--cfg tokio_unstable" cargo test --features full --test rt_metrics --no-run',
    },
    "6551": {
      testCmd:
        'RUSTFLAGS="--cfg tokio_unstable" cargo test --features full --test rt_metrics --no-fail-fast',
      install:
        'RUSTFLAGS="--cfg tokio_unstable" cargo test --features full --test rt_metrics --no-fail-fast --no-run',
    },
    "6603": {
      testCmd: "cargo test --test sync_mpsc --no-fail-fast",
      install: "cargo test --test sync_mpsc --no-fail-fast --no-run",
    },
    "6724": {
      testCmd: "cargo test --test io_write_all_buf --no-fail-fast",
      install: "cargo test --test io_write_all_buf --no-fail-fast --no-run",
    },
    "6752": {
      testCmd: "cargo test --test time_delay_queue --no-fail-fast",
      install: "cargo test --test time_delay_queue --no-fail-fast --no-run",
    },
    "6838": {
      testCmd: "cargo test --test uds_stream --no-fail-fast",
      install: "cargo test --test uds_stream --no-fail-fast --no-run",
    },
    "7139": {
      testCmd: 'RUSTFLAGS="--cfg tokio_unstable" cargo test --test fs_file --no-fail-fast',
      install: 'RUSTFLAGS="--cfg tokio_unstable" cargo test --test fs_file --no-fail-fast --no-run',
    },
  },
  "uutils/coreutils": {
    "6377": {
      testCmd: "cargo test test_env --no-fail-fast",
      install: "cargo test test_env --no-run",
    },
    "6575": { testCmd: "cargo test cksum --no-fail-fast", install: "cargo test cksum --no-run" },
    "6682": { testCmd: "cargo test mkdir --no-fail-fast", install: "cargo test mkdir --no-run" },
    "6690": {
      testCmd:
        "cargo test --no-fail-fast -- test_cp_cp test_cp_same_file test_cp_multiple_files test_cp_single_file test_cp_no_file",
      install:
        "cargo test --no-run -- test_cp_cp test_cp_same_file test_cp_multiple_files test_cp_single_file test_cp_no_file",
    },
    "6731": {
      testCmd: "cargo test backslash --no-fail-fast",
      install: "cargo test backslash --no-run",
    },
  },
  "valkey-io/valkey": {
    "1499": { testCmd: "TERM=dumb ./runtest --durable --single unit/introspection-2" },
    "1842": { testCmd: 'TERM=dumb ./runtest --durable --single unit/acl --only "/.*ACL LOAD.*"' },
    "790": { testCmd: "TERM=dumb ./runtest --durable --single unit/cluster/cluster-shards" },
    "928": {
      testCmd:
        'TERM=dumb ./runtest --durable --single unit/cluster/replica-migration --only "/.*NOREPLICAS.*"',
    },
  },
  "vuejs/core": {
    "11589": {
      testCmd:
        "pnpm run test packages/runtime-core/__tests__/apiWatch.spec.ts --no-watch --reporter=verbose",
      install: "pnpm i",
    },
    "11739": {
      testCmd:
        'pnpm run test packages/runtime-core/__tests__/hydration.spec.ts --no-watch --reporter=verbose -t "mismatch handling"',
      install: "pnpm i",
    },
    "11870": {
      testCmd:
        "pnpm run test packages/runtime-core/__tests__/helpers/renderList.spec.ts --no-watch --reporter=verbose",
      install: "pnpm i",
    },
    "11899": {
      testCmd:
        "pnpm run test packages/compiler-sfc/__tests__/compileStyle.spec.ts --no-watch --reporter=verbose",
      install: "pnpm i",
    },
    "11915": {
      testCmd:
        'pnpm run test packages/compiler-core/__tests__/parse.spec.ts --no-watch --reporter=verbose -t "Element"',
      install: "pnpm i",
    },
  },
}

/** Bare test-runner command for (repo, version) from the SWE-bench spec, or
 *  undefined when unknown. GOLD-FREE: no instance test names. */
export const specTestCmd = (repo: string, version: string | undefined): string | undefined =>
  version === undefined ? undefined : REPO_VERSION_SPECS[repo]?.[version]?.testCmd

/** Spec env-setup command list (export LANG=..., etc.) for (repo, version). */
export const specEvalCommands = (repo: string, version: string | undefined): readonly string[] =>
  (version === undefined ? undefined : REPO_VERSION_SPECS[repo]?.[version]?.evalCommands) ?? []

/** Spec install command for (repo, version). */
export const specInstall = (repo: string, version: string | undefined): string | undefined =>
  version === undefined ? undefined : REPO_VERSION_SPECS[repo]?.[version]?.install

/** Spec pre-install command list for (repo, version). */
export const specPreInstall = (repo: string, version: string | undefined): readonly string[] =>
  (version === undefined ? undefined : REPO_VERSION_SPECS[repo]?.[version]?.preInstall) ?? []

/** Official `pip_packages` PINS for (repo, version) — era-correct dep versions
 *  applied as uv `--with` so the repro/test env stops free-resolving deps to
 *  latest (RCA jun-29: sphinx 3.5 needs `Jinja2==3.0.3`, not 3.1+). Empty when
 *  unmapped (⇒ no pins, the pre-fix behavior). */
export const specPipPackages = (repo: string, version: string | undefined): readonly string[] =>
  (version === undefined ? undefined : REPO_VERSION_SPECS[repo]?.[version]?.pipPackages) ?? []

/** Whether the spec knows this (repo, version). */
export const hasRepoVersionSpec = (repo: string, version: string | undefined): boolean =>
  version !== undefined && REPO_VERSION_SPECS[repo]?.[version] !== undefined

/** Whether the spec knows this repo at ALL (any version). Lets a caller tell a
 *  genuinely-unknown repo apart from a known repo on a DRIFTED (unmapped) version
 *  — the latter is a spec-coverage gap to surface, not a silent fallback. */
export const specHasRepo = (repo: string): boolean => REPO_VERSION_SPECS[repo] !== undefined

/** Resolve the test-runner for (repo, version): the EXACT spec runner, or — when
 *  that version is unmapped (drift) — the repo's most-recent mapped version's
 *  runner. A repo's runner is stable across versions, so this degrades version
 *  drift gracefully WITHOUT a repo-name branch (and keeps a runtests repo from
 *  silently mis-resolving). `specTestCmd` stays strictly exact for callers that
 *  need precision. */
export const specResolvedRunner = (
  repo: string,
  version: string | undefined,
): string | undefined => {
  const exact = specTestCmd(repo, version)
  if (exact !== undefined) return exact
  const vers = REPO_VERSION_SPECS[repo]
  if (vers === undefined) return undefined
  const keys = Object.keys(vers).sort()
  const last = keys[keys.length - 1]
  return last === undefined ? undefined : vers[last]?.testCmd
}

/** Classify the in-loop test runner for (repo, version). "runtests" repos (django)
 *  genuinely CANNOT run under plain pytest — their tests need the project test
 *  harness + settings (the engage=0 RCA: pytest collection dies on
 *  ImproperlyConfigured), so the oracle invokes their spec runner. Everything
 *  else is pytest-compatible and uses the uniform pytest oracle (the spec runners
 *  for those — pytest / tox-wrapping-pytest / sympy bin-test — are all
 *  pytest-collectable in-loop; their native wrappers like tox aren't on the uv
 *  env anyway). Derived from the spec runner (drift-resilient via
 *  `specResolvedRunner`): this is the ONE place runner-name knowledge lives,
 *  so no logic file needs a per-framework literal, and an unmapped version of a
 *  runtests repo still classifies "runtests" rather than silently mis-routing. */
export const specRunnerKind = (
  repo: string,
  version: string | undefined,
): "runtests" | "pytest" => {
  const t = specResolvedRunner(repo, version)
  return t?.includes("runtests.py") ? "runtests" : "pytest"
}
