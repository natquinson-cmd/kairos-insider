#!/usr/bin/env bash

# Retry idempotent Cloudflare KV writes without hiding permanent failures.
# Callers that publish several keys should collect failures and call
# kv_fail_if_any after every key has been attempted.

kv_put_with_retry() {
  if [[ "$#" -ne 3 ]]; then
    echo "Usage: kv_put_with_retry <namespace-id> <key> <file>" >&2
    return 2
  fi

  local namespace_id="$1"
  local key="$2"
  local file_path="$3"
  local max_attempts="${KV_PUT_MAX_ATTEMPTS:-3}"
  local base_delay="${KV_PUT_BASE_DELAY_SECONDS:-5}"
  local attempt delay

  if [[ ! "$max_attempts" =~ ^[1-9][0-9]*$ ]]; then
    echo "KV_PUT_MAX_ATTEMPTS must be a positive integer" >&2
    return 2
  fi
  if [[ ! "$base_delay" =~ ^[0-9]+$ ]]; then
    echo "KV_PUT_BASE_DELAY_SECONDS must be a non-negative integer" >&2
    return 2
  fi

  for ((attempt = 1; attempt <= max_attempts; attempt++)); do
    if wrangler kv key put \
      --namespace-id="$namespace_id" \
      --remote "$key" \
      --path="$file_path"; then
      echo "Uploaded ${key} (attempt ${attempt}/${max_attempts})"
      return 0
    fi

    if ((attempt < max_attempts)); then
      delay=$((base_delay * (1 << (attempt - 1))))
      echo "::warning title=Cloudflare KV retry::${key} failed on attempt ${attempt}/${max_attempts}; retrying in ${delay}s"
      sleep "$delay"
    fi
  done

  echo "::warning title=Cloudflare KV upload incomplete::${key} failed after ${max_attempts} attempts"
  return 1
}

kv_fail_if_any() {
  if [[ "$#" -eq 0 ]]; then
    return 0
  fi

  local joined
  printf -v joined '%s, ' "$@"
  joined="${joined%, }"
  echo "::error title=Cloudflare KV uploads incomplete::Retries exhausted for: ${joined}"
  return 1
}
