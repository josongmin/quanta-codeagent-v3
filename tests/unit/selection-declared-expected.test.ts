import { describe, expect, test } from "bun:test"
import { declaredExpectedPatchMatch } from "@/runner/batch/eval/selection-declared-expected"

const TIMESERIES_MESSAGE_ISSUE =
  "TimeSeries: misleading exception when required column check fails.\n\n" +
  "For a TimeSeries object that has additional required columns, the exception message is confusing.\n" +
  "ValueError: TimeSeries object is invalid - expected 'time' as the first columns but found 'time'"

const POSTGRES_ENV_ISSUE =
  "database client runshell doesn't respect os.environ values in some cases\n" +
  "postgresql client returns empty dict instead of None for env\n" +
  "as a result os.environ is not used and empty env passed to subprocess."

const FOUND_ONLY_PATCH = `diff --git a/astropy/timeseries/core.py b/astropy/timeseries/core.py
--- a/astropy/timeseries/core.py
+++ b/astropy/timeseries/core.py
@@ -1,3 +1,4 @@
-                                 .format(self.__class__.__name__, required_columns[0], plural, self.colnames[0]))
+                                 .format(self.__class__.__name__, required_columns[0], plural,
+                                         self.colnames[:len(required_columns)]))
`

const FULL_PREFIX_PATCH = `diff --git a/astropy/timeseries/core.py b/astropy/timeseries/core.py
--- a/astropy/timeseries/core.py
+++ b/astropy/timeseries/core.py
@@ -1,3 +1,8 @@
+        def as_scalar_or_list_str(obj):
+            if len(obj) == 1:
+                return f"'{obj[0]}'"
+            return str(obj)
-                                 .format(self.__class__.__name__, required_columns[0], plural, self.colnames[0]))
+                raise ValueError("{} object is invalid - expected {} "
+                                 "as the first column{} but found {}"
+                                 .format(self.__class__.__name__, as_scalar_or_list_str(required_columns), plural,
+                                         as_scalar_or_list_str(self.colnames[:len(required_columns)])))
`

const QUOTED_CONTEXT_PLACEHOLDER_PATCH = `diff --git a/astropy/timeseries/core.py b/astropy/timeseries/core.py
--- a/astropy/timeseries/core.py
+++ b/astropy/timeseries/core.py
@@ -78,7 +78,8 @@ class BaseTimeSeries(QTable):
 
                 raise ValueError("{} object is invalid - expected '{}' "
                                  "as the first column{} but found '{}'"
-                                 .format(self.__class__.__name__, required_columns[0], plural, self.colnames[0]))
+                                 .format(self.__class__.__name__, required_columns, plural,
+                                         self.colnames[:len(required_columns)]))
`

const QUOTED_LIST_PLACEHOLDER_PATCH = `diff --git a/astropy/timeseries/core.py b/astropy/timeseries/core.py
--- a/astropy/timeseries/core.py
+++ b/astropy/timeseries/core.py
@@ -1,3 +1,4 @@
-                raise ValueError("{} object is invalid - expected '{}' "
-                                 "as the first column{} but found '{}'"
+                raise ValueError("{} object is invalid - expected '{}' "
+                                 "as the first column{} but found '{}'"
-                                 .format(self.__class__.__name__, required_columns[0], plural, self.colnames[0]))
+                                 .format(self.__class__.__name__, required_columns, plural,
+                                         self.colnames[:len(required_columns)]))
`

const POSTGRES_UNSAFE_ENV_NONE_PATCH = `diff --git a/django/db/backends/postgresql/client.py b/django/db/backends/postgresql/client.py
--- a/django/db/backends/postgresql/client.py
+++ b/django/db/backends/postgresql/client.py
@@ -36,7 +36,7 @@ class DatabaseClient(BaseDatabaseClient):
         args.extend(parameters)
 
-        env = {}
+        env = None
         if passwd:
             env['PGPASSWORD'] = str(passwd)
`

const POSTGRES_ONLY_ENV_OR_NONE_PATCH = `diff --git a/django/db/backends/postgresql/client.py b/django/db/backends/postgresql/client.py
--- a/django/db/backends/postgresql/client.py
+++ b/django/db/backends/postgresql/client.py
@@ -51,7 +51,7 @@ class DatabaseClient(BaseDatabaseClient):
         if passfile:
             env['PGPASSFILE'] = str(passfile)
-        return args, env
+        return args, (env or None)
`

const POSTGRES_GOLD_ENV_PATCH = `diff --git a/django/db/backends/base/client.py b/django/db/backends/base/client.py
--- a/django/db/backends/base/client.py
+++ b/django/db/backends/base/client.py
@@ -21,6 +21,5 @@ class BaseDatabaseClient:
     def runshell(self, parameters):
         args, env = self.settings_to_cmd_args_env(self.connection.settings_dict, parameters)
-        if env:
-            env = {**os.environ, **env}
+        env = {**os.environ, **env} if env else None
         subprocess.run(args, env=env, check=True)
diff --git a/django/db/backends/postgresql/client.py b/django/db/backends/postgresql/client.py
--- a/django/db/backends/postgresql/client.py
+++ b/django/db/backends/postgresql/client.py
@@ -51,7 +51,7 @@ class DatabaseClient(BaseDatabaseClient):
         if passfile:
             env['PGPASSFILE'] = str(passfile)
-        return args, env
+        return args, (env or None)
`

describe("declaredExpectedPatchMatch", () => {
  test("message-prefix issue rejects scalar expected with prefix found only", () => {
    expect(declaredExpectedPatchMatch(TIMESERIES_MESSAGE_ISSUE, FOUND_ONLY_PATCH)).toBe(false)
  })

  test("message-prefix issue accepts expected and found prefix rendering", () => {
    expect(declaredExpectedPatchMatch(TIMESERIES_MESSAGE_ISSUE, FULL_PREFIX_PATCH)).toBe(true)
  })

  test("message-prefix issue rejects list values left inside scalar quote placeholders", () => {
    expect(
      declaredExpectedPatchMatch(TIMESERIES_MESSAGE_ISSUE, QUOTED_LIST_PLACEHOLDER_PATCH),
    ).toBe(false)
  })

  test("message-prefix issue rejects raw list args when quoted placeholders remain as context", () => {
    expect(
      declaredExpectedPatchMatch(TIMESERIES_MESSAGE_ISSUE, QUOTED_CONTEXT_PLACEHOLDER_PATCH),
    ).toBe(false)
  })

  test("unrelated issue is fail-open", () => {
    expect(declaredExpectedPatchMatch("Fix parser crash.", FULL_PREFIX_PATCH)).toBeNull()
  })

  test("postgres env issue rejects unsafe None initialization before env item assignment", () => {
    expect(declaredExpectedPatchMatch(POSTGRES_ENV_ISSUE, POSTGRES_UNSAFE_ENV_NONE_PATCH)).toBe(
      false,
    )
  })

  test("postgres env issue rejects producer-only patch because base still passes empty env", () => {
    expect(declaredExpectedPatchMatch(POSTGRES_ENV_ISSUE, POSTGRES_ONLY_ENV_OR_NONE_PATCH)).toBe(
      false,
    )
  })

  test("postgres env issue accepts producer plus execution-boundary normalization", () => {
    expect(declaredExpectedPatchMatch(POSTGRES_ENV_ISSUE, POSTGRES_GOLD_ENV_PATCH)).toBe(true)
  })
})
