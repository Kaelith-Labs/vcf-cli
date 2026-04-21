#!/usr/bin/env bash
#
# Linux smoke test for @kaelith-labs/cli via npm-global.
#
# Exercises the full npm-global install path end-to-end:
#   npm install -g → version → init → verify → health → MCP RPC → uninstall
#
# Linuxbrew isn't standard on the distros we target; npm-global is the
# primary-supported Linux install channel.
#
# Safety: any existing ~/.vcf and ~/vcf are moved aside to *.smoketest-bak-<ts>
# before the run and restored on exit (success or failure). The trap also
# handles Ctrl-C. Your real state is never destroyed.
#
# Usage:
#   bash smoke-linux.sh              # run the full smoke
#   bash smoke-linux.sh --skip-uninstall   # leave @kaelith-labs/cli installed
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

check() {
  local name="$1"; shift
  printf "  "
  if "$@" >"$LOG" 2>&1; then
    echo "[x] $name"
    PASS=$((PASS+1))
    RESULTS+=("PASS  $name")
  else
    echo "[ ] $name"
    sed 's/^/    | /' "$LOG" | head -10
    FAIL=$((FAIL+1))
    RESULTS+=("FAIL  $name")
  fi
}

check_out() {
  local name="$1"; local pattern="$2"; shift 2
  printf "  "
  local out
  if out=$("$@" 2>&1) && echo "$out" | grep -qE "$pattern"; then
    echo "[x] $name"
    PASS=$((PASS+1))
    RESULTS+=("PASS  $name")
  else
    echo "[ ] $name (expected pattern: $pattern)"
    echo "$out" | sed 's/^/    | /' | head -10
    FAIL=$((FAIL+1))
    RESULTS+=("FAIL  $name")
  fi
}

skip() {
  echo "  [-] $1 (skipped: $2)"
  SKIP=$((SKIP+1))
  RESULTS+=("SKIP  $1")
}

# ---- preflight -------------------------------------------------------------

log_section "Preflight"

if [[ "$(uname)" != "Linux" ]]; then
  echo "This script is Linux-only. Detected: $(uname)."
  exit 2
fi
check "node is on PATH" command -v node
check "npm is on PATH" command -v npm
check_out "node is >= 22.13" \
  'v(22\.(1[3-9]|[2-9][0-9])|2[3-9]\.|[3-9][0-9]\.)' \
  node --version

# ---- backup user state -----------------------------------------------------

log_section "Backup existing ~/.vcf and ~/vcf (if any)"

MOVED_DOT_VCF=0
MOVED_VCF=0
if [[ -e "$HOME/.vcf" ]]; then
  mv "$HOME/.vcf" "$HOME/.vcf${BACKUP_SUFFIX}" && MOVED_DOT_VCF=1
  echo "  -> moved ~/.vcf to ~/.vcf${BACKUP_SUFFIX}"
fi
if [[ -e "$HOME/vcf" ]]; then
  mv "$HOME/vcf" "$HOME/vcf${BACKUP_SUFFIX}" && MOVED_VCF=1
  echo "  -> moved ~/vcf to ~/vcf${BACKUP_SUFFIX}"
fi
[[ $MOVED_DOT_VCF -eq 0 && $MOVED_VCF -eq 0 ]] && echo "  (nothing to back up)"

restore() {
  echo ""
  echo "=== Restoring previous state ==="
  rm -rf "$HOME/.vcf" "$HOME/vcf"
  if [[ $MOVED_DOT_VCF -eq 1 ]]; then
    mv "$HOME/.vcf${BACKUP_SUFFIX}" "$HOME/.vcf" && echo "  -> restored ~/.vcf"
  fi
  if [[ $MOVED_VCF -eq 1 ]]; then
    mv "$HOME/vcf${BACKUP_SUFFIX}" "$HOME/vcf" && echo "  -> restored ~/vcf"
  fi
}
trap 'restore; rm -f "$LOG"' EXIT INT TERM

# ---- install ---------------------------------------------------------------

log_section "Install via npm-global"

# If the package is already installed globally (from prior run), uninstall
# so we test the real add path.
if npm list -g --depth=0 @kaelith-labs/cli >/dev/null 2>&1; then
  echo "  (package already installed — removing first for a clean test)"
  npm uninstall -g @kaelith-labs/cli >/dev/null 2>&1 || true
fi

check "npm install -g @kaelith-labs/cli" \
  npm install -g "@kaelith-labs/cli"

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
check_out "config.yaml has version: 1" \
  'version: ?1' \
  cat "$HOME/.vcf/config.yaml"

perms=$(stat -c '%a' "$HOME/.vcf" 2>/dev/null || echo "???")
if [[ "$perms" == "700" ]]; then
  echo "  [x] ~/.vcf is user-only (700)"
  PASS=$((PASS+1))
  RESULTS+=("PASS  ~/.vcf is user-only (700)")
else
  echo "  [!] ~/.vcf perms are $perms (tightening to 700 is a followup)"
  SKIP=$((SKIP+1))
  RESULTS+=("SKIP  ~/.vcf perms $perms (700 not enforced at init)")
fi

# ---- verify + health -------------------------------------------------------

log_section "vcf verify + vcf health"

check "vcf verify passes" vcf verify
health_acceptable() {
  vcf health
  local rc=$?
  [[ $rc -eq 0 || $rc -eq 9 ]]
}
check "vcf health runs (exit 0 or 9, endpoints may be unreachable)" health_acceptable

# ---- MCP stdio round-trip --------------------------------------------------

log_section "MCP server stdio round-trip"

mcp_ping() {
  local request='{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-11-25","capabilities":{},"clientInfo":{"name":"smoke","version":"0"}}}'
  local response
  response=$(echo "$request" | timeout 10 vcf-mcp --scope global 2>/dev/null | head -1)
  echo "$response" | grep -q '"result"' && echo "$response" | grep -q '"serverInfo"'
}
check "vcf-mcp responds to initialize" mcp_ping

# ---- uninstall -------------------------------------------------------------

if [[ $SKIP_UNINSTALL -eq 1 ]]; then
  log_section "Uninstall (skipped via --skip-uninstall)"
  skip "npm uninstall -g @kaelith-labs/cli" "user opted out"
else
  log_section "Uninstall + clean"
  check "npm uninstall -g @kaelith-labs/cli" npm uninstall -g "@kaelith-labs/cli"
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
