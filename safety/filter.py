"""
Deterministic content-risk screening for the legacy Python agent.

This module is a defense-in-depth signal, not a prompt-injection detector or
an authorization boundary. Tool permissions and runtime isolation must remain
independent of model-visible content.
"""
from __future__ import annotations

from dataclasses import dataclass
from enum import Enum
import re
from typing import Pattern


class FilterAction(str, Enum):
    ALLOW = "allow"
    WARN = "warn"
    BLOCK = "block"


@dataclass(frozen=True)
class FilterResult:
    """A classification that never needs to echo sensitive matched text."""

    action: FilterAction
    reason: str = ""
    flagged_content: str = ""


MAX_CONTENT_LENGTH = 200_000

INJECTION_PATTERNS: tuple[tuple[str, Pattern[str]], ...] = (
    ("instruction_override", re.compile(
        r"\b(ignore|disregard|forget|override)\b.{0,80}\b(previous|prior|above|system|developer)\b.{0,40}\b(instructions?|rules?|messages?|polic(?:y|ies))\b",
        re.IGNORECASE | re.DOTALL,
    )),
    ("system_prompt_disclosure", re.compile(
        r"\b(reveal|print|show|dump|repeat|expose)\b.{0,60}\b(system prompt|developer message|hidden instructions?)\b",
        re.IGNORECASE | re.DOTALL,
    )),
    ("safety_bypass", re.compile(
        r"\b(disable|bypass|turn off|evade)\b.{0,50}\b(safety|guardrails?|security policy|approval checks?)\b",
        re.IGNORECASE | re.DOTALL,
    )),
    ("credential_exfiltration", re.compile(
        r"\b(send|upload|exfiltrate|post|transmit)\b.{0,100}\b(credentials?|secrets?|api keys?|tokens?|private keys?)\b",
        re.IGNORECASE | re.DOTALL,
    )),
    ("remote_shell_pipeline", re.compile(
        r"\b(curl|wget)\b.{0,300}\|\s*(sudo\s+)?(bash|sh|zsh)\b",
        re.IGNORECASE | re.DOTALL,
    )),
)

SECRET_PATTERNS: tuple[tuple[str, Pattern[str]], ...] = (
    ("aws_access_key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    ("github_token", re.compile(r"\bgh[pousr]_[A-Za-z0-9_]{20,}\b")),
    ("slack_token", re.compile(r"\bxox[baprs]-[A-Za-z0-9-]{10,}\b")),
    ("private_key", re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----")),
    ("jwt_like_token", re.compile(r"\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b")),
)


class ContentFilter:
    """Classify suspicious instructions and accidental credential disclosure."""

    def __init__(self, strict_mode: bool = False):
        self.strict_mode = strict_mode

    @staticmethod
    def _validate_text(text: str) -> FilterResult | None:
        if not isinstance(text, str):
            return FilterResult(FilterAction.BLOCK, "Content must be text.", "invalid_type")
        if len(text) > MAX_CONTENT_LENGTH:
            return FilterResult(FilterAction.BLOCK, "Content exceeds the screening size limit.", "oversized_content")
        if not text.strip():
            return FilterResult(FilterAction.ALLOW)
        return None

    @staticmethod
    def _matches(patterns: tuple[tuple[str, Pattern[str]], ...], text: str) -> list[str]:
        return [name for name, pattern in patterns if pattern.search(text)]

    def filter_input(self, text: str) -> FilterResult:
        """Warn on instruction-manipulation attempts; block obvious pasted secrets."""
        invalid = self._validate_text(text)
        if invalid:
            return invalid
        secrets = self._matches(SECRET_PATTERNS, text)
        if secrets:
            return FilterResult(FilterAction.BLOCK, "Input appears to contain credential material; remove it and use a secret manager.", ",".join(secrets))
        risks = self._matches(INJECTION_PATTERNS, text)
        if risks:
            action = FilterAction.BLOCK if self.strict_mode else FilterAction.WARN
            return FilterResult(action, "Input contains instruction or execution patterns that require untrusted-data handling.", ",".join(risks))
        return FilterResult(FilterAction.ALLOW)

    def filter_output(self, text: str) -> FilterResult:
        """Block credential-shaped output and flag unsafe instruction content."""
        invalid = self._validate_text(text)
        if invalid:
            return invalid
        secrets = self._matches(SECRET_PATTERNS, text)
        if secrets:
            return FilterResult(FilterAction.BLOCK, "Output was withheld because it matched credential patterns.", ",".join(secrets))
        risks = self._matches(INJECTION_PATTERNS, text)
        if risks:
            action = FilterAction.BLOCK if self.strict_mode else FilterAction.WARN
            return FilterResult(action, "Output contains instructions that must not be treated as authority.", ",".join(risks))
        return FilterResult(FilterAction.ALLOW)
