import test from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, mkdir, writeFile, readFile, rename, symlink, utimes } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SourceControl, readSourceControl, sourceDiff, parseStatus, redact } from "./source-control.mjs";
import { authorizeRequest } from "./http-guard.mjs";
import { git, computeRundown } from "./git.mjs";

const testRoot = process.env.GITSUMMIT_TEST_ROOT || path.join(os.tmpdir(), "gitsummit-tests");
await mkdir(testRoot, { recursive: true });

async function g(cwd, ...args) {
    const result = await git(cwd, args);
    assert.equal(result.ok, true, result.stderr);
    return result.stdout.trim();
}
async function configure(root) {
    await g(root, "config", "user.name", "Canvas Test");
    await g(root, "config", "user.email", "canvas-test@example.invalid");
    await g(root, "config", "commit.gpgsign", "false");
    await g(root, "config", "core.autocrlf", "false");
    await g(root, "config", "core.hooksPath", path.join(root, ".test-hooks"));
}
async function fixture({ commit = true, remote = false, defaultBranch = "main" } = {}) {
    const dir = await mkdtemp(path.join(testRoot, "case-"));
    const local = path.join(dir, "local");
    await mkdir(local);
    await g(local, "init", "-b", defaultBranch);
    await configure(local);
    if (commit) {
        await writeFile(path.join(local, "file.txt"), "first\n");
        await g(local, "add", "--", "file.txt");
        await g(local, "commit", "-m", "Initial");
    }
    const control = new SourceControl(local);
    if (!remote) return { dir, local, control };
    const bare = path.join(dir, "remote.git"), peer = path.join(dir, "peer");
    await g(dir, "init", "--bare", `--initial-branch=${defaultBranch}`, bare);
    await g(local, "remote", "add", "origin", bare);
    await g(local, "push", "-u", "origin", defaultBranch);
    await g(dir, "clone", "-c", "core.autocrlf=false", bare, peer);
    await configure(peer);
    return { dir, local, control, bare, peer };
}
async function action(control, operation, extra = {}) {
    const state = await control.status();
    const preview = await control.prepare({ operation, revision: state.revision, ...extra });
    return control.execute({ token: preview.token, confirmed: true });
}
async function commitFile(root, name, content = name) {
    await writeFile(path.join(root, name), content);
    await g(root, "add", "--", name);
    await g(root, "commit", "-m", `Add ${name}`);
}
async function publishPeer(f, name) {
    await commitFile(f.peer, name);
    await g(f.peer, "push");
}

test("porcelain parser preserves spaces, quotes, newline paths and renames; separates conflict groups", () => {
    const data = parseStatus(' M space name.txt\0R  new"name.txt\0old name.txt\0?? line\nbreak.txt\0UU conflict\0AA both\0');
    assert.equal(data[0].unstaged, true);
    assert.equal(data[1].oldPath, "old name.txt");
    assert.equal(data[1].staged, true);
    assert.equal(data[2].path, "line\nbreak.txt");
    assert.equal(data[3].conflict, true);
    assert.equal(data[4].staged, false);
});

test("unborn branch: stage, inspect and unstage without losing file contents, then commit", async () => {
    const f = await fixture({ commit: false });
    await writeFile(path.join(f.local, "new.txt"), "new\n");
    assert.equal((await f.control.status()).unborn, true);
    await action(f.control, "stage", { filename: "new.txt" });
    assert.match((await sourceDiff(f.local, { kind: "staged", path: "new.txt" })).patch, /\+new/);
    await writeFile(path.join(f.local, "new.txt"), "new\nedited after staging\n");
    await action(f.control, "unstage", { filename: "new.txt" });
    assert.equal(await readFile(path.join(f.local, "new.txt"), "utf8"), "new\nedited after staging\n");
    await action(f.control, "stage", { filename: "new.txt" });
    await action(f.control, "commit", { message: "First canvas commit" });
    assert.equal((await f.control.status()).unborn, false);
    assert.equal(await g(f.local, "log", "-1", "--format=%s"), "First canvas commit");
});

test("staged and unstaged diffs stay separate; commit includes only staged content", async () => {
    const f = await fixture();
    await writeFile(path.join(f.local, "file.txt"), "staged\n");
    await action(f.control, "stage", { filename: "file.txt" });
    await writeFile(path.join(f.local, "file.txt"), "unstaged\n");
    const state = await f.control.status();
    assert.equal(state.files[0].staged, true); assert.equal(state.files[0].unstaged, true);
    assert.match((await sourceDiff(f.local, { kind: "staged", path: "file.txt" })).patch, /\+staged/);
    assert.match((await sourceDiff(f.local, { kind: "working", path: "file.txt" })).patch, /\+unstaged/);
    await action(f.control, "commit", { message: "Only staged" });
    assert.equal(await g(f.local, "show", "HEAD:file.txt"), "staged");
    assert.equal((await f.control.status()).files[0].unstaged, true);
});

test("stage uses literal filenames, not pathspec wildcards or shell commands", async () => {
    const f = await fixture();
    await writeFile(path.join(f.local, "[one].txt"), "literal");
    await writeFile(path.join(f.local, "o.txt"), "not staged");
    await action(f.control, "stage", { filename: "[one].txt" });
    assert.deepEqual((await f.control.status()).files.filter((file) => file.staged).map((file) => file.path), ["[one].txt"]);
    await assert.rejects(action(f.control, "stage", { filename: "../outside" }), /not eligible/);
    await assert.rejects(sourceDiff(f.local, { kind: "working", path: "../outside" }), /not in/);
});

test("staged rename can be unstaged; further edits to a staged rename can be staged", async () => {
    const f = await fixture();
    await rename(path.join(f.local, "file.txt"), path.join(f.local, "renamed.txt"));
    await g(f.local, "add", "-A");
    let state = await f.control.status();
    assert.equal(state.files[0].oldPath, "file.txt");
    await writeFile(path.join(f.local, "renamed.txt"), "first\nmore\n");
    await action(f.control, "stage", { filename: "renamed.txt" });
    await action(f.control, "unstage", { filename: "renamed.txt" });
    state = await f.control.status();
    assert.equal(state.files.some((file) => file.staged), false);
    assert.equal(await readFile(path.join(f.local, "renamed.txt"), "utf8"), "first\nmore\n");
});

test("a staged deletion plus an untracked copy of the same path supports both diffs and re-staging", async () => {
    const f = await fixture();
    await g(f.local, "rm", "--cached", "--", "file.txt");
    const state = await f.control.status();
    assert.equal(state.files.length, 1);
    assert.equal(state.files[0].staged, true);
    assert.equal(state.files[0].untracked, true);
    assert.match((await sourceDiff(f.local, { kind: "staged", path: "file.txt" })).patch, /-first/);
    assert.match((await sourceDiff(f.local, { kind: "working", path: "file.txt" })).patch, /\+first/);
    await action(f.control, "stage", { filename: "file.txt" });
    assert.equal((await f.control.status()).files.length, 0);
});

test("confirmation is bound to snapshot, expires, is single-use, and is required", async () => {
    const f = await fixture();
    await writeFile(path.join(f.local, "new.txt"), "one");
    const state = await f.control.status();
    const prepare = () => f.control.prepare({ operation: "stage", filename: "new.txt", revision: state.revision });
    const denied = await prepare();
    await assert.rejects(f.control.execute({ token: denied.token, confirmed: false }), /Confirmation/);
    const expired = await prepare();
    f.control.pending.get(expired.token).expires = 0;
    await assert.rejects(f.control.execute({ token: expired.token, confirmed: true }), /expired/);
    const stale = await prepare();
    await writeFile(path.join(f.local, "new.txt"), "two plus more");
    await assert.rejects(f.control.execute({ token: stale.token, confirmed: true }), /state changed/);
    await assert.rejects(prepare(), /state changed/);
    const fresh = await f.control.prepare({ operation: "stage", filename: "new.txt", revision: (await f.control.status()).revision });
    await f.control.execute({ token: fresh.token, confirmed: true });
    await assert.rejects(f.control.execute({ token: fresh.token, confirmed: true }), /already used/);
});

test("access-time metadata changes do not invalidate a preview or change the staged content", async () => {
    const f = await fixture();
    const filename = path.join(f.local, "new.txt"), modified = new Date("2025-01-01T00:00:00Z");
    await writeFile(filename, "preserved");
    await utimes(filename, modified, modified);
    const state = await f.control.status();
    const preview = await f.control.prepare({ operation: "stage", filename: "new.txt", revision: state.revision });
    await utimes(filename, new Date(), modified);
    await f.control.execute({ token: preview.token, confirmed: true });
    assert.equal(await g(f.local, "show", ":new.txt"), "preserved");
});

test("same-size edits with restored mtime invalidate the preview and diff revision", async () => {
    const f = await fixture();
    const filename = path.join(f.local, "new.txt"), modified = new Date("2025-01-01T00:00:00Z");
    await writeFile(filename, "one");
    await utimes(filename, modified, modified);
    const state = await f.control.status();
    const preview = await f.control.prepare({ operation: "stage", filename: "new.txt", revision: state.revision });
    await writeFile(filename, "two");
    await utimes(filename, modified, modified);
    assert.notEqual((await f.control.status()).revision, state.revision);
    await assert.rejects(f.control.execute({ token: preview.token, confirmed: true }), /state changed/);
    assert.equal((await f.control.status()).files[0].staged, false);
});

test("remote state is explicitly cached; fetch updates incoming commits and exact remote-to-HEAD diffs", async () => {
    const f = await fixture({ remote: true });
    await publishPeer(f, "remote.txt");
    let state = await f.control.status();
    assert.equal(state.behind, 0);
    await action(f.control, "fetch", { remote: "origin" });
    state = await f.control.status();
    assert.equal(state.behind, 1); assert.equal(state.ahead, 0);
    assert.equal(state.comparison.incoming[0].subject, "Add remote.txt");
    assert.deepEqual(state.comparison.files, [{ status: "D", path: "remote.txt" }]);
    assert.match((await sourceDiff(f.local, { kind: "compare", path: "remote.txt", ref: "origin/main" })).patch, /-remote.txt/);
    assert.ok(state.fetchedAt);
    assert.equal(await g(f.local, "log", "-1", "--format=%s"), "Initial");
});

test("pull fast-forwards clean local branch and push publishes only the configured branch", async () => {
    const f = await fixture({ remote: true });
    await publishPeer(f, "incoming.txt");
    await action(f.control, "pull");
    assert.equal(await readFile(path.join(f.local, "incoming.txt"), "utf8"), "incoming.txt");
    await commitFile(f.local, "outgoing.txt");
    assert.equal((await f.control.status()).ahead, 1);
    await action(f.control, "push");
    assert.equal(await g(f.dir, "--git-dir", f.bare, "rev-parse", "refs/heads/main"), await g(f.local, "rev-parse", "HEAD"));
});

test("sync fast-forwards from origin/main without pushing; does not merge divergent histories", async () => {
    const f = await fixture({ remote: true });
    await publishPeer(f, "sync.txt");
    assert.deepEqual((await action(f.control, "sync")).completed, ["pull"]);
    const remoteBefore = await g(f.dir, "--git-dir", f.bare, "rev-parse", "refs/heads/main");
    await commitFile(f.local, "local.txt");
    await action(f.control, "sync");
    assert.equal(await g(f.dir, "--git-dir", f.bare, "rev-parse", "refs/heads/main"), remoteBefore);
    assert.equal((await f.control.status()).syncTarget.ahead, 1);
    await publishPeer(f, "peer.txt");
    await action(f.control, "fetch", { remote: "origin" });
    const state = await f.control.status();
    assert.equal(state.ahead, 1); assert.equal(state.behind, 1);
    await assert.rejects(action(f.control, "sync"), /diverged/);
    await assert.rejects(action(f.control, "pull"), /diverged/);
    await assert.rejects(action(f.control, "push"), /failed/);
});

test("sync never contacts the push URL", async () => {
    const f = await fixture({ remote: true });
    await publishPeer(f, "kept.txt");
    await g(f.local, "config", "remote.origin.pushurl", path.join(f.dir, "missing.git"));
    assert.deepEqual((await action(f.control, "sync")).completed, ["pull"]);
    assert.equal(await readFile(path.join(f.local, "kept.txt"), "utf8"), "kept.txt");
    assert.equal(f.control.output.at(-1).success, true);
    assert.equal(f.control.output.some((entry) => entry.command === "push"), false);
});

test("sync compares against origin default, independently of upstream and selected comparison", async () => {
    const f = await fixture({ remote: true });
    await g(f.local, "checkout", "-b", "feature");
    await g(f.local, "push", "-u", "origin", "feature");
    const featureBefore = await g(f.dir, "--git-dir", f.bare, "rev-parse", "refs/heads/feature");
    await publishPeer(f, "main-change.txt");
    await action(f.control, "fetch", { remote: "origin" });
    await g(f.local, "update-ref", "--no-deref", "-d", "refs/remotes/origin/HEAD");
    const state = await f.control.status("origin/feature");
    assert.equal(state.comparison.ref, "origin/feature");
    assert.equal(state.behind, 0);
    assert.equal(state.syncTarget.ref, "origin/main");
    assert.equal(state.syncTarget.source, "origin/main fallback");
    assert.equal(state.syncTarget.behind, 1);
    const preview = await f.control.prepare({ operation: "sync", revision: state.revision });
    assert.match(preview.title, /Sync from origin\/main/);
    assert.match(preview.commands[0], /"origin" "refs\/heads\/main"$/);
    assert.equal(preview.commands.some((command) => /"push"/.test(command)), false);
    await f.control.execute({ token: preview.token, confirmed: true });
    assert.equal(await readFile(path.join(f.local, "main-change.txt"), "utf8"), "main-change.txt");
    assert.equal(await g(f.local, "rev-parse", "--abbrev-ref", "@{upstream}"), "origin/feature");
    assert.equal(await g(f.dir, "--git-dir", f.bare, "rev-parse", "refs/heads/feature"), featureBefore);
    assert.equal((await f.control.status()).syncTarget.behind, 0);
    await action(f.control, "push");
    assert.equal(await g(f.dir, "--git-dir", f.bare, "rev-parse", "refs/heads/feature"), await g(f.local, "rev-parse", "HEAD"));
});

test("sync uses origin/HEAD for a non-main default and works without a feature upstream", async () => {
    const f = await fixture({ remote: true, defaultBranch: "trunk" });
    await g(f.local, "remote", "set-head", "origin", "-a");
    await g(f.local, "checkout", "-b", "local-feature");
    await publishPeer(f, "trunk-change.txt");
    await action(f.control, "fetch", { remote: "origin" });
    const state = await f.control.status();
    assert.equal(state.upstream, null);
    assert.equal(state.syncTarget.ref, "origin/trunk");
    assert.equal(state.syncTarget.source, "origin/HEAD");
    assert.equal(state.syncTarget.behind, 1);
    assert.deepEqual((await action(f.control, "sync")).completed, ["pull"]);
    assert.equal(await g(f.local, "branch", "--show-current"), "local-feature");
    assert.equal((await f.control.status()).upstream, null);
});

test("missing default and dangling origin/HEAD never fall back to another remote or upstream", async () => {
    const f = await fixture({ remote: true, defaultBranch: "trunk" });
    await assert.rejects(action(f.control, "sync"), /default branch is unavailable/);
    await g(f.local, "update-ref", "refs/remotes/origin/main", await g(f.local, "rev-parse", "HEAD"));
    await g(f.local, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/missing");
    const state = await f.control.status();
    assert.equal(state.syncTarget.ref, "origin/missing");
    assert.equal(state.syncTarget.exists, false);
    assert.equal(state.syncTarget.behind, null);
    await assert.rejects(action(f.control, "sync"), /default branch is unavailable/);
    await g(f.local, "remote", "rename", "origin", "other");
    assert.equal((await f.control.status()).syncTarget, null);
    await assert.rejects(action(f.control, "sync"), /default branch is unavailable/);
});

test("changing origin's default invalidates a prepared sync even when both branches have the same commit", async () => {
    const f = await fixture({ remote: true });
    await g(f.local, "remote", "set-head", "origin", "-a");
    await g(f.local, "update-ref", "refs/remotes/origin/trunk", await g(f.local, "rev-parse", "HEAD"));
    const state = await f.control.status();
    const preview = await f.control.prepare({ operation: "sync", revision: state.revision });
    await g(f.local, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/trunk");
    await assert.rejects(f.control.execute({ token: preview.token, confirmed: true }), /state changed/);
});

test("local branches and tags named like origin refs cannot hide the default target", async () => {
    const f = await fixture({ remote: true });
    await g(f.local, "branch", "origin/main");
    await g(f.local, "tag", "origin/main");
    await publishPeer(f, "incoming.txt");
    await action(f.control, "fetch", { remote: "origin" });
    for (const useHead of [false, true]) {
        if (useHead) await g(f.local, "symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main");
        else await g(f.local, "update-ref", "--no-deref", "-d", "refs/remotes/origin/HEAD");
        const state = await f.control.status();
        assert.equal(state.syncTarget.exists, true);
        assert.equal(state.syncTarget.ref, "origin/main");
        assert.equal(state.syncTarget.behind, 1);
        assert.equal(state.upstream.exists, true);
        const preview = await f.control.prepare({ operation: "sync", revision: state.revision });
        assert.match(preview.commands[0], /"origin" "refs\/heads\/main"$/);
    }
    await action(f.control, "sync");
    assert.equal(await readFile(path.join(f.local, "incoming.txt"), "utf8"), "incoming.txt");
});

test("sync refuses divergence discovered during fetch and retains local commits", async () => {
    const f = await fixture({ remote: true });
    await commitFile(f.local, "local-only.txt");
    const head = await g(f.local, "rev-parse", "HEAD");
    const state = await f.control.status();
    assert.equal(state.syncTarget.behind, 0);
    const preview = await f.control.prepare({ operation: "sync", revision: state.revision });
    await publishPeer(f, "remote-only.txt");
    await assert.rejects(f.control.execute({ token: preview.token, confirmed: true }), /pull failed/);
    assert.equal(await g(f.local, "rev-parse", "HEAD"), head);
    assert.equal((await f.control.status()).syncTarget.behind, 1);
});

test("sync blocks dirty trees, detached HEAD and Git operations", async () => {
    const f = await fixture({ remote: true });
    await writeFile(path.join(f.local, "file.txt"), "dirty\n");
    await assert.rejects(action(f.control, "sync"), /clean working tree/);
    await action(f.control, "stage", { filename: "file.txt" });
    await assert.rejects(action(f.control, "sync"), /clean working tree/);
    await action(f.control, "commit", { message: "Local update" });
    await g(f.local, "checkout", "--detach");
    await assert.rejects(action(f.control, "sync"), /detached HEAD/);
    await g(f.local, "checkout", "main");
    await writeFile(path.join(f.local, ".git", "MERGE_HEAD"), await g(f.local, "rev-parse", "HEAD"));
    await assert.rejects(action(f.control, "sync"), /current Git operation/);
});

test("fetch, pull and sync do not prune refs or local tags even when Git configuration enables pruning", async () => {
    const f = await fixture({ remote: true });
    const head = await g(f.local, "rev-parse", "HEAD");
    await g(f.local, "update-ref", "refs/remotes/origin/keep-cached", head);
    await g(f.local, "tag", "keep-local-tag");
    for (const key of ["fetch.prune", "fetch.pruneTags", "remote.origin.prune", "remote.origin.pruneTags"]) await g(f.local, "config", key, "true");
    await action(f.control, "fetch", { remote: "origin" });
    assert.equal(await g(f.local, "rev-parse", "refs/remotes/origin/keep-cached"), head);
    assert.equal(await g(f.local, "rev-parse", "refs/tags/keep-local-tag"), head);
    await action(f.control, "pull");
    assert.equal(await g(f.local, "rev-parse", "refs/remotes/origin/keep-cached"), head);
    assert.equal(await g(f.local, "rev-parse", "refs/tags/keep-local-tag"), head);
    await action(f.control, "sync");
    assert.equal(await g(f.local, "rev-parse", "refs/remotes/origin/keep-cached"), head);
    assert.equal(await g(f.local, "rev-parse", "refs/tags/keep-local-tag"), head);
});

test("dirty tree, no upstream, detached HEAD, Git operations and empty commit are blocked", async () => {
    const f = await fixture({ remote: true });
    await writeFile(path.join(f.local, "dirty.txt"), "dirty");
    await assert.rejects(action(f.control, "pull"), /clean working tree/);
    await assert.rejects(action(f.control, "commit", { message: "Empty" }), /Stage changes/);
    await g(f.local, "branch", "--unset-upstream");
    await assert.rejects(action(f.control, "push"), /upstream/);
    await g(f.local, "checkout", "--detach");
    assert.equal((await f.control.status()).detached, true);
    await action(f.control, "stage", { filename: "dirty.txt" });
    await assert.rejects(action(f.control, "commit", { message: "Detached" }), /detached HEAD/);
    await g(f.local, "checkout", "main");
    await writeFile(path.join(f.local, ".git", "MERGE_HEAD"), await g(f.local, "rev-parse", "HEAD"));
    await assert.rejects(action(f.control, "commit", { message: "Merge" }), /Git operation/);
});

test("missing upstream and invalid comparison ref never report a passing sync state", async () => {
    const f = await fixture({ remote: true });
    await g(f.local, "update-ref", "-d", "refs/remotes/origin/main");
    const state = await f.control.status();
    assert.equal(state.upstream.exists, false); assert.equal(state.behind, null);
    await assert.rejects(action(f.control, "push"), /upstream/);
    await assert.rejects(readSourceControl(f.local, "origin/does-not-exist"), /no longer exists/);
});

test("confirmation detects changed remote destinations; secrets are redacted", async () => {
    const f = await fixture({ remote: true });
    const state = await f.control.status();
    const preview = await f.control.prepare({ operation: "push", revision: state.revision });
    await g(f.local, "config", "remote.origin.pushurl", "https://user:private@example.invalid/repo?token=secret");
    await assert.rejects(f.control.execute({ token: preview.token, confirmed: true }), /state changed/);
    const next = await f.control.status();
    assert.equal(next.remotes[0].pushUrl.includes("private"), false);
    assert.equal(next.remotes[0].pushUrl.includes("secret"), false);
    assert.equal(redact("https://pat@example.invalid/x"), "https://[redacted]@example.invalid/x");
    await g(f.local, "config", "--add", "remote.origin.pushurl", "https://example.invalid/second");
    await assert.rejects(action(f.control, "push"), /Multiple push URLs/);
});

test("diff handles binary and large untracked files without exposing unlimited content", async () => {
    const f = await fixture();
    await writeFile(path.join(f.local, "binary.dat"), Buffer.from([0, 1, 2]));
    assert.equal((await sourceDiff(f.local, { kind: "working", path: "binary.dat" })).patch, "Binary file.");
    await writeFile(path.join(f.local, "large.txt"), "x".repeat(300000));
    assert.equal((await sourceDiff(f.local, { kind: "working", path: "large.txt" })).truncated, true);
});

test("untracked symlink preview does not read the target", async (t) => {
    const f = await fixture();
    const target = path.join(f.dir, "outside.txt");
    await writeFile(target, "outside sentinel");
    try { await symlink(target, path.join(f.local, "link.txt")); }
    catch (error) { if (error.code === "EPERM") { t.skip("Windows symlink privilege unavailable"); return; } throw error; }
    const diff = await sourceDiff(f.local, { kind: "working", path: "link.txt" });
    assert.equal(diff.patch.includes("outside sentinel"), false);
});

test("worktree snapshot stays on its own branch; legacy review still works", async () => {
    const f = await fixture({ remote: true });
    const worktree = path.join(f.dir, "worktree");
    await g(f.local, "worktree", "add", "-b", "feature", worktree);
    await writeFile(path.join(worktree, "worktree.txt"), "only here");
    const state = await readSourceControl(worktree);
    assert.equal(state.root.replaceAll("\\", "/"), worktree.replaceAll("\\", "/"));
    assert.equal(state.branch, "feature");
    assert.equal((await readSourceControl(f.local)).files.length, 0);
    const review = await computeRundown(worktree);
    assert.equal(review.isGitRepo, true);
    assert.ok(review.files.some((file) => file.path === "worktree.txt"));
});

test("submodule pointer changes invalidate the parent snapshot and can be staged", async () => {
    const f = await fixture({ remote: true });
    await g(f.local, "-c", "protocol.file.allow=always", "submodule", "add", f.bare, "vendor");
    await g(f.local, "commit", "-m", "Add submodule");
    const nested = path.join(f.local, "vendor");
    await configure(nested);
    const before = await f.control.status();
    await commitFile(nested, "nested.txt");
    const after = await f.control.status();
    assert.notEqual(after.revision, before.revision);
    assert.ok(after.files.some((file) => file.path === "vendor"));
    await action(f.control, "stage", { filename: "vendor" });
    assert.ok((await f.control.status()).files.some((file) => file.path === "vendor" && file.staged));
});

test("HTTP guard rejects missing tokens, cross-origin writes and rebinding; accepts authenticated requests", () => {
    const context = { origin: "http://127.0.0.1:1234", token: "test-secret" };
    const url = new URL("/api/source/execute", context.origin);
    const req = (headers) => ({ headers: { host: "127.0.0.1:1234", ...headers } });
    assert.equal(authorizeRequest(req({}), url, context), false);
    assert.equal(authorizeRequest(req({ "x-gitsummit-token": "test-secret" }), url, context), true);
    assert.equal(authorizeRequest(req({ origin: "https://evil.invalid", "x-gitsummit-token": "test-secret" }), url, context), false);
    assert.equal(authorizeRequest(req({ host: "evil.invalid:1234", "x-gitsummit-token": "test-secret" }), url, context), false);
    assert.equal(authorizeRequest(req({}), new URL("/events?token=test-secret", context.origin), context), true);
});
