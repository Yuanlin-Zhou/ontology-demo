#!/usr/bin/env bash
# Consistent Java and dependency selectors for local evaluation and CI.
set -euo pipefail
cd "$(dirname "$0")/.."
action="${1:-check}"
if [[ -n "${JAVA_HOME:-}" && -x "$JAVA_HOME/bin/javac" ]]; then
  eval_jdk="$JAVA_HOME"
elif [[ -x .tools/jdk/bin/javac ]]; then
  eval_jdk="$PWD/.tools/jdk"
elif command -v javac >/dev/null; then
  eval_javac_path=$(readlink -f "$(command -v javac)")
  eval_jdk=$(dirname "$(dirname "$eval_javac_path")")
else
  echo 'JDK missing: run npm run setup:java first.' >&2
  exit 1
fi
case "$action" in
  setup) exec python3 scripts/setup-eval-java.py --jdk "$eval_jdk" ;;
  check|test) ;;
  *) echo 'Usage: bash scripts/eval-env.sh setup|check|test' >&2; exit 1 ;;
esac
python3 - <<'PY'
import hashlib, json, pathlib
root = pathlib.Path.cwd()
for entry in json.loads((root / 'eval/java-dependencies.json').read_text()):
    path = root / '.eval-cache/java-deps' / entry['url'].rsplit('/', 1)[1]
    if not path.exists() or hashlib.sha256(path.read_bytes()).hexdigest() != entry['sha256']:
        raise SystemExit('Evaluation dependency missing or invalid: ' + path.name + '; run npm run setup:eval')
if not (root / '.eval-cache/java-deps/poc-order-input.jar').exists():
    raise SystemExit('Order input fixture missing; run npm run setup:eval')
print('Pinned Java dependencies verified.')
PY
export EVAL_JAVAC="$eval_jdk/bin/javac"
export EVAL_JAVA="$eval_jdk/bin/java"
export EVAL_CLASSPATH="$PWD/.eval-cache/java-deps/*"
if [[ "$action" == test ]]; then exec npm test; fi
"$EVAL_JAVAC" -version
