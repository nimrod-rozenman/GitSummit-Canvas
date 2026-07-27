// git.mjs — repo-agnostic git introspection for the GitSummit canvas.
//
// Everything here shells out to `git` in a given working directory and returns
// plain JSON-serializable data. There is no durable state: the repository is
// the source of truth and we recompute on every open/refresh.

import { execFile } from "node:child_process";
import { readFile } from "node:fs/promises";
import path from "node:path";

import {
    parseSignalDiff,
    signalsFromContent,
    importsFromContent,
    docsFromContent,
    describeFile,
    signalChips,
    linkFiles,
    scoreRisk,
    overallRisk,
    roleOf,
} from "./analyze.mjs";

const US = "\x1f"; // unit separator, used as a safe field delimiter in git log
const DIFF_MAX_BUFFER = 128 * 1024 * 1024; // diffs can be large
const MAX_DIFF_LINES = 8000; // cap a single file's rendered diff
const FULL_CONTEXT = 20000; // "whole file" view: enough context to cover it
const UNTRACKED_MAX_BYTES = 2 * 1024 * 1024; // cap untracked file reads
const CONTENT_SCAN_MAX_BYTES = 256 * 1024; // per file, when reading working-tree text
const CONTENT_SCAN_MAX_FILES = 500; // total files read for imports and docs

/**
 * Run git with an argv array (no shell) in `cwd`. Never rejects on a non-zero
 * exit; returns { ok, stdout, stderr, code } so callers can branch on failure.
 */
function git(cwd, args, { maxBuffer = 1024 * 1024 } = {}) {
    return new Promise((resolve) => {
        execFile(
            "git",
            args,
            { cwd, maxBuffer, windowsHide: true, encoding: "utf8" },
            (err, stdout, stderr) => {
                if (err) {
                    resolve({
                        ok: false,
                        stdout: stdout ?? "",
                        stderr: stderr ?? String(err),
                        code: typeof err.code === "number" ? err.code : 1,
                    });
                } else {
                    resolve({ ok: true, stdout: stdout ?? "", stderr: stderr ?? "", code: 0 });
                }
            },
        );
    });
}

async function gitLine(cwd, args) {
    const r = await git(cwd, args);
    return r.ok ? r.stdout.trim() : null;
}

async function refExists(cwd, ref) {
    const r = await git(cwd, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    return r.ok && r.stdout.trim().length > 0;
}

/** Repo root for `cwd`, or null when `cwd` is not inside a git work tree. */
export async function repoRoot(cwd) {
    return await gitLine(cwd, ["rev-parse", "--show-toplevel"]);
}

/**
 * Resolve the base ref to compare against, in priority order:
 *   1. explicit override (open input / set_base action)
 *   2. origin/HEAD (the remote's default branch)
 *   3. first existing of main / master / develop / trunk
 * Returns { baseRef, mergeBase, hasBase, warnings }.
 */
async function resolveBase(cwd, override, branch) {
    const warnings = [];
    const candidates = [];

    if (override) candidates.push(override);

    const originHead = await gitLine(cwd, [
        "rev-parse",
        "--abbrev-ref",
        "--symbolic-full-name",
        "origin/HEAD",
    ]);
    if (originHead && originHead !== "origin/HEAD") candidates.push(originHead);

    candidates.push("origin/main", "origin/master", "main", "master", "develop", "trunk");

    let baseRef = null;
    for (const c of candidates) {
        // Don't compare a branch against itself.
        if (c === branch || c === `origin/${branch}`) continue;
        if (await refExists(cwd, c)) {
            baseRef = c;
            break;
        }
    }

    if (override && baseRef !== override) {
        warnings.push(`Base ref "${override}" not found; using "${baseRef ?? "none"}".`);
    }

    if (!baseRef) {
        warnings.push("No base branch found — showing changes since the last commit (HEAD).");
        const head = await refExists(cwd, "HEAD");
        return { baseRef: null, mergeBase: head ? "HEAD" : null, hasBase: false, warnings };
    }

    const mb = await gitLine(cwd, ["merge-base", "HEAD", baseRef]);
    if (!mb) {
        warnings.push(`Could not find a common ancestor with "${baseRef}".`);
        const head = await refExists(cwd, "HEAD");
        return { baseRef, mergeBase: head ? "HEAD" : null, hasBase: false, warnings };
    }

    return { baseRef, mergeBase: mb, hasBase: true, warnings };
}

/** Parse `git diff --numstat -z` output, keyed by (new) path. */
function parseNumstatZ(stdout) {
    const parts = stdout.split("\0");
    const out = new Map();
    let i = 0;
    while (i < parts.length) {
        const rec = parts[i];
        if (!rec) {
            i++;
            continue;
        }
        const m = rec.match(/^(-|\d+)\t(-|\d+)\t(.*)$/);
        if (!m) {
            i++;
            continue;
        }
        const [, addS, delS, pathPart] = m;
        const binary = addS === "-" || delS === "-";
        const additions = binary ? 0 : Number(addS);
        const deletions = binary ? 0 : Number(delS);
        let filePath;
        let oldPath = null;
        if (pathPart === "") {
            // rename/copy: next two NUL tokens are old, new
            oldPath = parts[i + 1] ?? null;
            filePath = parts[i + 2] ?? oldPath;
            i += 3;
        } else {
            filePath = pathPart;
            i += 1;
        }
        out.set(filePath, { path: filePath, oldPath, additions, deletions, binary });
    }
    return out;
}

/** Parse `git diff --name-status -M -z` into a status map keyed by (new) path. */
function parseNameStatusZ(stdout) {
    const parts = stdout.split("\0");
    const out = new Map();
    let i = 0;
    while (i < parts.length) {
        const status = parts[i];
        if (!status) {
            i++;
            continue;
        }
        const code = status[0];
        if (code === "R" || code === "C") {
            const oldP = parts[i + 1] ?? null;
            const newP = parts[i + 2] ?? oldP;
            out.set(newP, { status: code, oldPath: oldP, score: status.slice(1) || null });
            i += 3;
        } else {
            const p = parts[i + 1] ?? "";
            if (p) out.set(p, { status: code, oldPath: null, score: null });
            i += 2;
        }
    }
    return out;
}

/** List untracked (but not ignored) files as synthetic additions. */
async function untrackedFiles(cwd, root) {
    const r = await git(cwd, ["ls-files", "--others", "--exclude-standard", "-z"]);
    if (!r.ok) return [];
    const paths = r.stdout.split("\0").filter((p) => p.length);
    const files = [];
    for (const p of paths) {
        const info = await countFileLines(path.join(root, p));
        files.push({
            path: p,
            oldPath: null,
            additions: info.binary ? 0 : info.lines,
            deletions: 0,
            binary: info.binary,
            status: "A",
            untracked: true,
        });
    }
    return files;
}

async function countFileLines(absPath) {
    try {
        const buf = await readFile(absPath);
        const slice = buf.subarray(0, UNTRACKED_MAX_BYTES);
        if (slice.includes(0)) return { lines: 0, binary: true };
        if (buf.length === 0) return { lines: 0, binary: false };
        let lines = 0;
        for (let i = 0; i < slice.length; i++) if (slice[i] === 0x0a) lines++;
        // count a final line without trailing newline
        if (slice.length > 0 && slice[slice.length - 1] !== 0x0a) lines++;
        return { lines, binary: false };
    } catch {
        return { lines: 0, binary: false };
    }
}

async function getCommits(cwd, mergeBase, hasBase) {
    if (!hasBase || !mergeBase || mergeBase === "HEAD") return [];
    const fmt = ["%H", "%h", "%an", "%aI", "%s"].join(US);
    const r = await git(cwd, ["log", `--format=${fmt}`, `${mergeBase}..HEAD`], {
        maxBuffer: 8 * 1024 * 1024,
    });
    if (!r.ok) return [];
    return r.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => {
            const [hash, short, author, date, subject] = l.split(US);
            return { hash, short, author, date, subject };
        });
}

const STATUS_LABEL = {
    A: "added",
    M: "modified",
    D: "deleted",
    R: "renamed",
    C: "copied",
    T: "typechange",
    U: "unmerged",
};

/**
 * Read each changed file as it stands now and record two things the diff alone
 * cannot give us: every import it currently holds (so the dependency graph
 * reflects how the change hangs together, not just the import lines this diff
 * touched) and the doc comment above each declaration (so a summary can say
 * what the code is *for*). Deleted, binary and asset files are skipped, and the
 * scan is bounded in bytes and file count so a huge change stays fast. Failure
 * is silent: this is enrichment, never a reason to fail the rundown.
 */
async function attachContentSignals(fileList, signals, root) {
    let budget = CONTENT_SCAN_MAX_FILES;
    for (const f of fileList) {
        if (f.status === "D" || f.binary || f.role === "asset") continue;
        if (budget <= 0) break;
        budget--;
        try {
            const buf = await readFile(path.join(root, f.path), "utf8");
            const text = buf.slice(0, CONTENT_SCAN_MAX_BYTES);
            const sig = signals.get(f.path) ?? { path: f.path };
            sig.currentImports = importsFromContent(text);
            sig.docs = docsFromContent(text);
            signals.set(f.path, sig);
        } catch {
            /* unreadable or genuinely binary: fall back to the diff's imports */
        }
    }
}

/**
 * Compute the full rundown payload for `cwd`. `baseOverride` optionally forces
 * the comparison base.
 */
export async function computeRundown(cwd, baseOverride) {
    const root = await repoRoot(cwd);
    if (!root) {
        return {
            isGitRepo: false,
            cwd,
            generatedAt: new Date().toISOString(),
            warnings: ["This folder is not inside a git repository."],
        };
    }

    const branchRaw = await gitLine(cwd, ["rev-parse", "--abbrev-ref", "HEAD"]);
    const branch = branchRaw === "HEAD" ? "(detached HEAD)" : branchRaw || "(unknown)";
    const detached = branchRaw === "HEAD";

    const { baseRef, mergeBase, hasBase, warnings } = await resolveBase(
        cwd,
        baseOverride,
        detached ? null : branchRaw,
    );

    const files = new Map();

    if (mergeBase) {
        const numstat = await git(cwd, ["diff", "--numstat", "-M", "-z", mergeBase], {
            maxBuffer: DIFF_MAX_BUFFER,
        });
        const nameStatus = await git(cwd, ["diff", "--name-status", "-M", "-z", mergeBase], {
            maxBuffer: DIFF_MAX_BUFFER,
        });
        const numMap = numstat.ok ? parseNumstatZ(numstat.stdout) : new Map();
        const statusMap = nameStatus.ok ? parseNameStatusZ(nameStatus.stdout) : new Map();
        for (const [p, entry] of numMap) {
            const st = statusMap.get(p);
            files.set(p, {
                ...entry,
                status: st?.status ?? "M",
                oldPath: entry.oldPath ?? st?.oldPath ?? null,
                untracked: false,
            });
        }
        // name-status may list files numstat omits (rare); keep them.
        for (const [p, st] of statusMap) {
            if (!files.has(p)) {
                files.set(p, {
                    path: p,
                    oldPath: st.oldPath,
                    additions: 0,
                    deletions: 0,
                    binary: false,
                    status: st.status,
                    untracked: false,
                });
            }
        }
    }

    for (const f of await untrackedFiles(cwd, root)) {
        if (!files.has(f.path)) files.set(f.path, f);
    }

    const fileList = [...files.values()].map((f) => ({
        ...f,
        statusLabel: STATUS_LABEL[f.status] ?? "modified",
        dir: path.posix.dirname(f.path.split("\\").join("/")),
        name: path.posix.basename(f.path.split("\\").join("/")),
        churn: (f.additions || 0) + (f.deletions || 0),
    }));
    fileList.sort((a, b) => b.churn - a.churn || a.path.localeCompare(b.path));

    const stats = fileList.reduce(
        (acc, f) => {
            acc.additions += f.additions || 0;
            acc.deletions += f.deletions || 0;
            if (f.binary) acc.binary += 1;
            acc.byStatus[f.status] = (acc.byStatus[f.status] || 0) + 1;
            return acc;
        },
        { filesChanged: fileList.length, additions: 0, deletions: 0, binary: 0, byStatus: {} },
    );

    // Directory rollup (top-level segment) for the visual map.
    const dirMap = new Map();
    for (const f of fileList) {
        const top = f.dir === "." ? "(root)" : f.dir.split("/")[0];
        const d = dirMap.get(top) || { dir: top, additions: 0, deletions: 0, files: 0, churn: 0 };
        d.additions += f.additions || 0;
        d.deletions += f.deletions || 0;
        d.files += 1;
        d.churn += f.churn;
        dirMap.set(top, d);
    }
    const directories = [...dirMap.values()].sort((a, b) => b.churn - a.churn);

    const commits = await getCommits(cwd, mergeBase, hasBase);

    // One extra whole-tree pass at zero context gives us, per file: hunk counts,
    // the function/section each hunk sits in, and clean added-vs-removed line
    // lists to mine for declarations, imports and dependencies.
    let signals = new Map();
    if (mergeBase) {
        const r = await git(cwd, ["diff", "--unified=0", "-M", mergeBase], {
            maxBuffer: DIFF_MAX_BUFFER,
        });
        if (r.ok) {
            try {
                signals = parseSignalDiff(r.stdout);
            } catch {
                signals = new Map(); // analysis is a bonus; never fail the rundown over it
            }
        }
    }
    for (const f of fileList) {
        if (!f.untracked || signals.has(f.path)) continue;
        try {
            const buf = await readFile(path.join(root, f.path), "utf8");
            signals.set(f.path, signalsFromContent(f.path, buf.slice(0, UNTRACKED_MAX_BYTES)));
        } catch {
            /* unreadable: it just gets a churn-based summary */
        }
    }

    // Roles first: the content scan skips assets, and describeFile needs the
    // doc comments that scan collects.
    for (const f of fileList) f.role = roleOf(f.path);
    await attachContentSignals(fileList, signals, root);

    for (const f of fileList) {
        const sig = signals.get(f.path);
        f.summary = describeFile(f, sig);
        f.signals = signalChips(f, sig);
        f.hunks = sig?.hunks ?? 0;
    }
    linkFiles(fileList, signals);
    scoreRisk(fileList, signals);

    return {
        isGitRepo: true,
        cwd,
        repo: {
            root,
            name: path.basename(root),
            branch,
            detached,
            base: baseRef,
            baseResolved: mergeBase,
            hasBase,
            commitCount: commits.length,
        },
        stats,
        risk: overallRisk(fileList),
        files: fileList,
        directories,
        commits,
        highlights: fileList.filter((f) => f.churn > 0 || f.status === "D").slice(0, 8),
        warnings,
        generatedAt: new Date().toISOString(),
    };
}

/** Parse a unified-diff patch string into hunks with old/new line numbers. */
function parseUnifiedDiff(patch) {
    const rawLines = patch.split("\n");
    const hunks = [];
    let current = null;
    let oldNo = 0;
    let newNo = 0;
    let binary = false;
    let truncated = false;
    let rendered = 0;

    for (const line of rawLines) {
        if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
            binary = true;
            continue;
        }
        if (line.startsWith("@@")) {
            const m = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/);
            oldNo = m ? Number(m[1]) : 0;
            newNo = m ? Number(m[2]) : 0;
            current = { header: line, section: m ? m[3].trim() : "", lines: [] };
            hunks.push(current);
            continue;
        }
        if (!current) continue; // skip file header (diff --git, index, ---, +++)
        if (rendered >= MAX_DIFF_LINES) {
            truncated = true;
            break;
        }
        const marker = line[0];
        if (marker === "+") {
            current.lines.push({ type: "add", oldNo: null, newNo, content: line.slice(1) });
            newNo++;
            rendered++;
        } else if (marker === "-") {
            current.lines.push({ type: "del", oldNo, newNo: null, content: line.slice(1) });
            oldNo++;
            rendered++;
        } else if (marker === "\\") {
            current.lines.push({ type: "meta", oldNo: null, newNo: null, content: line.slice(1).trim() });
        } else {
            // context (leading space) or empty trailing line
            current.lines.push({ type: "ctx", oldNo, newNo, content: line.slice(1) });
            oldNo++;
            newNo++;
            rendered++;
        }
    }
    return { hunks, binary, truncated };
}

/**
 * Return the parsed diff for a single file. `file` is an entry from the rundown
 * (needs path, status, oldPath, untracked). `mergeBase` is the comparison base.
 * With `full`, ask git for enough context to cover the whole file so the change
 * can be read in place rather than as isolated hunks.
 */
export async function getFileDiff(cwd, mergeBase, file, { full = false } = {}) {
    if (!file) return { error: "No file specified." };

    if (file.untracked) {
        const root = await repoRoot(cwd);
        const abs = root ? path.join(root, file.path) : file.path;
        const info = await countFileLines(abs);
        if (info.binary) {
            return { path: file.path, status: file.status, binary: true, hunks: [], truncated: false };
        }
        let content = "";
        try {
            content = await readFile(abs, "utf8");
        } catch (e) {
            return { path: file.path, error: `Could not read file: ${String(e)}` };
        }
        const lines = content.split("\n");
        if (lines.length && lines[lines.length - 1] === "") lines.pop();
        const capped = lines.slice(0, MAX_DIFF_LINES);
        return {
            path: file.path,
            status: file.status,
            binary: false,
            full,
            truncated: lines.length > capped.length,
            hunks: [
                {
                    header: `@@ -0,0 +1,${capped.length} @@`,
                    section: "new file (untracked)",
                    lines: capped.map((c, idx) => ({
                        type: "add",
                        oldNo: null,
                        newNo: idx + 1,
                        content: c,
                    })),
                },
            ],
        };
    }

    if (!mergeBase) return { path: file.path, error: "No base to diff against." };

    const args = ["diff", "-M", `-U${full ? FULL_CONTEXT : 3}`, mergeBase, "--"];
    if (file.oldPath) args.push(file.oldPath);
    args.push(file.path);

    const r = await git(cwd, args, { maxBuffer: DIFF_MAX_BUFFER });
    if (!r.ok) return { path: file.path, error: r.stderr || "git diff failed." };

    const parsed = parseUnifiedDiff(r.stdout);
    return {
        path: file.path,
        oldPath: file.oldPath ?? null,
        status: file.status,
        additions: file.additions ?? 0,
        deletions: file.deletions ?? 0,
        full,
        ...parsed,
    };
}

/** One-line text summary used by agent-facing actions. */
export function summarize(rundown) {
    if (!rundown?.isGitRepo) return "Not a git repository.";
    const s = rundown.stats;
    const r = rundown.repo;
    return (
        `${r.name} — ${r.branch}` +
        (r.base ? ` vs ${r.base}` : "") +
        `: ${s.filesChanged} file${s.filesChanged === 1 ? "" : "s"} changed, ` +
        `+${s.additions}/-${s.deletions}` +
        (r.commitCount ? `, ${r.commitCount} commit${r.commitCount === 1 ? "" : "s"}` : "") +
        (rundown.risk ? `. Risk: ${rundown.risk.band}` : "")
    );
}

/**
 * A cheap fingerprint of the working tree, used by the watcher to tell a real
 * change from filesystem noise (editor temp files, index churn, touch events).
 */
export async function fingerprint(cwd) {
    const head = await gitLine(cwd, ["rev-parse", "HEAD"]);
    const status = await git(cwd, ["status", "--porcelain=v1", "-z", "--untracked-files=all"], {
        maxBuffer: 16 * 1024 * 1024,
    });
    return `${head ?? ""}|${status.ok ? status.stdout.length : 0}|${status.ok ? hash(status.stdout) : 0}`;
}

function hash(s) {
    let h = 5381;
    for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
    return h >>> 0;
}
