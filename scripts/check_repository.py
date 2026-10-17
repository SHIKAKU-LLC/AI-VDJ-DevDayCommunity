#!/usr/bin/env python3
"""Reject unsafe repository inputs. Only read tracked files or index blobs.

Default: inspect tracked working files (CI). --staged: inspect every index blob
as it will be committed, including files unchanged by this commit. No file
contents, detected values, Git error output, or untracked files are printed.
This conservative check complements human review; it cannot identify all PII.
"""

from __future__ import annotations

import argparse
from dataclasses import dataclass
import json
import os
from pathlib import Path, PurePosixPath
import re
import stat
import subprocess
import sys
from urllib.parse import parse_qsl, unquote, urlsplit


DEFAULT_MAX_BYTES = 1024 * 1024
ALLOWED_SUFFIXES = frozenset({
    ".md", ".txt", ".rst", ".adoc", ".py", ".pyi", ".sh", ".bash", ".zsh",
    ".json", ".jsonl", ".csv", ".tsv", ".toml", ".yaml", ".yml", ".ini",
    ".cfg", ".lock", ".sql", ".r", ".js", ".mjs", ".cjs", ".ts", ".tsx",
    ".jsx", ".css", ".html", ".xml", ".c", ".h", ".cpp", ".hpp", ".rs", ".swift",
})
ALLOWED_NAMES = frozenset({
    ".gitignore", ".gitattributes", ".dockerignore", ".python-version",
    ".tool-versions", "dockerfile", "makefile", "license", "licence", "notice",
    "cmakelists.txt", ".env.example",
})
BLOCKED_DIRECTORIES = frozenset({
    "assets", "raw", "raw_assets", "raw-assets", "media", "audio", "stems",
    "video", "videos", "downloads", "private", "personal", "logs", "secrets",
    "credentials", ".aws", ".ssh", ".config", ".codex", ".venv", "venv",
    "node_modules", "__pycache__",
})
BLOCKED_NAMES = re.compile(
    r"(?i)(?:^\.env(?:\.|$)|^\.(?:npmrc|pypirc|netrc)$|"
    r"(?:^|[._-])(?:credentials?|secrets?|cookies?|tokens?|auth|session|"
    r"contacts?|customers?|users?|patients?|private[-_]?key)(?:[._-]|$)|"
    r"^id_(?:rsa|ed25519|ecdsa|dsa)(?:[._-]|$))"
)
TOKEN_PATTERNS = (
    re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH |DSA |ENCRYPTED )?PRIVATE KEY-----"),
    re.compile(r"\b(?:AKIA|ASIA)[A-Z0-9]{16}\b"),
    re.compile(r"\bgh[pousr]_[A-Za-z0-9]{30,}\b"),
    re.compile(r"\bgithub_pat_[A-Za-z0-9_]{30,}\b"),
    re.compile(r"\bsk-(?:proj-|svcacct-)?[A-Za-z0-9_-]{20,}\b"),
    re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{20,}\b"),
    re.compile(r"\bAIza[A-Za-z0-9_-]{30,}\b"),
    re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b"),
)
SENSITIVE_ASSIGNMENT = re.compile(
    r"(?i)(?<![\w])['\"]?(?:[a-z][a-z0-9]*_)*"
    r"(?:api_?key|access_?token|refresh_?token|client_?secret|password|passwd|"
    r"secret(?:_?key)?|auth_?token|authorization|cookie|session_?id)['\"]?"
    r"\s*[:=]\s*['\"]?([^\s'\",;}\]]+)"
)
PERSONAL_FIELD = re.compile(
    r"(?im)(?:^|[,{])\s*['\"]?(?:home_?address|phone_?number|date_?of_?birth|"
    r"social_?security_?number|passport_?number|credit_?card_?number|"
    r"patient_?id)['\"]?\s*[:=]\s*['\"]?([^\s'\",;}\]]+)"
)
PERSONAL_HEADER = re.compile(
    r"(?i)(?:^|[,\t])\s*['\"]?(?:e_?mail|phone_?number|home_?address|"
    r"full_?name|first_?name|last_?name|date_?of_?birth|ssn|passport_?number|"
    r"credit_?card_?number)['\"]?\s*(?:[,\t]|$)"
)
EMBEDDED_MEDIA = re.compile(
    r"(?i)data:(?:audio/|video/|image/|application/(?:octet-stream|zip))"
)
EMAIL = re.compile(r"\b[A-Z0-9._%+-]+@([A-Z0-9.-]+\.[A-Z]{2,})\b", re.I)
URL = re.compile(r"https?://[^\s<>\"'`]+", re.I)
SIGNED_QUERY_KEYS = frozenset({
    "signature", "sig", "token", "access_token", "auth", "authorization",
    "api_key", "apikey", "key", "x-amz-signature", "x-amz-credential",
    "x-amz-security-token", "awsaccesskeyid", "x-goog-signature",
    "x-goog-credential", "googleaccessid", "policy", "key-pair-id",
})


@dataclass(frozen=True)
class Finding:
    path: str
    rule: str


def git(root: Path, *args: str) -> bytes:
    return subprocess.run(
        ["git", "-C", str(root), *args], check=True, stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    ).stdout


def placeholder(value: str) -> bool:
    """Allow clearly symbolic examples and references, never token formats."""
    value = value.strip().lower()
    return (
        value in {"", "none", "null", "false", "true", "redacted", "placeholder",
                  "example", "dummy", "changeme", "change_me", "replace_me"}
        or value.startswith(("${", "$", "<", "{{", "your_", "your-", "example_",
                             "example-", "os.environ", "os.getenv", "process.env"))
    )


def path_rule(path: str, mode: str) -> str | None:
    item = PurePosixPath(path)
    if item.is_absolute() or ".." in item.parts:
        return "unsafe-path"
    if mode not in {"100644", "100755"}:
        return "symlink-or-submodule"
    if any(part.lower() in BLOCKED_DIRECTORIES for part in item.parts[:-1]):
        return "local-only-directory"
    name = item.name.lower()
    if name != ".env.example" and BLOCKED_NAMES.search(name):
        return "credential-or-personal-data-filename"
    if path == ".githooks/pre-commit" or name in ALLOWED_NAMES:
        return None
    if item.suffix.lower() not in ALLOWED_SUFFIXES:
        return "non-text-or-unapproved-extension"
    return None


def npm_assignment_view(content: str, path: str | None) -> str:
    """Distinguish typed npm dependency versions from credential assignments.

    Only the assignment check uses this view. Token, URL, personal-data and
    binary checks still inspect the original bytes, including every lock entry.
    """
    if path is None or PurePosixPath(path).name != "package-lock.json":
        return content
    def unique_fields(pairs):
        result = {}
        for key, value in pairs:
            if key in result:
                raise ValueError("Duplicate JSON field")
            result[key] = value
        return result
    try:
        document = json.loads(content, object_pairs_hook=unique_fields)
    except (ValueError, TypeError):
        return content
    if not isinstance(document, dict) or document.get("lockfileVersion") not in (2, 3):
        return content
    packages = document.get("packages")
    if not isinstance(packages, dict):
        return content
    normalized = {}
    for index, (name, package) in enumerate(packages.items()):
        if not isinstance(package, dict) or (name and (
            not name.startswith("node_modules/")
            or any(part in {"", ".", ".."} or not re.fullmatch(r"[@A-Za-z0-9_.-]+", part)
                   for part in name.split("/"))
        )):
            return content
        for section in ("dependencies", "devDependencies", "optionalDependencies", "peerDependencies"):
            dependencies = package.get(section)
            if isinstance(dependencies, dict):
                for dependency, version in dependencies.items():
                    if isinstance(version, str) and re.fullmatch(r"[~^]?\d+\.\d+\.\d+", version):
                        dependencies[dependency] = "placeholder"
        # Package paths are dictionary indices, not credential field names.
        normalized[f"npm_package_{index}"] = package
    document["packages"] = normalized
    return json.dumps(document)


def content_rules(data: bytes, path: str | None = None) -> set[str]:
    try:
        content = data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return {"binary-or-non-utf8"}
    if re.search(r"[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]", content):
        return {"binary-or-control-characters"}
    rules = set()
    if any(pattern.search(content) for pattern in TOKEN_PATTERNS):
        rules.add("secret-token-or-private-key")
    if any(not placeholder(match.group(1)) for match in SENSITIVE_ASSIGNMENT.finditer(npm_assignment_view(content, path))):
        rules.add("sensitive-value-assignment")
    if any(not placeholder(match.group(1)) for match in PERSONAL_FIELD.finditer(content)):
        rules.add("personal-data-field")
    first_line = content.split("\n", 1)[0]
    if ("," in first_line or "\t" in first_line) and PERSONAL_HEADER.search(first_line):
        rules.add("personal-data-table")
    if EMBEDDED_MEDIA.search(content):
        rules.add("embedded-media-or-binary")
    for match in EMAIL.finditer(content):
        domain = match.group(1).lower()
        if domain not in {"example.com", "example.net", "example.org"} and not domain.endswith(
            (".example", ".invalid", ".test", ".localhost", ".noreply.github.com")
        ):
            rules.add("personal-email-address")
    for match in URL.finditer(content):
        try:
            url = urlsplit(match.group(0))
            if url.username is not None or url.password is not None:
                rules.add("url-credentials")
            if any(
                unquote(key).lower() in SIGNED_QUERY_KEYS or unquote(key).lower().startswith("x-amz-")
                for key, _value in parse_qsl(url.query, keep_blank_values=True)
            ):
                rules.add("signed-or-sensitive-url")
        except ValueError:
            rules.add("malformed-url")
    return rules


def worktree_bytes(root: Path, path: str, max_bytes: int) -> tuple[bytes | None, str | None]:
    candidate = root / path
    try:
        # Reject parent symlinks as well as leaf symlinks before opening anything.
        current = root
        for component in PurePosixPath(path).parts:
            current = current / component
            if current.is_symlink():
                return None, "worktree-symlink"
        candidate.resolve().relative_to(root)
        info = candidate.stat()
        if not stat.S_ISREG(info.st_mode):
            return None, "non-regular-file"
        if info.st_size > max_bytes:
            return None, "over-size-limit"
        flags = os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0) | getattr(os, "O_NONBLOCK", 0)
        with os.fdopen(os.open(candidate, flags), "rb") as handle:
            opened = os.fstat(handle.fileno())
            if not stat.S_ISREG(opened.st_mode):
                return None, "non-regular-file"
            data = handle.read(max_bytes + 1)
        if len(data) > max_bytes:
            return None, "over-size-limit"
        return data, None
    except (OSError, ValueError):
        return None, "missing-or-unreadable-tracked-file"


def scan(root: Path, staged: bool = False, max_bytes: int = DEFAULT_MAX_BYTES) -> tuple[list[Finding], int]:
    findings = []
    entries = git(root, "ls-files", "--stage", "-z").split(b"\0")
    paths = set()
    for entry in entries:
        if not entry:
            continue
        metadata, raw_path = entry.split(b"\t", 1)
        mode, oid, stage = metadata.decode("ascii").split()
        path = os.fsdecode(raw_path)
        paths.add(path)
        rule = path_rule(path, mode)
        if stage != "0":
            rule = "unresolved-merge-entry"
        if rule:
            findings.append(Finding(path, rule))
            continue
        if staged:
            if int(git(root, "cat-file", "-s", oid)) > max_bytes:
                findings.append(Finding(path, "over-size-limit"))
                continue
            data = git(root, "cat-file", "blob", oid)
        else:
            data, rule = worktree_bytes(root, path, max_bytes)
            if rule:
                findings.append(Finding(path, rule))
                continue
        for rule in sorted(content_rules(data, path)):
            findings.append(Finding(path, rule))
    return sorted(set(findings), key=lambda finding: (finding.path, finding.rule)), len(paths)


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--root", type=Path, default=Path.cwd(), help="Git repository location")
    modes = parser.add_mutually_exclusive_group()
    modes.add_argument("--staged", action="store_true", help="Inspect all staged index blobs")
    modes.add_argument("--tracked", action="store_true", help="Inspect tracked working files (default)")
    parser.add_argument("--max-bytes", type=int, default=DEFAULT_MAX_BYTES, help="Per-file byte limit")
    args = parser.parse_args()
    if args.max_bytes < 1:
        parser.error("--max-bytes must be positive")
    try:
        root = Path(os.fsdecode(git(args.root, "rev-parse", "--show-toplevel")).strip()).resolve()
        findings, count = scan(root, staged=args.staged, max_bytes=args.max_bytes)
    except (OSError, ValueError, subprocess.CalledProcessError):
        print("Repository policy: unable to inspect Git repository.", file=sys.stderr)
        return 2
    if not count:
        print("Repository policy: no tracked files to inspect.", file=sys.stderr)
        return 2
    for finding in findings:
        print(f"FAIL {json.dumps(finding.path, ensure_ascii=True)}: {finding.rule}")
    if findings:
        print(f"Repository policy failed: {len(findings)} finding(s), {count} file(s) checked.")
        return 1
    print(f"Repository policy passed: {count} file(s), limit {args.max_bytes} bytes per file.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
