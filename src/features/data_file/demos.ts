// The three sample files the open sheet offers (prototype csv-core.js `DEMOS`).
//
// They exist so the feature is explorable without a file to hand — and so the
// Data quality tab has something to say on first run. Generated from a seeded
// LCG rather than checked in as fixtures: deterministic across launches, but a
// few hundred rows of text we do not ship in the bundle as a string blob.
//
// Kept out of core.ts so the parsing core stays free of sample data.

/** Deterministic 0–1 generator (numerical-recipes LCG). */
function rand(seed: number): () => number {
  let s = seed;
  return () => {
    s = (s * 1664525 + 1013904223) % 4294967296;
    return s / 4294967296;
  };
}

/** Messy commerce export: ragged rows, mixed types, blanks, duplicates. */
function demoOrders(): string {
  const r = rand(20260816);
  const countries = [
    "United States",
    "Germany",
    "Bangladesh",
    "Japan",
    "Brazil",
    "United Kingdom",
    '"Korea, Republic of"',
    "Canada",
    "France",
    "Australia",
  ];
  const channels = ["web", "ios", "android", "partner"];
  const statuses = [
    "paid",
    "paid",
    "paid",
    "shipped",
    "shipped",
    "refunded",
    "pending",
    "cancelled",
  ];
  const codes = ["", "", "", "SUMMER10", "WELCOME5", "", "BULK20", ""];
  const head =
    "order_id,ordered_at,customer_email,country,channel,items,subtotal,discount,total,status,shipped_at,rating,internal_note";
  const lines = [head];
  for (let i = 0; i < 214; i++) {
    const day = 1 + Math.floor(r() * 15);
    const items = 1 + Math.floor(r() * 5);
    const subtotal = +(items * (12 + r() * 90)).toFixed(2);
    const code = codes[Math.floor(r() * codes.length)]!;
    const disc = code
      ? +(subtotal * (code === "BULK20" ? 0.2 : code === "SUMMER10" ? 0.1 : 0.05)).toFixed(2)
      : 0;
    const status = statuses[Math.floor(r() * statuses.length)]!;
    const shipped =
      status === "shipped" ? "2026-08-" + String(Math.min(15, day + 2)).padStart(2, "0") : "";
    const rating = r() < 0.28 ? "" : String(1 + Math.floor(r() * 5));
    lines.push(
      [
        "ORD-" + (104200 + i),
        "2026-08-" +
          String(day).padStart(2, "0") +
          "T" +
          String(7 + Math.floor(r() * 12)).padStart(2, "0") +
          ":" +
          String(Math.floor(r() * 60)).padStart(2, "0") +
          ":00Z",
        "user" + (1000 + Math.floor(r() * 900)) + "@example.com",
        countries[Math.floor(r() * countries.length)]!,
        channels[Math.floor(r() * channels.length)]!,
        String(items),
        subtotal.toFixed(2),
        disc.toFixed(2),
        (subtotal - disc).toFixed(2),
        status,
        shipped,
        rating,
        "",
      ].join(","),
    );
  }
  // Deliberate real-world mess, so every issue class has a live example:
  // a stray-whitespace value, a non-ISO date, a quoted thousands separator
  // that breaks the numeric column, two ragged rows, and two exact duplicates.
  lines[12] =
    "ORD-104212,2026-08-04T09:14:00Z, user1420@example.com ,Germany,web,2,148.00,0.00,148.00,paid,,4,";
  lines[19] = "ORD-104219,08/06/2026,user1188@example.com,Japan,ios,1,64.00,0.00,64.00,paid,,5,";
  lines[26] =
    'ORD-104226,2026-08-07T11:02:00Z,user1301@example.com,Brazil,web,3,1299.00,0.00,"1,299.00",paid,,N/A,';
  lines[33] =
    "ORD-104233,2026-08-08T15:40:00Z,user1512@example.com,France,web,2,88.50,0.00,88.50,paid,,3";
  lines[44] =
    "ORD-104244,2026-08-09T08:05:00Z,user1077@example.com,Chile, Santiago,web,1,42.00,0.00,42.00,paid,,4,";
  lines.push(lines[60]!);
  lines.push(lines[61]!);
  return lines.join("\n") + "\n";
}

/** Tab-separated, clean, wide numeric ranges — the "no issues" reference. */
function demoStations(): string {
  const r = rand(7731);
  const names = [
    "Kestrel Ridge",
    "Harbour Point",
    "Mount Iona",
    "Cedar Flats",
    "North Basin",
    "Saltmarsh",
    "Pine Hollow",
    "Blue Mesa",
    "Fox Creek",
    "Granite Pass",
  ];
  const lines = ["station_id\tname\tregion\tlat\tlon\televation_m\tfirst_year\tactive"];
  for (let i = 0; i < 68; i++) {
    lines.push(
      [
        "ST" + String(100 + i),
        names[i % names.length]! + " " + (1 + Math.floor(i / names.length)),
        ["north", "south", "coastal", "inland"][Math.floor(r() * 4)]!,
        (-56 + r() * 112).toFixed(4),
        (-179 + r() * 358).toFixed(4),
        String(Math.round(r() * 3200)),
        String(1948 + Math.floor(r() * 70)),
        r() < 0.75 ? "true" : "false",
      ].join("\t"),
    );
  }
  return lines.join("\n") + "\n";
}

/** Semicolon-separated with a sparse debit/credit pair (>40%-empty columns). */
function demoLedger(): string {
  const r = rand(4242);
  const lines = ["entry_id;posted_on;account;description;debit;credit;currency"];
  const accounts = [
    "4000 Revenue",
    "5100 Hosting",
    "5200 Payroll",
    "6100 Travel",
    "1200 Receivables",
  ];
  const descriptions = [
    "Stripe payout",
    "AWS invoice",
    "Monthly salaries",
    "Conference travel",
    "Client settlement",
  ];
  for (let i = 0; i < 46; i++) {
    const deb = r() < 0.5;
    const amt = (r() * 4000 + 20).toFixed(2);
    lines.push(
      [
        "JE-" + (9000 + i),
        "2026-0" +
          (6 + Math.floor(r() * 3)) +
          "-" +
          String(1 + Math.floor(r() * 28)).padStart(2, "0"),
        accounts[Math.floor(r() * accounts.length)]!,
        descriptions[Math.floor(r() * descriptions.length)]!,
        deb ? amt : "",
        deb ? "" : amt,
        "USD",
      ].join(";"),
    );
  }
  return lines.join("\n") + "\n";
}

/** One offered sample: its name, why it is interesting, and its text. */
export interface DemoFile {
  name: string;
  note: string;
  text: string;
  size: number;
}

/** Built once at module load — the sheet renders their sizes immediately. */
export const DEMOS: DemoFile[] = [
  {
    name: "orders_export_2026-08.csv",
    note: "Messy commerce export — ragged rows, mixed types, blanks",
    build: demoOrders,
  },
  {
    name: "weather_stations.tsv",
    note: "Tab-separated, clean, wide numeric ranges",
    build: demoStations,
  },
  {
    name: "gl_ledger_q3.csv",
    note: "Semicolon-separated, sparse debit/credit pair",
    build: demoLedger,
  },
].map((d) => {
  const text = d.build();
  return { name: d.name, note: d.note, text, size: text.length };
});
