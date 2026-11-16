import { createHash, randomUUID } from "node:crypto";
import { lstat, open, readlink } from "node:fs/promises";
import { createReadStream } from "node:fs";
import path from "node:path";
import { git } from "./git.mjs";

const MAX_BUFFER = 16 * 1024 * 1024;
const LOG_LIMIT = 80;
const locks = new Set();
const hash = (value) => createHash("sha256").update(value).digest("hex");

export function redact(text) {
    return String(text).replace(/(https?:\/\/)[^\s/@]+(?::[^\s/@]*)?@/gi, "$1[redacted]@")
        .replace(/([?&](?:token|access_token|sig|password)=)[^&\s]+/gi, "$1[redacted]");
}

async function run(cwd, args, options) {
    const result = await git(cwd, args, { maxBuffer: MAX_BUFFER, ...options });
    if (!result.ok) throw new Error(redact(result.stderr || `Git exited with code ${result.code}.`));
    return result.stdout;
}

export function parseStatus(text) {
    const records = text.split("\0");
    const files = [];
    for (let i = 0; i < records.length; i++) {
        const record = records[i];
        if (!record) continue;
        const index = record[0], working = record[1], filename = record.slice(3);
        const oldPath = "RC".includes(index) || "RC".includes(working) ? records[++i] : null;
        const conflict = index === "U" || working === "U" || ["AA", "DD"].includes(index + working);
        files.push({
            path: filename, oldPath, index, working, conflict,
            staged: !conflict && index !== " " && index !== "?",
            unstaged: !conflict && working !== " ",
            untracked: index === "?",
        });
    }
    const grouped = new Map();
    for (const file of files) {
        const existing = grouped.get(file.path);
        if (existing && file.untracked) Object.assign(existing, { working: "?", untracked: true, unstaged: true });
        else {
            if (existing?.untracked) Object.assign(file, { working: "?", untracked: true, unstaged: true });
            grouped.set(file.path, file);
        }
    }
    return [...grouped.values()];
}

async function logs(cwd, range) {
    const text = await run(cwd, ["log", `-${LOG_LIMIT}`, "--format=%H%x00%h%x00%s%x00%aI", range, "--"]);
    return text.trimEnd().split("\n").filter(Boolean).map((line) => {
        const [id, short, subject, date] = line.split("\0");
        return { id, short, subject, date };
    });
}

async function compare(cwd, head, ref, refs) {
    if (!ref) return null;
    const target = refs.find((item) => item.name === ref);
    if (!target) throw new Error("The comparison branch no longer exists. Select another remote branch.");
    if (!head) return { ref, oid: target.oid, ahead: null, behind: null, incoming: [], outgoing: [], files: [], unborn: true };
    const [counts, incoming, outgoing, names] = await Promise.all([
        run(cwd, ["rev-list", "--left-right", "--count", `${head}...${target.oid}`, "--"]),
        logs(cwd, `${head}..${target.oid}`), logs(cwd, `${target.oid}..${head}`),
        run(cwd, ["diff", "--no-ext-diff", "--no-textconv", "--name-status", "-z", "--no-renames", target.oid, head, "--"]),
    ]);
    const [ahead, behind] = counts.trim().split(/\s+/).map(Number);
    const records = names.split("\0"), files = [];
    for (let i = 0; i + 1 < records.length; i += 2) files.push({ status: records[i], path: records[i + 1] });
    return { ref, oid: target.oid, ahead, behind, incoming, outgoing, files, logLimit: LOG_LIMIT };
}

async function defaultSyncTarget(cwd, head, remoteRefs, remotes) {
    if (!remotes.some((remote) => remote.name === "origin")) return null;
    const result = await git(cwd, ["symbolic-ref", "--quiet", "refs/remotes/origin/HEAD"]);
    if (!result.ok && result.code !== 1) throw new Error(redact(result.stderr));
    const symbolic = result.ok ? result.stdout.trim() : null;
    const fullRef = symbolic?.startsWith("refs/remotes/origin/")
        ? symbolic
        : !symbolic && remoteRefs.some((item) => item.fullName === "refs/remotes/origin/main") ? "refs/remotes/origin/main" : null;
    if (!fullRef) return null;
    const ref = fullRef.slice("refs/remotes/".length);
    const target = remoteRefs.find((item) => item.fullName === fullRef && !item.symbolic);
    let ahead = null, behind = null;
    if (head && target) {
        const counts = await run(cwd, ["rev-list", "--left-right", "--count", `${head}...${target.oid}`, "--"]);
        [ahead, behind] = counts.trim().split(/\s+/).map(Number);
    }
    return {
        remote: "origin", ref, remoteRef: "refs/heads/" + ref.slice("origin/".length),
        source: symbolic ? "origin/HEAD" : "origin/main fallback",
        exists: Boolean(target), oid: target?.oid ?? null, ahead, behind,
    };
}

function fastForwardPull(remote, remoteRef) {
    return [
        "-c", "fetch.prune=false", "-c", "fetch.pruneTags=false",
        "-c", `remote.${remote}.prune=false`, "-c", `remote.${remote}.pruneTags=false`,
        "pull", "--ff-only", "--no-rebase", "--no-edit", "--no-autostash", "--", remote, remoteRef,
    ];
}

export async function readSourceControl(cwd, comparisonRef) {
    const root = (await run(cwd, ["rev-parse", "--show-toplevel"])).trim();
    const [status, branchResult, headResult, refsText, remoteText, gitDir, indexEntries, fetchPath] = await Promise.all([
        run(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
        git(root, ["symbolic-ref", "--quiet", "--short", "HEAD"]),
        git(root, ["rev-parse", "--verify", "HEAD"]),
        run(root, ["for-each-ref", "--format=%(refname)%00%(objectname)%00%(symref)", "refs/remotes/"]),
        run(root, ["remote"]),
        run(root, ["rev-parse", "--absolute-git-dir"]),
        run(root, ["ls-files", "--stage", "-z"]),
        run(root, ["rev-parse", "--git-path", "FETCH_HEAD"]),
    ]);
    if (!branchResult.ok && branchResult.code !== 1) throw new Error(redact(branchResult.stderr));
    const branch = branchResult.ok ? branchResult.stdout.trim() : null;
    const head = headResult.ok ? headResult.stdout.trim() : null;
    if (!head && !branch) throw new Error("Cannot resolve repository HEAD.");
    const files = parseStatus(status);
    const remoteRefs = refsText.trimEnd().split("\n").filter(Boolean).map((line) => {
        const [fullName, oid, symbolic] = line.split("\0");
        return { name: fullName.slice("refs/remotes/".length), fullName, oid, symbolic };
    });
    const refs = remoteRefs.filter((ref) => !ref.symbolic);
    const remotes = await Promise.all(remoteText.trim().split("\n").filter(Boolean).map(async (name) => {
        const [fetchUrls, pushUrls] = await Promise.all([
            run(root, ["remote", "get-url", "--all", name]),
            run(root, ["remote", "get-url", "--push", "--all", name]),
        ]);
        return { name, fetchUrl: redact(fetchUrls.trim()), pushUrl: redact(pushUrls.trim()), signature: hash(fetchUrls + "\0" + pushUrls) };
    }));
    let upstream = null;
    if (branch) {
        const tracking = (await run(root, ["for-each-ref", "--format=%(upstream)%00%(upstream:remotename)%00%(upstream:remoteref)", `refs/heads/${branch}`])).trimEnd();
        const [fullName, remote, remoteRef] = tracking.split("\0");
        if (fullName) upstream = {
            name: fullName.replace(/^refs\/(?:remotes|heads)\//, ""), remote, remoteRef,
            exists: refs.some((ref) => ref.fullName === fullName),
        };
    }
    const operations = [];
    for (const marker of ["MERGE_HEAD", "CHERRY_PICK_HEAD", "REVERT_HEAD", "rebase-merge", "rebase-apply", "BISECT_LOG"]) {
        try { await lstat(path.join(gitDir.trim(), marker)); operations.push(marker); }
        catch (error) { if (error.code !== "ENOENT") throw error; }
    }
    let fetchedAt = null;
    try { fetchedAt = (await lstat(path.resolve(root, fetchPath.trim()))).mtime.toISOString(); }
    catch (error) { if (error.code !== "ENOENT") throw error; }
    const fileStats = [];
    // Hash content, not timestamps: Windows readers change ctime, while tools can preserve mtime.
    for (let i = 0; i < files.length; i += 8) {
        fileStats.push(...await Promise.all(files.slice(i, i + 8).map(async (file) => {
            try {
                const filename = path.join(root, file.path);
                const stat = await lstat(filename, { bigint: true });
                let digest;
                if (stat.isSymbolicLink()) digest = hash(await readlink(filename));
                else if (stat.isFile()) {
                    const content = createHash("sha256");
                    for await (const chunk of createReadStream(filename)) content.update(chunk);
                    digest = content.digest("hex");
                } else if (stat.isDirectory()) {
                    const [submoduleHead, submoduleStatus] = await Promise.all([
                        run(filename, ["rev-parse", "--verify", "HEAD"]),
                        run(filename, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]),
                    ]);
                    digest = hash(submoduleHead + "\0" + submoduleStatus);
                } else {
                    throw new Error("Unsupported file type in Git changes.");
                }
                return [file.path, String(stat.mode), digest];
            } catch (error) { if (error.code === "ENOENT") return [file.path, "missing"]; throw error; }
        })));
    }
    const syncTarget = await defaultSyncTarget(root, head, remoteRefs, remotes);
    const revision = hash(JSON.stringify({ head, branch, status, fileStats, index: hash(indexEntries), refs, remotes, upstream, operations, syncTarget }));
    const selected = comparisonRef || (upstream?.exists ? upstream.name : refs.find((ref) => /\/(main|master)$/.test(ref.name))?.name) || refs[0]?.name;
    const comparison = await compare(root, head, selected, refs);
    const trackingComparison = upstream?.exists
        ? comparison?.ref === upstream.name ? comparison : await compare(root, head, upstream.name, refs)
        : null;
    return {
        root, name: path.basename(root), branch, head, unborn: !head, detached: !branch,
        files, refs, remotes, upstream, operations, comparison, revision, syncTarget,
        ahead: trackingComparison?.ahead ?? null, behind: trackingComparison?.behind ?? null,
        fetchedAt, refreshedAt: new Date().toISOString(),
    };
}

export async function sourceDiff(cwd, { kind, path: filename, ref }) {
    const state = await readSourceControl(cwd, ref);
    const file = state.files.find((item) => item.path === filename);
    const allowed = kind === "compare" ? state.comparison?.files.some((item) => item.path === filename)
        : file && (kind === "staged" ? file.staged : kind === "working" && (file.unstaged || file.conflict));
    if (!allowed) throw new Error("This file is not in the selected change group. Refresh and try again.");
    if (kind === "working" && file.untracked) {
        const abs = path.join(state.root, filename);
        if ((await lstat(abs)).isSymbolicLink()) return { patch: "Untracked symbolic link. Stage it to inspect its Git diff.", truncated: false };
        const handle = await open(abs, "r");
        try {
            const buffer = Buffer.alloc(256 * 1024);
            const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
            const size = (await handle.stat()).size;
            const data = buffer.subarray(0, bytesRead);
            return { patch: data.includes(0) ? "Binary file." : data.toString("utf8").split("\n").map((line) => "+" + line).join("\n"), truncated: size > bytesRead };
        } finally { await handle.close(); }
    }
    const args = ["diff", "--no-ext-diff", "--no-textconv", "--no-color", "-U3"];
    if (kind === "staged") args.push("--cached");
    if (kind === "compare") args.push(state.comparison.oid, state.head);
    args.push("--", ...(file?.oldPath ? [file.oldPath] : []), filename);
    const patch = await run(state.root, args);
    return { patch: patch.slice(0, 256 * 1024), truncated: patch.length > 256 * 1024 };
}

function buildOperation(state, input) {
    const { operation, filename, message, remote } = input;
    const commands = [];
    let title, detail;
    if (["stage", "unstage"].includes(operation)) {
        const file = state.files.find((item) => item.path === filename);
        if (!file || file.conflict || !(operation === "stage" ? file.unstaged : file.staged)) {
            throw new Error("File is not eligible for this action. Resolve conflicts outside this canvas.");
        }
        const oldPath = operation === "unstage" || "RC".includes(file.working) ? file.oldPath : null;
        const paths = [...new Set([oldPath, filename].filter(Boolean))];
        commands.push(operation === "stage" ? ["add", "--", ...paths]
            : state.head ? ["restore", "--staged", "--", ...paths] : ["rm", "--cached", "-f", "--", ...paths]);
        title = operation === "stage" ? "Stage file" : "Unstage file";
        detail = filename;
    } else if (operation === "commit") {
        if (!state.branch || state.operations.length || state.files.some((file) => file.conflict)) throw new Error("Commit is disabled during a Git operation, conflicts, or detached HEAD.");
        if (!state.files.some((file) => file.staged)) throw new Error("Stage changes before committing.");
        if (typeof message !== "string" || !message.trim() || message.length > 16000 || message.includes("\0")) throw new Error("Enter a commit message of 1 to 16,000 characters.");
        commands.push(["commit", "-m", message.trim()]);
        title = "Commit staged changes";
        detail = `${state.files.filter((file) => file.staged).length} staged file(s) on ${state.branch}.\n\n${message.trim()}`;
    } else if (operation === "fetch") {
        const selected = state.remotes.find((item) => item.name === remote);
        if (!selected) throw new Error("Select a configured remote.");
        commands.push(["fetch", "--no-tags", "--no-prune", "--no-prune-tags", "--", selected.name]);
        title = "Fetch remote";
        detail = `${selected.name}\n${selected.fetchUrl}\nUpdates remote-tracking refs. Does not merge or prune.`;
    } else if (operation === "sync") {
        const target = state.syncTarget;
        if (!state.branch || !state.head) throw new Error("Sync requires a committed local branch, not detached HEAD.");
        if (!target?.exists) throw new Error("Origin's default branch is unavailable. Fetch origin and check origin/HEAD before syncing.");
        if (state.operations.length || state.files.some((file) => file.conflict)) throw new Error("Finish the current Git operation and resolve conflicts first.");
        if (state.files.length) throw new Error("Sync requires a clean working tree and index.");
        if (target.ahead > 0 && target.behind > 0) throw new Error(`Your branch and ${target.ref} have diverged. Resolve this outside the canvas; sync will not merge or rebase.`);
        const selected = state.remotes.find((item) => item.name === target.remote);
        commands.push(fastForwardPull(target.remote, target.remoteRef));
        title = `Sync from ${target.ref}`;
        detail = `${target.ref} -> ${state.branch}\nFetch: ${selected.fetchUrl}\n${target.behind} incoming commit(s) at last fetch.\nFetch this branch and fast-forward the current branch only. No push, merge commit, rebase, or autostash.\nDefault source: ${target.source}. Your branch's upstream stays unchanged.`;
    } else if (["pull", "push"].includes(operation)) {
        const upstream = state.upstream;
        if (!state.branch || !state.head || !upstream?.exists || !upstream.remoteRef?.startsWith("refs/heads/")) throw new Error("This action requires an existing remote upstream branch.");
        const selected = state.remotes.find((item) => item.name === upstream.remote);
        if (!selected) throw new Error("The upstream is not on a configured remote.");
        if (state.operations.length || state.files.some((file) => file.conflict)) throw new Error("Finish the current Git operation and resolve conflicts first.");
        if (operation !== "push" && state.files.length) throw new Error("Pull requires a clean working tree and index.");
        if (operation !== "push" && state.ahead > 0 && state.behind > 0) throw new Error("Branches have diverged. Resolve the divergence outside this canvas; no merge or rebase will run.");
        if (operation !== "pull" && selected.pushUrl.includes("\n")) throw new Error("Multiple push URLs are not supported. Use Git directly to review each destination.");
        if (operation !== "push") commands.push(fastForwardPull(selected.name, upstream.remoteRef));
        if (operation !== "pull") commands.push(["push", "--", selected.name, `HEAD:${upstream.remoteRef}`]);
        title = operation === "pull" ? "Pull fast-forward only" : "Push commits";
        detail = `${state.branch} <-> ${upstream.name}\nFetch: ${selected.fetchUrl}\nPush: ${selected.pushUrl}\n${state.behind} incoming / ${state.ahead} outgoing at last fetch.\nNo force push, merge commit, or rebase.`;
    } else {
        throw new Error("Unsupported Git operation.");
    }
    return { title, detail, commands };
}

export class SourceControl {
    constructor(cwd) { this.cwd = cwd; this.pending = new Map(); this.output = []; }
    async status(ref) { return readSourceControl(this.cwd, ref); }
    async prepare(input) {
        const state = await this.status();
        if (input.revision !== state.revision) throw new Error("Repository state changed. Refresh and review the action again.");
        const operation = buildOperation(state, input);
        const token = randomUUID();
        for (const [key, item] of this.pending) if (item.expires < Date.now()) this.pending.delete(key);
        if (this.pending.size >= 20) this.pending.clear();
        this.pending.set(token, { ...operation, revision: state.revision, root: state.root, expires: Date.now() + 120000 });
        return { token, title: operation.title, detail: operation.detail, commands: operation.commands.map((args) => "git " + args.map((arg) => JSON.stringify(arg)).join(" ")) };
    }
    async execute({ token, confirmed }) {
        const pending = this.pending.get(token);
        this.pending.delete(token);
        if (!pending || pending.expires < Date.now() || confirmed !== true) throw new Error("Confirmation is missing, expired, or already used.");
        if (locks.has(pending.root)) throw new Error("Another Git operation is running. Refresh before retrying.");
        locks.add(pending.root);
        const completed = [];
        try {
            const current = await this.status();
            if (current.root !== pending.root || current.revision !== pending.revision) throw new Error("Repository state changed after preview. Review and confirm a new action.");
            for (const args of pending.commands) {
                let commandIndex = 0;
                while (args[commandIndex] === "-c") commandIndex += 2;
                const label = args[commandIndex];
                const result = await git(pending.root, args, { timeout: 120000, maxBuffer: MAX_BUFFER });
                const output = redact(result.stdout + result.stderr);
                this.output.push({ at: new Date().toISOString(), command: label, success: result.ok, output: output.slice(-16000) });
                this.output = this.output.slice(-30);
                if (!result.ok) throw new Error(`${label} failed.${completed.length ? ` Completed: ${completed.join(", ")}. Those changes remain.` : ""}\n${output || "Git returned an error."}\nRefresh before retrying; no automatic retry was made.`);
                completed.push(label);
            }
            return { title: pending.title, completed };
        } finally { locks.delete(pending.root); }
    }
}
