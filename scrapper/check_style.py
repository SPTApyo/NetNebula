#!/usr/bin/env python3
"""Check comment style in changed source lines."""

import re
import subprocess
import sys


COMMENT_STARTS = ("#", "//", "/*", "*", "<!--")


def added_lines():
    result = subprocess.run(
        ["git", "diff", "--cached", "--unified=0"],
        check=True,
        capture_output=True,
        text=True,
    )
    staged = result.stdout
    if staged:
        return staged.splitlines()

    result = subprocess.run(
        ["git", "diff", "--unified=0"],
        check=True,
        capture_output=True,
        text=True,
    )
    return result.stdout.splitlines()


def comment_text(line):
    text = line.lstrip()[1:]
    if text.startswith(("/", "*", "!")):
        text = text[1:]
    return text.strip(" -*>")


def violations(lines):
    errors = []
    for line in lines:
        if not line.startswith("+") or line.startswith("+++"):
            continue
        content = line[1:]
        stripped = content.lstrip()
        inline = re.search(r"(?:#|//)\s+(.+)$", content)
        if stripped.startswith(COMMENT_STARTS):
            text = comment_text(stripped)
        elif inline:
            text = inline.group(1).strip()
        else:
            continue
        words = re.findall(r"[\w'-]+", text)
        if chr(0x2014) in text or chr(0x2013) in text:
            errors.append("em/en dash: " + content.strip())
        if len(words) > 8:
            errors.append(f"{len(words)} comment words: {content.strip()}")
    return errors


def main():
    errors = violations(added_lines())
    if errors:
        print("Comment style violations:")
        print("\n".join(f"- {error}" for error in errors))
        return 1
    print("Comment style check passed.")
    return 0


if __name__ == "__main__":
    sys.exit(main())