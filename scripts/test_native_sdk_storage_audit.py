"""Synthetic regressions only. Never load an SDK module or start a child."""
import contextlib
import importlib.util
import io
import json
from pathlib import Path
import runpy
import sys
import tempfile
import unittest
from unittest.mock import patch


SCRIPT = Path(__file__).with_name("native-sdk-storage-audit.py")
spec = importlib.util.spec_from_file_location("storage_audit", SCRIPT)
audit = importlib.util.module_from_spec(spec)
spec.loader.exec_module(audit)


class StorageAuditTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fo013a2-static-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.sdk = self.root / "sdk"
        for relative in audit.FILES.values():
            file = self.sdk / relative
            file.parent.mkdir(parents=True, exist_ok=True)
            file.write_text('{"version":"synthetic"}' if relative == "package.json" else "// fixture\n")

    def test_missing_sdk_and_sources_remain_blocked(self):
        for root in [self.root / "missing", self.root]:
            result = audit.inspect_sdk(root)
            self.assertEqual(result["status"], "BLOCKED")
            self.assertTrue(result["errors"])
            self.assertFalse(result["nativeExecutionAuthorized"])

    def test_unknown_or_changed_sdk_is_never_promoted_to_safe(self):
        result = audit.inspect_sdk(self.sdk)
        self.assertFalse(result["errors"])
        self.assertEqual(result["status"], "BLOCKED")
        self.assertTrue(all(o["status"] == "UNKNOWN" for o in result["observations"].values()))
        self.assertFalse(result["nativeExecuted"])

    def test_fixed_prefix_is_only_source_evidence(self):
        (self.sdk / audit.FILES["view"]).write_text('// fixture\nthis.pipePrefix = `/private/tmp/electrobun_ipc_pipe_fixture`;\n')
        result = audit.inspect_sdk(self.sdk)
        observation = result["observations"]["fixedIpcPrefixString"]
        self.assertEqual(observation["lines"], [2])
        self.assertEqual(observation["status"], "CONFIRMED_SOURCE")
        self.assertTrue(result["runtimeIpcFileCreation"].startswith("UNVERIFIED"))
        self.assertEqual(result["status"], "BLOCKED")

    def test_symlink_to_prefix_sibling_is_rejected_before_read(self):
        outside = self.root / "sdk-sibling"
        outside.mkdir()
        secret = outside / "fixture.txt"
        secret.write_text("synthetic-canary-do-not-read")
        file = self.sdk / audit.FILES["view"]
        file.unlink()
        file.symlink_to(secret)
        result = audit.inspect_sdk(self.sdk)
        self.assertNotIn(audit.FILES["view"], result["sources"])
        self.assertTrue(result["errors"])
        self.assertNotIn("synthetic-canary", json.dumps(result))

    def test_cli_exit_cannot_be_a_safety_pass(self):
        output = io.StringIO()
        with patch.object(sys, "argv", [str(SCRIPT), "--sdk-root", str(self.sdk)]), contextlib.redirect_stdout(output):
            self.assertEqual(audit.main(), 2)
        self.assertEqual(json.loads(output.getvalue())["status"], "BLOCKED")

    def test_retired_harness_never_reads_arguments_or_launches(self):
        # A synthetic artifact without the old blocked prefix cannot enable a
        # launch. Fail at any attempt to resolve an input or spawn a child.
        for args in [[], [str(self.root), "/synthetic/launcher"], ["--force", "--approved"]]:
            with patch.object(sys, "argv", ["native-isolation-audit.py", *args]), \
                 patch("subprocess.Popen", side_effect=AssertionError("subprocess forbidden")), \
                 patch.object(Path, "resolve", side_effect=AssertionError("input access forbidden")):
                with self.assertRaisesRegex(SystemExit, "NATIVE-005 BLOCKED"):
                    runpy.run_path(str(SCRIPT.with_name("native-isolation-audit.py")), run_name="__main__")


if __name__ == "__main__":
    unittest.main()
