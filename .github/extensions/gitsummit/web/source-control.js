(() => {
    "use strict";
    const token = new URLSearchParams(location.search).get("token") || "";
    const nativeFetch = window.fetch.bind(window);
    window.fetch = (input, init = {}) => {
        const url = new URL(typeof input === "string" ? input : input.url, location.href);
        if (url.origin !== location.origin) return nativeFetch(input, init);
        const headers = new Headers(init.headers || (input instanceof Request ? input.headers : undefined));
        headers.set("x-gitsummit-token", token);
        return nativeFetch(input, { ...init, headers });
    };
    const el = (id) => document.getElementById(id);
    const escape = (text) => String(text ?? "").replace(/[&<>"']/g, (char) => ({
        "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;",
    })[char]);
    let current = null, comparisonRef = "", loading = null, busy = false, selected = null, diffSequence = 0;

    function preserveView(update) {
        const panel = el("panel-source"), detail = document.querySelector(".sc-detail");
        const top = panel.scrollTop, offset = detail.offsetTop;
        const detailTop = detail.scrollTop, detailLeft = detail.scrollLeft;
        const pinned = detailTop > 0 || (top > 0 && top + panel.clientHeight > offset);
        update();
        panel.scrollTop = top + (pinned ? detail.offsetTop - offset : 0);
        detail.scrollTop = detailTop;
        detail.scrollLeft = detailLeft;
    }

    async function api(action, body, query = "") {
        const response = await fetch("api/source/" + action + query, body === undefined ? {} : {
            method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
        });
        const data = await response.json();
        if (!response.ok || data?.error) throw new Error(data?.error || `Request failed (${response.status}).`);
        return data;
    }

    function notice(message, error = false) {
        el("sc-notice").textContent = message;
        el("sc-notice").classList.toggle("sc-error", error);
    }

    function updateButtons() {
        const blocked = busy || !current;
        const conflict = current?.files.some((file) => file.conflict);
        const operation = current?.operations.length;
        const tracksRemote = current?.upstream?.exists && current.remotes.some((remote) => remote.name === current.upstream.remote);
        const target = current?.syncTarget;
        const syncBlocked = blocked || !target?.exists || !current?.branch || !current?.head ||
            current.files.length > 0 || operation || conflict || (target.ahead > 0 && target.behind > 0);
        el("sc-commit").disabled = blocked || !current?.branch || conflict || operation ||
            !current?.files.some((file) => file.staged) || !el("sc-message").value.trim();
        const sync = el("sc-sync");
        sync.disabled = syncBlocked;
        sync.classList.toggle("has-incoming", Boolean(target?.exists && target.behind > 0));
        sync.textContent = target
            ? `Sync from ${target.ref} ${target.behind ?? "?"}\u2193`
            : "Sync unavailable - origin default branch unknown";
        const syncReason = !target?.exists ? "Fetch origin and check origin/HEAD."
            : !current.branch || !current.head ? "A committed local branch is required."
                : operation || conflict ? "Resolve the current Git operation and conflicts first."
                    : current.files.length ? "A clean working tree and index are required."
                        : target.ahead > 0 && target.behind > 0 ? "Branches have diverged; resolve this outside the canvas."
                            : "Fetch and fast-forward the current branch. Never push.";
        sync.title = `${syncReason} Counts use cached refs. Default source: ${target?.source ?? "unknown"}.`;
        el("sc-menu-button").disabled = busy;
        document.querySelectorAll("[data-op]").forEach((button) => {
            const op = button.dataset.op;
            if (op === "sync") {
                button.disabled = syncBlocked;
                button.textContent = target ? `Sync from ${target.ref}...` : "Sync from origin default branch...";
                button.title = sync.title;
                return;
            }
            button.disabled = blocked || (op === "fetch" ? !current.remotes.length
                : !tracksRemote || !current.head || operation || conflict ||
                    (op !== "push" && (current.files.length > 0 || (current.ahead > 0 && current.behind > 0))));
        });
        document.querySelectorAll("[data-file-action]").forEach((button) => { button.disabled = blocked; });
    }

    function fileRow(file, kind) {
        const status = kind === "staged" ? file.index : file.untracked ? "U" : file.working || file.status;
        const filename = file.path.split("/").pop();
        const directory = file.path.slice(0, -filename.length);
        const action = kind === "staged" ? "unstage" : kind === "working" && !file.conflict ? "stage" : null;
        return `<div class="sc-file-row">
            <button class="sc-file" data-file="${escape(file.path)}" data-kind="${kind}" title="${escape(file.path)}">
                <span class="sc-file-icon" aria-hidden="true">&#9639;</span><span class="sc-filename">${escape(filename)}</span>
                <span class="sc-directory">${escape(directory)}</span><span class="sc-status sc-status-${escape(status)}">${escape(status)}</span>
            </button>${action ? `<button class="sc-icon" data-file-action="${action}" data-path="${escape(file.path)}" aria-label="${action === "stage" ? "Stage" : "Unstage"} ${escape(file.path)}" title="${action === "stage" ? "Stage" : "Unstage"} file">${action === "stage" ? "+" : "&#8722;"}</button>` : ""}
        </div>`;
    }

    function group(title, files, kind) {
        if (!files.length) return "";
        return `<details class="sc-group" data-group="${escape(title)}" open><summary>${title}<span class="sc-badge">${files.length}</span></summary>
            ${files.map((file) => fileRow(file, kind)).join("")}</details>`;
    }

    function render() {
        const collapsed = new Set([...document.querySelectorAll("#panel-source details[data-group]:not([open])")].map((node) => node.dataset.group));
        const data = current;
        el("sc-repository").innerHTML = `<span aria-hidden="true">&#9649;</span><strong>${escape(data.name)}</strong>
            <span class="sc-branch" title="${escape(data.branch || data.head)}">&#9095; ${escape(data.branch || "Detached HEAD")}</span>
            <span class="sc-counts">${data.upstream?.exists ? `${data.behind ?? "?"}&#8595; ${data.ahead ?? "?"}&#8593;` : "no upstream"}</span>`;
        el("sc-path").textContent = data.root;
        el("sc-upstream").textContent = data.upstream
            ? `Upstream: ${data.upstream.name}${data.upstream.exists ? "" : " (missing locally; fetch to check)"}`
            : data.unborn ? "No commits yet. Stage files to create the first commit."
                : data.detached ? "Detached HEAD. Commit and sync are disabled."
                    : "No upstream configured. Remote comparison is still available; publish this branch with Git outside the canvas.";
        el("sc-files").innerHTML =
            group("Merge Changes", data.files.filter((file) => file.conflict), "working") +
            group("Staged Changes", data.files.filter((file) => file.staged), "staged") +
            group("Changes", data.files.filter((file) => file.unstaged && !file.conflict), "working") ||
            '<div class="sc-clean"><span aria-hidden="true">&#10003;</span> No local changes</div>';
        const selector = el("sc-compare");
        selector.innerHTML = data.refs.length
            ? data.refs.map((ref) => `<option value="${escape(ref.name)}">${escape(ref.name)}</option>`).join("")
            : '<option value="">No remote-tracking branches</option>';
        selector.disabled = busy || !data.refs.length;
        selector.value = data.comparison?.ref || "";
        el("sc-freshness").textContent = `Cached refs. ${data.fetchedAt ? "Repository FETCH_HEAD updated " + new Date(data.fetchedAt).toLocaleString() : "Fetch time unknown"}. Fetch to check the remote.`;
        const comparison = data.comparison;
        el("sc-remote").innerHTML = comparison ? `
            <div class="sc-compare-caption">Committed HEAD compared with ${escape(comparison.ref)}. Local edits are listed above.</div>
            <div class="sc-comparison-counts"><span>${comparison.behind ?? "?"} incoming &#8595;</span><span>${comparison.ahead ?? "?"} outgoing &#8593;</span></div>
            ${commitGroup("Incoming", comparison.incoming, comparison.behind)}
            ${commitGroup("Outgoing", comparison.outgoing, comparison.ahead)}
            ${group("Different files (remote to HEAD)", comparison.files, "compare")}
            ${comparison.unborn ? '<p class="sc-note">Commit first to compare histories.</p>' : ""}
        ` : '<p class="sc-note">No remote comparison available.</p>';
        if (data.operations.length) notice(`Git operation in progress: ${data.operations.join(", ")}. Resolve it outside this canvas.`, true);
        for (const group of document.querySelectorAll("#panel-source details[data-group]")) {
            if (collapsed.has(group.dataset.group)) group.open = false;
        }
        updateButtons();
    }

    function commitGroup(title, commits, total) {
        if (!commits.length) return "";
        return `<details class="sc-group" data-group="${escape(title)}" open><summary>${title}<span class="sc-badge">${total}</span></summary>
            ${commits.map((commit) => `<div class="sc-commit-row" title="${escape(commit.id)}"><span class="sc-commit-dot" aria-hidden="true"></span>
                <span>${escape(commit.subject)}</span><code>${escape(commit.short)}</code></div>`).join("")}
            ${total > commits.length ? `<p class="sc-note">Showing ${commits.length} of ${total} commits.</p>` : ""}</details>`;
    }

    async function refresh() {
        if (loading) return loading;
        if (busy) return;
        loading = (async () => {
            try {
                const data = await api("status", undefined, comparisonRef ? "?ref=" + encodeURIComponent(comparisonRef) : "");
                const changed = current?.revision !== data.revision;
                current = data;
                preserveView(render);
                if (changed && selected) {
                    const file = data.files.find((item) => item.path === selected.path);
                    const exists = selected.kind === "compare" ? data.comparison?.files.some((item) => item.path === selected.path)
                        : selected.kind === "staged" ? file?.staged : file?.unstaged || file?.conflict;
                    if (exists) await showDiff(selected.kind, selected.path, false);
                    else {
                        selected = null; ++diffSequence;
                        el("sc-detail-title").textContent = "Working tree & remote";
                        el("sc-detail-content").textContent = "The selected change is no longer in this group. Select another file.";
                    }
                }
            } catch (error) {
                current = null;
                notice(error.message, true);
                updateButtons();
            } finally { loading = null; }
        })();
        return loading;
    }

    async function showDiff(kind, filename, scroll = true) {
        selected = { kind, path: filename };
        const sequence = ++diffSequence;
        el("sc-detail-title").textContent = `${kind === "compare" ? `${current?.comparison?.ref || "Remote"} \u2192 HEAD` : kind === "staged" ? "HEAD \u2192 Index" : "Index \u2192 Working tree"} / ${filename}`;
        if (scroll) el("sc-detail-content").textContent = "Loading diff...";
        try {
            const query = new URLSearchParams({ kind, path: filename, ...(current?.comparison?.ref ? { ref: current.comparison.ref } : {}) });
            const data = await api("diff", undefined, "?" + query);
            if (sequence !== diffSequence) return;
            preserveView(() => { el("sc-detail-content").innerHTML = `<pre class="sc-diff">${data.patch.split("\n").map((line) =>
                `<span class="${line.startsWith("+") ? "sc-line-add" : line.startsWith("-") ? "sc-line-del" : line.startsWith("@@") ? "sc-line-hunk" : ""}">${escape(line) || " "}</span>`).join("")}</pre>
                ${data.truncated ? '<p class="sc-notice">Diff truncated at 256 KiB. Use Git for the full diff.</p>' : !data.patch ? '<p class="sc-note">No text diff (the file may have changed again).</p>' : ""}`; });
        } catch (error) {
            if (sequence === diffSequence) {
                if (scroll) el("sc-detail-content").textContent = error.message;
                else notice("Could not refresh the diff. The previous version remains visible.\n" + error.message, true);
            }
        }
        if (scroll) el("sc-detail-title").scrollIntoView({
            behavior: matchMedia("(prefers-reduced-motion: reduce)").matches ? "instant" : "smooth",
            block: "start",
        });
    }

    function confirmPreview(preview) {
        return new Promise((resolve) => {
            const previous = document.activeElement;
            const dialog = document.createElement("dialog");
            dialog.className = "sc-dialog";
            dialog.setAttribute("aria-labelledby", "sc-confirm-title");
            dialog.innerHTML = `<h2 id="sc-confirm-title">${escape(preview.title)}</h2>
                <p>Repository: <strong>${escape(current.name)}</strong></p><p class="sc-path">${escape(current.root)}</p>
                <pre>${escape(preview.detail)}</pre><details><summary>Exact commands</summary><pre>${escape(preview.commands.join("\n"))}</pre></details>
                <div class="sc-dialog-actions"><button class="sc-secondary" data-cancel>Cancel</button><button class="sc-primary" data-confirm>Confirm ${escape(preview.title.toLowerCase())}</button></div>`;
            document.body.append(dialog);
            const finish = (value) => { dialog.close(); dialog.remove(); previous?.focus(); resolve(value); };
            dialog.querySelector("[data-cancel]").onclick = () => finish(false);
            dialog.querySelector("[data-confirm]").onclick = () => finish(true);
            dialog.addEventListener("cancel", (event) => { event.preventDefault(); finish(false); });
            dialog.showModal();
            dialog.querySelector("[data-cancel]").focus();
        });
    }

    async function operate(operation, filename) {
        if (busy || !current) return;
        busy = true; updateButtons();
        let outcome = null;
        notice("Preparing Git action...");
        el("sc-menu").hidden = true;
        el("sc-menu-button").setAttribute("aria-expanded", "false");
        try {
            if (loading) await loading;
            if (!current) throw new Error("Refresh repository status before running a Git action.");
            const remote = current.upstream?.remote || current.remotes[0]?.name;
            const preview = await api("prepare", {
                operation, filename, message: el("sc-message").value, remote, revision: current.revision,
            });
            if (!["stage", "unstage"].includes(operation) && !await confirmPreview(preview)) {
                notice("Operation canceled. No command ran.");
                return;
            }
            notice(`Running ${preview.title.toLowerCase()}...`);
            outcome = await api("execute", { token: preview.token, confirmed: true });
            if (operation === "commit") el("sc-message").value = "";
        } catch (error) { notice(error.message, true); }
        finally {
            busy = false;
            await refresh();
            updateButtons();
            if (outcome && current) notice(`${outcome.title} completed.`);
        }
    }

    async function output() {
        selected = null; ++diffSequence;
        el("sc-detail-title").textContent = "Git Output";
        try {
            const entries = await api("output");
            el("sc-detail-content").innerHTML = `<pre class="sc-output">${escape(entries.map((entry) =>
                `[${new Date(entry.at).toLocaleTimeString()}] git ${entry.command} - ${entry.success ? "completed" : "failed"}\n${entry.output}`).join("\n\n") || "No Git operations have run in this panel.")}</pre>`;
        } catch (error) { el("sc-detail-content").textContent = error.message; }
        el("sc-detail-title").scrollIntoView({ block: "nearest" });
    }

    el("sc-menu-button").onclick = () => {
        el("sc-menu").hidden = !el("sc-menu").hidden;
        el("sc-menu-button").setAttribute("aria-expanded", String(!el("sc-menu").hidden));
    };
    document.addEventListener("click", (event) => {
        if (!event.target.closest("#sc-menu,#sc-menu-button")) {
            el("sc-menu").hidden = true;
            el("sc-menu-button").setAttribute("aria-expanded", "false");
        }
        const operation = event.target.closest("[data-op]");
        if (operation) operate(operation.dataset.op);
        const action = event.target.closest("[data-file-action]");
        if (action) operate(action.dataset.fileAction, action.dataset.path);
        const file = event.target.closest("[data-file]");
        if (file) showDiff(file.dataset.kind, file.dataset.file);
    });
    el("sc-output-button").onclick = () => { el("sc-menu").hidden = true; output(); };
    el("sc-commit").onclick = () => operate("commit");
    el("sc-sync").onclick = () => operate("sync");
    el("sc-message").addEventListener("input", updateButtons);
    el("sc-message").addEventListener("keydown", (event) => {
        if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            if (!el("sc-commit").disabled) operate("commit");
        }
    });
    el("sc-compare").onchange = async () => {
        comparisonRef = el("sc-compare").value;
        selected = null; ++diffSequence;
        el("sc-detail-title").textContent = "Remote comparison";
        el("sc-detail-content").textContent = "Select a file from the new comparison.";
        if (loading) await loading;
        await refresh();
    };
    setInterval(() => {
        if (!document.hidden && document.body.classList.contains("source-active") && el("liveBtn").classList.contains("on")) refresh();
    }, 8000);
    window.sourceControl = { token, refresh };
})();
