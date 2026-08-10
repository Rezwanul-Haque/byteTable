// The HTTP console's forgiving command parser (M30 Task 8), ported from the
// prototype's `runHttp` front half.
//
// The console's job is to make the API reachable without ceremony, so the parser
// accepts everything a person plausibly types or pastes:
//
//   /collections
//   GET /collections/products
//   get collections/products                       (method lowercase, no slash)
//   'http://localhost:8108/collections'            (quoted, full URL)
//   curl -H 'X-TYPESENSE-API-KEY: xyz' 'http://…/collections/products'
//   curl -X POST …/documents?action=upsert -d '{"id":"p_1"}'
//   POST /collections/products/documents {"id":"p_1","name":"Kestrel"}
//
// Any `-H` in a pasted curl is DROPPED, including the key: the connection's own
// key is attached by the backend. That is what lets a curl copied out of the
// playground's request panel — which carries a `${TYPESENSE_API_KEY}`
// placeholder — run here unchanged.

import type { HttpConsoleRequest } from "./api";

const METHODS = ["GET", "POST", "PATCH", "PUT", "DELETE"];

/** Routes listed by `HELP` and by the parse-failure message. */
export const KNOWN_ROUTES = [
  "/health",
  "/debug",
  "/stats.json",
  "/keys",
  "/aliases",
  "/collections",
  "/collections/{name}",
  "/collections/{name}/documents",
  "/collections/{name}/documents/{id}",
  "/collections/{name}/documents/search?q=&query_by=",
  "/collections/{name}/synonyms",
  "/collections/{name}/overrides",
];

export type ParseResult =
  | { ok: true; request: HttpConsoleRequest }
  | { ok: false; message: string };

/**
 * Parse one console line. Never throws; an unreadable line comes back as a
 * client error that quotes the input and shows working examples, rather than a
 * bare "usage" wall (Task 8).
 */
export function parseConsoleCommand(raw: string, collection: string): ParseResult {
  let s = raw.trim();
  if (!s) return { ok: false, message: "Nothing to run." };

  // `curl` prefix, if pasted.
  s = s.replace(/^curl\s+/i, "");

  let method: string | null = null;
  let body: string | null = null;

  // Drop headers (the backend supplies the API key) and the common noise flags.
  s = s
    .replace(/-H\s+(['"]).*?\1/g, " ")
    .replace(/-H\s+\S+/g, " ")
    .replace(/\s--?(?:silent|s|location|L|compressed|insecure|k)\b/g, " ");

  const methodFlag = s.match(/-X\s+([A-Za-z]+)/);
  if (methodFlag) {
    method = methodFlag[1]!.toUpperCase();
    s = s.replace(methodFlag[0], " ");
  }

  // `-d '<json>'` / `--data '<json>'`, quoted or bare.
  const dataFlag = s.match(/(?:-d|--data(?:-raw|-binary)?)\s+(['"])([\s\S]*?)\1/);
  if (dataFlag) {
    body = dataFlag[2]!;
    s = s.replace(dataFlag[0], " ");
  } else {
    const bareData = s.match(/(?:-d|--data(?:-raw|-binary)?)\s+(\S+)/);
    if (bareData) {
      body = bareData[1]!;
      s = s.replace(bareData[0], " ");
    }
  }

  s = s
    .trim()
    .replace(/\\\s*$/, "")
    .trim();

  // A leading verb.
  const leadingMethod = s.match(new RegExp("^(" + METHODS.join("|") + ")\\b\\s*", "i"));
  if (leadingMethod) {
    method = method ?? leadingMethod[1]!.toUpperCase();
    s = s.slice(leadingMethod[0].length).trim();
  }

  // The first remaining word is the target; anything after it that looks like
  // JSON is the body (the `POST /path {json}` form).
  const words = s.split(/\s+/).filter(Boolean);
  let target = words.shift() ?? "";
  if (words.length && !body) {
    const rest = words.join(" ").trim();
    if (rest.startsWith("{") || rest.startsWith("[")) body = rest;
  }

  // Strip quotes, then the scheme+host of a full URL.
  target = target.replace(/^['"]|['"]$/g, "").replace(/^https?:\/\/[^/]+/i, "");
  if (target && !target.startsWith("/")) target = "/" + target;

  if (!target || target === "/") {
    return {
      ok: false,
      message:
        "Could not read a path from: " +
        raw.trim() +
        "\n\nUsage: [METHOD] /path [json]  —  the method is optional (GET is assumed), and a " +
        "pasted curl command works too.\n\nTry:\n  /health\n  GET /collections\n  /collections/" +
        (collection || "products") +
        "\n  /collections/" +
        (collection || "products") +
        "/documents/search?q=keyboard&query_by=name",
    };
  }

  return {
    ok: true,
    request: { method: method ?? "GET", path: target, body: body ?? undefined },
  };
}

/** The `HELP` text — the routes plus the one rule people trip on. */
export function helpText(collection: string): string {
  const name = collection || "products";
  return (
    "The method is optional (GET is assumed) and a pasted curl command works too — " +
    "any -H you paste is dropped, since this connection's API key is attached for you.\n\n" +
    KNOWN_ROUTES.map((r) => "  " + r.replace("{name}", name)).join("\n") +
    "\n\n  CLEAR — empty this session · ↑/↓ — walk history"
  );
}
