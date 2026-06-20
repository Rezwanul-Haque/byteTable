// ByteTable test fixture — MongoDB seed (M18). Auto-run by the mongo:7 image on
// FIRST init of an empty data volume (mounted into /docker-entrypoint-initdb.d).
// Mirrors the prototype's bytetable/mongo-data.js: two databases —
//   byteshop : users / products / orders / reviews   (+ a $jsonSchema validator on products)
//   analytics: events / sessions
// — with real ObjectId/ISODate values and referential integrity (orders.userId →
// users._id, orders.items.productId → products._id, reviews/events/sessions →
// users/products). Indexes match the design. Integer fields that a validator
// checks are wrapped in NumberInt so they are stored as BSON int, not double.
//
// Reproducible: a small seeded PRNG drives the picks, so every fresh `up`
// produces the same data.

/* global db, ObjectId, NumberInt */

function rng(seed) {
  let s = seed >>> 0;
  return function () {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 4294967296;
  };
}
const rand = rng(20260620);
const pick = (a) => a[Math.floor(rand() * a.length)];
const int = (lo, hi) => lo + Math.floor(rand() * (hi - lo + 1));
function daysAgo(d) {
  const t = new Date("2026-06-18T12:00:00Z").getTime() - d * 86400000 - Math.floor(rand() * 86400000);
  return new Date(t);
}

const FIRST = ["Ava", "Liam", "Noah", "Mia", "Zoe", "Kai", "Ivan", "Lena", "Omar", "Sara", "Yuki", "Nina", "Theo", "Ruby", "Finn", "Cleo"];
const LAST = ["Carter", "Singh", "Muller", "Rossi", "Kim", "Lopez", "Novak", "Haque", "Tan", "Costa", "Ahmed", "Ito"];
const COUNTRIES = ["US", "DE", "GB", "IN", "BR", "JP", "FR", "CA", "AU", "NL"];
const CITIES = { US: "Austin", DE: "Berlin", GB: "Leeds", IN: "Pune", BR: "Recife", JP: "Osaka", FR: "Lyon", CA: "Calgary", AU: "Perth", NL: "Utrecht" };
const PRODUCTS = [
  ["Aurora 65 Keyboard", "Keyboards", 129], ["Nimbus Mechanical TKL", "Keyboards", 99], ["Halo Wireless Numpad", "Accessories", 39],
  ["Echo Studio Monitor", "Audio", 219], ["Pulse ANC Earbuds", "Audio", 149], ['Lumen 27" 4K', "Displays", 459],
  ['Lumen 32" Ultrawide', "Displays", 699], ["Vault 2TB NVMe", "Storage", 189], ["Vault 1TB Portable", "Storage", 109],
  ["Grip Desk Mat XL", "Accessories", 29], ["Arc USB-C Hub", "Accessories", 59], ["Flux Charging Stand", "Accessories", 49],
];
const TAGS = ["rgb", "hotswap", "wireless", "usb-c", "low-profile", "noise-cancel", "hdr", "oem", "bestseller", "new"];
const STATUSES = ["paid", "pending", "shipped", "refunded", "cancelled"];
const EV = ["page_view", "add_to_cart", "checkout", "search", "signup", "login"];

// ---- byteshop ----
const users = [];
for (let i = 0; i < 24; i++) {
  const fn = pick(FIRST), ln = pick(LAST), c = pick(COUNTRIES);
  const u = {
    _id: new ObjectId(),
    name: fn + " " + ln,
    email: (fn + "." + ln).toLowerCase().replace(/[^a-z.]/g, "") + i + "@" + pick(["proton.me", "gmail.com", "fastmail.com", "byteshop.io"]),
    country: c,
    roles: rand() < 0.15 ? ["customer", "beta"] : ["customer"],
    address: { city: CITIES[c], zip: String(int(10000, 99999)), country: c },
    newsletter: rand() < 0.6,
    createdAt: daysAgo(int(20, 400)),
  };
  if (rand() < 0.25) u.lastLogin = daysAgo(int(0, 10));
  users.push(u);
}

const products = PRODUCTS.map((p, i) => {
  const doc = {
    _id: new ObjectId(),
    sku: p[1].slice(0, 3).toUpperCase() + "-" + String(1000 + i),
    title: p[0],
    category: p[1],
    price: p[2],
    currency: "USD",
    stock: NumberInt(int(0, 240)),
    tags: Array.from(new Set([pick(TAGS), pick(TAGS)])),
    attributes: { weightG: int(80, 2400), warrantyMonths: pick([12, 24, 36]) },
    active: rand() < 0.9,
  };
  if (p[1] === "Keyboards") doc.attributes.switches = pick(["linear", "tactile", "clicky"]);
  return doc;
});

const orders = [];
for (let i = 0; i < 30; i++) {
  const u = pick(users);
  const nItems = int(1, 3);
  const items = [];
  let total = 0;
  for (let k = 0; k < nItems; k++) {
    const p = pick(products); const qty = int(1, 3);
    items.push({ productId: p._id, sku: p.sku, qty: qty, price: p.price });
    total += p.price * qty;
  }
  const status = pick(STATUSES);
  const o = {
    _id: new ObjectId(),
    userId: u._id,
    items: items,
    total: total,
    currency: "USD",
    status: status,
    shipping: { method: pick(["standard", "express", "pickup"]), city: u.address.city, country: u.country },
    createdAt: daysAgo(int(0, 120)),
  };
  if (status === "shipped" || status === "refunded") o.shippedAt = daysAgo(int(0, 110));
  if (status === "refunded") o.refund = { amount: total, reason: pick(["damaged", "late", "changed-mind"]) };
  orders.push(o);
}

const reviews = [];
for (let i = 0; i < 26; i++) {
  const p = pick(products), u = pick(users);
  reviews.push({
    _id: new ObjectId(),
    productId: p._id,
    userId: u._id,
    rating: int(1, 5),
    title: pick(["Love it", "Solid", "Meh", "Exceeded expectations", "Would buy again", "Not for me"]),
    body: pick(["Great build quality and fast shipping.", "Does the job, nothing fancy.", "A bit pricey but worth it.", "Stopped working after a week.", "My new daily driver."]),
    verified: rand() < 0.7,
    createdAt: daysAgo(int(0, 90)),
  });
}

// ---- analytics ----
const events = [];
for (let i = 0; i < 40; i++) {
  events.push({
    _id: new ObjectId(),
    type: pick(EV),
    userId: rand() < 0.8 ? pick(users)._id : null,
    props: { path: pick(["/", "/cart", "/p/aurora-65", "/search", "/checkout"]), ua: pick(["mac", "win", "ios", "android"]) },
    ts: daysAgo(int(0, 14)),
  });
}
const sessions = [];
for (let i = 0; i < 18; i++) {
  sessions.push({
    _id: new ObjectId(),
    userId: rand() < 0.7 ? pick(users)._id : null,
    device: pick(["desktop", "mobile", "tablet"]),
    pages: int(1, 22),
    durationSec: int(15, 3600),
    country: pick(COUNTRIES),
    startedAt: daysAgo(int(0, 14)),
  });
}

// ---- byteshop: create collections (validator on products), indexes, insert ----
const shop = db.getSiblingDB("byteshop");
shop.createCollection("products", {
  validator: {
    $jsonSchema: {
      bsonType: "object",
      required: ["sku", "title", "price"],
      properties: {
        sku: { bsonType: "string", description: "required string" },
        price: { bsonType: ["double", "int"], minimum: 0 },
        stock: { bsonType: "int", minimum: 0 },
      },
    },
  },
});

shop.users.insertMany(users);
shop.products.insertMany(products);
shop.orders.insertMany(orders);
shop.reviews.insertMany(reviews);

shop.users.createIndex({ email: 1 }, { unique: true, name: "email_1" });
shop.users.createIndex({ country: 1 }, { name: "country_1" });
shop.products.createIndex({ sku: 1 }, { unique: true, name: "sku_1" });
shop.products.createIndex({ category: 1, price: -1 }, { name: "category_1_price_-1" });
shop.products.createIndex({ tags: 1 }, { sparse: true, name: "tags_1" });
shop.orders.createIndex({ userId: 1 }, { name: "userId_1" });
shop.orders.createIndex({ status: 1, createdAt: -1 }, { name: "status_1_createdAt_-1" });
shop.reviews.createIndex({ productId: 1 }, { name: "productId_1" });
shop.reviews.createIndex({ userId: 1 }, { name: "userId_1" });
shop.reviews.createIndex({ rating: -1 }, { name: "rating_-1" });

// ---- analytics ----
const ana = db.getSiblingDB("analytics");
ana.events.insertMany(events);
ana.sessions.insertMany(sessions);
ana.events.createIndex({ type: 1, ts: -1 }, { name: "type_1_ts_-1" });
ana.events.createIndex({ userId: 1 }, { sparse: true, name: "userId_1" });
ana.sessions.createIndex({ startedAt: -1 }, { name: "startedAt_-1" });
ana.sessions.createIndex({ country: 1 }, { name: "country_1" });

print(
  "ByteTable MongoDB seed: byteshop(users=" + users.length + ", products=" + products.length +
  ", orders=" + orders.length + ", reviews=" + reviews.length + "), analytics(events=" +
  events.length + ", sessions=" + sessions.length + ")",
);
