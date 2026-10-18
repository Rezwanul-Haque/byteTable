// Engine mark — the engine's logo, everywhere one is shown: the connection
// picker, the connect cards, the sidebars, the dashboards and the title bar.
//
// The glyphs come from TWO places, and which one an engine uses is not a style
// choice — it is whether the brand exists in Simple Icons:
//
//   1. OFFICIAL MARKS (`simple-icons`, CC0-1.0) for the seven that are in the
//      set. The files are public domain; the logos they draw remain their
//      owners' trademarks, and shipping them to identify the product you are
//      connecting to is nominative use.
//   2. IN-HOUSE DRAWINGS for the four with no entry: SQL Server and DynamoDB
//      (Simple Icons carries no Microsoft or Amazon brand icons — both were
//      withdrawn from the set), Typesense (never added), and `csv`, which is a
//      workspace kind rather than a product and has no logo to use.
//
// EVERY GLYPH IS A FILL, never a stroke, and fills the 24×24 box edge to edge.
// Simple Icons paths are built that way, and a drawn glyph that is a few units
// smaller or a stroke lighter than the brand mark beside it reads as a mistake
// in a row of eleven. Holes (SQL Server's window panes, the CSV gridlines) are
// real holes via `fill-rule: evenodd`, NOT a shape painted in the background
// colour — there is no plate behind these any more, so a knockout would show
// whatever is behind the icon.
//
// Colour is ENGINE_META's, NOT the brand hex Simple Icons ships. That table is
// the app's one engine palette — the import sheet's detection dot and
// SchemaDiff's connection cards read the same table — and a mark painted in
// the brand hex would be the only thing on screen disagreeing about what
// colour Postgres is. The silhouette carries the recognition; the palette
// stays ours. It is applied as `color` so a theme can override it in CSS —
// every glyph below paints with `currentColor`.

import type { ReactNode } from "react";
import {
  siApachecassandra,
  siClickhouse,
  siMongodb,
  siMysql,
  siPostgresql,
  siRedis,
  siSqlite,
} from "simple-icons";

import { useLocale } from "../i18n/useT";
import type { BadgeEngine } from "../types";

import { ENGINE_META, engineLabel } from "./engineMeta";

import "./EngineMark.css";

/** The official mark, where one exists. Keyed by engine, not by brand slug, so
 *  a missing entry is a plain falsy check at the render site. */
const BRAND_PATHS: Partial<Record<BadgeEngine, string>> = {
  sqlite: siSqlite.path,
  mysql: siMysql.path,
  postgres: siPostgresql.path,
  redis: siRedis.path,
  mongodb: siMongodb.path,
  cassandra: siApachecassandra.path,
  clickhouse: siClickhouse.path,
};

/** Lifts a drawn glyph from the ~16-unit box it was composed in to the 24-unit
 *  one the brand paths fill, about the centre. */
const DRAWN_FIT = "translate(12 12) scale(1.5) translate(-12 -12)";

/**
 * The four engines Simple Icons cannot supply, drawn on the same 24×24 grid as
 * the brand paths and to the same visual weight — they sit in one row with the
 * real marks.
 */
const DRAWN_GLYPHS: Partial<Record<BadgeEngine, ReactNode>> = {
  // A database cylinder with a four-pane window cut out of its face: the two
  // things that identify this engine are "Microsoft" and "SQL", and the pane is
  // the only part of the first that survives at this size.
  mssql: (
    <g transform={DRAWN_FIT}>
      <ellipse cx="12" cy="7.2" rx="6.4" ry="2.3" />
      <path
        fillRule="evenodd"
        d="M5.6 7.2v10c0 1.3 2.9 2.3 6.4 2.3s6.4-1 6.4-2.3v-10zM8.8 10h2.8v2.8H8.8zm3.6 0h2.8v2.8h-2.8zm-3.6 3.6h2.8v2.8H8.8zm3.6 0h2.8v2.8h-2.8z"
      />
    </g>
  ),
  // A cylinder struck by a bolt: the managed key-value store, fast and remote.
  dynamodb: (
    <g transform={DRAWN_FIT}>
      <ellipse cx="12" cy="7.4" rx="5.7" ry="2.3" />
      <path
        fillRule="evenodd"
        d="M6.3 7.4v9.2c0 1.3 2.6 2.3 5.7 2.3s5.7-1 5.7-2.3V7.4zM12.9 9.3 9.6 14.2h2.4l-.9 3.5 3.6-4.9h-2.5z"
      />
    </g>
  ),
  // A lens over a spark — search, and search that returns instantly. The ring
  // is an annulus rather than a stroked circle so it scales with the rest.
  typesense: (
    <g transform={DRAWN_FIT}>
      <path
        fillRule="evenodd"
        d="M10.9 5.4a5.5 5.5 0 1 0 0 11 5.5 5.5 0 0 0 0-11zm0 2.2a3.3 3.3 0 1 1 0 6.6 3.3 3.3 0 0 1 0-6.6z"
      />
      <path d="M14.4 15.9l1.5-1.5 4.3 4.3-1.5 1.5z" />
      <path d="M17.4 4.8l.8 1.9 1.9.8-1.9.8-.8 1.9-.8-1.9-1.9-.8 1.9-.8z" />
    </g>
  ),
  // Not an engine: the M35 data-file workspace. A table, since that is all a
  // CSV is.
  csv: (
    <g transform={DRAWN_FIT}>
      <path
        fillRule="evenodd"
        d="M6.8 6.2h10.4c1.2 0 2.2 1 2.2 2.2v9.2c0 1.2-1 2.2-2.2 2.2H6.8c-1.2 0-2.2-1-2.2-2.2V8.4c0-1.2 1-2.2 2.2-2.2zM4.6 9.8h14.8v1.6H4.6zM11.2 11.4h1.6v8.4h-1.6z"
      />
    </g>
  ),
};

interface EngineMarkProps {
  /** A database engine, or `csv` for the M35 data-file workspace. */
  engine: BadgeEngine;
  /** Rendered box, px. The glyph fills it edge to edge — there is no plate and
   *  no padding, so this is the mark's true size. */
  size?: number;
}

/**
 * The logo for an engine. Decorative by default — every place it is used labels
 * the engine in text beside it — so it carries `aria-hidden` and leaves the
 * accessible name to that label, with the product name in `title` for a hover.
 */
export function EngineMark({ engine, size = 34 }: EngineMarkProps) {
  // Subscribe to locale changes so the title repaints with the rest of the UI.
  useLocale();
  const brand = BRAND_PATHS[engine];
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      className="engine-mark"
      style={{ color: ENGINE_META[engine].color }}
      aria-hidden="true"
      focusable="false"
    >
      <title>{engineLabel(engine)}</title>
      <g fill="currentColor">{brand ? <path d={brand} /> : DRAWN_GLYPHS[engine]}</g>
    </svg>
  );
}
