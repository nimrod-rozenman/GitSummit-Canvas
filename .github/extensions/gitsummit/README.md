# GitSummit

A **repo-agnostic** Copilot CLI **canvas** for the pre-PR phase. After a coding agent
finishes making changes, open **GitSummit** to see what changed, how the changed files
depend on each other, and what looks most likely to break — before you open a pull request.

It works in any repository: it inspects whatever workspace the session is running in via
`git`, so nothing here is specific to one project.

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
**↗ Open file** (launches your editor) and **＋ Comment**.

### Commits

The branch's commit narrative, plus a directory rollup showing where the change is
concentrated. Clicking a directory filters Changes to it.

## Risk

Every file gets **Risk: none / small / medium / high**. It is a heuristic, so it is never
presented as a verdict: every point carries a plain-language reason, shown on the card.

| Signal | Why it counts |
| --- | --- |
| the whole file is removed | anything still importing it breaks |
| removes declarations | callers lose an API they were using |
| N changed files depend on it | blast radius inside this very change |
| moved / renamed | imports pointing at it must change |
| large change, many deletions | more surface to get wrong |
| dependency manifest or CI edit | breaks the build rather than the code |
| no test in this change covers it | nothing proves it still works |

The header shows the change-wide risk: the worst file, nudged up for each other notable one.

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

## Auto-update

GitSummit watches the repository and recomputes when it actually changes. Filesystem events
are debounced and checked against a cheap fingerprint of the working tree, so editor noise
and git's own index churn don't cause redraws. Refreshing keeps your place: same tab, same
expanded files, same scroll position. The **Auto** toggle turns it off.

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

Apart from review comments (held in memory for the life of the canvas), no durable state is
kept: the repository is the source of truth and the rundown is recomputed on open, refresh
and repo change.

## Installing it elsewhere

Point the app's extension installer at this folder:

```
https://github.com/nimrod-rozenman/rundown-canvas/tree/main/.github/extensions/gitsummit
```
