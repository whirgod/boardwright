#!/bin/sh
# Print the latest Claude plan usage snapshot (see docs/WORKFLOW.md#usage-limits).
# Usage: scripts/claude-usage.sh [--gate PERCENT]
#   --gate: exit 2 if the 5h window is at/above PERCENT or the 7d window is at/above 90.
set -eu

file="$HOME/.claude/state/rate-limits.json"
if [ ! -f "$file" ]; then
    echo "no usage snapshot at $file (ask the user to run /usage)" >&2
    exit 1
fi

now=$(date +%s)
jq -r --argjson now "$now" '
  def at(t): if t then (t | strftime("%Y-%m-%d %H:%M UTC")) else "?" end;
  "5h: \(.rate_limits.five_hour.used_percentage // "?")% (resets \(at(.rate_limits.five_hour.resets_at)))",
  "7d: \(.rate_limits.seven_day.used_percentage // "?")% (resets \(at(.rate_limits.seven_day.resets_at)))",
  "snapshot age: \($now - .updated_at)s"
' "$file"

if [ "${1:-}" = "--gate" ]; then
    limit=${2:?--gate needs a percentage}
    jq -e --argjson limit "$limit" '
      (.rate_limits.five_hour.used_percentage // 0) < $limit
      and (.rate_limits.seven_day.used_percentage // 0) < 90
    ' "$file" >/dev/null || exit 2
fi
