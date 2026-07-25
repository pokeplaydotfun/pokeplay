#!/usr/bin/env python3
"""
Hands the pokeplay.fun apex over to Slab Showdown, reversibly.

The old PokePlay block is COMMENTED OUT, never deleted, and its files
(/root/pokeplay-web) and the pokeplay service are not touched at all. To give
the apex back, delete the new block and uncomment the old one.

The play.pokeplay.fun block is deliberately left alone, so re-adding that DNS
record brings the old game straight back.

Usage:  swap-apex.py <caddyfile> <new-block-file>
"""
import sys

MARKER = "# [slab-showdown] previous PokePlay apex block, commented out"
TARGET = "pokeplay.fun, www.pokeplay.fun {"


def find_block(lines, header):
    """Return (start, end) line indices of a top-level `header { ... }` block."""
    for i, line in enumerate(lines):
        if line.strip() == header.strip():
            depth = 0
            for j in range(i, len(lines)):
                depth += lines[j].count("{") - lines[j].count("}")
                if depth == 0 and j > i:
                    return i, j
                if depth == 0 and j == i and "}" in lines[j]:
                    return i, j
            raise SystemExit(f"unbalanced braces after line {i + 1}")
    return None


def main() -> int:
    caddyfile, block_file = sys.argv[1], sys.argv[2]

    with open(caddyfile) as f:
        text = f.read()
    lines = text.split("\n")

    with open(block_file) as f:
        new_block = f.read().rstrip("\n")

    if MARKER in text:
        # The swap has already happened. Refresh OUR block in place so changes
        # to the template actually reach production — previously this returned
        # early and the live config could never be updated. The commented-out
        # original block is left exactly as it is.
        # The template opens with a comment banner, so the block header is the
        # first non-comment line that opens a brace — not simply line one.
        header = next(
            (ln.strip() for ln in new_block.split("\n")
             if ln.strip().endswith("{") and not ln.strip().startswith("#")),
            "",
        )
        if not header:
            print("could not find a block header in the template — leaving it alone")
            return 0
        ours = find_block(lines, header)
        if not ours:
            print(f"already swapped, but no live block matching {header!r} — leaving it alone")
            return 0

        # The commented-out copy cannot match: its lines are "# "-prefixed.
        start, end = ours
        before_play = find_block(lines, "play.pokeplay.fun {")
        out = lines[:start] + new_block.split("\n") + lines[end + 1 :]
        out_text = "\n".join(out).rstrip("\n") + "\n"

        after_play = find_block(out_text.split("\n"), "play.pokeplay.fun {")
        if bool(before_play) != bool(after_play):
            print("refusing to write: the play.pokeplay.fun block would be lost")
            return 1

        if out_text == text:
            print("apex already swapped; block is already up to date")
            return 0

        with open(caddyfile, "w") as f:
            f.write(out_text)
        print(f"refreshed the live {header!r} block from the template")
        return 0

    found = find_block(lines, TARGET)
    if not found:
        print(f"could not find a block for {TARGET!r} — refusing to guess")
        return 1

    start, end = found
    print(f"commenting out the old apex block (lines {start + 1}-{end + 1})")

    commented = [MARKER, "# Restore by deleting the Slab Showdown block below and uncommenting this."]
    commented += ["# " + ln if ln.strip() else "#" for ln in lines[start : end + 1]]

    # Sanity: the play.pokeplay.fun block must survive untouched.
    before_play = find_block(lines, "play.pokeplay.fun {")

    out = lines[:start] + commented + lines[end + 1 :]
    out_text = "\n".join(out).rstrip("\n") + "\n\n" + new_block + "\n"

    after_play = find_block(out_text.split("\n"), "play.pokeplay.fun {")
    if bool(before_play) != bool(after_play):
        print("refusing to write: the play.pokeplay.fun block would be lost")
        return 1

    with open(caddyfile, "w") as f:
        f.write(out_text)

    print("apex handed to Slab Showdown; play.pokeplay.fun left intact")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
