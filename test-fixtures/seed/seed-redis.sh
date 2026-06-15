#!/usr/bin/env bash
# Seed the Redis test container with a rich, design-representative keyspace
# (ported from the prototype's redis-data.js "e-commerce cache layer"):
#   db0 — application cache  (products, leaderboards, sets, flags, stats, a stream)
#   db1 — sessions & carts   (session hashes with TTL, cart hashes)
#   db2 — queues             (JSON lists, a heartbeat string)
# Every Redis type is represented (string/hash/list/set/zset/stream) plus TTL
# and JSON-string keys, so the key viewer can be exercised end-to-end.
#
# Run after `docker compose up -d`. Redis has no auto-init dir, so this is manual.
set -euo pipefail

# R <db> <args...> — run a redis-cli command against the given logical db.
R() {
  local db="$1"
  shift
  docker exec -i bt-redis redis-cli --no-auth-warning -a bytetable -n "$db" "$@" >/dev/null
}

# Wipe the dbs we manage so re-runs are clean.
for db in 0 1 2; do R "$db" FLUSHDB; done

# ---------------- db0 — application cache ----------------
# products: id|name|category|price
products=(
  "1|Mechanical Keyboard MK-87|peripherals|129.00"
  "4|4K Monitor 27\"|displays|379.00"
  "11|Noise-Cancelling Headset|audio|249.00"
  "14|NVMe SSD 2TB|storage|164.99"
  "19|Ergonomic Chair E-200|furniture|459.00"
  "20|Standing Desk 140cm|furniture|629.00"
  "17|Raspberry Pi 5 8GB|sbc|84.00"
  "5|Ultrawide Monitor 34\"|displays|549.00"
)
views=(98000 41000 23700 30500 8800 6400 51200 12900)
stock=(212 34 0 188 12 7 240 56)
i=0
for p in "${products[@]}"; do
  IFS='|' read -r id name cat price <<<"$p"
  R 0 HSET "product:$id" id "$id" name "$name" category "$cat" price "$price" stock "${stock[$i]}" currency EUR
  R 0 EXPIRE "product:$id" $((600 + i * 137))
  R 0 SET "product:$id:views" "${views[$i]}"
  i=$((i + 1))
done

# leaderboards (zset)
R 0 ZADD leaderboard:sales 612 product:1 540 product:4 503 product:11 488 product:14 \
  366 product:5 281 product:17 122 product:19 84 product:20
R 0 ZADD leaderboard:spenders 6401.50 user:3 4820.00 user:7 3990.75 user:1 3120.20 user:5 \
  2410.00 user:2 1980.40 user:8 940.10 user:4 612.00 user:6

# sets
R 0 SADD online_users user:1 user:3 user:5 user:7 user:9 user:12 user:18 user:24 user:31 user:6 user:22
R 0 SADD tags:popular ergonomic wireless usb-c 4k mechanical rgb silent

# feature flags (hash)
R 0 HSET feature_flags new_checkout true dark_mode true recommendations_v2 false \
  express_ship true loyalty_beta false

# rate limits (string + short TTL)
for ipc in "203.0.113.42|37" "198.51.100.7|12" "203.0.113.91|58"; do
  IFS='|' read -r ip n <<<"$ipc"
  R 0 SET "ratelimit:$ip" "$n"
  R 0 EXPIRE "ratelimit:$ip" 58
done

# daily stats (string + TTL) + a JSON-string key
R 0 SET stats:orders:today 248
R 0 EXPIRE stats:orders:today 43200
R 0 SET stats:revenue:today 52840
R 0 EXPIRE stats:revenue:today 43200
R 0 SET config:json '{"theme":"dark","lang":"en","page_size":50}'

# orders stream
for ev in "created|7|119.00" "paid|7|119.00" "created|12|379.00" "shipped|3|249.00" \
  "paid|12|379.00" "created|22|84.00" "paid|22|84.00" "shipped|7|119.00"; do
  IFS='|' read -r type oid amount <<<"$ev"
  R 0 XADD events:orders '*' type "$type" order_id "$oid" amount "$amount"
done

# ---------------- db1 — sessions & carts ----------------
names=("Ada Okafor" "Linus Tanaka" "Grace Müller" "Alan Silva" "Edsger Novak" \
  "Barbara Haugen" "Donald Costa" "Margaret Iqbal" "Dennis Mbeki" "Radia Larsen" \
  "Ken Petrov" "Frances Garcia" "Bjarne Schmidt" "Anita Rossi")
uas=("Firefox/127" "Chrome/126" "Safari/17.5" "Edge/126")
n=0
for name in "${names[@]}"; do
  tok=$(printf '%016x' $(((0x9e3779b1 * (n + 1)) & 0xffffffffffffffff)))
  uid=$((n * 2 + 1))
  R 1 HSET "session:$tok" user_id "$uid" name "$name" ip "203.0.113.$((20 + n))" \
    ua "${uas[$((n % 4))]}" cart_items $((n % 5)) csrf "$(printf '%08x' $(((0x1000193 * (n + 3)) & 0xffffffff)))"
  R 1 EXPIRE "session:$tok" $((1800 + n * 600))
  if ((n % 2 == 0)); then
    R 1 HSET "cart:user:$uid" "product:$((1 + n % 20))" $((1 + n % 4)) "product:$((4 + n % 8))" 1
    R 1 EXPIRE "cart:user:$uid" $((3600 + n * 1200))
  fi
  n=$((n + 1))
done

# ---------------- db2 — queues ----------------
R 2 RPUSH queue:emails \
  '{"to":"ada@example.com","tpl":"order_confirm"}' \
  '{"to":"linus@example.com","tpl":"ship_notice"}' \
  '{"to":"grace@example.com","tpl":"receipt"}' \
  '{"to":"alan@example.com","tpl":"password_reset"}' \
  '{"to":"edsger@example.com","tpl":"order_confirm"}'
R 2 RPUSH queue:webhooks \
  '{"url":"https://hooks.partner.io/3920","event":"order.paid"}' \
  '{"url":"https://hooks.partner.io/7714","event":"order.shipped"}' \
  '{"url":"https://hooks.partner.io/5183","event":"order.paid"}'
R 2 RPUSH queue:emails:dead \
  '{"to":"bounce@example.com","tpl":"receipt","error":"SMTP 550"}'
R 2 SET worker:heartbeat "$(date +%s000)"
R 2 EXPIRE worker:heartbeat 30

echo "Redis seeded:"
for db in 0 1 2; do
  size=$(docker exec bt-redis redis-cli --no-auth-warning -a bytetable -n "$db" DBSIZE)
  echo "  db$db: $size keys"
done
echo "Types: string · hash · list · set · zset · stream (+ TTL + JSON-string keys)"
