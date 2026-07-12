// CQL type helpers (colour + classification), shared across the Cassandra
// components. Kept in a non-component module so React Fast Refresh stays happy.

export const CQL_TYPE_COLOR: Record<string, string> = {
  uuid: "#b08cff",
  timeuuid: "#c792ea",
  text: "#98c379",
  varchar: "#98c379",
  ascii: "#98c379",
  int: "#56b6c2",
  bigint: "#56b6c2",
  smallint: "#56b6c2",
  double: "#56b6c2",
  float: "#56b6c2",
  decimal: "#56b6c2",
  counter: "#56b6c2",
  boolean: "#e2b340",
  timestamp: "#e5a458",
  date: "#e5a458",
  time: "#e5a458",
  inet: "#61afef",
  blob: "#7f8794",
  set: "#61afef",
  list: "#61afef",
  map: "#61afef",
  tuple: "#61afef",
};

/** The head type of a CQL type — `set<text>` → `set`, `map<a,b>` → `map`. */
export function baseType(t: string | undefined): string {
  return (t ?? "").replace(/<.*$/, "");
}

export function cqlColor(type: string): string {
  return CQL_TYPE_COLOR[baseType(type)] ?? "#e3e6eb";
}

/** Types whose value needs the structured row editor, not a one-line input. */
const CASS_COMPLEX_TYPES = ["set", "list", "map", "tuple", "frozen", "blob", "counter", "vector"];
export function cassIsComplex(type: string): boolean {
  return CASS_COMPLEX_TYPES.includes(baseType(type));
}

/** The numeric CQL scalar types (rendered as numbers / number inputs). */
export const CQL_NUMERIC_TYPES = [
  "int",
  "bigint",
  "smallint",
  "double",
  "float",
  "decimal",
  "counter",
];
export function cqlIsNumeric(type: string): boolean {
  return CQL_NUMERIC_TYPES.includes(baseType(type));
}
