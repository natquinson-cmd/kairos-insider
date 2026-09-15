#!/usr/bin/env bash
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
HELPER="$ROOT/.github/scripts/kv-put-with-retry.sh"
WORKFLOW="$ROOT/.github/workflows/update-13f.yml"

fail() {
  echo "FAIL: $*" >&2
  exit 1
}

assert_file_lines() {
  local file="$1"
  shift
  local expected actual
  expected="$(printf '%s\n' "$@")"
  actual="$(cat "$file" 2>/dev/null || true)"
  [[ "$actual" == "$expected" ]] || fail "$file: expected [$expected], got [$actual]"
}

[[ -f "$HELPER" ]] || fail "missing retry helper: $HELPER"

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin"
touch "$tmp/data.json"

cat > "$tmp/bin/wrangler" <<'FAKE_WRANGLER'
#!/usr/bin/env bash
set -euo pipefail
count=0
[[ ! -f "$FAKE_WRANGLER_COUNT" ]] || count="$(cat "$FAKE_WRANGLER_COUNT")"
count=$((count + 1))
printf '%s' "$count" > "$FAKE_WRANGLER_COUNT"
printf '%s\n' "$*" >> "$FAKE_WRANGLER_CALLS"
case "$FAKE_WRANGLER_MODE" in
  transient) [[ "$count" -ge 3 ]] ;;
  permanent) exit 1 ;;
  success) exit 0 ;;
  by-key)
    [[ "$*" != *'etf-ita'* ]]
    ;;
  *) exit 2 ;;
esac
FAKE_WRANGLER

cat > "$tmp/bin/sleep" <<'FAKE_SLEEP'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$1" >> "$FAKE_SLEEP_CALLS"
FAKE_SLEEP
chmod +x "$tmp/bin/wrangler" "$tmp/bin/sleep"

export PATH="$tmp/bin:$PATH"
export FAKE_WRANGLER_COUNT="$tmp/count"
export FAKE_WRANGLER_CALLS="$tmp/calls"
export FAKE_SLEEP_CALLS="$tmp/sleeps"

# Two transient failures must recover on the third attempt with 5s/10s backoff.
export FAKE_WRANGLER_MODE=transient
bash -c 'source "$1"; kv_put_with_retry namespace-id etf-ita "$2"' _ "$HELPER" "$tmp/data.json"
assert_file_lines "$FAKE_WRANGLER_COUNT" 3
assert_file_lines "$FAKE_SLEEP_CALLS" 5 10

# A permanent failure must be returned after three attempts.
rm -f "$FAKE_WRANGLER_COUNT" "$FAKE_WRANGLER_CALLS" "$FAKE_SLEEP_CALLS"
export FAKE_WRANGLER_MODE=permanent
if bash -c 'source "$1"; kv_put_with_retry namespace-id etf-ita "$2"' _ "$HELPER" "$tmp/data.json"; then
  fail "a permanently failing upload returned success"
fi
assert_file_lines "$FAKE_WRANGLER_COUNT" 3
assert_file_lines "$FAKE_SLEEP_CALLS" 5 10

# A multi-key block must attempt later keys before reporting the failures.
rm -f "$FAKE_WRANGLER_COUNT" "$FAKE_WRANGLER_CALLS" "$FAKE_SLEEP_CALLS"
export FAKE_WRANGLER_MODE=by-key
if bash -c '
  source "$1"
  failures=()
  if ! kv_put_with_retry namespace-id etf-ita "$2"; then failures+=(etf-ita); fi
  if ! kv_put_with_retry namespace-id etf-ura "$2"; then failures+=(etf-ura); fi
  kv_fail_if_any "${failures[@]}"
' _ "$HELPER" "$tmp/data.json"; then
  fail "a multi-key block hid its exhausted retry"
fi
assert_file_lines "$FAKE_WRANGLER_COUNT" 4
grep -q 'etf-ura' "$FAKE_WRANGLER_CALLS" || fail "the key after a permanent failure was skipped"

# The aggregate helper succeeds for an empty list and reports every failed key.
bash -c 'source "$1"; kv_fail_if_any' _ "$HELPER"
if output="$(bash -c 'source "$1"; kv_fail_if_any first-key second-key' _ "$HELPER" 2>&1)"; then
  fail "the aggregate helper accepted failed keys"
fi
[[ "$output" == *'first-key'* && "$output" == *'second-key'* ]] || fail "aggregate output omitted a key"

# Workflow integration: all KV writes use the helper, ETF failure is deferred,
# and the final report runs after the daily snapshots and summary.
python - "$WORKFLOW" <<'PY'
import pathlib
import sys

text = pathlib.Path(sys.argv[1]).read_text(encoding='utf-8')
assert 'wrangler kv key put' not in text
assert text.count('kv_put_with_retry') == 11
assert text.count('kv-put-with-retry.sh') >= 7
assert 'id: upload_13f' in text
assert 'id: upload_etf' in text
assert 'continue-on-error: true' in text[text.index('- name: Upload ETF data to KV'):text.index('# ===== SHORT INTEREST')]
assert text.index('- name: Report critical KV upload failures') > text.index('- name: Summary')
assert 'steps.upload_13f.outcome' in text
assert 'steps.upload_etf.outcome' in text
PY

echo "KV upload retry tests passed"
