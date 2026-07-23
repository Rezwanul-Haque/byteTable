//! Domain model for the schema map. Pure value objects; the only outward
//! dependency is `serde`.
//!
//! As in the saved_queries and connections slices, the plain `serde` derives
//! below double as the wire/persisted representation (camelCase fields) so the
//! renderer's TS literals match exactly.

use serde::{Deserialize, Serialize};

/// Position of one table card in the ER diagram, in diagram coordinates.
///
/// `table` is the table name (unique within a schema), used as the key the
/// renderer matches a card to. `x`/`y` are absolute positions in the diagram's
/// own coordinate space (before zoom/pan are applied at render time).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NodePosition {
    pub table: String,
    pub x: f64,
    pub y: f64,
    /// Optional user-resized card width (read-mode "resizable cards"). Absent
    /// (and omitted from the wire) when the card is at its default width, so
    /// pre-resize saved layouts keep parsing unchanged and only widened cards
    /// carry a value. The renderer clamps and applies it.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub w: Option<f64>,
}

/// A user-dragged offset for one FK edge's midpoint waypoint.
///
/// `id` opaquely identifies an FK edge; the renderer owns the id scheme (e.g.
/// `"childTable.col->refTable"`). The backend never parses it — it is just the
/// key an offset is stored under.
///
/// `dx`/`dy` are a *relative* offset applied to the edge's computed midpoint, so
/// the edge keeps its bend when the two connected cards move. Storing the
/// offset (not an absolute waypoint) is what lets a dragged edge stay sensible
/// after a layout reflow.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeWaypoint {
    pub id: String,
    pub dx: f64,
    pub dy: f64,
}

/// A manual cardinality override for one relationship edge. `id` matches the
/// renderer's edge id (same scheme as `EdgeWaypoint.id`); `kind` is the
/// frontend's cardinality string (`"1:1"` / `"1:N"` / `"M:N"`). Absent for an
/// edge means "auto-derive from the schema". Stored opaquely — the renderer
/// owns the value set.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct EdgeCardinality {
    pub id: String,
    pub kind: String,
}

/// The full saved layout for one (connectionId, schema): every table card's
/// position, every user-dragged FK edge offset, and the zoom level.
///
/// Design choices:
///
/// - `positions` / `edges` are `Vec`s keyed by `table` / `id` rather than maps.
///   A `Vec` serializes to a clean JSON array, round-trips order, and the
///   renderer already iterates these; a map keyed by name would gain nothing
///   here. Lookups are by the embedded key field.
/// - `zoom` is `Option<f64>`: present once the user has zoomed, absent (and
///   omitted from the wire) otherwise, so the renderer can fall back to its
///   default zoom. Pan is intentionally **omitted** — pan is cheap to recompute
///   (centre on the cards) and persisting it tends to reopen the diagram
///   scrolled off-screen if the card set changed; if a future milestone wants
///   sticky pan it can add an `Option<(f64, f64)>` field without breaking the
///   wire (a new optional field).
#[derive(Debug, Clone, PartialEq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MapLayout {
    #[serde(default)]
    pub positions: Vec<NodePosition>,
    #[serde(default)]
    pub edges: Vec<EdgeWaypoint>,
    /// Manual cardinality overrides, keyed by edge id. Omitted from the wire
    /// when empty (a new optional field, non-breaking like `zoom`).
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub cardinalities: Vec<EdgeCardinality>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub zoom: Option<f64>,
}

/// The export format the renderer chose. Lowercase on the wire to match the
/// app's enum convention (see `AppError::kind`).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ExportFormat {
    Png,
    Svg,
}

/// What `diagram_export` writes and how `data` is interpreted.
///
/// For **both** formats `data` is the diagram's SVG document text — the renderer
/// no longer rasterizes. This is deliberate: WebKitGTK (the Linux webview)
/// cannot draw an SVG to a `<canvas>` and read it back as PNG, so a browser-side
/// raster fails there while working on macOS/Windows. Instead:
///
/// - `format: "svg"` → the SVG text is written verbatim.
/// - `format: "png"` → the SVG is rasterized in Rust (`render::svg_to_png`) at
///   `scale`× its intrinsic size, and the resulting PNG bytes are written. This
///   renders identically on every platform. `scale` defaults to 1× when absent;
///   the renderer sends 2× for crisp HiDPI output.
///
/// `path` is the user-chosen destination from the native save dialog. Because
/// the user explicitly picked it, no extra scope restriction applies (the
/// save dialog *is* the consent).
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ExportPayload {
    pub path: String,
    pub format: ExportFormat,
    pub data: String,
    /// PNG raster scale factor (ignored for SVG). Absent → 1×.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub scale: Option<f64>,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn sample() -> MapLayout {
        MapLayout {
            positions: vec![
                NodePosition {
                    table: "users".into(),
                    x: 10.0,
                    y: 20.5,
                    w: None,
                },
                NodePosition {
                    table: "orders".into(),
                    x: 300.0,
                    y: -40.0,
                    w: Some(360.0),
                },
            ],
            edges: vec![EdgeWaypoint {
                id: "orders.user_id->users".into(),
                dx: 12.0,
                dy: -8.0,
            }],
            cardinalities: Vec::new(),
            zoom: Some(1.5),
        }
    }

    #[test]
    fn wire_format_is_camel_case() {
        let json = serde_json::to_value(sample()).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "positions": [
                    { "table": "users", "x": 10.0, "y": 20.5 },
                    { "table": "orders", "x": 300.0, "y": -40.0, "w": 360.0 },
                ],
                "edges": [
                    { "id": "orders.user_id->users", "dx": 12.0, "dy": -8.0 },
                ],
                "zoom": 1.5,
            })
        );
    }

    #[test]
    fn zoom_is_omitted_from_the_wire_when_absent() {
        let layout = MapLayout {
            zoom: None,
            ..sample()
        };
        let json = serde_json::to_value(layout).expect("serialize");
        assert!(json.get("zoom").is_none());
    }

    #[test]
    fn empty_layout_round_trips_with_arrays_present() {
        let json = serde_json::to_value(MapLayout::default()).expect("serialize");
        assert_eq!(
            json,
            serde_json::json!({
                "positions": [],
                "edges": [],
            })
        );
    }

    #[test]
    fn node_width_is_omitted_when_absent_and_round_trips_when_set() {
        // Default width → no `w` key on the wire (pre-resize layouts stay lean).
        let none = NodePosition {
            table: "t".into(),
            x: 1.0,
            y: 2.0,
            w: None,
        };
        assert!(serde_json::to_value(&none).unwrap().get("w").is_none());
        // A resized card carries its width and round-trips.
        let some = NodePosition {
            table: "t".into(),
            x: 1.0,
            y: 2.0,
            w: Some(420.0),
        };
        let back: NodePosition =
            serde_json::from_value(serde_json::to_value(&some).unwrap()).unwrap();
        assert_eq!(back.w, Some(420.0));
        // An old payload with no `w` field still deserializes (defaults to None).
        let legacy: NodePosition =
            serde_json::from_value(serde_json::json!({ "table": "t", "x": 1.0, "y": 2.0 }))
                .expect("legacy node parses");
        assert_eq!(legacy.w, None);
    }

    #[test]
    fn missing_arrays_default_to_empty_on_deserialize() {
        // A future / partial payload that carries only zoom must still parse.
        let layout: MapLayout = serde_json::from_value(serde_json::json!({ "zoom": 2.0 }))
            .expect("deserialize partial");
        assert!(layout.positions.is_empty());
        assert!(layout.edges.is_empty());
        assert_eq!(layout.zoom, Some(2.0));
    }

    #[test]
    fn serde_round_trip_preserves_all_fields() {
        let layout = sample();
        let json = serde_json::to_string(&layout).expect("serialize");
        let back: MapLayout = serde_json::from_str(&json).expect("deserialize");
        assert_eq!(back, layout);
    }

    #[test]
    fn export_payload_wire_shape_is_camel_case_with_lowercase_format() {
        let svg = ExportPayload {
            path: "/tmp/diagram.svg".into(),
            format: ExportFormat::Svg,
            data: "<svg/>".into(),
            scale: None,
        };
        assert_eq!(
            serde_json::to_value(&svg).expect("serialize"),
            serde_json::json!({
                "path": "/tmp/diagram.svg",
                "format": "svg",
                "data": "<svg/>",
            })
        );

        let png = ExportPayload {
            path: "/tmp/diagram.png".into(),
            format: ExportFormat::Png,
            data: "<svg/>".into(),
            scale: Some(2.0),
        };
        let png_json = serde_json::to_value(&png).expect("serialize");
        assert_eq!(png_json["format"], "png");
        assert_eq!(png_json["scale"], 2.0);

        // Round-trips from a renderer-shaped literal; scale defaults to None.
        let back: ExportPayload = serde_json::from_value(serde_json::json!({
            "path": "/tmp/x.png",
            "format": "png",
            "data": "<svg/>",
        }))
        .expect("deserialize");
        assert_eq!(back.format, ExportFormat::Png);
        assert_eq!(back.data, "<svg/>");
        assert_eq!(back.scale, None);
    }
}
