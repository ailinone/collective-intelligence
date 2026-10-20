#!/usr/bin/env python3
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

"""Tests for scripts/ci/run-eval-in-overlay.sh and eval-overlay-runner.cjs.

Run from anywhere:

    python3 -m unittest discover -s scripts/ci -p 'test_*.py' -v

Stdlib only. The script is run by a real bash in "local docker" mode with a fake
`docker` on PATH. The fake `docker run` does what the real one would do for the
eval container: it keeps the argv and stdin it was given, then runs the container's
`node -e SCRIPT` for real (with the -e variables as environment and the recorded
stdin), so the whole path is exercised end to end: token via stdin, benchmark
unpacked and imported, results printed back and restored, exit code propagated.
A local HTTP server plays the ci_api VIP.

Needs `node` (the same Node the Quality Gates job installs). The tests are skipped
only when it is missing, and the workflow installs it before this suite runs.
"""

import json
import os
import shutil
import subprocess
import tempfile
import threading
import unittest
from http.server import BaseHTTPRequestHandler, HTTPServer

HERE = os.path.dirname(os.path.abspath(__file__))
SCRIPT = os.path.join(HERE, "run-eval-in-overlay.sh")
BASH = os.environ.get("BASH_BIN", "bash")
TOKEN = "tok-3f9a7c1e-do-not-leak"

FAKE_DOCKER = r"""#!/usr/bin/env bash
set -u
st="$FAKE_STATE"
printf '%s\n' "$*" >> "$st/argv.log"
fmt=""
prev=""
for a in "$@"; do
  [ "$prev" = "--format" ] && fmt="$a"
  prev="$a"
done
case "$1" in
  info) echo "active|true|fake-manager" ;;
  network) echo "overlay|true" ;;
  service)
    case "$2" in
      ls) exit 0 ;;
      # ci_api_node_image: the image of the live ci_api spec.
      *) echo "fake/ci-api:1@sha256:00" ;;
    esac
    ;;
  ps) exit 0 ;;
  rm) echo "$*" >> "$st/removed" ;;
  run)
    printf '%s\n' "$@" > "$st/run.argv"
    cat > "$st/run.stdin"
    script="${!#}"
    envs=()
    is_eval=0
    args=("$@")
    n=${#args[@]}
    for ((i = 0; i < n - 2; i++)); do
      if [ "${args[$i]}" = "-e" ]; then
        envs+=("${args[$((i + 1))]}")
        case "${args[$((i + 1))]}" in EVAL_SCRIPT_NAME=*) is_eval=1 ;; esac
      fi
    done
    if [ "$is_eval" = 0 ]; then
      # ci_api_http (the /health preflight): status line, then the body.
      printf '%s\n{}' "${FAKE_HEALTH:-200}"
      exit 0
    fi
    cp "$st/run.argv" "$st/eval.argv"
    if [ -n "${FAKE_RUN_RC:-}" ]; then exit "$FAKE_RUN_RC"; fi
    if [ -n "${FAKE_EVIL:-}" ]; then
      printf 'progress line\n@@EVAL_RESULTS@@../escape@@aGk=\n@@EVAL_RESULTS@@ok.json@@e30=\n'
      exit 0
    fi
    exec env -i PATH="$PATH" EVAL_WORKDIR="$st/work" "${envs[@]}" \
      node -e "$script" < "$st/run.stdin"
    ;;
  *) echo "unexpected docker call: $*" >&2; exit 1 ;;
esac
"""

STUB_EVAL = r"""import { writeFileSync, mkdirSync } from 'fs';
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..');
const base = process.env.EVAL_API_BASE_URL;
const res = await fetch(`${base}/v1/chat/completions`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${process.env.EVAL_BEARER_TOKEN}`, 'Content-Type': 'application/json' },
  body: '{}',
});
mkdirSync(join(ROOT, 'eval-results'), { recursive: true });
writeFileSync(
  join(ROOT, 'eval-results', 'stub.json'),
  JSON.stringify({ status: res.status, args: process.argv.slice(2), evalArgsInEnv: Object.keys(process.env).filter((k) => k === 'EVAL_ARGS' || k === 'EVAL_SCRIPT_NAME') }),
);
process.stdout.write('stub done');
if (process.argv.includes('--fail')) process.exit(1);
if (process.argv.includes('--hang')) setInterval(() => {}, 1000);
"""


class _Api(BaseHTTPRequestHandler):
    seen = []

    def do_POST(self):  # noqa: N802
        length = int(self.headers.get("content-length") or 0)
        self.rfile.read(length)
        _Api.seen.append(self.headers.get("Authorization"))
        self.send_response(200)
        self.send_header("content-type", "application/json")
        self.end_headers()
        self.wfile.write(b"{}")

    def log_message(self, *args):  # silence
        pass


@unittest.skipUnless(shutil.which("node"), "node is required")
class RunEvalInOverlayTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.server = HTTPServer(("127.0.0.1", 0), _Api)
        cls.port = cls.server.server_address[1]
        threading.Thread(target=cls.server.serve_forever, daemon=True).start()

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()

    def setUp(self):
        _Api.seen = []
        self.tmp = tempfile.mkdtemp(prefix="eval-overlay-test-")
        self.addCleanup(shutil.rmtree, self.tmp, True)
        self.bin = os.path.join(self.tmp, "bin")
        self.state = os.path.join(self.tmp, "state")
        self.out = os.path.join(self.tmp, "out", "eval-results")
        os.makedirs(self.bin)
        os.makedirs(self.state)
        docker = os.path.join(self.bin, "docker")
        with open(docker, "w") as fh:
            fh.write(FAKE_DOCKER)
        os.chmod(docker, 0o755)
        self.stub = os.path.join(self.tmp, "stub-eval.mjs")
        with open(self.stub, "w") as fh:
            fh.write(STUB_EVAL)

    def run_script(self, *args, token=TOKEN, extra_env=None):
        env = {
            "PATH": self.bin + os.pathsep + os.environ["PATH"],
            "HOME": self.tmp,
            "FAKE_STATE": self.state,
            "CI_API_BASE_URL": f"http://127.0.0.1:{self.port}",
            "GITHUB_RUN_ID": "4242",
        }
        if token is not None:
            env["EVAL_BEARER_TOKEN"] = token
        env.update(extra_env or {})
        return subprocess.run(
            [BASH, SCRIPT, "--out", self.out, *args],
            env=env,
            capture_output=True,
            text=True,
            timeout=120,
        )

    def read_state(self, name):
        with open(os.path.join(self.state, name)) as fh:
            return fh.read()

    def test_runs_the_benchmark_and_restores_results(self):
        r = self.run_script(self.stub, "--", "--ci", "--fail-threshold=0.03")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        with open(os.path.join(self.out, "stub.json")) as fh:
            result = json.load(fh)
        self.assertEqual(result["status"], 200)
        self.assertEqual(result["args"], ["--ci", "--fail-threshold=0.03"])
        self.assertEqual(result["evalArgsInEnv"], [], "runner plumbing must not leak into the benchmark env")
        self.assertIn("stub done", r.stdout)
        self.assertNotIn("@@EVAL_RESULTS@@", r.stdout, "result frames must not reach the job log")
        self.assertEqual(_Api.seen, [f"Bearer {TOKEN}"])

    def test_token_travels_on_stdin_only(self):
        r = self.run_script(self.stub, "--", "--ci")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        for name in ("argv.log", "eval.argv"):
            self.assertNotIn(TOKEN, self.read_state(name), f"token leaked into docker argv ({name})")
        self.assertTrue(self.read_state("run.stdin").startswith(TOKEN + "\n"))
        self.assertNotIn(TOKEN, r.stdout + r.stderr)

    def test_container_is_locked_down_and_on_the_overlay(self):
        r = self.run_script(self.stub, "--", "--ci")
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        argv = self.read_state("eval.argv").split("\n")
        for flag in ("--read-only", "--rm", "--log-driver", "--cap-drop"):
            self.assertIn(flag, argv)
        self.assertEqual(argv[argv.index("--network") + 1], "ci_default")
        self.assertEqual(argv[argv.index("--pull") + 1], "never")
        self.assertIn("EVAL_API_BASE_URL=" + f"http://127.0.0.1:{self.port}", argv)

    def test_benchmark_failure_exit_code_is_propagated_and_results_kept(self):
        r = self.run_script(self.stub, "--", "--ci", "--fail")
        self.assertEqual(r.returncode, 1, r.stdout + r.stderr)
        self.assertTrue(os.path.exists(os.path.join(self.out, "stub.json")))

    def test_missing_token_fails_before_touching_docker_run(self):
        r = self.run_script(self.stub, token="")
        self.assertNotEqual(r.returncode, 0)
        self.assertIn("EVAL_BEARER_TOKEN is empty", r.stdout + r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.state, "eval.argv")))

    def test_rejects_arguments_that_are_not_plain_flags(self):
        for bad in ("--ci;id", "--x=a b", "ci", "--x=$(id)"):
            r = self.run_script(self.stub, "--", bad)
            self.assertEqual(r.returncode, 2, f"{bad!r}: {r.stdout}{r.stderr}")
        self.assertFalse(os.path.exists(os.path.join(self.state, "eval.argv")))

    def test_unhealthy_api_stops_before_running_the_benchmark(self):
        r = self.run_script(self.stub, "--", "--ci", extra_env={"FAKE_HEALTH": "503"})
        self.assertEqual(r.returncode, 3, r.stdout + r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.state, "eval.argv")))

    def test_timeout_is_reported(self):
        r = self.run_script(self.stub, "--", "--ci", extra_env={"FAKE_RUN_RC": "124"})
        self.assertEqual(r.returncode, 124, r.stdout + r.stderr)
        self.assertIn("timed out", r.stdout + r.stderr)

    def test_soft_deadline_stops_a_hanging_benchmark_and_keeps_its_results(self):
        r = self.run_script(self.stub, "--", "--ci", "--hang", extra_env={"EVAL_SOFT_TIMEOUT_S": "2"})
        self.assertEqual(r.returncode, 124, r.stdout + r.stderr)
        self.assertIn("soft deadline", r.stdout + r.stderr)
        self.assertTrue(os.path.exists(os.path.join(self.out, "stub.json")), "results written before the hang must survive")

    def test_unsafe_result_names_are_ignored(self):
        r = self.run_script(self.stub, "--", "--ci", extra_env={"FAKE_EVIL": "1"})
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)
        self.assertFalse(os.path.exists(os.path.join(self.tmp, "out", "escape")))
        self.assertFalse(os.path.exists(os.path.join(self.out, "escape")))
        self.assertTrue(os.path.exists(os.path.join(self.out, "ok.json")))
        self.assertIn("unsafe name", r.stdout + r.stderr)

    def test_sweep_mode_removes_this_runs_leftovers_without_a_token(self):
        r = self.run_script("--sweep", token=None)
        # The fake docker answers `ps`/`service ls` with "unexpected docker call",
        # which the sweep tolerates; what matters is that no token is needed.
        self.assertEqual(r.returncode, 0, r.stdout + r.stderr)


if __name__ == "__main__":
    unittest.main()
