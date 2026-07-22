//! In-process SVG→PNG rasterizer for the schema-map export.
//!
//! WHY BACKEND: the export SVG is rasterized here (resvg), not in the webview
//! canvas. WebKitGTK — the Linux Tauri webview — cannot reliably draw an SVG
//! `<img>` to a `<canvas>` and read it back with `toDataURL('image/png')`, so a
//! browser-side raster throws on Linux while it works on macOS (WKWebView) and
//! Windows (WebView2). Rendering in Rust makes PNG export identical and reliable
//! on every platform; SVG export stays a verbatim text write.
//!
//! FONTS: the export text uses exactly one face — JetBrains Mono, weights 400
//! and 600 (see `export.ts` / `cardMapExport.ts`, every `<text>` is
//! `font-family: "JetBrains Mono"`). We ship those TTFs (OFL, `assets/fonts/`)
//! and load only them into a private `fontdb`; no system fonts are consulted, so
//! even a font-less Linux box renders the diagram text correctly and identically
//! everywhere. The `@font-face` rules embedded in the SVG (present so a
//! standalone SVG file still looks right) reference woff2, which `fontdb` can't
//! parse — usvg ignores them and resolves "JetBrains Mono" from the loaded TTFs.

use resvg::tiny_skia;
use resvg::usvg;

use crate::shared::error::AppError;

const JETBRAINS_MONO_REGULAR: &[u8] =
    include_bytes!("../../../assets/fonts/JetBrainsMono-Regular.ttf");
const JETBRAINS_MONO_SEMIBOLD: &[u8] =
    include_bytes!("../../../assets/fonts/JetBrainsMono-SemiBold.ttf");

/// Rasterize an export SVG document to PNG bytes at `scale`× its intrinsic size.
/// 2× matches the crispness the old webview-canvas path produced on HiDPI; any
/// non-finite or non-positive scale is clamped to 1×.
pub fn svg_to_png(svg: &str, scale: f32) -> Result<Vec<u8>, AppError> {
    let scale = if scale.is_finite() && scale > 0.0 {
        scale
    } else {
        1.0
    };

    let mut options = usvg::Options::default();
    {
        let db = options.fontdb_mut();
        db.load_font_data(JETBRAINS_MONO_REGULAR.to_vec());
        db.load_font_data(JETBRAINS_MONO_SEMIBOLD.to_vec());
    }

    let tree = usvg::Tree::from_str(svg, &options)
        .map_err(|err| AppError::Invalid(format!("The diagram SVG could not be parsed: {err}")))?;

    let size = tree.size();
    let width = (f64::from(size.width()) * f64::from(scale))
        .round()
        .max(1.0) as u32;
    let height = (f64::from(size.height()) * f64::from(scale))
        .round()
        .max(1.0) as u32;

    let mut pixmap = tiny_skia::Pixmap::new(width, height).ok_or_else(|| {
        AppError::Invalid(format!(
            "The diagram is too large to rasterize ({width}×{height} pixels)."
        ))
    })?;

    let transform = tiny_skia::Transform::from_scale(scale, scale);
    resvg::render(&tree, transform, &mut pixmap.as_mut());

    pixmap
        .encode_png()
        .map_err(|err| AppError::Io(format!("Could not encode the PNG image: {err}")))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A minimal export-shaped SVG: explicit size + a JetBrains Mono text run,
    /// exactly the shape `buildExportSvg` emits (sans the embedded @font-face).
    const SAMPLE_SVG: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40">
        <rect width="120" height="40" fill="#131418"/>
        <text x="6" y="24" font-family="JetBrains Mono" font-size="12" fill="#e3e6eb">users</text>
    </svg>"##;

    fn is_png(bytes: &[u8]) -> bool {
        bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A])
    }

    #[test]
    fn renders_a_png_with_the_expected_pixel_dimensions() {
        let png = svg_to_png(SAMPLE_SVG, 2.0).expect("render");
        assert!(is_png(&png), "output is a PNG");
        // Decode the IHDR width/height (bytes 16..24, big-endian) — 120×40 @2×.
        let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
        let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
        assert_eq!((width, height), (240, 80));
    }

    #[test]
    fn scale_one_keeps_the_intrinsic_size() {
        let png = svg_to_png(SAMPLE_SVG, 1.0).expect("render");
        let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
        let height = u32::from_be_bytes([png[20], png[21], png[22], png[23]]);
        assert_eq!((width, height), (120, 40));
    }

    #[test]
    fn a_non_positive_scale_is_clamped_to_one() {
        let png = svg_to_png(SAMPLE_SVG, 0.0).expect("render");
        let width = u32::from_be_bytes([png[16], png[17], png[18], png[19]]);
        assert_eq!(width, 120);
    }

    #[test]
    fn an_embedded_woff2_font_face_is_tolerated_and_falls_back_to_the_bundled_ttf() {
        // The real export SVG carries `@font-face { src: url(data:font/woff2...) }`
        // so a standalone SVG file looks right. fontdb/ttf-parser can't decode
        // woff2, so usvg must ignore that face and resolve "JetBrains Mono" from
        // our loaded TTFs — not error. (Bytes below aren't valid woff2 on purpose.)
        let svg = concat!(
            r##"<svg xmlns="http://www.w3.org/2000/svg" width="120" height="40" viewBox="0 0 120 40">"##,
            r##"<defs><style>@font-face{font-family:"JetBrains Mono";font-weight:400;"##,
            r##"src:url(data:font/woff2;base64,d09GMgABAAAAAAAA) format("woff2");}</style></defs>"##,
            r##"<text x="6" y="24" font-family="JetBrains Mono" font-size="12" fill="#e3e6eb">users</text>"##,
            r##"</svg>"##,
        );
        let png = svg_to_png(svg, 2.0).expect("render despite the unparseable woff2 face");
        assert!(is_png(&png));
    }

    #[test]
    fn malformed_svg_is_an_invalid_error() {
        let err = svg_to_png("not an svg at all", 2.0).unwrap_err();
        assert!(matches!(err, AppError::Invalid(_)));
    }

    #[test]
    fn the_bundled_jetbrains_mono_faces_resolve_at_both_weights() {
        let mut options = usvg::Options::default();
        let db = options.fontdb_mut();
        db.load_font_data(JETBRAINS_MONO_REGULAR.to_vec());
        db.load_font_data(JETBRAINS_MONO_SEMIBOLD.to_vec());
        let has = |weight: usvg::fontdb::Weight| {
            db.query(&usvg::fontdb::Query {
                families: &[usvg::fontdb::Family::Name("JetBrains Mono")],
                weight,
                ..Default::default()
            })
            .is_some()
        };
        assert!(has(usvg::fontdb::Weight::NORMAL), "weight 400 face present");
        assert!(
            has(usvg::fontdb::Weight::SEMIBOLD),
            "weight 600 face present"
        );
    }
}
