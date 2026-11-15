<div align="center">

<img src="docs/logo.svg" alt="GitSummit mountain logo" width="88" height="88" />

# GitSummit

### The last look before the pull request.

**Source Control and code review in a canvas-capable GitHub Copilot host.**
Compare local work with remote branches, manage Git changes, and review the code.

This is a community extension, not an official host feature or an endorsement by
the host's vendor.

</div>

---

## ⚡ Quick start

<p>
  <a href="https://github.com/github/app">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="docs/icons/copilot-dark.svg" />
      <img src="docs/icons/copilot.svg" alt="GitHub Copilot desktop app" width="40" height="40" />
    </picture>
  </a>
  &nbsp;&nbsp;&nbsp;&nbsp;
  <a href="https://code.visualstudio.com/"><img src="docs/icons/vscode.png" alt="Visual Studio Code" width="40" height="40" /></a>
</p>

In the **GitHub Copilot app** or **Visual Studio Code** chat, send the prompt below.
Use **Agent** mode in VS Code.

```text
install this canvas https://github.com/nimrod-rozenman/GitSummit-Canvas/tree/main/.github/extensions/gitsummit
```

Approve the installation prompts. Then ask **Open GitSummit**.
Viewing the canvas requires a host with canvas-extension support.

---

## 🔍 Beyond the diff

An agent finishes a task and hands you a diff. `git diff` shows you *lines*. A PR view shows you *files, alphabetically*. Neither tells you the thing you actually need before you press **Create pull request**:

> **What did this change actually touch, in what order does it make sense to read it, and which file is going to bite me?**

GitSummit answers exactly that — in the gap between *"agent is done"* and *"PR is open"*.

It inspects the active session's Git workspace. Its analysis uses local Git output
and file contents rather than a language server or a project-specific service.
Source Control provides stage, unstage, commit, fetch, pull, push, and sync
controls. The three review tabs help explain the code behind those changes.

---

## 🗺️ The four tabs

The screenshots below use a synthetic `example-catalog` repository.
All code, names, and commits are demonstration data. These are canvas-only
captures, without account details or the host app's sidebar.

<table>
<tr>
<td width="25%" valign="top">

### `0` Source Control

**Your worktree and remote, in one view.**

</td>
<td width="25%" valign="top">

### `1` Diagram

**How the change fits together.**

</td>
<td width="25%" valign="top">

### `2` Changes

**What each file did, riskiest first.**

</td>
<td width="25%" valign="top">

### `3` Commits

**The story of the branch.**

</td>
</tr>
</table>

### Source Control — local changes and remote comparison

![GitSummit Source Control with staged and unstaged example files, remote comparison, and a diff below the controls](docs/screenshots/tab-source-control.png)

Repository controls sit above the selected diff at every window width.
All tabs use the same dark palette.

- **Stage and unstage:** use the file buttons. Unstage preserves working files.
- **Commit:** enter a message and confirm the staged changes. Unstaged edits stay separate.
- **Fetch, pull, push, or sync:** use the Git menu and review the confirmation.
- **Compare:** select a remote-tracking branch to see incoming and outgoing
  commits and differences between its committed tree and local HEAD.

Remote comparisons use cached refs. Refresh does not fetch. The displayed
`FETCH_HEAD` time describes the repository, not the freshness of every remote.
Fetch contacts the upstream remote, or the first configured remote if no upstream
exists. Changing the comparison selector does not redirect pull or push.

Git actions use short-lived, single-use previews bound to repository state.
Changed content requires a new preview. Pull and sync require a clean worktree
and use fast-forward-only updates. No force push, rebase, reset, discard, or
pruning is exposed. Missing upstreams, conflicts, and in-progress Git operations
disable actions that cannot safely proceed. A failed sync reports any completed
pull rather than silently retrying.

### 🕸️ Diagram — the shape of the change

![GitSummit diagram showing dependencies in a synthetic catalog project](docs/screenshots/tab-diagram.png)

A top-to-bottom flow. Changed files are grouped into **layers** by how they depend on each other: the top layer depends on nothing else in the change, each layer below uses the one above it, and files with no links land in **Standalone**. Layers are named after the file the rest of the layer leans on — `Data access` → `Core logic` → `Tests`.

Every card carries the filename, its directory, line counts, `↑used-by` / `↓uses` degrees and a one-line description.

| | |
| --- | --- |
| **Solid arrow** | *uses* — points **downward**, from a dependency into the file that consumes it |
| **Dashed red arrow** | a link this change **removed** |
| **Ringed card** | flagged: read this one closely |
| **Hover** | isolates a file and everything it touches |
| **Click** | jumps to it in **Changes**, with a `↩ Back to diagram` button waiting |

### 📄 Changes — file by file

![GitSummit file summary and diff for synthetic catalog search code](docs/screenshots/tab-changes.png)

Each changed file is a card: status, name, risk, directory, counts, a 1–3 sentence summary, signal chips (`+ createRateLimiter`, `− resetWindow`, `+ ioredis`) and the plain-language reasons behind its risk score.

Three groupings, one click apart:

- **Triage** *(default)* — riskiest first: **Read closely** → **Worth a look** → **Routine**
- **List** — flat, ordered by churn
- **Layers** — the Diagram's ordering, so you read the change in the order it was built

Expand a card for **Changed hunks / Whole file**, **Full screen**, **Open file**,
and **Comment**. Open file first requests the host's editor canvas. If that is
unavailable, it can fall back to an installed editor or the system file handler.

### 📜 Commits — where the work went

![GitSummit commit timeline and directory summary using demonstration data](docs/screenshots/tab-commits.png)

The branch's commit narrative, plus a directory rollup showing where the change is concentrated. Click a directory to filter **Changes** down to it.

---

## 🎯 Risk — a heuristic that shows its work

Every file gets **Risk: none / small / medium / high**. It is a *heuristic*, so it is never presented as a verdict — **every point carries its own reason**, printed right on the card.

| Signal | Why it counts |
| :-- | :-- |
| 🗑️ the whole file is removed | remaining imports may need changes |
| ✂️ removes declarations | callers may depend on the removed API |
| 🔗 N changed files depend on it | blast radius *inside this very change* |
| 📦 moved / renamed | every import pointing at it must change |
| 📈 large change, many deletions | more surface area to get wrong |
| ⚙️ dependency manifest or CI edit | breaks the **build**, not just the code |
| 🧪 no changed test is linked to it | the heuristic found no related test in this change |

The header shows the change-wide risk: the worst file, nudged up for each additional notable one.

---

## 🔍 Filtering that can't hide the scary file

One filter bar applies to the **three review tabs**: a search box plus
**Added / Edited / Deleted / Renamed** chips.

The **High risk** chip is deliberately *not* another `AND`. It is an **override** — it shows every flagged file regardless of the other filters, which grey themselves out while it is on.

> **Why:** so nothing risky can hide behind a filter you forgot was set.

---

## 💬 Review comments → straight back to the agent

Comment on a whole file, or on any individual line in a diff. Comments live in the canvas for the length of the review — **nothing is written into your repository**.

**Submit comments** prepares Markdown grouped by file and attempts to copy it to
the clipboard. The agent can read comments with `get_feedback`. This does not
post a review or comment to GitHub. The feedback flow is:

```mermaid
flowchart LR
    A["🤖 Agent<br/>makes changes"] --> B["🔍 You review<br/>in GitSummit"]
    B --> C["💬 Submit<br/>comments"]
    C --> D["🤖 act on my<br/>GitSummit feedback"]
    D --> A
    B -.->|"looks good"| E["🚀 Open the PR"]
```

After submitting, you literally just say:

> *"act on my GitSummit feedback"*

---

## 🔄 Auto-update that doesn't fight your editor

Source Control refreshes local status every eight seconds while visible and Auto
is enabled. Its snapshots use working-file content hashes and staged Git entries.

GitSummit watches the repository and recomputes when its Git fingerprint changes.

Filesystem events are debounced for 400 ms. A fingerprint of HEAD and porcelain
status reduces redundant updates. It is not a content digest: another edit to an
already-modified file may require **Refresh**. Refreshing preserves the selected
tab, expanded files, and scroll position.

The extension uses recursive `fs.watch` where supported, with a four-second poll
as a fallback. Watching runs while a canvas event-stream client is connected.
The **Auto** toggle pauses automatic UI refresh; it does not stop the server's
watcher.

---

## 🧬 How the comparison base is chosen

In priority order:

```
explicit override  →  origin/HEAD (the remote's default branch)  →  first of main / master / develop / trunk
```

GitSummit then compares the **working tree** — committed **+** staged **+** unstaged — against the **merge-base** with that ref. Untracked files the agent just created are folded in as new-file additions, so work-in-progress shows up too.

---

## 🤖 Agent-facing API

**Open input** (`open_canvas` with `canvasId: "gitsummit"`):

| Field | Type | What it does |
| --- | --- | --- |
| `base` | `string` | Force a comparison base, e.g. `"main"` |
| `focus` | `string` | Open straight to a specific file |

**Actions:**

| Action | What it does |
| --- | --- |
| `refresh` | Recompute from current git state and push the update to the canvas |
| `set_base` | Change the comparison base, then refresh |
| `focus_file` | Switch to **Changes**, expand a file, scroll to it |
| `get_feedback` | Read the reviewer's comments back as markdown |
| `source_status` | Read local state and a remote-ref comparison without fetching or changing Git |

`source_status` accepts an optional `ref` naming an existing remote-tracking
branch. Git mutations are exposed through the canvas UI, not as agent actions.

---

## ⌨️ Keyboard shortcuts

| | | | |
| :-: | --- | :-: | --- |
| <kbd>0</kbd> | Source Control | <kbd>Ctrl+Enter</kbd> | Preview a commit from the message box |
| <kbd>1</kbd> | Diagram | <kbd>/</kbd> | Focus the filter |
| <kbd>2</kbd> | Changes | <kbd>r</kbd> | Refresh |
| <kbd>3</kbd> | Commits | <kbd>Esc</kbd> | Close the full-screen diff |

Shortcuts do not intercept typing in input fields. Escape also cancels an open
Git-operation confirmation.
With a tab focused, use Left/Right arrows, Home, or End to change views.
The header, tab row, and toolbar stay aligned. Each view preserves its reading
position. Short transitions respect reduced-motion preferences.

---

## 🏗️ Architecture

```mermaid
flowchart TB
    subgraph host["Copilot CLI session"]
        AGENT["Agent — open_canvas, actions"]
    end

    subgraph ext["extension.mjs — separate Node process"]
        SRV["Loopback HTTP server<br/>127.0.0.1, random port"]
        SSE["SSE stream — /events"]
        WATCH["Repo watcher<br/>debounce + fingerprint"]
    end

    subgraph core["Analysis"]
        GIT["git.mjs<br/>Git execution and diff parsing"]
        SC["source-control.mjs<br/>status, comparison, confirmed actions"]
        AN["analyze.mjs<br/>summaries, links, risk"]
    end

    UI["web/ — iframe UI<br/>vanilla JS, no framework"]
    REPO[("Your repository")]

    AGENT --> SRV
    SRV --> GIT --> REPO
    SRV --> SC --> GIT
    GIT --> AN --> SRV
    SRV --> UI
    SSE --> UI
    WATCH --> REPO
    WATCH --> SSE
    UI -->|comments and confirmed Git actions| SRV
    SRV -->|get_feedback| AGENT
```

| File | Purpose |
| --- | --- |
| [`extension.mjs`](.github/extensions/gitsummit/extension.mjs) | Canvas registration, loopback HTTP server, event stream, watcher, and agent actions |
| [`git.mjs`](.github/extensions/gitsummit/git.mjs) | Git introspection and unified-diff parsing |
| [`source-control.mjs`](.github/extensions/gitsummit/source-control.mjs) | Local status, remote comparisons, and confirmed Git actions |
| [`http-guard.mjs`](.github/extensions/gitsummit/http-guard.mjs) | Per-panel token and loopback request validation |
| [`source-control.test.mjs`](.github/extensions/gitsummit/source-control.test.mjs) | Integration tests using disposable local Git remotes |
| [`analyze.mjs`](.github/extensions/gitsummit/analyze.mjs) | Heuristic summaries, links, and risk |
| [`web/app.js`](.github/extensions/gitsummit/web/app.js) | Interactive review UI |
| [`web/styles.css`](.github/extensions/gitsummit/web/styles.css) | Shared dark palette and review layout |
| [`web/source-control.js`](.github/extensions/gitsummit/web/source-control.js) | Source Control interactions and confirmations |
| [`web/source-control.css`](.github/extensions/gitsummit/web/source-control.css) | Stacked Source Control layout |
| [`web/index.html`](.github/extensions/gitsummit/web/index.html) | Canvas document |

The extension uses Node built-ins and the host-provided Copilot SDK. No build step
is required. Its dependency links and risk scores are text-based heuristics,
not a resolved code graph, a security audit, or evidence that tests passed.

---

## 🔒 Privacy and data flow

- **Runtime repository data is sensitive.** The canvas reads paths, diffs, file
  contents, commit messages, and author names from the workspace it reviews.
  It does not automatically redact them.
- **Review data is local to the extension process.** The UI uses a per-instance
  HTTP server bound to `127.0.0.1`. Review comments are held in memory and can be
  returned to the host agent or copied to the clipboard.
- **Requests are protected, not sandboxed.** Local API endpoints require a
  per-panel token and reject cross-origin requests. Do not expose or forward the
  port. Use trusted repositories and local software.
- **Confirmed Git actions can send data.** Fetch, pull, push, and sync contact
  the configured Git remote. Push sends commits and their contents. Review the
  repository, destination, and commands before confirming.
- **Git changes persist.** Staging updates the index, committing creates a
  commit, and pulling can update working files. Comments and bounded Git Output
  are held in memory. Unsubmitted message drafts reset with the panel.
- **Other tools have their own policies.** Git uses the current user's
  authentication, hooks, and signing configuration. Git terminal prompts and
  Git Credential Manager interactivity are disabled. Other configured askpass
  or SSH helpers may still prompt. Failures and timeouts appear in the UI.
  Inspect Git state before retrying a timed-out operation. Host processing,
  clipboard synchronization, editors, and Git helpers are separate. Remote URL
  credentials are redacted, but source code and messages are not.

Do not publish screenshots, logs, review exports, or recordings from a work or
customer repository. Use a synthetic example and follow the
[screenshot guidance](docs/screenshots/README.md).

Before making a fork or release public, inspect all branches, tags, historical
blobs, commit attribution, commit trailers, and hosted assets. Removing a value
from the latest file does not remove it from Git history. Confirm that you have
the right to publish the code; a content scan cannot establish ownership.

---

## 🎨 Theme

All four tabs share Source Control's dark background and inset colors rather
than inheriting the host theme.

---

## 📋 Requirements

| | |
| --- | --- |
| **Host** | a GitHub Copilot host with canvas extension support |
| **Node** | 20 or later |
| **git** | on `PATH` |
| **OS** | Windows · macOS · Linux |

## Validation

From `.github/extensions/gitsummit`, run:

```text
node --test source-control.test.mjs
```

Tests create disposable local repositories and remotes. They do not change your
current repository or contact an external remote. Set `GITSUMMIT_TEST_ROOT` to
choose where to keep the test fixtures. The symlink test reports a skip if the
account lacks permission to create symbolic links.

## License

No license has been selected for this repository. Public visibility alone does
not grant permission to reuse or redistribute its code. The owner must confirm
publication rights and select a license before presenting it as open source.
Third-party icons retain their own [licenses and usage terms](docs/icons/README.md).

---

<div align="center">

**Built for the moment between _"the agent is done"_ and _"ship it"_.**

</div>
