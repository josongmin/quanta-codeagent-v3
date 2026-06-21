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

const DATABASE_TIMEZONE_ISSUE =
  "TIME_ZONE value in DATABASES settings is not used when making dates timezone-aware " +
  "on MySQL, SQLite, and Oracle."

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

const UNQUOTED_SCALAR_BRANCH_PATCH = `diff --git a/astropy/timeseries/core.py b/astropy/timeseries/core.py
--- a/astropy/timeseries/core.py
+++ b/astropy/timeseries/core.py
@@ -69,13 +69,15 @@ class BaseTimeSeries(QTable):
             plural = 's' if len(required_columns) > 1 else ''
+            expected = required_columns[0] if len(required_columns) == 1 else required_columns
 
             elif self.colnames[:len(required_columns)] != required_columns:
 
-                raise ValueError("{} object is invalid - expected '{}' "
-                                 "as the first column{} but found '{}'"
-                                 .format(self.__class__.__name__, required_columns[0], plural, self.colnames[0]))
+                raise ValueError("{} object is invalid - expected {} "
+                                 "as the first column{} but found {}"
+                                 .format(self.__class__.__name__, expected,
+                                         plural, self.colnames[:len(required_columns)]))
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

const DATABASE_TIMEZONE_MYSQL_ONLY_PATCH = `diff --git a/django/db/backends/mysql/operations.py b/django/db/backends/mysql/operations.py
--- a/django/db/backends/mysql/operations.py
+++ b/django/db/backends/mysql/operations.py
@@ -71,7 +71,7 @@ class DatabaseOperations(BaseDatabaseOperations):
-        if settings.USE_TZ:
-            field_name = "CONVERT_TZ(%s, 'UTC', '%s')" % (field_name, tzname)
+        if settings.USE_TZ and self.connection.timezone_name != tzname:
+            field_name = "CONVERT_TZ(%s, '%s', '%s')" % (field_name, self.connection.timezone_name, tzname)
`

const DATABASE_TIMEZONE_SQLITE_OPS_ONLY_PATCH = `diff --git a/django/db/backends/sqlite3/operations.py b/django/db/backends/sqlite3/operations.py
--- a/django/db/backends/sqlite3/operations.py
+++ b/django/db/backends/sqlite3/operations.py
@@ -87,7 +87,9 @@ class DatabaseOperations(BaseDatabaseOperations):
-    def _convert_tzname_to_sql(self, tzname):
-        return "'%s'" % tzname if settings.USE_TZ else 'NULL'
+    def _convert_tznames_to_sql(self, tzname):
+        return "'%s'" % tzname, "'%s'" % self.connection.timezone_name
@@ -91,16 +93,16 @@ class DatabaseOperations(BaseDatabaseOperations):
-        return "django_datetime_cast_date(%s, %s)" % (
-            field_name, self._convert_tzname_to_sql(tzname),
+        return "django_datetime_cast_date(%s, %s, %s)" % (
+            field_name, *self._convert_tznames_to_sql(tzname),
`

const DATABASE_TIMEZONE_GOLD_PATCH = `diff --git a/django/db/backends/mysql/operations.py b/django/db/backends/mysql/operations.py
--- a/django/db/backends/mysql/operations.py
+++ b/django/db/backends/mysql/operations.py
@@ -71,7 +71,7 @@ class DatabaseOperations(BaseDatabaseOperations):
-        if settings.USE_TZ:
-            field_name = "CONVERT_TZ(%s, 'UTC', '%s')" % (field_name, tzname)
+        if settings.USE_TZ and self.connection.timezone_name != tzname:
+            field_name = "CONVERT_TZ(%s, '%s', '%s')" % (field_name, self.connection.timezone_name, tzname)
diff --git a/django/db/backends/oracle/operations.py b/django/db/backends/oracle/operations.py
--- a/django/db/backends/oracle/operations.py
+++ b/django/db/backends/oracle/operations.py
@@ -102,7 +102,13 @@ class DatabaseOperations(BaseDatabaseOperations):
-        return "CAST((FROM_TZ(%s, '0:00') AT TIME ZONE '%s') AS TIMESTAMP)" % (field_name, tzname)
+        if self.connection.timezone_name != tzname:
+            return "CAST((FROM_TZ(%s, '%s') AT TIME ZONE '%s') AS TIMESTAMP)" % (
+                field_name,
+                self.connection.timezone_name,
+                tzname,
+            )
+        return field_name
diff --git a/django/db/backends/sqlite3/base.py b/django/db/backends/sqlite3/base.py
--- a/django/db/backends/sqlite3/base.py
+++ b/django/db/backends/sqlite3/base.py
@@ -195,10 +195,10 @@ class DatabaseWrapper(BaseDatabaseWrapper):
-        conn.create_function("django_datetime_cast_date", 2, _sqlite_datetime_cast_date)
-        conn.create_function("django_datetime_cast_time", 2, _sqlite_datetime_cast_time)
-        conn.create_function("django_datetime_extract", 3, _sqlite_datetime_extract)
-        conn.create_function("django_datetime_trunc", 3, _sqlite_datetime_trunc)
+        conn.create_function("django_datetime_cast_date", 3, _sqlite_datetime_cast_date)
+        conn.create_function("django_datetime_cast_time", 3, _sqlite_datetime_cast_time)
+        conn.create_function("django_datetime_extract", 4, _sqlite_datetime_extract)
+        conn.create_function("django_datetime_trunc", 4, _sqlite_datetime_trunc)
diff --git a/django/db/backends/sqlite3/operations.py b/django/db/backends/sqlite3/operations.py
--- a/django/db/backends/sqlite3/operations.py
+++ b/django/db/backends/sqlite3/operations.py
@@ -87,22 +87,24 @@ class DatabaseOperations(BaseDatabaseOperations):
-    def _convert_tzname_to_sql(self, tzname):
-        return "'%s'" % tzname if settings.USE_TZ else 'NULL'
+    def _convert_tznames_to_sql(self, tzname):
+        return "'%s'" % tzname, "'%s'" % self.connection.timezone_name
-        return "django_datetime_cast_date(%s, %s)" % (
-            field_name, self._convert_tzname_to_sql(tzname),
+        return "django_datetime_cast_date(%s, %s, %s)" % (
+            field_name, *self._convert_tznames_to_sql(tzname),
-        return "django_datetime_cast_time(%s, %s)" % (
-            field_name, self._convert_tzname_to_sql(tzname),
+        return "django_datetime_cast_time(%s, %s, %s)" % (
+            field_name, *self._convert_tznames_to_sql(tzname),
-        return "django_datetime_extract('%s', %s, %s)" % (
-            lookup_type.lower(), field_name, self._convert_tzname_to_sql(tzname),
+        return "django_datetime_extract('%s', %s, %s, %s)" % (
+            lookup_type.lower(), field_name, *self._convert_tznames_to_sql(tzname),
-        return "django_datetime_trunc('%s', %s, %s)" % (
-            lookup_type.lower(), field_name, self._convert_tzname_to_sql(tzname),
+        return "django_datetime_trunc('%s', %s, %s, %s)" % (
+            lookup_type.lower(), field_name, *self._convert_tznames_to_sql(tzname),
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

  test("message-prefix issue rejects unquoted scalar branch plus raw found prefix", () => {
    expect(declaredExpectedPatchMatch(TIMESERIES_MESSAGE_ISSUE, UNQUOTED_SCALAR_BRANCH_PATCH)).toBe(
      false,
    )
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

  test("database timezone issue rejects single-backend patch", () => {
    expect(
      declaredExpectedPatchMatch(DATABASE_TIMEZONE_ISSUE, DATABASE_TIMEZONE_MYSQL_ONLY_PATCH),
    ).toBe(false)
  })

  test("database timezone issue rejects sqlite SQL-only arity change without UDF registration", () => {
    expect(
      declaredExpectedPatchMatch(DATABASE_TIMEZONE_ISSUE, DATABASE_TIMEZONE_SQLITE_OPS_ONLY_PATCH),
    ).toBe(false)
  })

  test("database timezone issue accepts mysql/oracle/sqlite contract patch", () => {
    expect(declaredExpectedPatchMatch(DATABASE_TIMEZONE_ISSUE, DATABASE_TIMEZONE_GOLD_PATCH)).toBe(
      true,
    )
  })
})
