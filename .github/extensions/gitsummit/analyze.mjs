// analyze.mjs — turns a raw git diff into the things a reviewer actually wants:
// a sentence describing each file, the links between changed files, and a risk
// read on what might break.
//
// Everything here is derived from `git` output alone — no language server, no
// network, no per-language configuration. That keeps it repo-agnostic at the
// cost of being heuristic, so nothing here is presented as fact: summaries are
// descriptive and every risk point carries its own plain-language reason.

/* ------------------------------------------------------------------ *
 * Diff signal extraction
 * ------------------------------------------------------------------ */

/** Declarations, across the languages a regex can honestly recognise. */
const DECL_RES = [
    // export function foo / async function foo / function* foo
    /^\s*(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/,
    // class/interface/type/enum/struct/record, with any modifier soup in front
    /^\s*(?:(?:export|default|public|private|protected|internal|abstract|sealed|static|final|partial|pub)\s+)*(?:class|interface|struct|enum|record|type|trait|protocol)\s+([A-Za-z_$][\w$]*)/,
    // export const foo = / let foo: / var foo =
    // Anchored at column 0 unless exported: an indented `const v = helper(x)`
    // is a local inside a function, and reporting it as a declaration is what
    // produced summaries like "Adds v" that tell a reviewer nothing.
    /^(?:\s*export\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*[=:]/,
    // python / ruby
    /^\s*def\s+([A-Za-z_]\w*)/,
    // go: func Foo / func (r *T) Foo
    /^\s*func\s+(?:\([^)]*\)\s*)?([A-Za-z_]\w*)/,
    // rust
    /^\s*(?:pub\s+)?fn\s+([A-Za-z_]\w*)/,
    // C#/Java members — require a visibility modifier so `if (x)` can't match
    /^\s*(?:public|private|protected|internal)\s+(?:(?:static|async|virtual|override|sealed|abstract|final|readonly)\s+)*(?:[\w<>\[\],.?]+\s+)?([A-Za-z_]\w*)\s*\(/,
];

/** Import specifiers. The captured group is the module path or name. */
const IMPORT_RES = [
    /^\s*import\s+[^'"]*from\s+['"]([^'"]+)['"]/, // js/ts, single line
    // multi-line import: the closing `} from "x"` lands on its own line
    /^\s*\}?\s*from\s+['"]([^'"]+)['"]/,
    /^\s*import\s+['"]([^'"]+)['"]/, // js/ts side-effect, go
    /require\(\s*['"]([^'"]+)['"]\s*\)/, // cjs
    /^\s*from\s+([\w./]+)\s+import\s/, // python
    /^\s*using\s+(?:static\s+)?([\w.]+)\s*;/, // c#
    /^\s*use\s+([\w:]+)/, // rust
    /^\s*#include\s+["<]([^">]+)[">]/, // c/c++
    /^\s*@?import\s+["']([^"']+)["']/, // css/scss
];

/** Marks a declaration as part of the file's public surface. */
const EXPORTED_RE = /^\s*(?:export\b|pub\b|public\b)/;

const TEST_RE =
    /^\s*(?:it|test|describe|context)\s*\(|^\s*\[(?:Fact|Theory|Test|TestMethod)\]|^\s*def\s+test_|^\s*func\s+Test[A-Z]|@Test\b/;

/** package.json-style "name": "^1.2.3" — a version-shaped value, not any key. */
const DEP_RES = [
    /"([^"]+)"\s*:\s*"[\^~>=<]?\d[^"]*"/,
    /<PackageReference\s+Include="([^"]+)"/i,
    /^\s*([A-Za-z0-9_.-]+)\s*[=<>~!]=/, // requirements.txt
    /^\s*(?:require\s+)?([\w.\-/]+)\s+v?\d+\./, // go.mod
    /^\s*([A-Za-z0-9_-]+)\s*=\s*[{"]/, // Cargo.toml
];

function firstMatch(line, regexes) {
    for (const re of regexes) {
        const m = line.match(re);
        if (m && m[1]) return m[1];
    }
    return null;
}

function unquotePath(p) {
    if (!p.startsWith('"')) return p;
    try {
        return JSON.parse(p);
    } catch {
        return p.slice(1, -1);
    }
}

/**
 * Parse one whole-tree `git diff --unified=0` into per-file signals.
 * With zero context every body line is an addition or a removal, which makes
 * "what was added" and "what was removed" cleanly separable.
 */
export function parseSignalDiff(stdout) {
    const files = new Map();
    let cur = null;

    const start = (p, oldPath) => {
        cur = {
            path: p,
            oldPath: oldPath ?? null,
            hunks: 0,
            sections: [],
            addedDecls: [],
            removedDecls: [],
            exportedDecls: [],
            addedImports: [],
            removedImports: [],
            addedTests: 0,
            removedTests: 0,
            addedDeps: [],
            removedDeps: [],
            binary: false,
        };
        files.set(p, cur);
    };

    for (const line of stdout.split("\n")) {
        if (line.startsWith("diff --git ")) {
            const m = line.match(/^diff --git (.+) (.+)$/);
            if (m) {
                const a = unquotePath(m[1]).replace(/^a\//, "");
                const b = unquotePath(m[2]).replace(/^b\//, "");
                start(b, a === b ? null : a);
            } else {
                cur = null;
            }
            continue;
        }
        if (!cur) continue;
        if (line.startsWith("Binary files") || line.startsWith("GIT binary patch")) {
            cur.binary = true;
            continue;
        }
        if (line.startsWith("+++") || line.startsWith("---") || line.startsWith("index ")) continue;
        if (line.startsWith("@@")) {
            cur.hunks++;
            const m = line.match(/^@@ [^@]*@@\s*(.*)$/);
            const section = m ? m[1].trim() : "";
            if (section && !cur.sections.includes(section)) cur.sections.push(section);
            continue;
        }

        const added = line[0] === "+";
        const removed = line[0] === "-";
        if (!added && !removed) continue;
        const body = line.slice(1);

        const decl = firstMatch(body, DECL_RES);
        if (decl) {
            (added ? cur.addedDecls : cur.removedDecls).push(decl);
            if (added && EXPORTED_RE.test(body)) cur.exportedDecls.push(decl);
        }

        const imp = firstMatch(body, IMPORT_RES);
        if (imp) (added ? cur.addedImports : cur.removedImports).push(imp);

        // Only count test cases in files that actually are tests, otherwise any
        // file mentioning `test(` or `describe(` picks up phantom cases.
        if (roleOf(cur.path) === "test" && TEST_RE.test(body))
            added ? cur.addedTests++ : cur.removedTests++;

        if (isManifest(cur.path)) {
            const dep = firstMatch(body, DEP_RES);
            if (dep) (added ? cur.addedDeps : cur.removedDeps).push(dep);
        }
    }

    for (const s of files.values()) {
        s.addedDecls = unique(s.addedDecls);
        s.removedDecls = unique(s.removedDecls);
        s.exportedDecls = unique(s.exportedDecls);
        s.addedImports = unique(s.addedImports);
        s.removedImports = unique(s.removedImports);
        s.addedDeps = unique(s.addedDeps);
        s.removedDeps = unique(s.removedDeps);
        // A declaration that is both added and removed was edited, not introduced.
        const both = s.addedDecls.filter((d) => s.removedDecls.includes(d));
        s.editedDecls = both;
        s.addedDecls = s.addedDecls.filter((d) => !both.includes(d));
        s.removedDecls = s.removedDecls.filter((d) => !both.includes(d));
        // Same for dependencies: a manifest line that merely gained a trailing
        // comma reads as both an add and a drop, which it plainly is not.
        const sameDep = s.addedDeps.filter((d) => s.removedDeps.includes(d));
        s.addedDeps = s.addedDeps.filter((d) => !sameDep.includes(d));
        s.removedDeps = s.removedDeps.filter((d) => !sameDep.includes(d));
    }
    return files;
}

const unique = (a) => [...new Set(a)].filter(Boolean);

/** Signals for an untracked file, read from its content as one big addition. */
export function signalsFromContent(filePath, content) {
    const s = {
        path: filePath,
        oldPath: null,
        hunks: 1,
        sections: [],
        addedDecls: [],
        removedDecls: [],
        exportedDecls: [],
        addedImports: [],
        removedImports: [],
        addedTests: 0,
        removedTests: 0,
        addedDeps: [],
        removedDeps: [],
        editedDecls: [],
        binary: false,
    };
    for (const body of content.split("\n")) {
        const decl = firstMatch(body, DECL_RES);
        if (decl) {
            s.addedDecls.push(decl);
            if (EXPORTED_RE.test(body)) s.exportedDecls.push(decl);
        }
        const imp = firstMatch(body, IMPORT_RES);
        if (imp) s.addedImports.push(imp);
        if (roleOf(filePath) === "test" && TEST_RE.test(body)) s.addedTests++;
        if (isManifest(filePath)) {
            const dep = firstMatch(body, DEP_RES);
            if (dep) s.addedDeps.push(dep);
        }
    }
    s.addedDecls = unique(s.addedDecls);
    s.exportedDecls = unique(s.exportedDecls);
    s.addedImports = unique(s.addedImports);
    s.addedDeps = unique(s.addedDeps);
    return s;
}

/* ------------------------------------------------------------------ *
 * File roles
 * ------------------------------------------------------------------ */

export const ROLE_LABEL = {
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

export function roleOf(p) {
    const s = String(p).toLowerCase();
    const name = s.split("/").pop();
    if (/(^|[._-])(test|spec)s?[._]/.test(name) || /(^|\/)(tests?|specs?|__tests__)\//.test(s))
        return "test";
    if (/\.(md|mdx|rst|adoc|txt)$/.test(name) || /(^|\/)docs?\//.test(s)) return "docs";
    if (/\.d\.ts$/.test(name) || /(^|\/)types?\//.test(s)) return "types";
    if (/\.(png|jpe?g|gif|svg|ico|webp|woff2?|ttf|otf|mp4|pdf|zip)$/.test(name)) return "asset";
    if (
        /\.(ya?ml|json|toml|ini|cfg|conf|properties|env|lock)$/.test(name) ||
        /(^|\/)config\//.test(s)
    )
        return "config";
    if (/(^|\/)(routes?|controllers?|handlers?|api|endpoints?)\//.test(s)) return "api";
    if (/(^|\/)(stores?|repositor(y|ies)|models?|db|dal|data)\//.test(s)) return "data";
    if (/(^|\/)middlewares?\//.test(s)) return "middleware";
    if (
        /(^|\/)(components?|views?|pages?|screens?|ui)\//.test(s) ||
        /\.(tsx|jsx|vue|svelte|css|scss|less)$/.test(name)
    )
        return "ui";
    if (/(^|\/)(utils?|helpers?|lib|common|shared)\//.test(s)) return "util";
    if (/^(server|main|app|index|program|startup)\.[a-z]+$/.test(name)) return "entry";
    return "core";
}

const MANIFEST_RE =
    /^(package(-lock)?\.json|yarn\.lock|pnpm-lock\.yaml|go\.(mod|sum)|cargo\.(toml|lock)|requirements\.txt|pyproject\.toml|poetry\.lock|gemfile(\.lock)?|composer\.json|pom\.xml|build\.gradle(\.kts)?|.+\.(cs|fs|vb)proj|directory\.packages\.props)$/i;
const CI_RE =
    /^\.github\/workflows\/|^(azure-pipelines|\.gitlab-ci|\.circleci\/|jenkinsfile|dockerfile|docker-compose|\.travis)/i;

export const isManifest = (p) => MANIFEST_RE.test(String(p).split("/").pop());
export const isCI = (p) => CI_RE.test(String(p));

/* ------------------------------------------------------------------ *
 * Links between changed files
 * ------------------------------------------------------------------ */

const EXTS = [
    ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".d.ts",
    ".py", ".go", ".rs", ".cs", ".java", ".rb", ".php", ".kt", ".swift",
    ".c", ".h", ".cc", ".cpp", ".hpp", ".css", ".scss", ".vue", ".svelte", ".json",
];

/**
 * Resolve an import specifier to another changed file, or null.
 * Only links where BOTH ends are part of this change are kept — the point is to
 * show how the change hangs together, not to map the whole repo.
 */
export function resolveLink(fromPath, spec, changed, byBase) {
    if (!spec) return null;
    const dir = fromPath.includes("/") ? fromPath.slice(0, fromPath.lastIndexOf("/")) : "";

    if (spec.startsWith(".")) {
        const joined = normalize(dir ? dir + "/" + spec : spec);
        const candidates = [joined];
        const noExt = joined.replace(/\.[A-Za-z0-9]+$/, "");
        for (const ext of EXTS) {
            candidates.push(joined + ext, joined + "/index" + ext, noExt + ext);
        }
        for (const c of candidates) if (c !== fromPath && changed.has(c)) return c;
        return null;
    }

    // Non-relative: accept only an unambiguous basename match, so a common word
    // in a namespace can't invent a link.
    const seg = spec.split(/[/\\.:]/).filter(Boolean).pop();
    if (!seg) return null;
    const hits = byBase.get(seg.toLowerCase());
    if (hits && hits.length === 1 && hits[0] !== fromPath) return hits[0];
    return null;
}

function normalize(p) {
    const out = [];
    for (const part of p.split("/")) {
        if (!part || part === ".") continue;
        if (part === "..") out.pop();
        else out.push(part);
    }
    return out.join("/");
}

/** Every import specifier a file holds right now, read from its full text. */
export function importsFromContent(content) {
    const out = [];
    for (const line of String(content).split("\n")) {
        const imp = firstMatch(line, IMPORT_RES);
        if (imp) out.push(imp);
    }
    return unique(out);
}

/* ------------------------------------------------------------------ *
 * Purpose, taken from the author's own doc comments
 * ------------------------------------------------------------------ */

const DOC_MAX = 88;
/* `#` opens a comment in several languages but also a C preprocessor line and
   a shebang, neither of which describes the code below it. */
const NOT_A_COMMENT_RE = /^#\s*(?:include|define|if|ifdef|ifndef|else|elif|endif|pragma|!)/;
/* Declaration regexes that name a function or a type. A `const` holding a
   number is documented too, but "what this module now does" is answered by its
   functions, so those win when both are available. */
const NAMED_THING = new Set([0, 1, 3, 4, 5, 6]);

/** Which DECL_RE matched, so callers can tell a function from a bare value. */
function matchDecl(line) {
    for (let i = 0; i < DECL_RES.length; i++) {
        const m = line.match(DECL_RES[i]);
        if (m && m[1]) return { name: m[1], notable: NAMED_THING.has(i) };
    }
    return null;
}

/** The prose inside one comment line, or null when the line isn't a comment. */
function commentBody(line) {
    const t = line.trim();
    if (!t || NOT_A_COMMENT_RE.test(t)) return null;
    if (t.startsWith("/*")) return t.replace(/^\/\*+/, "").replace(/\*+\/$/, "").trim();
    if (t.startsWith("*/")) return "";
    if (t.startsWith("*")) return t.replace(/^\*+\/?/, "").trim();
    if (t.startsWith("//")) return t.replace(/^\/+!?/, "").trim();
    if (t.startsWith("#")) return t.replace(/^#+/, "").trim();
    return null;
}

/** Cut to `max` on a clause or word boundary, so nothing ends mid-word. */
function clampSentence(s, max) {
    if (s.length <= max) return s;
    const head = s.slice(0, max);
    const cut = Math.max(
        head.lastIndexOf(", "),
        head.lastIndexOf("; "),
        head.lastIndexOf(": "),
        head.lastIndexOf(" — "),
    );
    const at = cut > max * 0.5 ? cut : head.lastIndexOf(" ");
    return (at > 0 ? head.slice(0, at) : head).trimEnd().replace(/[,;:]$/, "") + "…";
}

/** Collapse a comment block to the one short phrase a card can show. */
function firstSentence(parts) {
    const text = parts
        .filter((p) => p && !p.trim().startsWith("@")) // @param/@returns aren't a summary
        .join(" ")
        .replace(/[`*_]/g, "") // inline markdown reads as noise in plain text
        .replace(/\s+/g, " ")
        .trim();
    if (!text) return null;
    // One sentence is the description; the rest is detail the card has no room
    // for. Abbreviations aside, a period followed by a space ends it.
    const first = text.split(/(?<=[.!?])\s+/)[0].replace(/[.]$/, "").trim();
    return first.length < 3 ? null : clampSentence(first, DOC_MAX);
}

/**
 * The doc comment directly above line `idx`, reduced to a single short phrase.
 * Blank lines, decorators and attributes are stepped over so a comment still
 * counts as documentation when something sits between it and the declaration.
 */
function docAbove(lines, idx) {
    let i = idx - 1;
    while (i >= 0 && (!lines[i].trim() || /^\s*(?:@|\[|#\[)/.test(lines[i]))) i--;

    const parts = [];
    for (; i >= 0; i--) {
        const body = commentBody(lines[i]);
        if (body === null) break;
        parts.push(body);
        if (/^\s*\/\*/.test(lines[i])) break; // reached the opening /**
        if (parts.length > 12) break; // a licence header is not a description
    }
    return firstSentence(parts.reverse());
}

/**
 * A docstring on the lines just below a declaration — where Python, and any
 * language that borrowed the convention, actually puts its documentation.
 */
function docBelow(lines, idx) {
    let i = idx + 1;
    while (i < lines.length && !lines[i].trim()) i++;
    if (i >= lines.length) return null;

    const open = lines[i].trim().match(/^[rubf]{0,2}("""|''')/i);
    if (!open) return null;
    const q = open[1];
    const head = lines[i].trim().slice(lines[i].trim().indexOf(q) + 3);
    const end = head.indexOf(q);
    if (end >= 0) return firstSentence([head.slice(0, end)]);

    const parts = [head];
    for (i++; i < lines.length && parts.length < 12; i++) {
        const close = lines[i].indexOf(q);
        if (close >= 0) {
            parts.push(lines[i].slice(0, close));
            break;
        }
        parts.push(lines[i]);
    }
    return firstSentence(parts);
}

/**
 * Map every declaration in a file to the sentence its author wrote above it.
 * This is the one place a summary can say what a function is *for* rather than
 * merely that it appeared — and it stays honest, because the words are the
 * author's, not ours.
 */
export function docsFromContent(content) {
    const lines = String(content).split("\n");
    const docs = {};
    for (let i = 0; i < lines.length; i++) {
        const hit = matchDecl(lines[i]);
        if (!hit || docs[hit.name]) continue;
        const text = docAbove(lines, i) ?? docBelow(lines, i);
        if (text) docs[hit.name] = { text, notable: hit.notable };
    }
    return docs;
}

/** Attach `links: [{ to, kind }]` to every file, in place. */
export function linkFiles(files, signals) {
    const changed = new Set(files.map((f) => f.path));
    const byBase = new Map();
    for (const f of files) {
        const base = f.name.replace(/\.[^.]*$/, "").toLowerCase();
        if (!byBase.has(base)) byBase.set(base, []);
        byBase.get(base).push(f.path);
    }
    for (const f of files) {
        const sig = signals.get(f.path);
        const links = [];
        const seen = new Set();
        const liveTargets = new Set();
        const add = (spec, kind) => {
            const to = resolveLink(f.path, spec, changed, byBase);
            if (!to || seen.has(to + kind)) return;
            // A file that still imports its neighbour is not "unlinked from"
            // it, however the specifier was rewritten along the way.
            if (kind === "del" && liveTargets.has(to)) return;
            seen.add(to + kind);
            if (kind !== "del") liveTargets.add(to);
            links.push({ to, kind });
        };
        // Live links come from what the file imports *now*, not only from the
        // import lines this diff happened to touch — two changed files that
        // already referenced each other are still related, and that
        // relationship is the whole point of the diagram. `addedImports` is
        // still unioned in so a deleted file, or one we could not read, keeps
        // whatever the diff did tell us.
        const live = unique([...(sig?.currentImports ?? []), ...(sig?.addedImports ?? [])]);
        for (const spec of live) add(spec, "add");
        for (const spec of sig?.removedImports ?? []) {
            // An import that was only moved around still exists; ignore those.
            if (live.includes(spec)) continue;
            add(spec, "del");
        }
        f.links = links;
    }
}

/* ------------------------------------------------------------------ *
 * Summaries
 * ------------------------------------------------------------------ */

function listPhrase(arr, max = 3) {
    const a = arr.slice(0, max);
    const extra = arr.length - a.length;
    // "a, b and c and 3 more" reads badly, so an overflow list stays comma-
    // separated and spends its only "and" on the count.
    if (extra) return a.join(", ") + " and " + extra + " more";
    return a.length <= 1 ? a.join("") : a.slice(0, -1).join(", ") + " and " + a[a.length - 1];
}

/** Long lists read as noise, so past a handful name a few and count the rest. */
function many(arr, max = 3) {
    return listPhrase(arr, arr.length <= max + 1 ? max + 1 : max);
}

const KIND_NOUN = {
    test: "test file",
    docs: "documentation",
    config: "configuration",
    types: "type declarations",
    asset: "asset",
    ui: "interface file",
    api: "route",
    data: "store",
    middleware: "middleware",
    util: "helper",
    entry: "entry point",
    core: "module",
};

/**
 * A 1–3 sentence description of what happened to one file.
 *
 * Deliberately says nothing about line counts or hunk counts: the card already
 * shows the status badge and +/− beside this text, so repeating them here would
 * spend the only prose we have on numbers the reader can already see. What the
 * reader cannot see is *what the code is for*, so that leads instead.
 */
export function describeFile(file, sig) {
    try {
        const role = roleOf(file.path);
        const noun = KIND_NOUN[role] ?? "module";
        const docs = sig?.docs ?? {};
        const plural = (n, w) => n + " " + w + (n === 1 ? "" : "s");
        const out = [];

        if (file.binary) {
            const verb =
                file.status === "A" ? "added" : file.status === "D" ? "removed" : "changed";
            return `Binary ${noun} ${verb} — there is no textual diff to review.`;
        }

        // 1. Status, but only when it carries something the badge does not.
        if (file.status === "A") {
            out.push(`New ${noun}.`);
        } else if (file.status === "D") {
            const what = sig?.removedDecls?.length
                ? `, removing ${listPhrase(sig.removedDecls)}`
                : "";
            out.push(`Deleted ${noun}${what}.`);
        } else if (file.status === "R" || file.status === "C") {
            const verb = file.status === "R" ? "Renamed" : "Copied";
            out.push(`${verb} from ${file.oldPath}.`);
        }
        // A plain edit gets no status sentence at all — "Edited" next to an
        // "M" badge and a +12/−3 count is three ways of saying one thing.

        // 2. What the change is actually about.
        if (file.status !== "D") {
            // Prefer the public surface: on a new 500-line module, "adds these
            // three exports" is the useful sentence, not a roll-call of locals.
            const introduced = sig?.exportedDecls?.length ? sig.exportedDecls : sig?.addedDecls;
            if (role === "test" && (sig?.addedTests || sig?.removedTests)) {
                const parts = [];
                if (sig.addedTests) parts.push(`adds ${plural(sig.addedTests, "test case")}`);
                if (sig.removedTests) parts.push(`removes ${plural(sig.removedTests, "test case")}`);
                out.push(cap(parts.join(" and ") + "."));
            } else if (introduced?.length && sig?.removedDecls?.length) {
                out.push(withPurpose("Adds", introduced, docs, sig.removedDecls));
            } else if (introduced?.length) {
                out.push(withPurpose("Adds", introduced, docs));
            } else if (sig?.removedDecls?.length) {
                out.push(`Removes ${listPhrase(sig.removedDecls)}.`);
            } else if (sig?.editedDecls?.length) {
                out.push(withPurpose("Reworks", sig.editedDecls, docs));
            } else if (sig?.sections?.length && role !== "docs" && role !== "asset") {
                // git's hunk context is the nearest preceding line, which in
                // prose files is just a sentence — only useful for code.
                out.push(
                    withPurpose("Changes code inside", unique(sig.sections.map(shortSection)), docs),
                );
            }
        }

        // 3. What it now depends on.
        if (isManifest(file.path) && (sig?.addedDeps?.length || sig?.removedDeps?.length)) {
            const parts = [];
            if (sig.addedDeps.length) parts.push(`adds ${listPhrase(sig.addedDeps)}`);
            if (sig.removedDeps.length) parts.push(`drops ${listPhrase(sig.removedDeps)}`);
            out.push(`Dependency change: ${parts.join(", ")}.`);
        } else if (file.status !== "D") {
            const added = (sig?.addedImports ?? []).filter(
                (i) => !(sig?.removedImports ?? []).includes(i),
            );
            const removed = (sig?.removedImports ?? []).filter(
                (i) => !(sig?.addedImports ?? []).includes(i),
            );
            if (added.length && removed.length) {
                out.push(
                    `Now imports ${listPhrase(added.map(shortSpec), 2)}; no longer imports ${listPhrase(removed.map(shortSpec), 2)}.`,
                );
            } else if (added.length) {
                out.push(`Now imports ${listPhrase(added.map(shortSpec), 2)}.`);
            } else if (removed.length) {
                out.push(`No longer imports ${listPhrase(removed.map(shortSpec), 2)}.`);
            }
        }

        if (!out.length) {
            const churn = (file.additions || 0) + (file.deletions || 0);
            return churn ? `Edited ${noun}.` : `No content change.`;
        }
        return out.slice(0, 3).join(" ");
    } catch {
        const churn = (file.additions || 0) + (file.deletions || 0);
        return `${churn} line${churn === 1 ? "" : "s"} changed.`;
    }
}

/** Keep a doc sentence flowing after an em dash without shouting mid-clause. */
const lowerFirst = (s) => (/^[A-Z][a-z]/.test(s) ? s[0].toLowerCase() + s.slice(1) : s);

/**
 * "Adds importsFromContent — every import specifier a file holds right now."
 *
 * Names alone ("Adds importsFromContent") tell a reviewer nothing they can act
 * on, so where the author documented the thing we borrow their sentence. A
 * documented function or type leads over a documented constant; the remaining
 * names are counted rather than recited, since the doc has already spent the
 * line and the names are listed as chips anyway.
 */
function withPurpose(verb, names, docs, removed) {
    const tail = removed?.length ? ` Removes ${listPhrase(removed)}.` : "";
    const lead =
        names.find((n) => docs[n]?.notable) ?? names.find((n) => docs[n]);
    if (!lead) return `${verb} ${many(names)}.${tail}`;
    const rest = names.length - 1;
    const also = rest > 0 ? ` (+${rest} more)` : "";
    return `${verb} ${lead} — ${lowerFirst(docs[lead].text)}${also}.${tail}`;
}

const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1) : s);
const shortSpec = (s) => s.split("/").slice(-2).join("/");

/**
 * git's hunk header carries the enclosing line verbatim ("export function
 * helper(a) {"). Reduce it to the bare name so a summary reads like prose
 * rather than pasted code, falling back to trimmed text when no name is found.
 */
function shortSection(s) {
    const text = String(s).replace(/\s*\{.*$/, "").trim();
    const name = firstMatch(text, DECL_RES);
    return name || text.slice(0, 48);
}

/** Compact chips shown under the summary. */
export function signalChips(file, sig) {
    const chips = [];
    if (file.binary) chips.push({ t: "binary", k: "" });
    if (file.status === "R") chips.push({ t: "renamed", k: "dep" });
    const introduced = sig?.exportedDecls?.length ? sig.exportedDecls : (sig?.addedDecls ?? []);
    for (const d of introduced.slice(0, 3)) chips.push({ t: "+ " + d, k: "plus" });
    for (const d of (sig?.removedDecls ?? []).slice(0, 2)) chips.push({ t: "− " + d, k: "minus" });
    if (sig?.addedTests) chips.push({ t: `+${sig.addedTests} tests`, k: "plus" });
    for (const d of (sig?.addedDeps ?? []).slice(0, 2)) chips.push({ t: "+ " + d, k: "dep" });
    if (sig?.hunks > 1 && chips.length < 4) chips.push({ t: sig.hunks + " hunks", k: "" });
    return chips.slice(0, 5);
}

/* ------------------------------------------------------------------ *
 * Risk
 * ------------------------------------------------------------------ */

/** none / small / medium / high — words, because the score is a heuristic. */
export function riskBand(score) {
    return score >= 60 ? "high" : score >= 35 ? "medium" : score >= 15 ? "small" : "none";
}

/**
 * Score how likely a file is to break something, with a reason for every point.
 * The reasons are the product; the number only exists to order them.
 */
export function riskFor(file, ctx) {
    const reasons = [];
    let s = 0;
    const add = (pts, why) => {
        s += pts;
        if (why) reasons.push(why);
    };

    const role = roleOf(file.path);
    const fanIn = ctx.fanIn(file.path);
    const removed = ctx.signals.get(file.path)?.removedDecls ?? [];
    const churn = (file.additions || 0) + (file.deletions || 0);

    if (file.status === "D") add(18, "the whole file is removed");
    if (file.status === "R") add(8, "moved — imports pointing here have to change");
    if (file.binary) add(6, "binary — there is no diff to review");

    if (churn >= 40) add(Math.min(20, Math.sqrt(churn) * 2), `large change (${churn} lines)`);
    else add(Math.sqrt(churn) * 2);

    if (file.deletions >= 20)
        add(Math.min(12, Math.sqrt(file.deletions) * 1.6), `deletes ${file.deletions} lines`);
    else if (file.deletions) add(Math.sqrt(file.deletions) * 1.6);

    if (removed.length) add(Math.min(24, 12 * removed.length), `removes ${listPhrase(removed)}`);

    if (fanIn)
        add(
            Math.min(18, 6 * fanIn),
            `${fanIn} changed file${fanIn === 1 ? "" : "s"} depend${fanIn === 1 ? "s" : ""} on it`,
        );

    if (isManifest(file.path)) add(12, "changes the dependency manifest");
    else if (isCI(file.path)) add(10, "changes CI or deployment config");

    const reviewable = role !== "docs" && role !== "asset" && role !== "test";
    if (reviewable && file.status !== "D" && !ctx.coveredByTest(file.path))
        add(12, "no test in this change covers it");

    const score = Math.max(0, Math.min(100, Math.round(s)));
    return { score, band: riskBand(score), reasons };
}

/** Attach `risk` to every file, in place. */
export function scoreRisk(files, signals) {
    const inbound = new Map(files.map((f) => [f.path, []]));
    for (const f of files) {
        for (const l of f.links ?? []) {
            if (l.kind === "del") continue;
            inbound.get(l.to)?.push(f.path);
        }
    }
    const ctx = {
        signals,
        fanIn: (p) => (inbound.get(p) ?? []).length,
        coveredByTest: (p) => (inbound.get(p) ?? []).some((from) => roleOf(from) === "test"),
    };
    for (const f of files) f.risk = riskFor(f, ctx);
}

/** Change-wide risk: the worst file, nudged up by each other notable one. */
export function overallRisk(files) {
    if (!files.length) return { score: 0, band: "none", reasons: [], alsoNotable: 0 };
    const sorted = files.slice().sort((a, b) => (b.risk?.score ?? 0) - (a.risk?.score ?? 0));
    const top = sorted[0];
    const alsoNotable = sorted.filter((f, i) => i > 0 && (f.risk?.score ?? 0) >= 35).length;
    const score = Math.min(100, (top.risk?.score ?? 0) + Math.min(15, 3 * alsoNotable));
    return {
        score,
        band: riskBand(score),
        topPath: top.path,
        reasons: top.risk?.reasons ?? [],
        alsoNotable,
    };
}
