// User-global Source Control and pre-PR review for the active session worktree.
// Review actions are read-only. Git mutations require a file action or a
// confirmed, single-use preview through the authenticated loopback UI.

import { createServer } from "node:http";
import { readFile } from "node:fs/promises";
import { watch } from "node:fs";
import { fileURLToPath } from "node:url";
import { execFile } from "node:child_process";
import path from "node:path";
import { randomBytes } from "node:crypto";

import { joinSession, createCanvas, CanvasError } from "@github/copilot-sdk/extension";
import { computeRundown, getFileDiff, summarize, repoRoot, fingerprint } from "./git.mjs";
import { SourceControl, sourceDiff } from "./source-control.mjs";
import { authorizeRequest } from "./http-guard.mjs";

const WEB_DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), "web");

const STATIC = {
    "/": { file: "index.html", type: "text/html; charset=utf-8" },
    "/index.html": { file: "index.html", type: "text/html; charset=utf-8" },
    "/styles.css": { file: "styles.css", type: "text/css; charset=utf-8" },
    "/app.js": { file: "app.js", type: "text/javascript; charset=utf-8" },
    "/source-control.js": { file: "source-control.js", type: "text/javascript; charset=utf-8" },
    "/source-control.css": { file: "source-control.css", type: "text/css; charset=utf-8" },
};

const WATCH_DEBOUNCE_MS = 400;
const POLL_INTERVAL_MS = 4000;

// instanceId -> instance record
const instances = new Map();

function sendJson(res, obj, code = 200) {
    const body = JSON.stringify(obj);
    res.writeHead(code, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": Buffer.byteLength(body),
    });
    res.end(body);
}

async function readBody(req, limit = 256 * 1024) {
    const chunks = [];
    let size = 0;
    for await (const c of req) {
        size += c.length;
        if (size > limit) throw new Error("Request body too large.");
        chunks.push(c);
    }
    if (!chunks.length) return {};
    try {
        return JSON.parse(Buffer.concat(chunks).toString("utf8"));
    } catch {
        throw new Error("Invalid JSON body.");
    }
}

async function serveStatic(res, entry) {
    try {
        const buf = await readFile(path.join(WEB_DIR, entry.file));
        res.writeHead(200, { "Content-Type": entry.type, "Cache-Control": "no-store" });
        res.end(buf);
    } catch {
        res.writeHead(404).end("Not found");
    }
}

function broadcast(inst, msg) {
    if (!inst?.sse) return;
    const payload = `data: ${JSON.stringify(msg)}\n\n`;
    for (const res of inst.sse) {
        try {
            res.write(payload);
        } catch {
            /* dropped client */
        }
    }
}

async function ensureRundown(inst) {
    inst.rundown = await computeRundown(inst.cwd, inst.baseOverride);
    return inst.rundown;
}

/* ------------------------------------------------------------------ *
 * Repo watcher
 *
 * fs.watch is noisy: editors write temp files, git rewrites its index, and a
 * single save can fire several events. So every event is debounced and then
 * checked against a cheap fingerprint of the working tree; we only recompute
 * and notify the canvas when that fingerprint actually moved. The watcher only
 * runs while someone is looking (an SSE client is connected).
 * ------------------------------------------------------------------ */

const IGNORED = /(^|[\\/])(node_modules|\.git[\\/](objects|logs|refs|modules)|dist|build|out|target|\.next|\.venv|__pycache__)([\\/]|$)/;

async function startWatching(inst) {
    if (inst.watchers.length || inst.poll) return;
    const root = inst.root ?? (await repoRoot(inst.cwd));
    if (!root) return;
    inst.root = root;
    inst.fingerprint = await fingerprint(inst.cwd).catch(() => null);

    const bump = (name) => {
        if (name && IGNORED.test(String(name))) return;
        clearTimeout(inst.debounce);
        inst.debounce = setTimeout(() => checkForChange(inst), WATCH_DEBOUNCE_MS);
    };

    // Recursive watching is supported on Windows and macOS, and on Linux from
    // Node 20. If it throws anywhere, fall back to polling the fingerprint.
    try {
        inst.watchers.push(watch(root, { recursive: true, persistent: false }, (_e, name) => bump(name)));
    } catch {
        inst.poll = setInterval(() => checkForChange(inst), POLL_INTERVAL_MS);
        return;
    }
    // HEAD and the index live under .git, which the recursive watch above may
    // report inconsistently across platforms; watch the dir itself as well.
    try {
        inst.watchers.push(
            watch(path.join(root, ".git"), { persistent: false }, (_e, name) => {
                if (name === "HEAD" || name === "index" || name === "ORIG_HEAD") bump(null);
            }),
        );
    } catch {
        /* no .git dir to watch (worktree, submodule): the recursive watch covers it */
    }
}

async function checkForChange(inst) {
    if (!inst.sse.size) return;
    let fp = null;
    try {
        fp = await fingerprint(inst.cwd);
    } catch {
        return;
    }
    if (fp === inst.fingerprint) return; // filesystem noise, not a real change
    inst.fingerprint = fp;
    try {
        await ensureRundown(inst);
        broadcast(inst, { type: "refresh" });
    } catch {
        /* a transient git state (mid-rebase, index.lock): the next event retries */
    }
}

function stopWatching(inst) {
    for (const w of inst.watchers) {
        try {
            w.close();
        } catch {
            /* ignore */
        }
    }
    inst.watchers = [];
    clearTimeout(inst.debounce);
    clearInterval(inst.poll);
    inst.poll = null;
}

/* ------------------------------------------------------------------ *
 * Review comments
 * ------------------------------------------------------------------ */

function addComment(inst, { path: p, line, text }) {
    const comment = {
        id: "c" + ++inst.commentSeq,
        path: String(p ?? ""),
        line: line ?? null,
        text: String(text ?? "").trim(),
        at: new Date().toISOString(),
    };
    if (!comment.path || !comment.text) throw new Error("A path and comment text are required.");
    inst.comments.push(comment);
    return comment;
}

/** The reviewer's comments as markdown, grouped by file. */
function commentsMarkdown(inst) {
    if (!inst.comments.length) return "";
    const byFile = new Map();
    for (const c of inst.comments) {
        if (!byFile.has(c.path)) byFile.set(c.path, []);
        byFile.get(c.path).push(c);
    }
    let out = "## GitSummit review feedback\n\n";
    for (const [p, list] of byFile) {
        out += `### ${p}\n`;
        for (const c of list) {
            const where = c.line
                ? `line ${c.line.slice(1)}${c.line[0] === "o" ? " (old)" : ""}`
                : "file";
            out += `- **${where}** — ${c.text}\n`;
        }
        out += "\n";
    }
    return out;
}

/* ------------------------------------------------------------------ *
 * Opening a file for the reviewer
 * ------------------------------------------------------------------ */

function run(cmd, args) {
    return new Promise((resolve) => {
        execFile(cmd, args, { windowsHide: true, shell: process.platform === "win32" }, (err) =>
            resolve(!err),
        );
    });
}

// One stable id: re-opening the host's editor canvas with the same instance
// swaps the file in place, so review stays in a single panel instead of
// accumulating one per file.
const EDITOR_INSTANCE = "gitsummit-file";

/**
 * Show a file inside the Copilot app that hosts this canvas, by opening the
 * built-in editor canvas next to us. Reviewing shouldn't throw the reader out
 * into another application.
 */
async function openInApp(relPath) {
    try {
        await session.rpc.canvas.open({
            canvasId: "editor",
            instanceId: EDITOR_INSTANCE,
            input: {
                scope: "repo",
                path: relPath,
                title: relPath.split("/").pop(),
                placement: { focus: true },
            },
        });
        return "Copilot";
    } catch {
        return null;
    }
}

/** Last resort only: the host could not show the file itself. */
async function openExternally(abs) {
    if (await run("code", ["-g", abs])) return "VS Code";
    if (process.platform === "win32") {
        if (await run("cmd", ["/c", "start", "", abs])) return "system default";
    } else if (process.platform === "darwin") {
        if (await run("open", [abs])) return "system default";
    } else if (await run("xdg-open", [abs])) {
        return "system default";
    }
    return null;
}

/* ------------------------------------------------------------------ *
 * HTTP
 * ------------------------------------------------------------------ */

function handleSse(inst, req, res) {
    res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
    });
    res.write(": connected\n\n");
    inst.sse.add(res);
    startWatching(inst);

    // Flush a focus request that arrived before the iframe connected.
    if (inst.pendingFocus) {
        res.write(`data: ${JSON.stringify({ type: "focus", path: inst.pendingFocus })}\n\n`);
        inst.pendingFocus = null;
    }

    const ka = setInterval(() => {
        try {
            res.write(": ping\n\n");
        } catch {
            /* ignore */
        }
    }, 25000);
    inst.keepAlives.add(ka);

    req.on("close", () => {
        clearInterval(ka);
        inst.keepAlives.delete(ka);
        inst.sse.delete(res);
        if (!inst.sse.size) stopWatching(inst);
    });
}

async function startServer(inst) {
    const server = createServer(async (req, res) => {
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("X-Content-Type-Options", "nosniff");
        let url;
        try {
            url = new URL(req.url, "http://127.0.0.1");
        } catch {
            res.writeHead(400).end("Bad request");
            return;
        }
        const pathname = url.pathname;

        try {
            if (!authorizeRequest(req, url, inst)) {
                sendJson(res, { error: "This request is not authorized for this canvas." }, 403);
                return;
            }
            if (pathname.startsWith("/api/source/")) {
                const action = pathname.slice("/api/source/".length);
                const expectedMethod = ["prepare", "execute"].includes(action) ? "POST" : "GET";
                if (req.method !== expectedMethod) {
                    sendJson(res, { error: `Use ${expectedMethod}.` }, 405);
                    return;
                }
                if (action === "status") sendJson(res, await inst.source.status(url.searchParams.get("ref")));
                else if (action === "diff") sendJson(res, await sourceDiff(inst.cwd, {
                    kind: url.searchParams.get("kind"), path: url.searchParams.get("path"), ref: url.searchParams.get("ref"),
                }));
                else if (action === "output") sendJson(res, inst.source.output);
                else if (action === "prepare") sendJson(res, await inst.source.prepare(await readBody(req)));
                else if (action === "execute") {
                    try { sendJson(res, await inst.source.execute(await readBody(req))); }
                    finally { broadcast(inst, { type: "refresh" }); }
                } else sendJson(res, { error: "Unknown Source Control endpoint." }, 404);
                return;
            }
            if (pathname === "/events") {
                handleSse(inst, req, res);
                return;
            }

            if (pathname === "/api/rundown") {
                sendJson(res, await ensureRundown(inst));
                return;
            }

            if (pathname === "/api/file") {
                const target = url.searchParams.get("path");
                if (!target) {
                    sendJson(res, { error: "Missing 'path' query parameter." }, 400);
                    return;
                }
                const rundown = inst.rundown ?? (await ensureRundown(inst));
                const file = rundown.files?.find((f) => f.path === target);
                if (!file) {
                    sendJson(res, { path: target, error: "File is not part of the current rundown." });
                    return;
                }
                const full = url.searchParams.get("full") === "1";
                sendJson(res, await getFileDiff(inst.cwd, rundown.repo?.baseResolved, file, { full }));
                return;
            }

            if (pathname === "/api/open") {
                if (req.method !== "POST") {
                    sendJson(res, { error: "Use POST." }, 405);
                    return;
                }
                const { path: target } = await readBody(req);
                const rundown = inst.rundown ?? (await ensureRundown(inst));
                // Only ever open a file that is part of this change, so a stray
                // request can't turn the canvas into a general file launcher.
                if (!rundown.files?.some((f) => f.path === target)) {
                    sendJson(res, { ok: false, error: "File is not part of the current rundown." }, 400);
                    return;
                }
                const root = rundown.repo?.root ?? (await repoRoot(inst.cwd));
                const how =
                    (await openInApp(target)) ?? (await openExternally(path.join(root, target)));
                sendJson(res, how ? { ok: true, how } : { ok: false, error: "No editor available." });
                return;
            }

            if (pathname === "/api/comments") {
                if (req.method === "POST") {
                    const body = await readBody(req);
                    addComment(inst, body);
                } else if (req.method === "DELETE") {
                    const id = url.searchParams.get("id");
                    inst.comments = id ? inst.comments.filter((c) => c.id !== id) : [];
                }
                sendJson(res, { comments: inst.comments });
                return;
            }

            const entry = STATIC[pathname];
            if (entry) {
                await serveStatic(res, entry);
                return;
            }
            res.writeHead(404).end("Not found");
        } catch (err) {
            sendJson(res, { error: String(err?.message ?? err) }, 500);
        }
    });

    await new Promise((resolve, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolve);
    });
    const addr = server.address();
    const port = typeof addr === "object" && addr ? addr.port : 0;
    inst.server = server;
    inst.origin = `http://127.0.0.1:${port}`;
    inst.url = `${inst.origin}/?token=${inst.token}`;
}

/** Resolve the working directory to inspect, most specific first. */
function resolveCwd(ctx) {
    return ctx?.session?.workingDirectory || process.cwd();
}

function getOrInit(instanceId) {
    let inst = instances.get(instanceId);
    if (!inst) {
        inst = {
            server: null,
            url: null,
            cwd: null,
            root: null,
            baseOverride: null,
            rundown: null,
            sse: new Set(),
            keepAlives: new Set(),
            pendingFocus: null,
            watchers: [],
            debounce: null,
            poll: null,
            fingerprint: null,
            comments: [],
            commentSeq: 0,
            token: randomBytes(32).toString("hex"),
            source: null,
        };
        instances.set(instanceId, inst);
    }
    return inst;
}

const session = await joinSession({
    canvases: [
        createCanvas({
            id: "gitsummit",
            displayName: "GitSummit",
            description:
                "Global Git Source Control with staged changes, remote comparisons, confirmed Git operations, and the existing pre-PR diagram, diffs, and review comments.",
            inputSchema: {
                type: "object",
                properties: {
                    base: {
                        type: "string",
                        description: "Optional base ref/branch to compare against (default: auto-detected).",
                    },
                    focus: {
                        type: "string",
                        description: "Optional file path to open directly in the Changes tab.",
                    },
                },
                additionalProperties: false,
            },
            actions: [
                {
                    name: "source_status",
                    description: "Read local changes, upstream state and a selected remote branch comparison. Does not fetch or modify Git.",
                    inputSchema: {
                        type: "object",
                        properties: { ref: { type: "string", description: "Existing remote-tracking branch name." } },
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const inst = instances.get(ctx.instanceId);
                        if (!inst) throw new CanvasError("not_open", "GitSummit is not open.");
                        return await inst.source.status(ctx.input?.ref);
                    },
                },
                {
                    name: "refresh",
                    description:
                        "Recompute the rundown from the current git state and push the update to the open canvas.",
                    handler: async (ctx) => {
                        const inst = instances.get(ctx.instanceId);
                        if (!inst) throw new CanvasError("not_open", "GitSummit is not open.");
                        const rundown = await ensureRundown(inst);
                        inst.fingerprint = await fingerprint(inst.cwd).catch(() => inst.fingerprint);
                        broadcast(inst, { type: "refresh" });
                        return { ok: true, summary: summarize(rundown) };
                    },
                },
                {
                    name: "set_base",
                    description:
                        "Change the base ref/branch the rundown compares against, then refresh the canvas.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            base: { type: "string", description: "Base ref or branch name (e.g. 'main')." },
                        },
                        required: ["base"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const inst = instances.get(ctx.instanceId);
                        if (!inst) throw new CanvasError("not_open", "GitSummit is not open.");
                        inst.baseOverride = String(ctx.input?.base ?? "").trim() || null;
                        const rundown = await ensureRundown(inst);
                        broadcast(inst, { type: "base" });
                        return { ok: true, base: rundown.repo?.base ?? null, summary: summarize(rundown) };
                    },
                },
                {
                    name: "focus_file",
                    description:
                        "Open a specific file in the canvas: switches to the Changes tab, expands it and scrolls to it.",
                    inputSchema: {
                        type: "object",
                        properties: {
                            path: { type: "string", description: "Repo-relative file path to open." },
                        },
                        required: ["path"],
                        additionalProperties: false,
                    },
                    handler: async (ctx) => {
                        const inst = instances.get(ctx.instanceId);
                        if (!inst) throw new CanvasError("not_open", "GitSummit is not open.");
                        const target = String(ctx.input?.path ?? "").trim();
                        if (!target) throw new CanvasError("invalid_input", "A 'path' is required.");
                        if (inst.sse.size > 0) broadcast(inst, { type: "focus", path: target });
                        else inst.pendingFocus = target;
                        return { ok: true, path: target };
                    },
                },
                {
                    name: "get_feedback",
                    description:
                        "Read the review comments the user left in the canvas, as markdown grouped by file. Use this when they say they have submitted comments or ask you to act on their review.",
                    handler: async (ctx) => {
                        const inst = instances.get(ctx.instanceId);
                        if (!inst) throw new CanvasError("not_open", "GitSummit is not open.");
                        return {
                            count: inst.comments.length,
                            comments: inst.comments,
                            markdown: commentsMarkdown(inst),
                        };
                    },
                },
            ],
            open: async (ctx) => {
                const inst = getOrInit(ctx.instanceId);
                inst.cwd = resolveCwd(ctx);
                if (!inst.source || inst.source.cwd !== inst.cwd) inst.source = new SourceControl(inst.cwd);
                if (typeof ctx.input?.base === "string" && ctx.input.base.trim()) {
                    inst.baseOverride = ctx.input.base.trim();
                }
                if (!inst.server) await startServer(inst);
                if (typeof ctx.input?.focus === "string" && ctx.input.focus.trim()) {
                    inst.pendingFocus = ctx.input.focus.trim();
                }

                let title = "GitSummit";
                let status;
                try {
                    const rundown = await ensureRundown(inst);
                    if (rundown.isGitRepo) {
                        title = `GitSummit · ${rundown.repo.branch}`;
                        status = summarize(rundown);
                    } else {
                        status = "Not a git repository";
                    }
                } catch (e) {
                    status = `Error: ${String(e?.message ?? e)}`;
                }
                return { url: inst.url, title, status };
            },
            onClose: async (ctx) => {
                const inst = instances.get(ctx.instanceId);
                if (!inst) return;
                instances.delete(ctx.instanceId);
                stopWatching(inst);
                for (const ka of inst.keepAlives) clearInterval(ka);
                for (const res of inst.sse) {
                    try {
                        res.end();
                    } catch {
                        /* ignore */
                    }
                }
                if (inst.server) await new Promise((resolve) => inst.server.close(() => resolve()));
            },
        }),
    ],
});
