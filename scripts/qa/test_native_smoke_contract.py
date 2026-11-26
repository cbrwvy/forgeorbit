import json
from pathlib import Path
import tempfile
import unittest

from native_smoke_contract import diagnose_defaults, persistence_status, prepare_evidence_dir, decode_api_response, check_first_runtime_token


class DefaultsContractTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="fo-smoke02-contract-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name).resolve()
        for name in ("home", "projects", "data", "artifacts/App/Contents/MacOS"):
            (self.root / name).mkdir(parents=True)
        self.expected = {"home": str(self.root / "home"), "cwd": str(self.root / "projects"), "dataDir": str(self.root / "data")}

    def test_exact_isolated_response_passes(self):
        result = diagnose_defaults(self.expected, self.root, self.root / "projects")
        self.assertTrue(result["pass"])
        self.assertTrue(all(result["insideRuntimeRoot"].values()))

    def test_launcher_cwd_mismatch_is_identified_without_relaxation(self):
        response = dict(self.expected, cwd=str(self.root / "artifacts/App/Contents/MacOS"))
        result = diagnose_defaults(response, self.root, self.root / "projects")
        self.assertFalse(result["pass"])
        self.assertEqual(result["perFieldEqual"], {"home": True, "cwd": False, "dataDir": True})

    def test_explicit_native_layout_inside_root_can_pass(self):
        cwd = self.root / "artifacts/App/Contents/MacOS"
        self.assertTrue(diagnose_defaults(dict(self.expected, cwd=str(cwd)), self.root, cwd)["pass"])

    def test_external_path_refused_and_redacted_without_opening_it(self):
        result = diagnose_defaults(dict(self.expected, home="/synthetic-owner-home"), self.root, self.root / "projects")
        self.assertFalse(result["pass"])
        self.assertFalse(result["insideRuntimeRoot"]["home"])
        self.assertNotIn("/synthetic-owner-home", json.dumps(result))

    def test_prefix_sibling_and_symlink_escape_refused(self):
        for path in [str(self.root) + "-sibling", str(self.root / "escape")]:
            if path.endswith("/escape"):
                (self.root / "escape").symlink_to(self.root.parent)
            self.assertFalse(diagnose_defaults(dict(self.expected, dataDir=path), self.root, self.root / "projects")["pass"])

    def test_extra_and_missing_fields_are_reported_without_extra_values(self):
        response = {"home": self.expected["home"], "cwd": self.expected["cwd"], "token": "never-export-this"}
        result = diagnose_defaults(response, self.root, self.root / "projects")
        self.assertEqual(result["missingFields"], ["dataDir"])
        self.assertEqual(result["extraFields"], ["token"])
        self.assertNotIn("never-export-this", json.dumps(result))
        self.assertFalse(result["pass"])

    def test_non_object_and_non_string_values_refused(self):
        for response in [None, [], {**self.expected, "cwd": 17}]:
            self.assertFalse(diagnose_defaults(response, self.root, self.root / "projects")["pass"])

    def test_external_expected_cwd_cannot_be_used_as_a_bypass(self):
        with self.assertRaises(ValueError):
            diagnose_defaults(self.expected, self.root, self.root.parent)

    def test_aborted_running_is_not_a_persistence_failure_or_pass(self):
        self.assertEqual(persistence_status(None, False)["status"], "NOT_PROVEN")
        self.assertFalse(persistence_status(("round1",), False)["pass"])

    def test_missing_marker_after_completed_running_fails(self):
        self.assertEqual(persistence_status(None, True)["status"], "FAIL")

    def test_marker_after_completed_running_passes(self):
        self.assertTrue(persistence_status(("round1",), True)["pass"])

    def test_new_evidence_namespace_preserves_old_phase(self):
        old = prepare_evidence_dir(self.root)
        (old / "historical.txt").write_text("preserve")
        new = prepare_evidence_dir(self.root, self.root / "evidence/smoke03")
        self.assertNotEqual(new, old)
        self.assertEqual((old / "historical.txt").read_text(), "preserve")
        self.assertEqual(new.stat().st_mode & 0o077, 0)

    def test_evidence_outside_campaign_is_refused(self):
        for path in [self.root.parent / "outside", self.root / "evidence"]:
            with self.assertRaises(ValueError):
                prepare_evidence_dir(self.root, path)

    def test_evidence_symlink_escape_is_refused(self):
        (self.root / "evidence").mkdir()
        (self.root / "evidence/escape").symlink_to(self.root.parent)
        with self.assertRaises(ValueError):
            prepare_evidence_dir(self.root, self.root / "evidence/escape/smoke03")

    def test_preference_204_accepts_only_empty_body(self):
        self.assertIsNone(decode_api_response(204, b""))
        with self.assertRaises(ValueError):
            decode_api_response(204, b'{}')

    def test_json_response_still_requires_valid_json(self):
        self.assertEqual(decode_api_response(200, b'{"ok":true}'), {"ok": True})
        for body in [b'', b'invalid']:
            with self.assertRaises(ValueError):
                decode_api_response(200, body)

    def test_incomplete_phase_can_continue_only_with_same_runtime_token(self):
        first = self.root / "token-sha256.txt"
        completed = self.root / "completed.json"
        first.write_text("synthetic-digest\n")
        check_first_runtime_token(first, "synthetic-digest", completed)
        self.assertEqual(first.read_text(), "synthetic-digest\n")
        with self.assertRaises(ValueError):
            check_first_runtime_token(first, "another-runtime", completed)

    def test_completed_running_cannot_be_replayed_as_first_phase(self):
        completed = self.root / "completed.json"
        completed.write_text('{}')
        with self.assertRaises(ValueError):
            check_first_runtime_token(self.root / "token", "synthetic-digest", completed)


if __name__ == "__main__":
    unittest.main()
