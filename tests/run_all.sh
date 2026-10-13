#!/usr/bin/env bash
# Runs every test suite. Needs node 18+, python3 with fastapi/uvicorn/websockets
# (requirements.txt + `pip install websockets`), and for the Android tests a
# Gradle + ANDROID_HOME setup (see android/README.md). Throwaway test-only
# dependencies - pyubx2/pyrtcm, geographiclib, pyproj (independent reference
# implementations) and jsdom - are installed into .test-deps/ on first run.
# The Site map's cross-checks against Ground_EO_Tracker's own code run when
# that repo is checked out next to this one (or at $GROUND_EO_TRACKER); its
# real-browser test runs when Chrome/Chromium is installed ($CHROME).
#
#   tests/run_all.sh            # everything
#   SKIP_ANDROID=1 tests/run_all.sh
set -euo pipefail
cd "$(dirname "$0")/.."
DEPS=.test-deps
GRADLE=${GRADLE:-gradle}

[ -d "$DEPS/py/pyubx2" ] || python3 -m pip install -q --target "$DEPS/py" pyubx2 pyrtcm
[ -d "$DEPS/py/pyproj" ] || python3 -m pip install -q --target "$DEPS/py" geographiclib pyproj
[ -d "$DEPS/node/node_modules/jsdom" ] || (mkdir -p "$DEPS/node" && cd "$DEPS/node" && npm init -y >/dev/null && npm install --silent jsdom@24.1.3)

echo "== reference vectors (pyubx2 / pyrtcm) =="
PYTHONPATH="$DEPS/py" python3 tests/oracle/gen_vectors.py > tests/oracle/vectors.json

echo "== web protocol layer vs reference =="
node --test tests/web/protocol.test.js
PYTHONPATH="$DEPS/py" python3 tests/oracle/check_encoders.py tests/oracle/js_frames.json

echo "== F9P simulator vs reference =="
SIM_DUMP=$(mktemp)
node tests/web/dump_sim.js > "$SIM_DUMP"
PYTHONPATH="$DEPS/py" python3 tests/web/check_sim.py "$SIM_DUMP"
rm -f "$SIM_DUMP"

echo "== site map math vs geographiclib / PROJ / Ground_EO_Tracker =="
PYTHONPATH="$DEPS/py" python3 tests/oracle/gen_site_vectors.py > tests/oracle/site_vectors.json
rm -f tests/oracle/js_site.json
node --test tests/web/sitecalc.test.js
if [ -f tests/oracle/js_site.json ]; then   # written by sitecalc.test.js when Ground_EO_Tracker is present
  python3 tests/oracle/check_site_config.py tests/oracle/js_site.json
fi

echo "== relay server =="
python3 tests/server/test_relay.py

echo "== web end-to-end (real page + relay, simulated receivers) =="
NODE_PATH="$DEPS/node/node_modules" node tests/web/e2e.js

CHROME=${CHROME:-$(command -v google-chrome || command -v chromium || command -v chromium-browser || true)}
if [ -n "$CHROME" ] && grep -q '"yaml"' tests/oracle/site_vectors.json; then
  echo "== site map in real Chrome (map, two tabs, Open -> Write -> Save) =="
  CHROME="$CHROME" NODE_PATH="$DEPS/node/node_modules" node tests/web/site_browser.js
else
  echo "== site map browser test SKIPPED (needs Chrome and Ground_EO_Tracker) =="
fi

if [ -z "${SKIP_ANDROID:-}" ]; then
  echo "== android (protocol vs reference, sessions end-to-end) =="
  (cd android && "$GRADLE" -p . :app:testDebugUnitTest --console=plain -q)
  PYTHONPATH="$DEPS/py" python3 tests/oracle/check_encoders.py tests/oracle/kt_frames.json
fi

echo
echo "ALL TEST SUITES PASSED"
