// GitSummit canvas client. Talks only to its own loopback server:
//   GET  /api/rundown             -> full payload (summaries, links, risk)
//   GET  /api/file?path=&full=1   -> parsed diff for one file
//   POST /api/open                -> open a file in the editor
//   GET/POST/DELETE /api/comments -> review comments the agent can read back
//   GET  /events                  -> SSE ({type:"refresh"|"base"|"focus"})

/* ================================================================
   App
   ================================================================ */
const state = {
    rundown: null,
    tab: "diagram",
    changesView: "triage",
    filter: "",
    kindOff: new Set(),
    riskOnly: false,
    fromDiagram: null,
    open: new Set(),
    full: new Set(),
    diffs: new Map(), // path|full -> parsed diff
    comments: [],
    submitted: false,
    sheet: null,
    auto: true,
};
const CHANGES_VIEWS = [
    ["triage", "Triage"],
    ["list", "List"],
    ["layers", "Layers"],
];
const $ = (id) => document.getElementById(id);
const esc = (s) =>
    String(s ?? "")
        .replace(/&/g, "&amp;")
        .replace(/</g, "&lt;")
        .replace(/>/g, "&gt;");

// Four review-facing kinds, so R/C and M/T don't fragment the filter.
const KINDS = ["added", "edited", "deleted", "renamed"];
const KIND_LABEL = {
    added: "Added",
    edited: "Edited",
    deleted: "Deleted",
    renamed: "Renamed",
};
const kindOf = (st) =>
    st === "A" ? "added" : st === "D" ? "deleted" : st === "R" || st === "C" ? "renamed" : "edited";
const KIND_COLOR = {
    added: "var(--st-A)",
    edited: "var(--st-M)",
    deleted: "var(--st-D)",
    renamed: "var(--st-R)",
};
const statusColor = (st) => KIND_COLOR[kindOf(st)];

/** Every changed file, with the display fields the UI needs. */
const files = () => state.rundown?.files ?? [];
const risk = (f) => f.risk ?? { score: 0, band: "none", reasons: [] };




/* The High risk chip is an override, not another AND: when it's on you
   get every flagged file regardless of the kind chips or the search box,
   so nothing risky can hide behind a filter you forgot was set. */
function visible() {
    if (state.riskOnly) {
        return files().filter(
            (f) => risk(f).band === "high" || risk(f).band === "medium",
        );
    }
    const q = state.filter.trim().toLowerCase();
    return files().filter(
        (f) =>
            !state.kindOff.has(kindOf(f.status)) &&
            (!q || f.path.toLowerCase().includes(q)),
    );
}

/* ---------------- topbar ---------------- */
function renderTopbar() {
    const r = state.rundown.repo;
    $("repoName").textContent = r.name;
    $("branchFlow").innerHTML =
        '<span class="head">' +
        esc(r.branch) +
        "</span>" +
        (r.base ? ' <span class="arrow">→</span> <span>' + esc(r.base) + "</span>" : "");

    const risky = state.rundown.risk ?? { band: "none", reasons: [], alsoNotable: 0 };
    const why = risky.topPath
        ? "Riskiest file: " +
          risky.topPath +
          (risky.reasons.length ? " — " + risky.reasons.join("; ") : "") +
          (risky.alsoNotable
              ? "\n" + risky.alsoNotable + " other file(s) also worth a close look."
              : "") +
          "\n\nHeuristic only: blast radius inside this change, removed declarations, deletions, dependency/CI edits and missing test coverage."
        : "";

    const n = files().length;
    $("chips").innerHTML =
        '<span class="meta">' +
        n +
        " file" +
        (n === 1 ? "" : "s") +
        (r.commitCount
            ? " · " + r.commitCount + " commit" + (r.commitCount === 1 ? "" : "s")
            : "") +
        "</span>" +
        '<span class="risk risk-' +
        risky.band +
        '" title="' +
        esc(why) +
        '"><i></i>Risk: ' +
        risky.band +
        "</span>";

    $("stamp").textContent =
        "updated " +
        new Date(state.rundown.generatedAt).toLocaleTimeString([], {
            hour: "2-digit",
            minute: "2-digit",
        });
    $("tabCountChanges").textContent = n;
    $("tabCountCommits").textContent = state.rundown.commits.length;
}

/* ---------------- tabs ---------------- */
function moveInk() {
    const btn = $("tabs").querySelector('.tab[aria-selected="true"]');
    const ink = $("tabInk");
    if (!btn) return;
    ink.style.left = btn.offsetLeft + "px";
    ink.style.width = btn.offsetWidth + "px";
}
function setTab(name) {
    state.tab = name;
    $("tabs")
        .querySelectorAll(".tab")
        .forEach((b) => b.setAttribute("aria-selected", String(b.dataset.tab === name)));
    document
        .querySelectorAll(".panel")
        .forEach((p) => p.classList.toggle("active", p.id === "panel-" + name));
    moveInk();
    renderTabTools();
    renderActiveTab();
}

function renderTabTools() {
    const host = $("tabtools");
    if (state.tab !== "changes") {
        host.innerHTML = "";
        return;
    }
    const inline = true;
    host.innerHTML =
        '<span class="seg" id="viewSeg">' +
        CHANGES_VIEWS.map(
            (v) =>
                '<button class="seg-btn' +
                (state.changesView === v[0] ? " on" : "") +
                '" data-view="' +
                v[0] +
                '">' +
                v[1] +
                "</button>",
        ).join("") +
        "</span>" +
        (inline
            ? '<button class="tbtn" id="expandAll">Expand all</button>' +
              '<button class="tbtn" id="collapseAll">Collapse all</button>'
            : "");

    host.querySelectorAll(".seg-btn").forEach((b) =>
        b.addEventListener("click", () => {
            state.changesView = b.dataset.view;
            renderTabTools();
            renderCards();
        }),
    );
    if (inline) {
        $("expandAll").addEventListener("click", () => {
            visible().forEach((f) => state.open.add(f.path));
            renderCards();
        });
        $("collapseAll").addEventListener("click", () => {
            state.open.clear();
            renderCards();
        });
    }
}

/** Re-render whatever tab is showing — used by the filter and by refresh. */
function renderActiveTab() {
    if (state.tab === "changes") renderCards();
    else if (state.tab === "diagram") drawDiagram();
    else renderCommits();
    const shown = visible().length;
    $("fcount").textContent = state.riskOnly
        ? shown + " flagged · other filters paused"
        : shown === files().length
          ? ""
          : shown + " of " + files().length + " files";
}

/* ---------------- changes ---------------- */
function miniBar(a, d) {
    const t = a + d;
    if (!t) return '<span class="minibar"><i></i><i></i><i></i><i></i><i></i></span>';
    let g = Math.round((5 * a) / t);
    if (a > 0 && g === 0) g = 1;
    if (d > 0 && g === 5) g = 4;
    let s = "";
    for (let i = 0; i < 5; i++) s += '<i class="' + (i < g ? "a" : "d") + '"></i>';
    return '<span class="minibar">' + s + "</span>";
}

function renderStatusChips() {
    const counts = {};
    for (const f of files()) {
        const k = kindOf(f.status);
        counts[k] = (counts[k] || 0) + 1;
    }
    const riskCount = files().filter(
        (f) => risk(f).band === "high" || risk(f).band === "medium",
    ).length;
    $("schips").innerHTML =
        KINDS.filter((k) => counts[k])
            .map((k) => {
                const on = !state.kindOff.has(k);
                return (
                    '<button class="schip ' +
                    (on ? "on" : "") +
                    '" data-k="' +
                    k +
                    '" aria-pressed="' +
                    on +
                    '"><span class="dot" style="background:' +
                    KIND_COLOR[k] +
                    '"></span>' +
                    KIND_LABEL[k] +
                    " <b>" +
                    counts[k] +
                    "</b></button>"
                );
            })
            .join("") +
        (riskCount
            ? '<span class="chip-div"></span><button class="schip risk-chip ' +
              (state.riskOnly ? "on" : "") +
              '" data-riskonly aria-pressed="' +
              state.riskOnly +
              '" title="Show only the files flagged as needing a close look">' +
              '<span class="ring"></span>High risk <b>' +
              riskCount +
              "</b></button>"
            : "");

    $("schips")
        .querySelectorAll(".schip[data-k]")
        .forEach((b) => {
            b.disabled = state.riskOnly;
            b.addEventListener("click", () => {
                const k = b.dataset.k;
                if (state.kindOff.has(k)) state.kindOff.delete(k);
                else state.kindOff.add(k);
                renderStatusChips();
                renderActiveTab();
            });
        });
    $("filter").disabled = state.riskOnly;
    $("filter").placeholder = state.riskOnly
        ? "Paused while High risk is on"
        : "Filter files…  (/)";
    const rb = $("schips").querySelector("[data-riskonly]");
    if (rb)
        rb.addEventListener("click", () => {
            state.riskOnly = !state.riskOnly;
            renderStatusChips();
            renderActiveTab();
        });
}

/* ================================================================
   Diff surface + review feedback.

   Three things live here:
     - the diff itself, either just the changed hunks or the whole file
     - a per-file toolbar (whole file / full screen / open in editor)
     - review comments, at file level or pinned to a diff line, which
       the agent can read back out of the canvas
   ================================================================ */

function diffRowHtml(f, l, key) {
    const type = l[0],
        oldNo = l[1],
        newNo = l[2],
        content = l[3];
    const sign = type === "add" ? "+" : type === "del" ? "-" : " ";
    const anchor = newNo == null ? "o" + oldNo : "n" + newNo;
    const mine = state.comments.filter((c) => c.path === f.path && c.line === anchor);
    return (
        '<tr class="' +
        type +
        '" data-anchor="' +
        anchor +
        '"><td class="cmt"><button class="cmt-add" data-path="' +
        esc(f.path) +
        '" data-anchor="' +
        anchor +
        '" data-key="' +
        key +
        '" title="Comment on this line">+</button></td><td class="gut">' +
        (oldNo == null ? "" : oldNo) +
        '</td><td class="gut">' +
        (newNo == null ? "" : newNo) +
        '</td><td class="code" data-sign="' +
        sign +
        '">' +
        esc(content) +
        "</td></tr>" +
        mine
            .map(
                (c) =>
                    '<tr class="cmt-row"><td></td><td colspan="3">' +
                    commentHtml(c) +
                    "</td></tr>",
            )
            .join("")
    );
}

function commentHtml(c) {
    return (
        '<div class="comment"><div class="comment-body">' +
        esc(c.text) +
        '</div><button class="comment-del" data-id="' +
        c.id +
        '" title="Delete comment">×</button></div>'
    );
}

/** The diff body only — shared by the inline card and the full-screen sheet. */
function diffBodyHtml(f, key) {
    const diff = state.diffs.get(diffKey(f));
    if (!diff) return '<div class="diff-note">Loading diff…</div>';
    if (diff.error) return '<div class="diff-note">' + esc(diff.error) + "</div>";
    if (diff.binary) return '<div class="diff-note">Binary file — no textual diff to show.</div>';
    if (!diff.hunks?.length)
        return '<div class="diff-note">No line changes (metadata or mode change only).</div>';

    const body = diff.hunks
        .map((h) => {
            const rows = h.lines
                .map((l) => diffRowHtml(f, [l.type, l.oldNo, l.newNo, l.content], key))
                .join("");
            return (
                '<div class="hunk"><div class="hunk-header"><span>' +
                esc(h.header) +
                '</span><span class="section">' +
                esc(h.section) +
                '</span></div><table class="diff"><tbody>' +
                rows +
                "</tbody></table></div>"
            );
        })
        .join("");
    return (
        body +
        (diff.truncated
            ? '<div class="diff-note">Diff truncated — this file is large. Open it in your editor for the full change.</div>'
            : "")
    );
}

const diffKey = (f) => f.path + (state.full.has(f.path) ? "|full" : "");

/** Fetch a diff if we don't have it yet, then repaint just that diff body. */
async function ensureDiff(f) {
    const key = diffKey(f);
    if (state.diffs.has(key)) return;
    try {
        const res = await fetch(
            "api/file?path=" +
                encodeURIComponent(f.path) +
                (state.full.has(f.path) ? "&full=1" : ""),
            { cache: "no-store" },
        );
        state.diffs.set(key, await res.json());
    } catch (e) {
        state.diffs.set(key, { error: "Could not load diff: " + String(e) });
    }
    // Only repaint if this file is still on screen in the same mode.
    if (diffKey(f) !== key) return;
    for (const host of document.querySelectorAll(
        '.card[data-path="' + CSS.escape(f.path) + '"] .card-diff, #sheet .sheet-body',
    )) {
        const body = host.querySelector(".diff-body");
        if (body) body.innerHTML = diffBodyHtml(f, host.closest("#sheet") ? "sheet" : "card");
    }
}

function diffToolsHtml(f, key) {
    const full = state.full.has(f.path);
    const fileComments = state.comments.filter((c) => c.path === f.path && !c.line);
    return (
        '<div class="difftools">' +
        '<span class="seg"><button class="seg-btn' +
        (full ? "" : " on") +
        '" data-diffmode="hunks" data-path="' +
        esc(f.path) +
        '">Changed hunks</button><button class="seg-btn' +
        (full ? " on" : "") +
        '" data-diffmode="full" data-path="' +
        esc(f.path) +
        '">Whole file</button></span>' +
        '<span class="tool-spacer"></span>' +
        (key === "sheet"
            ? ""
            : '<button class="tbtn" data-sheet="' +
              esc(f.path) +
              '" title="Open this diff full screen">⤢ Full screen</button>') +
        '<button class="tbtn" data-openfile="' +
        esc(f.path) +
        '" title="Open this file in your editor">↗ Open file</button>' +
        '<button class="tbtn" data-comment="' +
        esc(f.path) +
        '" data-key="' +
        key +
        '">＋ Comment</button>' +
        "</div>" +
        (fileComments.length
            ? '<div class="file-comments">' +
              fileComments.map(commentHtml).join("") +
              "</div>"
            : "")
    );
}

function diffHtml(f, key) {
    ensureDiff(f);
    return (
        diffToolsHtml(f, key || "card") +
        '<div class="diff-body">' +
        diffBodyHtml(f, key || "card") +
        "</div>"
    );
}

/* ---- comment composer ---- */
function openComposer(host, path, anchor) {
    host.querySelectorAll(".composer").forEach((c) => c.remove());
    const box = document.createElement("div");
    box.className = "composer";
    box.innerHTML =
        '<textarea rows="3" placeholder="Feedback for the agent — what should it change here?"></textarea>' +
        '<div class="composer-actions"><button class="tbtn primary" data-save>Save comment</button>' +
        '<button class="tbtn" data-cancel>Cancel</button></div>';
    host.appendChild(box);
    const ta = box.querySelector("textarea");
    ta.focus();
    const save = async () => {
        const text = ta.value.trim();
        box.remove();
        if (text) {
            // The extension holds the comments so an agent action can read them
            // back; nothing is written into the repository.
            try {
                const res = await fetch("api/comments", {
                    method: "POST",
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify({ path, line: anchor || null, text }),
                });
                state.comments = (await res.json()).comments ?? state.comments;
                state.submitted = false;
            } catch {
                /* keep the UI responsive even if the post failed */
            }
        }
        renderFeedbackChip();
        renderCards();
        if (state.sheet) openSheet(state.sheet);
    };
    box.querySelector("[data-save]").addEventListener("click", save);
    box.querySelector("[data-cancel]").addEventListener("click", () => box.remove());
    ta.addEventListener("keydown", (e) => {
        if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) save();
        if (e.key === "Escape") box.remove();
    });
}

/* ---- full-screen diff sheet ---- */
function openSheet(path) {
    const f = files().find((x) => x.path === path);
    if (!f) return;
    state.sheet = path;
    const sheet = $("sheet");
    sheet.hidden = false;
    sheet.innerHTML =
        '<div class="sheet-panel"><div class="sheet-head">' +
        '<span class="badge badge-' +
        f.status +
        '">' +
        f.status +
        '</span><span class="sheet-path"><span>' +
        esc(f.dir === "." ? "" : f.dir + "/") +
        "<b>" +
        esc(f.name) +
        "</b></span></span>" +
        '<span class="risk risk-' +
        risk(f).band +
        '">Risk: ' +
        risk(f).band +
        "</span>" +
        '<button class="tbtn" data-closesheet>✕ Close</button></div>' +
        '<div class="sheet-body">' +
        diffHtml(f, "sheet") +
        "</div></div>";
}

function closeSheet() {
    state.sheet = null;
    $("sheet").hidden = true;
    $("sheet").innerHTML = "";
}

/* ---- feedback panel: everything the agent will read back ---- */
function feedbackMarkdown() {
    if (!state.comments.length) return "";
    const byFile = new Map();
    for (const c of state.comments) {
        if (!byFile.has(c.path)) byFile.set(c.path, []);
        byFile.get(c.path).push(c);
    }
    let out = "## GitSummit review feedback\n\n";
    for (const [path, list] of byFile) {
        out += "### " + path + "\n";
        for (const c of list) {
            const where = c.line
                ? "line " + c.line.slice(1) + (c.line[0] === "o" ? " (old)" : "")
                : "file";
            out += "- **" + where + "** — " + c.text + "\n";
        }
        out += "\n";
    }
    return out;
}

function renderFeedbackChip() {
    const n = state.comments.length;
    const btn = $("feedbackBtn");
    const label = btn.querySelector("span");
    btn.classList.toggle("ready", n > 0 && !state.submitted);
    btn.classList.toggle("done", n > 0 && state.submitted);
    btn.classList.toggle("idle", n === 0);
    label.textContent = state.submitted && n ? "Comments submitted" : "Submit comments";
    let badge = btn.querySelector(".n");
    if (n) {
        if (!badge) {
            badge = document.createElement("span");
            badge.className = "n";
            btn.appendChild(badge);
        }
        if (badge.textContent !== String(n)) {
            btn.classList.remove("nudge");
            void btn.offsetWidth;
            btn.classList.add("nudge");
        }
        badge.textContent = n;
    } else if (badge) {
        badge.remove();
    }
}

function submitComments() {
    if (!state.comments.length) return;
    // The comments already live in the extension, so submitting just marks them
    // ready and copies the markdown; the agent reads them via get_feedback.
    navigator.clipboard.writeText(feedbackMarkdown()).catch(() => {});
    state.submitted = true;
    renderFeedbackChip();
    closeSheet();
    toast(
        state.comments.length +
            " comment" +
            (state.comments.length === 1 ? "" : "s") +
            " submitted — ask Copilot to act on your review",
    );
}

function openFeedback() {
    const sheet = $("sheet");
    sheet.hidden = false;
    const md = feedbackMarkdown();
    const n = state.comments.length;
    sheet.innerHTML =
        '<div class="sheet-panel"><div class="sheet-head">' +
        '<span class="sheet-title">Submit comments</span>' +
        '<span class="sheet-note">' +
        (n
            ? n + " comment" + (n === 1 ? "" : "s") + " ready for Copilot"
            : "No comments yet") +
        "</span>" +
        '<span class="tool-spacer"></span>' +
        (n
            ? '<button class="tbtn" data-copyfb>Copy as markdown</button>' +
              '<button class="tbtn" data-clearfb>Clear all</button>' +
              '<button class="submit-btn ready" data-submitfb>' +
              '<svg viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M14.5 1.5 7.2 8.8"/><path d="M14.5 1.5 9.9 14.5 7.2 8.8 1.5 6.1 14.5 1.5Z"/></svg>' +
              "<span>Submit to Copilot</span></button>"
            : "") +
        '<button class="tbtn" data-closesheet>✕ Close</button></div>' +
        '<div class="sheet-body feedback-body">' +
        (md
            ? "<pre class='fb-md'>" + esc(md) + "</pre>"
            : '<div class="diff-note">Add a comment from any file card or diff line. Comments stay in this review — nothing is written to your repo — and the agent reads them back out of the canvas.</div>') +
        "</div></div>";
}

function toast(text) {
    const n = document.createElement("div");
    n.className = "toast";
    n.textContent = text;
    document.body.appendChild(n);
    setTimeout(() => n.remove(), 2600);
}

function cardHtml(f) {
    const open = state.open.has(f.path);
    const counts = f.binary
        ? '<span style="color:var(--muted)">bin</span>'
        : '<span class="a">+' +
          f.additions +
          '</span><span class="d">-' +
          f.deletions +
          "</span>" +
          miniBar(f.additions, f.deletions);
    const sigs = (f.signals || [])
        .map((s) => '<span class="sig ' + (s.k || "") + '">' + esc(s.t) + "</span>")
        .join("");
    const r = risk(f);
    const why = r.reasons.length
        ? '<div class="risk-why"><b>Risk</b>' + esc(r.reasons.join(" · ")) + "</div>"
        : "";
    return (
        '<article class="card ' +
        (open ? "open " : "") +
        (r.band === "high" ? "risky-high" : r.band === "medium" ? "risky" : "") +
        '" data-path="' +
        esc(f.path) +
        '" style="--acc:' +
        statusColor(f.status) +
        '">' +
        '<div class="card-head" role="button" tabindex="0" aria-expanded="' +
        open +
        '">' +
        '<span class="badge badge-' +
        f.status +
        '">' +
        f.status +
        "</span>" +
        '<span class="ch-title"><span class="ch-name" title="' +
        esc(f.path) +
        '">' +
        esc(f.name) +
        "</span>" +
        (state.fromDiagram === f.path
            ? '<button class="backbtn" data-back title="Return to this file in the diagram">↩ Back to diagram</button>'
            : "") +
        "</span>" +
        '<span class="risk risk-' +
        r.band +
        '" title="Risk: ' +
        r.band +
        (r.reasons.length ? " — " + esc(r.reasons.join("; ")) : "") +
        '"><i></i>Risk: ' +
        r.band +
        "</span>" +
        '<span class="chev">▶</span>' +
        '<span class="ch-sub"><span class="ch-dir"><span>' +
        esc(f.dir === "." ? "(root)" : f.dir) +
        '</span></span><span class="counts">' +
        counts +
        "</span></span>" +
        "</div>" +
        '<div class="card-summary">' +
        '<div class="summary-text">' +
        esc(f.summary) +
        "</div>" +
        (sigs ? '<div class="signals">' + sigs + "</div>" : "") +
        why +
        "</div>" +
        (open ? '<div class="card-diff">' + diffHtml(f, "card") + "</div>" : "") +
        "</article>"
    );
}

function renderCards() {
    const files = visible();
    const host = $("cards");
    if (!files.length) {
        host.innerHTML =
            '<div class="empty"><div class="empty-inner"><div class="empty-emoji">🔍</div><div>No files match.</div></div></div>';
        return;
    }
    const groups =
        state.changesView === "triage"
            ? triageGroups(files)
            : state.changesView === "layers"
              ? layerGroups(files)
              : null;
    host.innerHTML = groups
        ? groups.map(groupHtml).join("")
        : files.map(cardHtml).join("");
    host.querySelectorAll(".card-head").forEach((h) => {
        const fire = () => toggle(h.closest(".card").dataset.path);
        h.addEventListener("click", (e) => {
            if (e.target.closest("[data-back]")) return;
            fire();
        });
        h.addEventListener("keydown", (e) => {
            if (e.target.closest("[data-back]")) return;
            if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                fire();
            }
        });
    });
}

function groupHtml(g) {
    return (
        '<section class="group"><div class="group-head">' +
        '<span class="group-step ' +
        (g.tone || "") +
        '">' +
        esc(g.step) +
        "</span>" +
        '<span class="group-cap">' +
        esc(g.cap) +
        "</span>" +
        '<span class="group-sub">' +
        esc(g.sub) +
        "</span>" +
        '<span class="group-rule"></span></div>' +
        g.files.map(cardHtml).join("") +
        "</section>"
    );
}

/* View B — Triage: read order, riskiest first. Turns the score from a
   decoration into an instruction about where to spend attention. */
function triageGroups(files) {
    const buckets = [
        {
            test: (b) => b === "high" || b === "medium",
            step: "!",
            tone: "g-high",
            cap: "Read closely",
            sub: "biggest blast radius — start here",
        },
        {
            test: (b) => b === "small",
            step: "~",
            tone: "g-mid",
            cap: "Worth a look",
            sub: "meaningful edits, contained impact",
        },
        {
            test: (b) => b === "none",
            step: "·",
            tone: "g-low",
            cap: "Routine",
            sub: "docs, config and small edits",
        },
    ];
    const sorted = files.slice().sort((a, b) => risk(b).score - risk(a).score);
    return buckets
        .map((k) => ({
            step: k.step,
            tone: k.tone,
            cap: k.cap,
            sub: k.sub,
            files: sorted.filter((f) => k.test(risk(f).band)),
        }))
        .filter((g) => g.files.length)
        .map((g) => ({
            ...g,
            sub:
                g.files.length +
                " file" +
                (g.files.length === 1 ? "" : "s") +
                " · " +
                g.sub,
        }));
}

/* View C — Layers: the same dependency order the Diagram uses, so you
   read the change in the order it was built. */
/** "3 files · use Middleware" — shared by the Changes and Diagram tabs. */
function bandSub(b) {
    const n = b.files.length;
    const verb = n === 1 ? "uses" : "use";
    return (
        n +
        " file" +
        (n === 1 ? "" : "s") +
        " · " +
        (b.standalone
            ? "no links to the rest of the change"
            : b.uses
              ? verb + " " + b.uses
              : "nothing else here feeds them")
    );
}

function layerGroups(files) {
    return layerModel(files).bands.map((b) => ({
        step: b.standalone ? "—" : b.step,
        tone: b.standalone ? "g-low" : "",
        cap: b.cap,
        sub: bandSub(b),
        files: b.files,
    }));
}

function toggle(path) {
    if (state.open.has(path)) {
        state.open.delete(path);
        state.full.delete(path);
    } else {
        state.open.add(path);
    }
    renderCards();
}

function goToFile(path, fromDiagram) {
    state.filter = "";
    $("filter").value = "";
    state.kindOff.clear();
    state.riskOnly = false;
    state.fromDiagram = fromDiagram ? path : null;
    renderStatusChips();
    state.open.add(path);
    setTab("changes");
    requestAnimationFrame(() => {
        const card = $("cards").querySelector('.card[data-path="' + CSS.escape(path) + '"]');
        if (!card) return;
        card.scrollIntoView({ behavior: "smooth", block: "start" });
        card.classList.add("flash");
        setTimeout(() => card.classList.remove("flash"), 1200);
    });
}

/** Return to the diagram and pulse the node you came from. */
function backToDiagram() {
    const path = state.fromDiagram;
    state.fromDiagram = null;
    renderCards(); // drop the back button from the (now hidden) card
    setTab("diagram");
    requestAnimationFrame(() => {
        const node = $("stage").querySelector(
            '.cardnode[data-path="' + CSS.escape(path) + '"]',
        );
        if (!node) return;
        node.scrollIntoView({ behavior: "smooth", block: "center" });
        node.classList.add("flash");
        setTimeout(() => node.classList.remove("flash"), 1400);
    });
}

/* ---------------- commits ---------------- */
function renderCommits() {
    $("timeline").innerHTML = state.rundown.commits
        .map(
            (c) =>
                '<div class="tl-item"><div class="tl-subject">' +
                esc(c.subject) +
                '</div><div class="tl-meta"><span class="tl-hash">' +
                esc(c.short) +
                "</span><span>" +
                esc(c.author) +
                "</span><span>·</span><span>" +
                esc(c.date) +
                "</span></div></div>",
        )
        .join("");

    const m = new Map();
    for (const f of visible()) {
        const top = f.dir === "." ? "(root)" : f.dir.split("/")[0];
        const d = m.get(top) || { dir: top, additions: 0, deletions: 0, files: 0, churn: 0 };
        d.additions += f.additions;
        d.deletions += f.deletions;
        d.files++;
        d.churn += f.churn;
        m.set(top, d);
    }
    const dirs = [...m.values()].sort((a, b) => b.churn - a.churn);
    const max = Math.max(1, ...dirs.map((d) => d.churn));
    if (!dirs.length) {
        $("dirGrid").innerHTML =
            '<div style="color:var(--muted);font-size:12px">No files match the current filter.</div>';
        return;
    }
    $("dirGrid").innerHTML = dirs
        .map(
            (d) =>
                '<div class="dir-card" data-dir="' +
                esc(d.dir) +
                '"><div class="dir-head"><span class="dir-name">' +
                esc(d.dir) +
                '</span><span class="dir-files">' +
                d.files +
                " file" +
                (d.files === 1 ? "" : "s") +
                '</span></div><div class="bar"><span class="sa" style="width:' +
                (d.additions / max) * 100 +
                '%"></span><span class="sd" style="width:' +
                (d.deletions / max) * 100 +
                '%"></span></div><div class="dir-counts"><span class="a">+' +
                d.additions +
                '</span> <span class="d">-' +
                d.deletions +
                "</span></div></div>",
        )
        .join("");
    $("dirGrid")
        .querySelectorAll(".dir-card")
        .forEach((c) =>
            c.addEventListener("click", () => {
                const d = c.dataset.dir;
                state.filter = d === "(root)" ? "" : d + "/";
                $("filter").value = state.filter;
                setTab("changes");
            }),
        );
}

/* ---------------- shared SVG helpers ---------------- */
const SVGNS = "http://www.w3.org/2000/svg";
function el(n, attrs) {
    const e = document.createElementNS(SVGNS, n);
    for (const k in attrs || {}) e.setAttribute(k, attrs[k]);
    return e;
}

function showTip(evt, f, links) {
    const t = $("tip");
    const lk =
        links && (links.uses || links.usedBy)
            ? "<br>" +
              [
                  links.uses
                      ? "uses " + links.uses + " changed file" + (links.uses === 1 ? "" : "s")
                      : "",
                  links.usedBy
                      ? "used by " +
                        links.usedBy +
                        " changed file" +
                        (links.usedBy === 1 ? "" : "s")
                      : "",
              ]
                  .filter(Boolean)
                  .join(" · ")
            : "";
    t.innerHTML =
        '<div class="tp">' +
        esc(f.path) +
        '</div><div class="ts">' +
        KIND_LABEL[kindOf(f.status)] +
        " · " +
        (f.binary ? "binary" : "+" + f.additions + " / −" + f.deletions) +
        "<br>" +
        esc(String(f.summary || "").split(". ")[0]) +
        "." +
        lk +
        "</div>";
    t.classList.add("show");
    const st = $("stage").getBoundingClientRect();
    let x = evt.clientX - st.left + $("stage").scrollLeft + 14;
    let y = evt.clientY - st.top + $("stage").scrollTop + 14;
    if (evt.clientX - st.left + 320 > st.width) x -= 330;
    if (evt.clientY - st.top + 130 > st.height) y -= 140;
    t.style.left = Math.max(6, x) + "px";
    t.style.top = Math.max(6, y) + "px";
}
const hideTip = () => $("tip").classList.remove("show");

function wireNode(node, f, links) {
    node.addEventListener("mousemove", (e) => showTip(e, f, links));
    node.addEventListener("mouseleave", hideTip);
    node.addEventListener("click", () => {
        hideTip();
        goToFile(f.path, true);
    });
}

/* ================================================================
   Model: dependency graph, layers, roles and risk. Everything here
   is derived from data git.mjs can produce on its own — no language
   server, no network.
   ================================================================ */

const clip = (s, max) => (s.length > max ? s.slice(0, Math.max(1, max - 1)) + "…" : s);
const clipLeft = (s, max) =>
    s.length > max ? "…" + s.slice(s.length - Math.max(1, max - 1)) : s;

/* Role labels for naming a layer. The role itself is decided server-side in
   analyze.mjs and arrives on each file, so there is only one copy of that
   heuristic to keep honest. */
const ROLE_LABEL = {
    types: "Types & contracts",
    test: "Tests",
    docs: "Documentation",
    config: "Configuration",
    api: "API surface",
    data: "Data access",
    middleware: "Middleware",
    ui: "Interface",
    util: "Utilities",
    entry: "Entry points",
    asset: "Assets",
    core: "Core logic",
};

/* ---- dependency graph over the changed files only ---- */
function buildGraph(files) {
    const known = new Set(files.map((f) => f.path));
    const out = new Map();
    const inn = new Map();
    const edges = [];
    for (const f of files) {
        out.set(f.path, []);
        inn.set(f.path, []);
    }
    for (const f of files) {
        for (const l of f.links || []) {
            if (!known.has(l.to) || l.to === f.path) continue;
            const kind = l.kind || "add";
            out.get(f.path).push({ to: l.to, kind: kind });
            inn.get(l.to).push({ to: f.path, kind: kind });
            edges.push({ from: f.path, to: l.to, kind: kind });
        }
    }
    return { out: out, inn: inn, edges: edges, files: files };
}

let _graphAll = null;
const graphAll = () => (_graphAll = _graphAll || buildGraph(files()));

/* Risk, roles, summaries and links all arrive from git.mjs — the server did
   the analysis, so the client only decides how to show it. */
/* ---- layers: files grouped by depth in the dependency chain ---- */
function flowLevels(g) {
    const level = new Map();
    const walk = (p, stack) => {
        if (level.has(p)) return level.get(p);
        if (stack.has(p)) return 0;
        stack.add(p);
        let lv = 0;
        for (const e of g.out.get(p) || []) {
            if (e.kind === "del") continue;
            lv = Math.max(lv, walk(e.to, stack) + 1);
        }
        stack.delete(p);
        level.set(p, lv);
        return lv;
    };
    for (const f of g.files) walk(f.path, new Set());

    // A file held only by a removed link has no live dependencies, so it
    // would otherwise rank as a foundation. Park it just above whatever
    // dropped it instead.
    for (const f of g.files) {
        const all = g.out.get(f.path).concat(g.inn.get(f.path));
        if (!all.length || all.some((e) => e.kind !== "del")) continue;
        level.set(
            f.path,
            Math.max(0, Math.max(...all.map((e) => level.get(e.to) ?? 0)) - 1),
        );
    }
    return level;
}

/**
 * Name a layer after the file the rest of it leans on most, and report that
 * file's directory so the next layer can tell whether a directory name would
 * actually distinguish it.
 */
function bandName(files, g, taken, prev, prevDir) {
    const anchor = files
        .slice()
        .sort(
            (a, b) =>
                g.inn.get(b.path).filter((e) => e.kind !== "del").length -
                    g.inn.get(a.path).filter((e) => e.kind !== "del").length ||
                b.churn - a.churn,
        )[0];
    const dir = anchor.dir === "." ? "" : anchor.dir.split("/").pop();
    const candidates = [
        ROLE_LABEL[anchor.role],
        // A directory only names a layer if it sets it apart from the one
        // before; in a single-folder change it says nothing.
        dir && dir !== prevDir ? dir.charAt(0).toUpperCase() + dir.slice(1) : null,
        // A layer with no identity of its own is still meaningfully described
        // by what it consumes.
        prev && "Uses " + prev,
    ];
    for (const c of candidates) if (c && !taken.has(c)) return { name: c, dir };
    return { name: null, dir };
}
function layerModel(files) {
    const g = buildGraph(files);
    const level = flowLevels(g);
    const degree = (p) => g.out.get(p).length + g.inn.get(p).length;
    const linked = files.filter((f) => degree(f.path) > 0);
    const bands = [];
    const taken = new Set();

    const maxLv = linked.length ? Math.max(...linked.map((f) => level.get(f.path))) : -1;
    let prevDir = null;
    for (let lv = 0; lv <= maxLv; lv++) {
        const inBand = linked.filter((f) => level.get(f.path) === lv);
        if (!inBand.length) continue;
        const prev = bands.length ? bands[bands.length - 1].cap : null;
        // "Uses Uses Core logic" reads terribly, so a layer already named after
        // its predecessor is referred to by number instead.
        const prevRef = prev ? (prev.startsWith("Uses ") ? "layer " + bands.length : prev) : null;
        const named = bandName(inBand, g, taken, prevRef, prevDir);
        const name = named.name || "Layer " + (bands.length + 1);
        prevDir = named.dir;
        taken.add(name);
        bands.push({
            files: inBand,
            step: bands.length + 1,
            cap: name,
            uses: prevRef,
            note:
                bands.length === 0
                    ? "Nothing else in this change feeds these files."
                    : "These files use " + prevRef + ".",
        });
    }
    const rest = files
        .filter((f) => degree(f.path) === 0)
        .sort((a, b) => b.churn - a.churn);
    if (rest.length) {
        bands.push({
            files: rest,
            step: 0,
            cap: "Standalone",
            note: "No links to the rest of the change.",
            standalone: true,
        });
    }

    // Barycentre sweeps: pull each file towards the average slot of what
    // it links to, so connectors stay short and mostly untangled.
    const pos = new Map();
    const reindex = () => bands.forEach((b) => b.files.forEach((f, i) => pos.set(f.path, i)));
    reindex();
    for (let s = 0; s < 3; s++) {
        for (const b of bands) {
            if (b.standalone) continue;
            const bary = new Map();
            for (const f of b.files) {
                const nb = g.out
                    .get(f.path)
                    .concat(g.inn.get(f.path))
                    .map((e) => pos.get(e.to))
                    .filter((v) => v != null);
                bary.set(
                    f.path,
                    nb.length ? nb.reduce((a, c) => a + c, 0) / nb.length : pos.get(f.path),
                );
            }
            b.files.sort(
                (a, c) =>
                    bary.get(a.path) - bary.get(c.path) || pos.get(a.path) - pos.get(c.path),
            );
        }
        reindex();
    }
    return { g: g, level: level, bands: bands, hasLinks: linked.length > 0 };
}

/* ================================================================
   Diagram — a left-to-right pipeline of dependency layers.
   ================================================================ */

/** Shared hover behaviour: isolate a file and the links that touch it. */
function attachFocus(svg, g, cardEls, linkEls) {
    return {
        on(path) {
            const near = new Set([path]);
            for (const e of g.edges) {
                if (e.from === path) near.add(e.to);
                if (e.to === path) near.add(e.from);
            }
            svg.classList.add("focus");
            cardEls.forEach((elm, p) => elm.classList.toggle("dim", !near.has(p)));
            linkEls.forEach((l) =>
                l.els.forEach((elm) =>
                    elm.classList.toggle("on", l.from === path || l.to === path),
                ),
            );
        },
        off() {
            svg.classList.remove("focus");
            cardEls.forEach((elm) => elm.classList.remove("dim"));
            linkEls.forEach((l) => l.els.forEach((elm) => elm.classList.remove("on")));
        },
    };
}

/* ---- one short line of "what this file does" for the diagram card ---- */
function contextLine(f) {
    const first = String(f.summary || "").split(/\.\s/)[0];
    return first ? first.replace(/\.$/, "") : "";
}

function arrowHead(x, y) {
    return el("path", {
        class: "arrow",
        d:
            "M" + (x - 4.5) + "," + (y - 7) + " L" + (x + 4.5) + "," + (y - 7) +
            " L" + x + "," + y + " Z",
        fill: "var(--st-M)",
    });
}

const CARD_H = 62;

function drawCard(f, x, y, w, g) {
    const card = el("g", { class: "cardnode fade-in" });
    card.dataset.path = f.path;
    const r = risk(f);
    if (r.band === "high" || r.band === "medium") {
        // A ring around the whole card. Status owns colour inside the
        // box, so risk has to live outside it; solid vs dashed keeps the
        // two levels apart without leaning on colour alone.
        const high = r.band === "high";
        const ring = el("rect", {
            class: "riskring",
            x: x - 3.5,
            y: y - 3.5,
            width: w + 7,
            height: CARD_H + 7,
            rx: 13,
            fill: "none",
            stroke: high ? "var(--del)" : "var(--warn)",
            "stroke-width": high ? 2 : 1.4,
            "stroke-dasharray": high ? "" : "5 4",
        });
        const rt = el("title");
        rt.textContent = "Risk: " + r.band + " — " + r.reasons.join("; ");
        ring.appendChild(rt);
        card.appendChild(ring);
    }
    card.appendChild(
        el("rect", { class: "cbox", x: x, y: y, width: w, height: CARD_H, rx: 10 }),
    );
    card.appendChild(
        el("rect", {
            x: x + 1.5,
            y: y + 2,
            width: 3,
            height: CARD_H - 4,
            rx: 1.5,
            fill: statusColor(f.status),
        }),
    );

    const uses = g.out.get(f.path).filter((e) => e.kind !== "del").length;
    const usedBy = g.inn.get(f.path).filter((e) => e.kind !== "del").length;
    const cnt = f.binary
        ? "bin"
        : "+" + f.additions + (f.deletions ? " −" + f.deletions : "");

    const name = el("text", { class: "cname", x: x + 12, y: y + 18 });
    name.textContent = clip(
        f.name,
        Math.max(6, Math.floor((w - 30 - cnt.length * 6.1) / 6.6)),
    );
    card.appendChild(name);

    const c1 = el("text", {
        class: "ccnt",
        x: x + w - 10,
        y: y + 18,
        "text-anchor": "end",
        fill: f.binary ? "var(--muted)" : "var(--add)",
    });
    c1.textContent = cnt;
    card.appendChild(c1);

    const dir = el("text", { class: "cdir", x: x + 12, y: y + 32 });
    dir.textContent = clipLeft(
        f.dir === "." ? "(root)" : f.dir,
        Math.max(6, Math.floor((w - 90) / 6.1)),
    );
    card.appendChild(dir);

    if (uses || usedBy) {
        const rel = el("text", {
            class: "crel",
            x: x + w - 10,
            y: y + 32,
            "text-anchor": "end",
        });
        rel.textContent = [
            usedBy ? "↑" + usedBy : "",
            uses ? "↓" + uses : "",
        ]
            .filter(Boolean)
            .join("  ");
        const rtt = el("title");
        const plural = (n) => n + " changed file" + (n === 1 ? "" : "s");
        rtt.textContent = [
            usedBy
                ? plural(usedBy) + (usedBy === 1 ? " depends" : " depend") + " on this."
                : "",
            uses ? "It uses " + plural(uses) + "." : "",
        ]
            .filter(Boolean)
            .join(" ");
        rel.appendChild(rtt);
        card.appendChild(rel);
    }

    const ctx = contextLine(f);
    if (ctx) {
        const c = el("text", { class: "cctx", x: x + 12, y: y + 49 });
        c.textContent = clip(ctx, Math.max(10, Math.floor((w - 22) / 5.35)));
        card.appendChild(c);
    }

    wireNode(card, f, { uses: uses, usedBy: usedBy });
    return card;
}

/* Vertical flow: layers stack down the panel, which suits a tall side
   panel far better than columns, and every arrow points the same way. */
function drawFlow(host, w) {
    const files = visible();
    if (!files.length) return false;
    const model = layerModel(files);
    const bands = model.bands;
    const g = model.g;

    const PAD = 14;
    const GAP = 10;
    const ROW_GAP = 16;
    const HEAD_H = 36;
    const BAND_GAP = 30;

    const avail = Math.max(220, w - PAD * 2);
    const cols = Math.max(1, Math.min(3, Math.floor((avail + GAP) / (238 + GAP))));
    const cardW = (avail - GAP * (cols - 1)) / cols;

    const box = new Map();
    let y = 14;
    for (const b of bands) {
        b.headY = y;
        y += HEAD_H;
        b.files.forEach((f, i) => {
            box.set(f.path, {
                x: PAD + (i % cols) * (cardW + GAP),
                y: y + Math.floor(i / cols) * (CARD_H + ROW_GAP),
                w: cardW,
            });
        });
        y += Math.ceil(b.files.length / cols) * (CARD_H + ROW_GAP) - ROW_GAP + BAND_GAP;
    }
    const H = Math.max(300, y);
    const W = Math.max(w, PAD * 2 + cardW);
    const svg = el("svg", { width: W, height: H, viewBox: "0 0 " + W + " " + H });
    const gLinks = el("g");
    const gCards = el("g");

    for (const b of bands) {
        const head = el("g");
        const t = el("title");
        t.textContent = b.cap + " — " + b.note;
        head.appendChild(t);
        head.appendChild(
            el("circle", {
                class: "band-dot",
                cx: PAD + 7,
                cy: b.headY + 8,
                r: 7.5,
            }),
        );
        const step = el("text", {
            class: "band-step",
            x: PAD + 7,
            y: b.headY + 11.5,
            "text-anchor": "middle",
        });
        step.textContent = b.standalone ? "–" : b.step;
        head.appendChild(step);
        const cap = el("text", { class: "band-cap", x: PAD + 21, y: b.headY + 12 });
        cap.textContent = b.cap;
        head.appendChild(cap);
        const sub = el("text", {
            class: "band-sub",
            x: PAD + 21,
            y: b.headY + 26,
        });
        sub.textContent = bandSub(b);
        head.appendChild(sub);
        svg.appendChild(head);
    }
    svg.appendChild(gLinks);
    svg.appendChild(gCards);

    const linkEls = [];
    for (const e of g.edges) {
        const dep = box.get(e.to);
        const use = box.get(e.from);
        if (!dep || !use) continue;
        const els = [];
        const x1 = dep.x + dep.w / 2;
        const y1 = dep.y + CARD_H;
        const x2 = use.x + use.w / 2;
        const y2 = use.y;
        if (y2 > y1 + 6) {
            const dy = Math.max(14, (y2 - y1) * 0.45);
            els.push(
                el("path", {
                    class: "link" + (e.kind === "del" ? " del" : ""),
                    d:
                        "M" + x1 + "," + y1 + " C" + x1 + "," + (y1 + dy) + " " +
                        x2 + "," + (y2 - dy) + " " + x2 + "," + y2,
                }),
            );
            const head = arrowHead(x2, y2);
            if (e.kind === "del") head.setAttribute("fill", "var(--st-D)");
            els.push(head);
        } else {
            // same row — loop out to the side instead of cutting across
            const yb = Math.max(y1, use.y + CARD_H) + 11;
            els.push(
                el("path", {
                    class: "link" + (e.kind === "del" ? " del" : ""),
                    d:
                        "M" + x1 + "," + y1 + " C" + x1 + "," + yb + " " +
                        x2 + "," + yb + " " + x2 + "," + (use.y + CARD_H),
                }),
            );
        }
        els.forEach((elm) => gLinks.appendChild(elm));
        linkEls.push({ from: e.from, to: e.to, els: els });
    }

    const cardEls = new Map();
    const focus = attachFocus(svg, g, cardEls, linkEls);
    let n = 0;
    for (const b of bands) {
        for (const f of b.files) {
            const p = box.get(f.path);
            const card = drawCard(f, p.x, p.y, p.w, g);
            card.style.animationDelay = n * 16 + "ms";
            n++;
            card.addEventListener("mouseenter", () => focus.on(f.path));
            card.addEventListener("mouseleave", focus.off);
            cardEls.set(f.path, card);
            gCards.appendChild(card);
        }
    }

    host.appendChild(svg);
    return model.hasLinks;
}

function drawDiagram() {
    const stage = $("stage");
    [...stage.querySelectorAll("svg")].forEach((s) => s.remove());
    // clientWidth, not the bounding rect: the rect includes the vertical
    // scrollbar. Fall back to the panel if the stage is hidden (0 wide).
    const w = stage.clientWidth || stage.closest(".panels").clientWidth || 600;
    const linked = drawFlow(stage, Math.max(240, w));
    $("legend").classList.toggle("links", linked);
    $("hint").textContent = visible().length
        ? linked
            ? "Dependencies flow top to bottom · hover a file to isolate its links"
            : "No links found between these files — grouped as standalone"
        : "No files match the current filter";
}

/* ---------------- wiring ---------------- */
$("tabs")
    .querySelectorAll(".tab")
    .forEach((b) => b.addEventListener("click", () => setTab(b.dataset.tab)));
$("filter").addEventListener("input", (e) => {
    state.filter = e.target.value;
    renderActiveTab();
});

/* One delegated handler covers the diff toolbar, line comments and the
   sheet, so re-rendering a card never leaves dead buttons behind. */
function wireSurface(root) {
    root.addEventListener("click", (e) => {
        const back = e.target.closest("[data-back]");
        if (back) {
            e.stopPropagation();
            return backToDiagram();
        }
        const mode = e.target.closest("[data-diffmode]");
        if (mode) {
            const p = mode.dataset.path;
            if (mode.dataset.diffmode === "full") state.full.add(p);
            else state.full.delete(p);
            renderCards();
            if (state.sheet) openSheet(state.sheet);
            return;
        }
        const sheetBtn = e.target.closest("[data-sheet]");
        if (sheetBtn) return openSheet(sheetBtn.dataset.sheet);

        const openBtn = e.target.closest("[data-openfile]");
        if (openBtn) return openInEditor(openBtn.dataset.openfile);

        const add = e.target.closest(".cmt-add");
        if (add) {
            const row = add.closest("tr");
            let host = row.nextElementSibling;
            if (!host || !host.classList.contains("composer-row")) {
                host = document.createElement("tr");
                host.className = "composer-row";
                host.innerHTML = '<td></td><td colspan="3"></td>';
                row.after(host);
            }
            openComposer(host.querySelector("td:last-child"), add.dataset.path, add.dataset.anchor);
            return;
        }
        const fileCmt = e.target.closest("[data-comment]");
        if (fileCmt) {
            return openComposer(fileCmt.closest(".difftools").parentElement, fileCmt.dataset.comment, null);
        }
        const del = e.target.closest(".comment-del");
        if (del) {
            fetch("api/comments?id=" + encodeURIComponent(del.dataset.id), { method: "DELETE" })
                .then((r) => r.json())
                .then((d) => {
                    state.comments = d.comments ?? [];
                    renderFeedbackChip();
                    renderCards();
                    if (state.sheet) openSheet(state.sheet);
                })
                .catch(() => {});
            return;
        }
        if (e.target.closest("[data-closesheet]")) return closeSheet();
        if (e.target.closest("[data-submitfb]")) return submitComments();
        if (e.target.closest("[data-copyfb]")) {
            navigator.clipboard.writeText(feedbackMarkdown()).catch(() => {});
            e.target.textContent = "Copied ✓";
            return;
        }
        if (e.target.closest("[data-clearfb]")) {
            fetch("api/comments", { method: "DELETE" })
                .then((r) => r.json())
                .then((d) => {
                    state.comments = d.comments ?? [];
                    state.submitted = false;
                    renderFeedbackChip();
                    renderCards();
                    openFeedback();
                })
                .catch(() => {});
            return;
        }
    });
}
wireSurface($("cards"));
wireSurface($("sheet"));
$("sheet").addEventListener("click", (e) => {
    if (e.target === $("sheet")) closeSheet();
});
$("feedbackBtn").addEventListener("click", openFeedback);

async function openInEditor(path) {
    try {
        const res = await fetch("api/open", {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ path }),
        });
        const d = await res.json();
        toast(d.ok ? "Opened " + path + (d.how ? " (" + d.how + ")" : "") : d.error || "Could not open the file");
    } catch (e) {
        toast("Could not open the file: " + String(e));
    }
}

/* ---------------- data ---------------- */

/** Load the rundown, keeping the view exactly where the reviewer left it. */
async function loadRundown({ preserve = true } = {}) {
    let data;
    try {
        const res = await fetch("api/rundown", { cache: "no-store" });
        data = await res.json();
    } catch (e) {
        $("cards").innerHTML =
            '<div class="empty"><div class="empty-inner"><div class="empty-emoji">⚠️</div>' +
            "<div>Could not load the rundown.</div><div style=\"color:var(--muted);margin-top:6px\">" +
            esc(String(e)) +
            "</div></div></div>";
        return;
    }

    const scroller = document.querySelector(".panel.active .scroll") || $("stage");
    const top = scroller ? scroller.scrollTop : 0;
    const left = scroller ? scroller.scrollLeft : 0;

    state.rundown = data;
    state.diffs.clear(); // the working tree moved; cached diffs are stale
    _graphAll = null;

    if (!data.isGitRepo) {
        $("cards").innerHTML =
            '<div class="empty"><div class="empty-inner"><div class="empty-emoji">📁</div><div>' +
            esc(data.warnings?.[0] ?? "Not a git repository.") +
            "</div></div></div>";
        return;
    }

    // Drop open/full state for files that no longer exist in the change.
    const live = new Set(files().map((f) => f.path));
    for (const p of [...state.open]) if (!live.has(p)) state.open.delete(p);
    for (const p of [...state.full]) if (!live.has(p)) state.full.delete(p);
    if (state.fromDiagram && !live.has(state.fromDiagram)) state.fromDiagram = null;

    renderTopbar();
    renderStatusChips();
    renderTabTools();
    renderActiveTab();

    if (preserve && scroller) {
        scroller.scrollTop = top;
        scroller.scrollLeft = left;
    }
    $("stamp").classList.remove("bump");
    void $("stamp").offsetWidth;
    $("stamp").classList.add("bump");
}

async function loadComments() {
    try {
        const res = await fetch("api/comments", { cache: "no-store" });
        state.comments = (await res.json()).comments ?? [];
    } catch {
        state.comments = [];
    }
    renderFeedbackChip();
}

$("refreshBtn").addEventListener("click", () => {
    const b = $("refreshBtn");
    b.classList.add("spinning");
    loadRundown().finally(() => setTimeout(() => b.classList.remove("spinning"), 400));
});
$("liveBtn").addEventListener("click", () => {
    state.auto = !state.auto;
    $("liveBtn").classList.toggle("on", state.auto);
    $("liveBtn").title = state.auto
        ? "Recompute automatically when the repo changes"
        : "Auto-refresh off — use Refresh";
});
document.addEventListener("keydown", (e) => {
    if (document.activeElement === $("filter")) {
        if (e.key === "Escape") $("filter").blur();
        return;
    }
    if (e.key === "1") setTab("diagram");
    else if (e.key === "2") setTab("changes");
    else if (e.key === "3") setTab("commits");
    else if (e.key === "r") loadRundown();
    else if (e.key === "Escape" && state.sheet) closeSheet();
    else if (e.key === "/") {
        e.preventDefault();
        setTab("changes");
        $("filter").focus();
    }
});
let rt;
window.addEventListener("resize", () => {
    moveInk();
    clearTimeout(rt);
    if (state.tab === "diagram") rt = setTimeout(drawDiagram, 120);
});

// Live updates pushed by the extension's repo watcher.
try {
    const es = new EventSource("events");
    es.onmessage = (ev) => {
        let msg;
        try {
            msg = JSON.parse(ev.data);
        } catch {
            return;
        }
        if (msg.type === "refresh" || msg.type === "base") {
            if (state.auto || msg.type === "base") loadRundown();
        } else if (msg.type === "focus" && msg.path) {
            loadRundown().then(() => {
                if (files().some((f) => f.path === msg.path)) goToFile(msg.path);
            });
        }
    };
} catch {
    /* SSE unavailable — Refresh still works */
}

setTab("diagram");
loadComments();
loadRundown({ preserve: false });
requestAnimationFrame(moveInk);