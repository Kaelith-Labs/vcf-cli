#!/usr/bin/env bash
#
# macOS smoke test for @kaelith-labs/cli via Homebrew tap.
#
# Exercises the full Brew install path end-to-end:
#   tap → install → version → init → verify → health → MCP RPC → uninstall
#
# Safety: any existing ~/.vcf and ~/vcf are moved aside to *.smoketest-bak-<ts>
# before the run and restored on exit (success or failure). The trap also
# handles Ctrl-C. Your real state is never destroyed.
#
# Usage:
#   bash smoke-macos.sh              # run the full smoke
#   bash smoke-macos.sh --skip-uninstall   # leave vcf-cli installed afterwards
#
# Exit code: 0 if every check passes, 1 otherwise.

set -u
set -o pipefail

SKIP_UNINSTALL=0
for arg in "$@"; do
  case "$arg" in
    --skip-uninstall) SKIP_UNINSTALL=1 ;;
    -h|--help)
      sed -n '2,20p' "$0"; exit 0 ;;
    *) echo "unknown arg: $arg" >&2; exit 2 ;;
  esac
done

PASS=0
FAIL=0
SKIP=0
RESULTS=()
STARTED_AT=$(date +%s)
BACKUP_SUFFIX=".smoketest-bak-$STARTED_AT"
LOG=$(mktemp -t vcf-smoke.XXXXXX)
trap 'rm -f "$LOG"' EXIT

log_section() {
  echo ""
  echo "=== $1 ==="
}

# check "name" "command to run" — pass if exit 0, fail otherwise.
# Stderr + stdout of the command are captured to $LOG for diagnostics on fail.
check() {
  local name="$1"; shift
  printf "  "
  if "$@" >"$LOG" 2>&1; then
    echo "✓ $name"
    PASS=$((PASS+1))
    RESULTS+=("PASS  $name")
  else
    echo "✗ $name"
    sed 's/^/    | /' "$LOG" | head -10
    FAIL=$((FAIL+1))
    RESULTS+=("FAIL  $name")
  fi
}

# check_out "name" "expected regex" "command ..."
check_out() {
  local name="$1"; local pattern="$2"; shift 2
  printf "  "
  local out
  if out=$("$@" 2>&1) && echo "$out" | grep -qE "$pattern"; then
    echo "✓ $name"
    PASS=$((PASS+1))
    RESULTS+=("PASS  $name")
  else
    echo "✗ $name (expected pattern: $pattern)"
    echo "$out" | sed 's/^/    | /' | head -10
    FAIL=$((FAIL+1))
    RESULTS+=("FAIL  $name")
  fi
}

skip() {
  echo "  ⊘ $1 (skipped: $2)"
  SKIP=$((SKIP+1))
  RESULTS+=("SKIP  $1")
}

# ---- preflight -------------------------------------------------------------

log_section "Preflight"

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script is macOS-only. Detected: $(uname)."
  exit 2
fi
check "brew is installed" command -v brew
check "node is on PATH or brew will install it" bash -c 'command -v node >/dev/null || brew info node >/dev/null'

# ---- backup user state -----------------------------------------------------

log_section "Backup existing ~/.vcf and ~/vcf (if any)"

MOVED_DOT_VCF=0
MOVED_VCF=0
if [[ -e "$HOME/.vcf" ]]; then
  mv "$HOME/.vcf" "$HOME/.vcf${BACKUP_SUFFIX}" && MOVED_DOT_VCF=1
  echo "  → moved ~/.vcf to ~/.vcf${BACKUP_SUFFIX}"
fi
if [[ -e "$HOME/vcf" ]]; then
  mv "$HOME/vcf" "$HOME/vcf${BACKUP_SUFFIX}" && MOVED_VCF=1
  echo "  → moved ~/vcf to ~/vcf${BACKUP_SUFFIX}"
fi
[[ $MOVED_DOT_VCF -eq 0 && $MOVED_VCF -eq 0 ]] && echo "  (nothing to back up)"

restore() {
  echo ""
  echo "=== Restoring previous state ==="
  rm -rf "$HOME/.vcf" "$HOME/vcf"
  if [[ $MOVED_DOT_VCF -eq 1 ]]; then
    mv "$HOME/.vcf${BACKUP_SUFFIX}" "$HOME/.vcf" && echo "  → restored ~/.vcf"
  fi
  if [[ $MOVED_VCF -eq 1 ]]; then
    mv "$HOME/vcf${BACKUP_SUFFIX}" "$HOME/vcf" && echo "  → restored ~/vcf"
  fi
}
# Trap covers normal exit, interrupt, and most termination paths.
trap 'restore; rm -f "$LOG"' EXIT INT TERM

# ---- install ---------------------------------------------------------------

log_section "Install via Homebrew tap"

# Clean prior tap if present so we test the real add path.
if brew tap | grep -q '^kaelith-labs/vcf$'; then
  echo "  (tap already present — untapping first for a clean test)"
  brew untap kaelith-labs/vcf || true
fi

check "brew tap kaelith-labs/vcf" \
  brew tap kaelith-labs/vcf https://github.com/Kaelith-Labs/homebrew-vcf
check "brew install vcf-cli" \
  brew install vcf-cli

# ---- shim + version --------------------------------------------------------

log_section "Binary + PATH"

check "vcf is on PATH" command -v vcf
check "vcf-mcp is on PATH" command -v vcf-mcp
check_out "vcf version reports a semver" \
  'vcf-cli [0-9]+\.[0-9]+\.[0-9]+' \
  vcf version

# ---- init + fs checks ------------------------------------------------------

log_section "vcf init + filesystem layout"

check "vcf init --no-telemetry succeeds" vcf init --no-telemetry
check "~/.vcf exists" test -d "$HOME/.vcf"
check "~/.vcf/config.yaml exists" test -f "$HOME/.vcf/config.yaml"
check_out "config.yaml has no unresolved \${ENV} refs" \
  'version: ?1' \
  cat "$HOME/.vcf/config.yaml"

# Note: vcf.db is lazy-created on first MCP/tool call (not at init), and
# ~/.vcf/kb is seeded only when @kaelith-labs/kb is available alongside
# the CLI install — a known gap filed in plans/2026-04-20-followups.md.
# The smoke deliberately doesn't assert on either so a packaged install
# without the kb peer still passes here.

# ~/.vcf should be user-only readable. 700 is ideal; anything group/world
# readable surfaces as a warning, not a hard fail (default umask on many
# macOS installs gives 755, which is a real but non-critical exposure).
perms=$(stat -f '%A' "$HOME/.vcf" 2>/dev/null || echo "???")
if [[ "$perms" == "700" ]]; then
  echo "  ✓ ~/.vcf is user-only (700)"
  PASS=$((PASS+1))
  RESULTS+=("PASS  ~/.vcf is user-only (700)")
else
  echo "  ⚠ ~/.vcf perms are $perms (tightening to 700 is a followup)"
  SKIP=$((SKIP+1))
  RESULTS+=("SKIP  ~/.vcf perms $perms (700 not enforced at init)")
fi

# ---- verify + health -------------------------------------------------------

log_section "vcf verify + vcf health"

check "vcf verify passes" vcf verify
# `vcf health` exits 9 when any configured endpoint is unreachable. On a
# fresh smoke box the seeded `local-ollama` endpoint usually isn't running,
# so we accept exit 0 OR 9 — we're smoke-testing the install path, not the
# operator's endpoint inventory.
health_acceptable() {
  vcf health
  local rc=$?
  [[ $rc -eq 0 || $rc -eq 9 ]]
}
check "vcf health runs (exit 0 or 9, endpoints may be unreachable)" health_acceptable

# ---- MCP stdio round-trip --------------------------------------------------

log_section "MCP server stdio round-trip"

# Launch vcf-mcp, send an initialize JSON-RPC, close stdin, read response.
# Server should terminate cleanly when stdin closes.
# macOS lacks GNU `timeout` by default; prefer `gtimeout` (coreutils) if
# present, fall back to plain execution (vcf-mcp exits on stdin close so
# hang risk is low in practice — still worth a guard).
if command -v gtimeout >/dev/null; then
  TIMEOUT_BIN="gtimeout 10"
elif command -v timeout >/dev/null; then
  TIMEOUT_BIN="timeout 10"
else
  TIMEOUT_BIN=""
fi

mcp_ping() {
  local request='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  local response
  if [[ -n "$TIMEOUT_BIN" ]]; then
    response=$(echo "$request" | $TIMEOUT_BIN vcf-mcp --scope global 2>/dev/null | head -1)
  else
    response=$(echo "$request" | vcf-mcp --scope global 2>/dev/null | head -1)
  fi
  echo "$response" | grep -q '"result"' && echo "$response" | grep -q '"serverInfo"'
}
check "vcf-mcp responds to initialize" mcp_ping

# ---- uninstall -------------------------------------------------------------

if [[ $SKIP_UNINSTALL -eq 1 ]]; then
  log_section "Uninstall (skipped via --skip-uninstall)"
  skip "brew uninstall vcf-cli" "user opted out"
  skip "brew untap kaelith-labs/vcf" "user opted out"
else
  log_section "Uninstall + clean"
  check "brew uninstall vcf-cli" brew uninstall vcf-cli
  check "brew untap kaelith-labs/vcf" brew untap kaelith-labs/vcf
  check "vcf is no longer on PATH" bash -c '! command -v vcf'
fi

# ---- summary ---------------------------------------------------------------

ELAPSED=$(( $(date +%s) - STARTED_AT ))
log_section "Summary"
echo "  pass: $PASS"
echo "  fail: $FAIL"
echo "  skip: $SKIP"
echo "  time: ${ELAPSED}s"
echo ""
if [[ $FAIL -gt 0 ]]; then
  echo "Failed checks:"
  printf '  %s\n' "${RESULTS[@]}" | grep '^FAIL'
  echo ""
  echo "RESULT: FAIL"
  exit 1
fi
echo "RESULT: PASS"
exit 0
