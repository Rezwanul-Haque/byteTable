#!/usr/bin/env bash
# Seed DynamoDB Local with a design-representative dataset (ported from the
# prototype's dynamo-data.js "e-commerce, single-table + a few classic tables"):
#
#   ShopApp   — SINGLE-TABLE DESIGN: PK + SK + GSI1, heterogeneous items
#               (USER profiles, ORDERs sharing a user's partition = item
#               collections, PRODUCTs). On-demand billing.
#   Sessions  — partition-only (sessionId), a `byUser` GSI, PROVISIONED 5/5,
#               and a `ttl` TimeToLive attribute.
#   EventLog  — PK + SK (aggregateId / timestamp) with a `byType` GSI.
#
# This exercises every surface: the dashboard (items/GSIs/billing/size), the
# scan/query tab (PK + sort-key conditions on base table AND a GSI), the item
# editor (S/N/BOOL/M/L attrs), the schema map (item collections + GSI edges),
# and export/import.
#
# Run after `docker compose up -d`. DynamoDB Local has no auto-init dir, so this
# is manual (like seed-redis.sh).
#
# Connect to it in ByteTable: New connection → DynamoDB → Local endpoint →
#   Endpoint URL  http://localhost:8000
#   Region        eu-central-1   (label only)
# Any access keys work (DynamoDB Local ignores them in -sharedDb mode).
set -euo pipefail

REGION="eu-central-1"
CONTAINER="${BT_DYNAMO_CONTAINER:-bt-dynamo}"

# DDB <args...> — run an aws dynamodb command against the local endpoint with
# dummy credentials. Prefers a host `aws` CLI (talks to the published port); if
# absent, falls back to the amazon/aws-cli image SHARING the dynamodb-local
# container's network namespace, so `localhost:8000` reaches it cross-platform
# (no host networking needed).
if command -v aws >/dev/null 2>&1; then
  DDB() {
    AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local AWS_PAGER="" \
      aws dynamodb --region "$REGION" --endpoint-url "http://localhost:8000" "$@"
  }
else
  echo "Host 'aws' CLI not found — using the amazon/aws-cli container."
  DDB() {
    docker run --rm --network "container:${CONTAINER}" \
      -e AWS_ACCESS_KEY_ID=local -e AWS_SECRET_ACCESS_KEY=local -e AWS_PAGER="" \
      amazon/aws-cli dynamodb --region "$REGION" --endpoint-url "http://localhost:8000" "$@"
  }
fi

# Wait for the endpoint to accept requests (the JVM takes a moment after `up`).
echo "Waiting for DynamoDB Local…"
for _ in $(seq 1 30); do
  if DDB list-tables >/dev/null 2>&1; then break; fi
  sleep 1
done

# Idempotent: drop the tables we manage so a re-run is clean (like FLUSHDB).
for t in ShopApp Sessions EventLog; do
  DDB delete-table --table-name "$t" >/dev/null 2>&1 || true
done

# ---------------- ShopApp — single-table design (PK + SK + GSI1) ----------------
echo "Creating ShopApp (single-table design: PK + SK + GSI1)…"
DDB create-table \
  --table-name ShopApp \
  --attribute-definitions \
    AttributeName=PK,AttributeType=S \
    AttributeName=SK,AttributeType=S \
    AttributeName=GSI1PK,AttributeType=S \
    AttributeName=GSI1SK,AttributeType=S \
  --key-schema AttributeName=PK,KeyType=HASH AttributeName=SK,KeyType=RANGE \
  --global-secondary-indexes \
    'IndexName=GSI1,KeySchema=[{AttributeName=GSI1PK,KeyType=HASH},{AttributeName=GSI1SK,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
  --billing-mode PAY_PER_REQUEST >/dev/null

PUT() { DDB put-item --table-name "$1" --item "$2" >/dev/null; }

# Users (PROFILE items) — GSI1PK=USER, GSI1SK=email.
names=("Ada Okafor" "Linus Tanaka" "Grace Müller" "Alan Silva" "Edsger Novak" \
  "Barbara Haugen" "Donald Costa" "Margaret Iqbal")
countries=("DE" "US" "JP" "BR" "NO" "PL" "FR" "DE")
statuses=("PENDING" "PAID" "SHIPPED" "DELIVERED" "CANCELLED")
ship=("standard" "express")

n=0
for name in "${names[@]}"; do
  uid="U-$((1001 + n))"
  email="$(echo "$name" | tr '[:upper:]' '[:lower:]' | tr -c 'a-z' '.' | sed 's/\.\{2,\}/./g;s/^\.//;s/\.$//')@proton.me"
  country="${countries[$n]}"
  active=$([ $((n % 5)) -ne 0 ] && echo true || echo false)
  created="202$((4 + n % 2))-0$((1 + n % 9))-1${n}T09:14:00Z"
  PUT ShopApp "{\"PK\":{\"S\":\"USER#$uid\"},\"SK\":{\"S\":\"PROFILE\"},\"entity\":{\"S\":\"USER\"},\"userId\":{\"S\":\"$uid\"},\"name\":{\"S\":\"$name\"},\"email\":{\"S\":\"$email\"},\"country\":{\"S\":\"$country\"},\"isActive\":{\"BOOL\":$active},\"createdAt\":{\"S\":\"$created\"},\"GSI1PK\":{\"S\":\"USER\"},\"GSI1SK\":{\"S\":\"$email\"}}"

  # 1–2 ORDERs per user, sharing the user's partition (item collection).
  norders=$((1 + n % 2))
  for o in $(seq 1 "$norders"); do
    oid="O-$((40000 + n * 37 + o * 11))"
    status="${statuses[$(((n + o) % 5))]}"
    total="$(((n + 1) * 50 + o * 23)).50"
    items=$((1 + (n + o) % 4))
    method="${ship[$((o % 2))]}"
    created="2026-0$((1 + (n + o) % 9))-1${o}T11:0${o}:00Z"
    PUT ShopApp "{\"PK\":{\"S\":\"USER#$uid\"},\"SK\":{\"S\":\"ORDER#$oid\"},\"entity\":{\"S\":\"ORDER\"},\"orderId\":{\"S\":\"$oid\"},\"userId\":{\"S\":\"$uid\"},\"status\":{\"S\":\"$status\"},\"total\":{\"N\":\"$total\"},\"currency\":{\"S\":\"EUR\"},\"items\":{\"N\":\"$items\"},\"createdAt\":{\"S\":\"$created\"},\"shipping\":{\"M\":{\"method\":{\"S\":\"$method\"},\"country\":{\"S\":\"$country\"}}},\"GSI1PK\":{\"S\":\"ORDER#$status\"},\"GSI1SK\":{\"S\":\"$oid\"}}"
  done
  n=$((n + 1))
done

# Products (PRODUCT items) — GSI1PK=CATEGORY#<cat>, GSI1SK=name, with L + N attrs.
# sku|name|category|price|stock|tag
products=(
  "P-1001|Mechanical Keyboard MK-87|peripherals|129.00|212|bestseller"
  "P-1004|4K Monitor 27\"|displays|379.00|34|new"
  "P-1011|Noise-Cancelling Headset|audio|249.00|0|sale"
  "P-1014|NVMe SSD 2TB|storage|164.99|188|bestseller"
  "P-1019|Ergonomic Chair E-200|furniture|459.00|12|new"
  "P-1020|Standing Desk 140cm|furniture|629.00|7|sale"
)
for p in "${products[@]}"; do
  IFS='|' read -r sku pname cat price stock tag <<<"$p"
  # JSON-escape any double quotes in the name (e.g. `27"`).
  pname="${pname//\"/\\\"}"
  PUT ShopApp "{\"PK\":{\"S\":\"PRODUCT#$sku\"},\"SK\":{\"S\":\"META\"},\"entity\":{\"S\":\"PRODUCT\"},\"sku\":{\"S\":\"$sku\"},\"name\":{\"S\":\"$pname\"},\"category\":{\"S\":\"$cat\"},\"price\":{\"N\":\"$price\"},\"stock\":{\"N\":\"$stock\"},\"tags\":{\"L\":[{\"S\":\"$cat\"},{\"S\":\"$tag\"}]},\"GSI1PK\":{\"S\":\"CATEGORY#$cat\"},\"GSI1SK\":{\"S\":\"$pname\"}}"
done

# ---------------- Sessions — partition-only + byUser GSI + TTL ----------------
echo "Creating Sessions (partition-only, byUser GSI, TTL)…"
DDB create-table \
  --table-name Sessions \
  --attribute-definitions \
    AttributeName=sessionId,AttributeType=S \
    AttributeName=userId,AttributeType=S \
  --key-schema AttributeName=sessionId,KeyType=HASH \
  --global-secondary-indexes \
    'IndexName=byUser,KeySchema=[{AttributeName=userId,KeyType=HASH}],Projection={ProjectionType=KEYS_ONLY},ProvisionedThroughput={ReadCapacityUnits=5,WriteCapacityUnits=5}' \
  --billing-mode PROVISIONED \
  --provisioned-throughput ReadCapacityUnits=5,WriteCapacityUnits=5 >/dev/null
# Enable TTL on the `ttl` attribute (best effort — some local builds lag).
DDB update-time-to-live --table-name Sessions \
  --time-to-live-specification "Enabled=true,AttributeName=ttl" >/dev/null 2>&1 || true

now=$(date +%s)
devices=("desktop" "mobile" "tablet")
for i in $(seq 0 9); do
  sid="s_$(printf '%010x' $(((0x9e3779b1 * (i + 1)) & 0xffffffffff)))"
  uid="U-$((1001 + i % 8))"
  ip="$((1 + i)).$((10 + i)).$((20 + i)).$((30 + i))"
  dev="${devices[$((i % 3))]}"
  ttl=$((now + (i - 3) * 3600))
  PUT Sessions "{\"sessionId\":{\"S\":\"$sid\"},\"userId\":{\"S\":\"$uid\"},\"ip\":{\"S\":\"$ip\"},\"device\":{\"S\":\"$dev\"},\"createdAt\":{\"S\":\"2026-03-1${i}T08:00:00Z\"},\"ttl\":{\"N\":\"$ttl\"}}"
done

# ---------------- EventLog — PK + SK + byType GSI ----------------
echo "Creating EventLog (PK + SK, byType GSI)…"
DDB create-table \
  --table-name EventLog \
  --attribute-definitions \
    AttributeName=aggregateId,AttributeType=S \
    AttributeName=timestamp,AttributeType=S \
    AttributeName=eventType,AttributeType=S \
  --key-schema AttributeName=aggregateId,KeyType=HASH AttributeName=timestamp,KeyType=RANGE \
  --global-secondary-indexes \
    'IndexName=byType,KeySchema=[{AttributeName=eventType,KeyType=HASH},{AttributeName=timestamp,KeyType=RANGE}],Projection={ProjectionType=ALL}' \
  --billing-mode PAY_PER_REQUEST >/dev/null

events=("cart.add" "cart.remove" "checkout.start" "order.placed" "payment.ok" "login" "logout")
sources=("web" "ios" "android" "api")
for i in $(seq 0 11); do
  agg="U-$((1001 + i % 8))"
  ts="2026-04-$(printf '%02d' $((1 + i)))T1$((i % 9)):30:00Z"
  et="${events[$((i % 7))]}"
  src="${sources[$((i % 4))]}"
  ok=$([ $((i % 10)) -ne 0 ] && echo true || echo false)
  PUT EventLog "{\"aggregateId\":{\"S\":\"$agg\"},\"timestamp\":{\"S\":\"$ts\"},\"eventType\":{\"S\":\"$et\"},\"source\":{\"S\":\"$src\"},\"payload\":{\"M\":{\"v\":{\"N\":\"$((1 + i % 5))\"},\"ok\":{\"BOOL\":$ok}}}}"
done

echo "DynamoDB seeded:"
for t in ShopApp Sessions EventLog; do
  count=$(DDB scan --table-name "$t" --select COUNT --query 'Count' --output text 2>/dev/null || echo "?")
  echo "  $t: $count items"
done
echo "Single-table design: ShopApp (PK/SK + GSI1) with USER / ORDER / PRODUCT items."
