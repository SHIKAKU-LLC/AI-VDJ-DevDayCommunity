"""Policy tests use only synthetic files in temporary Git repositories."""

from pathlib import Path
import json
import subprocess
import sys
import tempfile
import unittest


SCANNER = Path(__file__).resolve().parents[1] / "scripts" / "check_repository.py"


class RepositoryPolicyTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory(prefix="ai-vdj-policy-")
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        self.git("init", "--quiet")

    def git(self, *arguments):
        return subprocess.run(
            ["git", "-C", str(self.root), *arguments], check=True,
            stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def write(self, path, content, stage=True):
        target = self.root / path
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_bytes(content if isinstance(content, bytes) else content.encode())
        if stage:
            self.git("add", "--", path)
        return target

    def check(self, *arguments):
        return subprocess.run(
            [sys.executable, str(SCANNER), "--root", str(self.root), *arguments],
            text=True, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        )

    def assert_rejected(self, rule, *arguments):
        result = self.check(*arguments)
        self.assertEqual(result.returncode, 1, result.stderr + result.stdout)
        self.assertIn(rule, result.stdout)
        return result

    def test_small_text_code_manifest_and_placeholder_are_accepted(self):
        self.write("README.md", "# Local assets\nReference hash: " + "a" * 64)
        self.write("analysis/metrics.py", "print('synthetic')\n")
        self.write("experiments/run.json", '{"source_sha256": "' + "b" * 64 + '"}')
        self.write(".env.example", "API_" + "KEY=${LOCAL_KEY}\n")
        for mode in ("--staged", "--tracked"):
            self.assertEqual(self.check(mode).returncode, 0)

    def test_npm_package_names_and_typed_versions_keep_secret_checks(self):
        dependency = "coo" + "kie"
        package_path = "node_modules/" + dependency
        document = {"lockfileVersion": 3, "packages": {
            "": {"dependencies": {dependency: "^0.7.2"}},
            package_path: {"version": "0.7.2"},
        }}
        target = self.write("tools/package-lock.json", json.dumps(document))
        for mode in ("--staged", "--tracked"):
            self.assertEqual(self.check(mode).returncode, 0)

        value = "fabricated_" + "credential_value"
        password_field = "pass" + "word"
        for location in (document, document["packages"][package_path]):
            location[password_field] = value
            target.write_text(json.dumps(document))
            self.assert_rejected("sensitive-value-assignment", "--tracked")
            self.git("add", "--", "tools/package-lock.json")
            self.assert_rejected("sensitive-value-assignment", "--staged")
            del location[password_field]

        document["packages"][""]["dependencies"][dependency] = value
        target.write_text(json.dumps(document))
        self.assert_rejected("sensitive-value-assignment", "--tracked")
        document["packages"][""]["dependencies"][dependency] = "^0.7.2"
        document["packages"][package_path]["description"] = "gh" + "p_" + "A" * 36
        target.write_text(json.dumps(document))
        self.assert_rejected("secret-token-or-private-key", "--tracked")

    def test_npm_assignment_exception_requires_a_valid_lockfile_path(self):
        dependency = "coo" + "kie"
        document = {"lockfileVersion": 3, "packages": {
            "": {"dependencies": {dependency: "^0.7.2"}},
        }}
        target = self.write("fixture.json", json.dumps(document))
        self.assert_rejected("sensitive-value-assignment")
        target.unlink()
        self.git("rm", "--cached", "--", "fixture.json")
        document["lockfileVersion"] = 1
        self.write("package-lock.json", json.dumps(document))
        self.assert_rejected("sensitive-value-assignment")

    def test_duplicate_json_fields_do_not_hide_an_earlier_sensitive_assignment(self):
        field = "pass" + "word"
        value = "fabricated_" + "credential_value"
        document = {"lockfileVersion": 3, "packages": {"": {}}}
        prefix = json.dumps({field: value})[1:-1]
        duplicate = json.dumps({field: "placeholder"})[1:-1]
        content = "{" + prefix + "," + duplicate + "," + json.dumps(document)[1:]
        self.write("package-lock.json", content)
        for mode in ("--staged", "--tracked"):
            result = self.assert_rejected("sensitive-value-assignment", mode)
            self.assertNotIn(value, result.stdout + result.stderr)

    def test_swift_source_retains_secret_and_binary_checks(self):
        target = self.write("native/helper.swift", "import Security\nprint(42)\n")
        self.assertEqual(self.check().returncode, 0)
        target.write_text("gh" + "p_" + "A" * 36)
        self.assert_rejected("secret-token-or-private-key")
        target.write_bytes(b"\x00payload")
        self.assert_rejected("binary-or-control-characters")

    def test_untracked_files_are_never_scanned(self):
        self.write("README.md", "Safe\n")
        self.write("local-secret.txt", "gh" + "p_" + "A" * 36, stage=False)
        self.assertEqual(self.check().returncode, 0)

    def test_index_snapshot_is_checked_instead_of_worktree(self):
        target = self.write("report.md", "gh" + "p_" + "A" * 36)
        target.write_text("Safe replacement, not yet staged\n")
        result = self.assert_rejected("secret-token-or-private-key", "--staged")
        self.assertNotIn("A" * 36, result.stdout)
        self.assertEqual(self.check("--tracked").returncode, 0)

    def test_worktree_edits_are_checked_in_default_mode(self):
        target = self.write("report.md", "Safe staged content\n")
        target.write_text("sk" + "-" + "Z" * 30)
        self.assert_rejected("secret-token-or-private-key")
        self.assertEqual(self.check("--staged").returncode, 0)

    def test_media_archives_binary_and_unapproved_extensions_rejected(self):
        for name in ("track.wav", "clip.MP4", "archive.zip", "notebook.ipynb"):
            self.write(name, "Text disguised as an asset\n")
        self.write("binary.txt", b"\x00\x01payload")
        self.write("non_utf8.txt", b"\xff\xfe")
        result = self.assert_rejected("non-text-or-unapproved-extension")
        self.assertIn("binary-or-control-characters", result.stdout)
        self.assertIn("binary-or-non-utf8", result.stdout)

    def test_local_asset_directories_and_sensitive_filenames_rejected(self):
        for name in ("raw/hash.md", "Audio/hash.json", "stems/note.txt", ".env.local",
                     "credential" + "s.json", "data/contacts.csv"):
            self.write(name, "synthetic\n")
        result = self.assert_rejected("local-only-directory", "--staged")
        self.assertIn("credential-or-personal-data-filename", result.stdout)

    def test_default_one_mebibyte_limit(self):
        self.write("result.txt", "x" * (1024 * 1024))
        self.assertEqual(self.check("--staged").returncode, 0)
        self.write("result.txt", "x" * (1024 * 1024 + 1))
        self.assert_rejected("over-size-limit", "--staged")
        self.assert_rejected("over-size-limit", "--tracked")

    def test_secret_assignment_and_private_key_rejected_without_echo(self):
        value = "fabricated_" + "value_123456789"
        self.write("config.yaml", "api_" + "key: " + value)
        self.write("key.txt", "-----BEGIN " + "PRIVATE KEY-----\nexample")
        result = self.assert_rejected("sensitive-value-assignment")
        self.assertIn("secret-token-or-private-key", result.stdout)
        self.assertNotIn(value, result.stdout + result.stderr)

    def test_signed_encoded_query_and_credential_urls_rejected(self):
        self.write("references.md", "https://storage.example.com/object?" + "X-Amz-" +
                   "Signature=" + "a" * 64 + "\nhttps://example.com/object?" + "%73ig=value\n" +
                   "https://user" + ":pass@example.com/object\n")
        result = self.assert_rejected("signed-or-sensitive-url")
        self.assertIn("url-credentials", result.stdout)

    def test_personal_data_fields_and_non_example_email_rejected(self):
        self.write("record.yaml", "home_" + "address: 1 Synthetic Street\n")
        self.write("note.md", "synthetic.person" + "@" + "fabricated-company.org")
        result = self.assert_rejected("personal-data-field")
        self.assertIn("personal-email-address", result.stdout)

    def test_inline_json_and_csv_personal_data_rejected(self):
        self.write("record.json", '{"version": 1, "phone_' + 'number": "123456789"}')
        self.write("table.csv", "metric,full_" + "name\n1,Synthetic Person\n")
        result = self.assert_rejected("personal-data-field")
        self.assertIn("personal-data-table", result.stdout)

    def test_embedded_media_in_text_rejected(self):
        self.write("report.json", '{"payload": "data:' + 'audio/wav;base64,AAAA"}')
        self.assert_rejected("embedded-media-or-binary")

    def test_symlink_and_worktree_parent_symlink_do_not_follow_targets(self):
        (self.root / "link.md").symlink_to("missing-outside-target")
        self.git("add", "link.md")
        self.assert_rejected("symlink-or-submodule", "--staged")
        self.git("rm", "--cached", "link.md")
        (self.root / "link.md").unlink()
        target = self.write("reports/check.md", "safe\n")
        target.unlink()
        target.parent.rmdir()
        target.parent.symlink_to("missing-outside-directory")
        self.assert_rejected("worktree-symlink")

    def test_missing_tracked_file_fails_closed(self):
        self.write("report.md", "safe\n").unlink()
        self.assert_rejected("missing-or-unreadable-tracked-file")

    def test_empty_index_and_non_repository_fail_closed(self):
        self.assertEqual(self.check().returncode, 2)
        with tempfile.TemporaryDirectory() as other:
            result = self.check("--root", other)
            self.assertEqual(result.returncode, 2)
            self.assertNotIn("fatal:", result.stderr)

    def test_policy_source_and_tests_pass_their_own_content_rules(self):
        self.write("scripts/check_repository.py", SCANNER.read_bytes())
        self.write("tests/test_repository_policy.py", Path(__file__).read_bytes())
        result = self.check("--staged")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)


if __name__ == "__main__":
    unittest.main()
