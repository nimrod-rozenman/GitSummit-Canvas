# GitSummit

A **repo-agnostic review canvas** for a canvas-capable GitHub Copilot host. After a coding agent
finishes making changes, open **GitSummit** to see what changed, how the changed files
depend on each other, and what looks most likely to break — before you open a pull request.

It works in any repository: it inspects whatever workspace the session is running in via
`git`, so nothing here is specific to one project.

This repository version provides the three review tabs below. It does not
include Git staging, commit, fetch, pull, or push controls. It uses the
host-provided `@github/copilot-sdk` and Node built-ins; no build or separate
dependency installation is required.

## The three tabs

### Diagram

A top-to-bottom flow of the change. Files are grouped into **layers** by how they depend on
each other — the first layer depends on nothing else in the change, each layer below uses
the one above it, and files with no links land in **Standalone**. Layers are named after the
file the rest of the layer leans on (`Data access` → `Core logic` → `Tests`).

Each card carries the filename, its directory, the line counts, `↑used-by` / `↓uses`, and a
one-line description. Arrows run downward from a dependency into the file that uses it; a
dashed red arrow is a link the change **removed**. Files that need a close look get a ring
around the card. Hover isolates a file and its links; click opens it in **Changes** with a
**↩ Back to diagram** button next to the filename.

### Changes

Every changed file as a card: status, name, risk, directory, counts, a 1–3 sentence summary,
signal chips (`+ createRateLimiter`, `− resetWindow`, `+ ioredis`) and the reasons behind its
risk. Three groupings:

- **Triage** (default) — riskiest first: *Read closely* / *Worth a look* / *Routine*.
- **List** — flat, ordered by churn.
- **Layers** — the same layers as the Diagram, so you read the change in the order it was built.

Expanding a card gives you a toolbar: **Changed hunks / Whole file**, **⤢ Full screen**,
**↗ Open file** and **＋ Comment**. Open file first requests the host's editor
canvas, then falls back to an installed editor or system file handler if needed.

### Commits

The branch's commit narrative, plus a directory rollup showing where the change is
concentrated. Clicking a directory filters Changes to it.

## Risk

Every file gets **Risk: none / small / medium / high**. It is a heuristic, so it is never
presented as a verdict: every point carries a plain-language reason, shown on the card.

| Signal | Why it counts |
| --- | --- |
| the whole file is removed | remaining imports may need changes |
| removes declarations | callers may depend on the removed API |
| N changed files depend on it | blast radius inside this very change |
| moved / renamed | imports pointing at it must change |
| large change, many deletions | more surface to get wrong |
| dependency manifest or CI edit | breaks the build rather than the code |
| no changed test is linked to it | no related test was found by the heuristic |

The header shows the change-wide risk: the worst file, nudged up for each other notable one.
These are text-based review hints, not a security audit, a resolved code graph,
or proof of test coverage.

## Filtering

A single filter bar applies to **every** tab: a search box and **Added / Edited / Deleted /
Renamed** chips. The **High risk** chip is an *override* rather than another AND — it shows
every flagged file regardless of the other filters, which grey out while it is on, so nothing
risky can hide behind a filter you forgot was set.

## Review comments

Comment on a whole file, or on any line in a diff. Comments live in the canvas for the length
of the review; **nothing is written into your repository**. **Submit comments** (top right)
opens them as markdown, and the agent reads them back with the `get_feedback` action — so
after submitting you can just say *"act on my GitSummit feedback"*.
Submitting prepares Markdown and attempts a clipboard copy. It does not post
comments or reviews to GitHub.

## Auto-update

GitSummit debounces filesystem events and checks HEAD and porcelain status.
This fingerprint is not a content digest; use Refresh if another edit to an
already-modified file does not appear. Refreshing preserves the selected tab,
expanded files, and scroll position. Auto pauses UI refresh, not the server's
watcher. A four-second poll is used when recursive watching is unavailable.

## How the comparison base is chosen

In priority order: an explicit override → the remote default branch (`origin/HEAD`) → the
first of `main` / `master` / `develop` / `trunk` that exists. GitSummit then compares the
working tree (committed + staged + unstaged) against the merge-base with that ref. Untracked
files the agent just created are included as new-file additions.

## Opening it

The agent opens it via the canvas system (`open_canvas` with `canvasId: "gitsummit"`).
Optional open input:

- `base` — force a comparison base (e.g. `"main"`).
- `focus` — open a specific file immediately.

## Agent-facing actions

| Action | What it does |
| --- | --- |
| `refresh` | Recompute from current git state and push the update to the canvas. |
| `set_base` | Change the comparison base, then refresh. |
| `focus_file` | Switch to Changes, expand a file and scroll to it. |
| `get_feedback` | Read the reviewer's comments back as markdown. |

## Keyboard shortcuts

`1` Diagram · `2` Changes · `3` Commits · `/` filter · `r` refresh · `Esc` close the
full-screen diff.

## Theme

GitSummit ships its own palette (Graphite) rather than following the host theme, so it looks
the same in every app theme.

## Files

| File | Purpose |
| --- | --- |
| `extension.mjs` | Wiring: `joinSession`, the canvas, a per-instance loopback HTTP server, SSE, the repo watcher, and the agent actions. |
| `git.mjs` | Repo-agnostic git introspection and unified-diff parsing. |
| `analyze.mjs` | Turns a diff into summaries, links between changed files, and risk. |
| `web/` | The interactive iframe UI (`index.html`, `styles.css`, `app.js`). |

The repository is the source of truth. The extension holds review comments in
memory for the life of the canvas.

## Privacy

The canvas displays real paths, source code, commit messages, and author names
from the workspace. It does not redact them. Comments and tool results can be
returned to the host agent; host processing and clipboard synchronization have
their own data policies.

The HTTP server binds only to `127.0.0.1`, but this review-only version does not
authenticate its endpoints. Do not forward the port or treat loopback as a
sandbox. Use trusted repositories and local software.

There is no built-in upload client or remote Git operation. Configured Git
helpers and the external-editor fallback are separate programs and can have
their own behavior.

Use synthetic repositories for public demos. Never bundle work code, captured
diffs, real logs, session state, or credentials with this extension. Inspect Git
history and metadata as well as the current files before publication.

## Installing it elsewhere

Point the app's extension installer at this folder:

```
https://github.com/nimrod-rozenman/GitSummit-Canvas/tree/main/.github/extensions/gitsummit
```

This is a community extension. References to the host and public tools describe
compatibility, not vendor affiliation. No license has been selected; publication
rights and licensing require the owner's decision.
