#!/usr/bin/env bash
# Seed the Redis test container with one key of every type + a TTL key.
# Run after `docker compose up -d`. Redis has no auto-init dir, so this is manual.
set -euo pipefail
R() { docker exec -i bt-redis redis-cli -a bytetable -n 0 "$@" >/dev/null; }

R SET   user:1:name "Ada Lovelace"
R SET   config:json '{"theme":"dark","lang":"en"}'
R HSET  user:1 name Ada email ada@byteshop.io age 36
R RPUSH queue:emails welcome receipt newsletter
R SADD  tags:user:1 vip beta early
R ZADD  leaderboard:sales 100 ada 50 alan 75 grace
R XADD  events:log '*' type login user ada
R SETEX session:abc 3600 tok-xyz

echo "Redis seeded — $(docker exec bt-redis redis-cli -a bytetable -n 0 DBSIZE) keys in db0:"
echo "  string user:1:name · string config:json (JSON) · hash user:1 · list queue:emails"
echo "  set tags:user:1 · zset leaderboard:sales · stream events:log · string session:abc (TTL 3600s)"
