#!/bin/sh
# Offline stand-in for commitlint (phase 4a, Task 2): reads the message file git passes as $1 and rejects a subject
# that does not start with "<TICKET-KEY>: ".
set -eu
subject=$(head -n 1 "$1")
case "$subject" in
  [A-Z]*-[0-9]*": "?*) echo "fake-commitlint: ok"; exit 0 ;;
esac
echo "fake-commitlint: subject must start with '<KEY>: ' (got: $subject)" >&2
echo "fake-commitlint: found 1 problems, 0 warnings" >&2
exit 1
