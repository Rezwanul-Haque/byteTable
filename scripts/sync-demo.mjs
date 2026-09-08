#!/usr/bin/env node
/*
 * Regenerates `landing/demo/` — the app simulator behind the landing page's
 * "Try Online" button — from the ByteTable design prototype.
 *
 *   node scripts/sync-demo.mjs [path-to-prototype]   (default: ../ByteTable_latest)
 *
 * The prototype is a complete in-browser simulation of ByteTable (React + a
 * mock query engine), so the demo IS the app rather than a hand-drawn replica.
 * Two things have to happen on the way in:
 *
 *  1. EXPERIMENTAL SURFACES ARE REMOVED. The prototype explores features that
 *     the app has not shipped; leaving them in would advertise things you
 *     can't download. Each removal below is justified against the source of
 *     truth in `src/`, and the patch asserts its anchor still matches — if a
 *     newer prototype moves the code, this script fails loudly instead of
 *     silently shipping the experiment.
 *
 *  2. IT IS COMPILED INTO ONE FILE. The prototype is 78 scripts that compile
 *     ~1 MB of JSX in the browser with Babel standalone (a 3 MB dependency and
 *     ~3 s of work). esbuild compiles the JSX here instead, and the modules
 *     are concatenated in the prototype's own load order and minified into a
 *     single `demo.min.js` — so the demo starts instantly, and the repo gains
 *     two generated files instead of eighty.
 *
 *     Concatenation is safe because these are plain scripts that already share
 *     one global scope: `ui.jsx` declares the bare `useState`/`useRef` its
 *     siblings use and every other module aliases its own (`useStateD`,
 *     `useStateS`, …), while cross-module access goes through
 *     `Object.assign(window, …)`. A duplicate top-level name would break that,
 *     so the bundle step checks for one.
 *
 * The output is committed: `landing/` is a standalone GitHub Pages site with
 * no build step. Running this needs the prototype (which is not in the repo)
 * and network access, for esbuild and React.
 */

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ESBUILD = "esbuild@0.25.10";
const REACT_VERSION = "18.3.1";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const src = path.resolve(root, process.argv[2] || "../ByteTable_latest");
const out = path.join(root, "landing", "demo");
const stage = path.join(out, ".stage");

const appVersion = JSON.parse(fs.readFileSync(path.join(root, "package.json"), "utf8")).version;
const srcApp = path.join(src, "bytetable");
if (!fs.existsSync(path.join(src, "ByteTable.html")) || !fs.existsSync(srcApp)) {
  fail(`No prototype at ${src} — pass its path as the first argument.`);
}

/* ---------------------------------------------------------------- helpers */

function fail(msg) {
  console.error("sync-demo: " + msg);
  process.exit(1);
}

/**
 * Anchored replace. `find` must match exactly once — a prototype refresh that
 * moves or rewrites the code fails the sync instead of quietly dropping the
 * patch (or, worse, shipping an experimental feature we meant to remove).
 */
function patch(text, find, replace, label) {
  const parts = text.split(find);
  if (parts.length !== 2) {
    fail(
      `patch "${label}" matched ${parts.length - 1}× (expected 1) — the prototype changed; re-check this edit.`,
    );
  }
  return parts.join(replace);
}

/**
 * React 18 UMD, bundled in so the demo has no CDN dependency at runtime. (The
 * prototype pulls React + Babel from unpkg; the JSX is pre-compiled here, so
 * only React itself is needed.) Cached under node_modules/ — it ends up inside
 * demo.min.js, so there is nothing to commit.
 *
 * Returns the two file paths, in load order.
 */
async function ensureVendor() {
  const dir = path.join(root, "node_modules", ".cache", "bytetable-demo");
  const names = ["react.production.min.js", "react-dom.production.min.js"];
  fs.mkdirSync(dir, { recursive: true });
  const paths = [];
  for (const name of names) {
    const pkg = name.startsWith("react-dom") ? "react-dom" : "react";
    const url = `https://unpkg.com/${pkg}@${REACT_VERSION}/umd/${name}`;
    const at = path.join(dir, `${REACT_VERSION}-${name}`);
    paths.push(at);
    if (fs.existsSync(at)) continue;
    let res;
    try {
      res = await fetch(url);
    } catch {
      fail(`could not download ${name} — save ${url} as ${at}.`);
    }
    if (!res.ok) fail(`could not download ${name} (HTTP ${res.status}).`);
    fs.writeFileSync(at, Buffer.from(await res.arrayBuffer()));
    console.log("sync-demo: fetched " + name);
  }
  return paths;
}

/* ------------------------------------------------------- what we leave out */

/*
 * Prototype-only, checked against the app:
 *   vqb.jsx / vqb-core.js  — the Visual Query Builder. `Tab` in
 *     src/features/workspaces/types.ts has no "vqb" kind.
 *   neo4j-*                — `Engine` in src/shared/types.ts has no "neo4j",
 *                            and src/features/browse has no neo4j workspace.
 *   tweaks-panel.jsx       — the design-tool overlay ("omelette starter
 *                            scaffold"), never part of the product.
 *   ddb-item-redesign.jsx  — a standalone redesign study; not loaded by the
 *                            prototype's own page either.
 * Oracle is dropped too (also absent from `Engine`), but it has no module of
 * its own — it goes away with its connections and its engine-picker tile.
 */
const DROP = new Set([
  // A 300 KB stylesheet dump the prototype's page never links.
  "sim-bytetable.css",
  "tweaks-panel.jsx",
  "vqb.jsx",
  "vqb-core.js",
  "neo4j-data.js",
  "neo4j-engine.js",
  "neo4j.jsx",
  "neo4j-graph.jsx",
  "neo4j-shell.jsx",
  "ddb-item-redesign.jsx",
]);

/* ------------------------------------------------- per-file source patches */

const PATCHES = {
  // ---- root component ---------------------------------------------------
  "app.jsx": (t) => {
    // Boot straight into the seeded workspaces instead of the connect screen.
    t = patch(
      t,
      `  const [workspaces, setWorkspaces] = useState([]);
  const [activeWsId, setActiveWsId] = useState(null);
  const [adding, setAdding] = useState(true);`,
      `  // DEMO: open with the sample connections already connected (BT_DEMO), so
  // the page lands in a workspace instead of on the connect screen.
  const [workspaces, setWorkspaces] = useState(() => BT_DEMO.workspaces());
  const [activeWsId, setActiveWsId] = useState(() => BT_DEMO.workspaces()[0].id);
  const [adding, setAdding] = useState(false);`,
      "app: seed workspaces",
    );

    // Keep the color cycle in step with the seeded tiles.
    t = patch(
      t,
      "const colorIdx = useRef(0);",
      "const colorIdx = useRef(BT_DEMO.workspaces().length);",
      "app: color index",
    );

    // No update prompt over a web demo — there is nothing to install into.
    t = patch(
      t,
      `  useEffect(() => {
    window.BT_UPDATE.check().then((info) => {`,
      `  useEffect(() => {
    if (BT_DEMO.isDemo) return; // DEMO: nothing to update in the browser
    window.BT_UPDATE.check().then((info) => {`,
      "app: skip update check",
    );

    // Neo4j is not a shipped engine.
    t = patch(t, ` : conn.engine === 'neo4j' ? 'neo4j'`, "", "app: neo4j workspace kind");
    t = patch(
      t,
      `            ) : ws.kind === 'neo4j' ? (
              <Neo4jWorkspace
                workspace={ws}
                isActive={!showConnect && ws.id === activeWsId}
                onCloseWorkspace={() => closeWorkspace(ws.id)}
                toast={toast}
              />
`,
      "",
      "app: neo4j workspace branch",
    );

    // The tweaks panel is a design tool, not a product surface.
    const tweaksAt = t.indexOf("      <TweaksPanel>");
    const tweaksEnd = t.indexOf("      </TweaksPanel>");
    if (tweaksAt === -1 || tweaksEnd === -1)
      fail('patch "app: tweaks panel" found no <TweaksPanel> block.');
    t = t.slice(0, tweaksAt) + t.slice(tweaksEnd + "      </TweaksPanel>\n".length);

    return t;
  },

  // ---- SQL workspace ----------------------------------------------------
  "workspace.jsx": (t) => {
    t = patch(t, `, vqb: 'account_tree'`, "", "workspace: vqb tab icon");
    t = patch(
      t,
      "function TabBar({ tabs, activeId, onSelect, onClose, onNewSql, onNewVqb, onToggleTerminal, termOpen }) {",
      "function TabBar({ tabs, activeId, onSelect, onClose, onNewSql, onToggleTerminal, termOpen }) {",
      "workspace: TabBar signature",
    );
    t = patch(
      t,
      `      <button className="tab-new" onClick={onNewVqb} title="New visual query">
        <MIcon name="account_tree" size={16} />
      </button>
`,
      "",
      "workspace: vqb tab-bar button",
    );
    t = patch(
      t,
      `  const vqbCounter = useRef(1);
  const openVqb = () => {
    const n = vqbCounter.current++;
    const tab = { id: 'tab-vqb-' + Date.now(), kind: 'vqb', schemaName, title: 'Visual query ' + n };
    setTabs((ts) => [...ts, tab]);
    setActiveId(tab.id);
  };

`,
      "",
      "workspace: openVqb",
    );
    t = patch(t, " onNewVqb={openVqb}", "", "workspace: TabBar vqb prop");
    t = patch(
      t,
      `              ) : t.kind === 'vqb' ? (
                <VqbTab tab={t} isActive={t.id === activeId} schemaName={t.schemaName} onUpdateTab={(p) => updateTab(t.id, p)} onOpenSql={openSql} toast={toast} />
`,
      "",
      "workspace: vqb tab body",
    );
    return t;
  },

  // ---- engine registry --------------------------------------------------
  "ui.jsx": (t) => {
    t = patch(
      t,
      `  oracle: { label: 'Oracle', short: 'Or', color: '#c74634' },\n`,
      "",
      "ui: oracle badge",
    );
    t = patch(
      t,
      `  neo4j: { label: 'Neo4j', short: 'N4', color: '#018bff' },\n`,
      "",
      "ui: neo4j badge",
    );
    return t;
  },

  // ---- sample connections ----------------------------------------------
  "data.js": (t) => {
    // Oracle isn't a shipped engine — drop both saved connections.
    for (const id of ["prod-oracle", "dev-oracle"]) {
      const at = t.indexOf(`      id: '${id}'`);
      if (at === -1) fail(`patch "data: ${id}" found no connection.`);
      const start = t.lastIndexOf("    {", at);
      const end = t.indexOf("    },\n", at) + "    },\n".length;
      t = t.slice(0, start) + t.slice(end);
    }
    return t;
  },

  // ---- version ----------------------------------------------------------
  // The prototype ships a placeholder version; show the one people would
  // actually download.
  "updater.jsx": (t) =>
    patch(
      t,
      `  const CURRENT = '1.0.0';`,
      `  const CURRENT = '${appVersion}';`,
      "updater: current version",
    ),

  // ---- connect screen ---------------------------------------------------
  "connect.jsx": (t) => {
    // The engine picker renders Object.keys(ENGINE_META), so oracle and neo4j
    // are already gone from it; these are the URL-import affordances that
    // still advertise them.
    t = patch(
      t,
      `  neo4j: ['neo4j', '7687'], 'neo4j+s': ['neo4j', '7687'], bolt: ['neo4j', '7687'], 'bolt+s': ['neo4j', '7687'],\n`,
      "",
      "connect: neo4j url schemes",
    );
    t = patch(t, `, 'neo4j+s': 1, 'bolt+s': 1`, "", "connect: neo4j secure schemes");
    t = patch(
      t,
      `Try postgres, mysql, sqlserver, oracle, clickhouse, redis, mongodb, cassandra, neo4j/bolt or http (Typesense).`,
      `Try postgres, mysql, sqlserver, clickhouse, redis, mongodb, cassandra or http (Typesense).`,
      "connect: scheme error text",
    );
    t = patch(
      t,
      `{['postgres://', 'mysql://', 'sqlserver://', 'oracle://', 'clickhouse://', 'redis://', 'mongodb+srv://', 'cassandra://', 'neo4j+s://', 'http:// (Typesense)', 'jdbc:\\u2026', 'Server=\\u2026;']`,
      `{['postgres://', 'mysql://', 'sqlserver://', 'clickhouse://', 'redis://', 'mongodb+srv://', 'cassandra://', 'http:// (Typesense)', 'jdbc:\\u2026', 'Server=\\u2026;']`,
      "connect: scheme chips",
    );
    // The engines the connect screen advertises — the shipped list.
    t = patch(
      t,
      `SQLite · MySQL · PostgreSQL · SQL Server · Oracle · ClickHouse · Redis · DynamoDB · MongoDB · Cassandra · Neo4j · Typesense — more engines coming.`,
      `SQLite · MySQL · PostgreSQL · SQL Server · ClickHouse · Redis · DynamoDB · MongoDB · Cassandra · Typesense — more engines coming.`,
      "connect: engine list",
    );
    return t;
  },
};

/* --------------------------------------------------------- copy + compile */

fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(stage, { recursive: true });
const vendor = await ensureVendor();

const files = fs.readdirSync(srcApp).filter((f) => !DROP.has(f) && /\.(jsx?|css)$/.test(f));
const jsx = [];
let copied = 0;

for (const f of files) {
  let text = fs.readFileSync(path.join(srcApp, f), "utf8");
  if (PATCHES[f]) text = PATCHES[f](text);

  // The prototype narrates itself as a prototype; this is a product demo.
  text = text
    .split("simulated in this prototype")
    .join("simulated in this demo")
    .split("this is a prototype window")
    .join("this is a browser demo")
    .split(" is not supported in this prototype — only SELECT queries run against the mock engine.")
    .join(" is not supported in this demo — only SELECT queries run against the sample data.");

  fs.writeFileSync(path.join(stage, f), text);
  if (f.endsWith(".jsx")) jsx.push(f);
  copied++;
}

// JSX → JS, left UNWRAPPED so every module shares one global scope — the
// prototype depends on it (`ui.jsx` declares the bare `useState`/`useRef`
// its siblings use, and each other module aliases its own: `useStateD`,
// `useStateS`, …). Wrapping each file would hide those from each other.
//
// Compiled output keeps a `.jsx.js` extension: three modules ship as both
// `x.js` (a plain store) and `x.jsx` (its UI), and a plain `.js` output would
// overwrite the store.
try {
  execFileSync(
    "npx",
    [
      "--yes",
      ESBUILD,
      ...jsx,
      "--loader:.jsx=jsx",
      "--target=es2019",
      "--out-extension:.js=.jsx.js",
      `--outdir=${stage}`,
      "--log-level=warning",
    ],
    { cwd: stage, stdio: ["ignore", "inherit", "inherit"] },
  );
} catch {
  fail(`could not run ${ESBUILD} via npx (network needed on first run).`);
}

/* ----------------------------------------------------------- the page */

let html = fs.readFileSync(path.join(src, "ByteTable.html"), "utf8");

html = patch(
  html,
  "<title>ByteTable — DB Client Prototype</title>",
  '<title>ByteTable — interactive demo</title>\n<meta name="robots" content="noindex" />',
  "html: title",
);
html = patch(
  html,
  '<div class="splash-foot">v1.0.0 · free &amp; open source</div>',
  `<div class="splash-foot">v${appVersion} · free &amp; open source</div>`,
  "html: splash version",
);

// The prototype's own script order is the module graph — there is no other
// dependency manifest, so read it off the page before rewriting it.
const scriptsAt = html.indexOf('<script src="https://unpkg.com/react@');
const scriptsEnd = html.lastIndexOf("</body>");
if (scriptsAt === -1) fail("html: found no script block to rewrite.");

const order = [...html.slice(scriptsAt, scriptsEnd).matchAll(/src="bytetable\/([^"]+)"/g)]
  .map((m) => m[1])
  .filter((f) => !DROP.has(f))
  .map((f) => f.replace(/\.jsx$/, ".jsx.js"));

html = html.slice(0, scriptsAt) + '<script src="demo.min.js"></script>\n' + html.slice(scriptsEnd);
fs.writeFileSync(path.join(out, "index.html"), html);

/* --------------------------------------------------------------- bundle */

/*
 * Sharing one global scope means two modules declaring the same top-level
 * `const`/`let`/`class` collide. Concatenated into one file that is a hard
 * SyntaxError, so name the two culprits here rather than leaving esbuild to
 * report a line number in a 40k-line concatenation.
 */
const seen = new Map();
for (const f of order) {
  for (const m of fs
    .readFileSync(path.join(stage, f), "utf8")
    .matchAll(/^(?:const|let|class)\s+(?:\{([^}]*)\}|([A-Za-z_$][\w$]*))/gm)) {
    const names = m[2] ? [m[2]] : m[1].split(",").map((p) => p.split(":").pop().trim());
    for (const n of names.filter(Boolean)) {
      if (seen.has(n) && seen.get(n) !== f)
        fail(
          `"${n}" is declared at top level in both ${seen.get(n)} and ${f} — they share a scope.`,
        );
      seen.set(n, f);
    }
  }
}

// One file, in load order: the seed first (App reads BT_DEMO on its first
// render), then the modules. Concatenation is safe precisely because these
// are plain scripts sharing one scope — that is how the prototype runs them.
const app = [demoBoot(), ...order.map((f) => fs.readFileSync(path.join(stage, f), "utf8"))].join(
  "\n;\n",
);

let bundle;
try {
  bundle = execFileSync(
    "npx",
    [
      "--yes",
      ESBUILD,
      "--minify",
      "--format=iife",
      "--target=es2019",
      "--loader=js",
      "--log-level=warning",
    ],
    {
      input: app,
      maxBuffer: 64 * 1024 * 1024,
      encoding: "utf8",
    },
  );
} catch {
  fail("esbuild could not minify the bundle (see the error above).");
}

// React ships pre-minified with its license banner — concatenated verbatim so
// the banner survives and we don't re-minify someone else's build.
fs.writeFileSync(
  path.join(out, "demo.min.js"),
  [
    `/* ByteTable interactive demo — generated by scripts/sync-demo.mjs. Do not edit.\n   React ${REACT_VERSION} (MIT) followed by the demo application. */`,
    ...vendor.map((v) => fs.readFileSync(v, "utf8")),
    bundle,
  ].join("\n"),
);

fs.rmSync(stage, { recursive: true, force: true });

/* ------------------------------------------------------------------ boot */

function demoBoot() {
  return `/*
 * The sample connections the simulator opens with: one per engine family the
 * demo covers — MySQL (relational), Redis (key-value), DynamoDB (document)
 * and ClickHouse (columnar). Every other engine the app supports is still
 * reachable from "New connection".
 */
(function () {
  var SEED = [
    { from: 'staging-mysql', kind: 'sql' },
    { from: 'staging-redis', kind: 'redis' },
    { from: 'dynamo', kind: 'dynamodb' },
    { from: 'prod-clickhouse', kind: 'sql' },
  ];

  var cache = null;
  window.BT_DEMO = {
    isDemo: true,
    /** The rail's opening workspaces — built once, then reused. */
    workspaces: function () {
      if (cache) return cache;
      var colors = window.BT_DATA.workspaceColors;
      cache = SEED.map(function (s, i) {
        var conn =
          s.from === 'dynamo'
            ? window.BT_DYNAMO.connection
            : window.BT_DATA.connections.filter(function (c) { return c.id === s.from; })[0];
        if (!conn) throw new Error('demo: no sample connection "' + s.from + '"');
        return { id: 'ws-demo-' + i, conn: conn, name: conn.name, color: colors[i % colors.length], kind: s.kind };
      });
      return cache;
    },
  };
})();
`;
}

const kb = (n) => (n / 1024).toFixed(0) + " KB";
console.log(
  `sync-demo: ${copied} modules (${jsx.length} compiled) → landing/demo/demo.min.js (${kb(fs.statSync(path.join(out, "demo.min.js")).size)})`,
);
console.log("sync-demo: removed " + [...DROP].join(", "));
