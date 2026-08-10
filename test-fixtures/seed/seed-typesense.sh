#!/usr/bin/env bash
# Seed the Typesense test container with a design-representative search cluster
# (ported from the prototype's typesense-data.js "ByteShop" dataset):
#
#   products  - 28 docs, the collection the playground demos against.
#   articles  - 12 docs with a `body` snippet field, so highlighting and the
#               title/snippet split are exercised.
#   users     - 16 docs, a third collection for the sidebar.
#
# Plus the things that make the workspace's harder states reachable:
#   - a SYNONYM set (so the x-ray can label a `synonym` match),
#   - a CURATION rule with a pin AND a hide (so the `N hidden` chip and the
#     `curated` badge both appear),
#   - an ALIAS,
#   - a SEARCH-ONLY API key, so key-scope degradation can be tested for real.
#
# The documents and schemas are static files in `seed/typesense/` rather than
# generated here on purpose: macOS ships **bash 3.2**, which has no associative
# arrays, so generating this data in-script was neither portable nor reviewable.
# Static fixtures also match how the other engines seed (cassandra.cql, mongo.js).
#
# PORTABILITY: keep this script bash-3.2-clean — no `declare -A`, no `${x^^}`,
# no `mapfile`. Also never write a multibyte character (an ellipsis, an arrow)
# directly after a variable reference: bash 3.2 folds the following bytes into
# the variable NAME, which under `set -u` fails with a baffling
# "unbound variable" naming a mangled identifier.
#
# Typesense has no auto-init dir, so this is run manually after `up`.
set -euo pipefail

HOST="${BT_TYPESENSE_URL:-http://localhost:8108}"
KEY="${BT_TYPESENSE_KEY:-bytetable}" # admin key
DIR="$(cd "$(dirname "$0")" && pwd)/typesense"

# Typesense v30 moved synonyms/curation to top-level resources. This fixture
# pins v29, so the per-collection endpoints are correct here; the adapter speaks
# both dialects and picks by the version it probes.
api() {
  method="$1"
  path="$2"
  shift 2
  curl -sS -X "$method" "${HOST}${path}" -H "X-TYPESENSE-API-KEY: ${KEY}" "$@"
}

# POST a JSON file to a path, failing loudly if Typesense rejects it.
post_json() {
  path="$1"
  file="$2"
  what="$3"
  response=$(api POST "$path" -H 'Content-Type: application/json' --data-binary "@${file}")
  case "$response" in
  *'"message"'*)
    echo "FAILED to create ${what}: ${response}" >&2
    exit 1
    ;;
  esac
}

echo "waiting for Typesense at ${HOST} ..."
ready=no
i=0
while [ "$i" -lt 60 ]; do
  if curl -sf "${HOST}/health" >/dev/null 2>&1; then
    ready=yes
    break
  fi
  i=$((i + 1))
  sleep 1
done
if [ "$ready" != yes ]; then
  echo "Typesense never became ready at ${HOST} (is the container up?)" >&2
  exit 1
fi

# Wipe so re-runs are clean (a fresh volume has none of these; ignore the 404s).
# Analytics rules are dropped first: a rule pointing at a collection that is
# about to be deleted makes the server log "Collection not found" every flush.
for r in product_queries_agg product_no_hits_agg; do
  api DELETE "/analytics/rules/${r}" >/dev/null 2>&1 || true
done
for c in products articles users product_queries product_no_hits; do
  api DELETE "/collections/${c}" >/dev/null 2>&1 || true
done
api DELETE "/aliases/catalog" >/dev/null 2>&1 || true

echo "creating collections ..."
post_json /collections "${DIR}/products.schema.json" "the products collection"
post_json /collections "${DIR}/articles.schema.json" "the articles collection"
post_json /collections "${DIR}/users.schema.json" "the users collection"

# JSONL import. The response is one JSON object PER LINE (`{"success":true}`),
# so a failure is spotted by grepping for a false rather than by the presence of
# a "message" key.
import_docs() {
  collection="$1"
  file="$2"
  result=$(api POST "/collections/${collection}/documents/import?action=upsert" \
    -H 'Content-Type: text/plain' --data-binary "@${file}")
  failed=$(printf '%s\n' "$result" | grep -c '"success":false' || true)
  total=$(grep -c . "$file" || true)
  if [ "$failed" != "0" ]; then
    echo "FAILED to import ${failed} of ${total} ${collection} documents:" >&2
    printf '%s\n' "$result" | grep '"success":false' | head -3 >&2
    exit 1
  fi
  echo "  ${collection}: ${total} documents"
}

echo "importing documents ..."
import_docs products "${DIR}/products.jsonl"
import_docs articles "${DIR}/articles.jsonl"
import_docs users "${DIR}/users.jsonl"

echo "creating synonyms, curation, alias ..."
# Multi-way: searching any of these finds the others - the x-ray labels the
# resulting match `synonym`, which no prefix/typo explanation would cover.
api PUT /collections/products/synonyms/kbd \
  -H 'Content-Type: application/json' \
  --data-binary "@${DIR}/synonym-kbd.json" >/dev/null

# A pin AND a hide, so both the `curated` badge and the `N hidden` chip appear.
api PUT /collections/products/overrides/promote-kestrel \
  -H 'Content-Type: application/json' \
  --data-binary "@${DIR}/curation-promote-kestrel.json" >/dev/null

api PUT /aliases/catalog \
  -H 'Content-Type: application/json' \
  --data-binary "@${DIR}/alias-catalog.json" >/dev/null

# ---------------------------------------------------------------------------
# Analytics
# ---------------------------------------------------------------------------
# The dashboard's popular / no-hit panel reads REAL analytics: Typesense only
# records queries when the server runs with `--enable-search-analytics` AND a
# rule exists pointing a source collection at a destination collection it writes
# aggregated counts into. Both are set up here, then real traffic is sent so the
# panel has something to show on first open.
echo "configuring analytics ..."
post_json /collections "${DIR}/product_queries.schema.json" "the popular-queries collection"
post_json /collections "${DIR}/product_no_hits.schema.json" "the no-hits collection"

api PUT /analytics/rules/product_queries_agg -H 'Content-Type: application/json' \
  --data-binary "@${DIR}/analytics-popular.json" >/dev/null
api PUT /analytics/rules/product_no_hits_agg -H 'Content-Type: application/json' \
  --data-binary "@${DIR}/analytics-nohits.json" >/dev/null

# Queries are only counted when they carry a user id, and Typesense de-duplicates
# per user - so each repetition uses a distinct one to build a real distribution.
# `usb hub` and `webcam` match nothing, which is what populates the no-hits rule.
search_as() {
  curl -sS -o /dev/null "${HOST}/collections/products/documents/search?q=$1&query_by=name,brand,description" \
    -H "X-TYPESENSE-API-KEY: ${KEY}" -H "x-typesense-user-id: seed-$2"
}
send_traffic() {
  term="$1"
  times="$2"
  n=1
  while [ "$n" -le "$times" ]; do
    search_as "$term" "u${n}"
    n=$((n + 1))
  done
}
send_traffic keyboard 9
send_traffic nvme 6
send_traffic noise%20cancelling 4
send_traffic 4k%20display 3
send_traffic standing%20desk 2
send_traffic keybord 5
send_traffic usb%20hub 3
send_traffic webcam 2

# The server aggregates on `--analytics-flush-interval` (10s in this fixture),
# so wait for one flush and confirm the panel will actually have rows.
echo "waiting for the analytics flush ..."
popular=0
i=0
while [ "$i" -lt 20 ]; do
  popular=$(api GET "/collections/product_queries/documents/search?q=*&query_by=q&per_page=1" |
    sed -n 's/.*"found":\([0-9]*\).*/\1/p')
  popular=${popular:-0}
  if [ "$popular" != "0" ]; then break; fi
  i=$((i + 1))
  sleep 2
done
if [ "$popular" = "0" ]; then
  echo "  WARNING: analytics recorded nothing - the dashboard panel will be empty." >&2
else
  echo "  popular queries recorded: ${popular}"
fi

# A search-only key, so the workspace's "admin key required" degradation can be
# exercised against a real server rather than only reasoned about. Typesense
# returns the full key ONCE, at creation - print it here and nowhere else.
echo "creating a search-only API key ..."
search_key=$(api POST /keys -H 'Content-Type: application/json' \
  --data-binary "@${DIR}/key-search-only.json" |
  sed -n 's/.*"value":"\([^"]*\)".*/\1/p')

echo
echo "Typesense seeded at ${HOST}"
echo "  admin key       : ${KEY}"
echo "  search-only key : ${search_key:-<creation failed>}   (collections: products)"
echo
echo "In the app: Protocol http | Host localhost | Port 8108 | Default collection products | API key ${KEY}"
# Peers cannot be discovered - Typesense has no cluster-membership endpoint, not
# even on the leader - so the dashboard shows one row until it is told the rest.
echo "            Other nodes: localhost:8118, localhost:8128   (else the node table shows one row)"
