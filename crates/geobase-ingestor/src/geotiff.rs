//! GeoTIFF reader — the raster half of the GeoPack ingest pipeline.
//!
//! **Deliberately narrow** (docs/DECISIONS.md, 2026-07-06): Phase 0.3 accepts
//! exactly the shapes below and rejects everything else loudly, per the
//! CRS-discipline invariant ("validate, never assume"):
//!
//! - single image (one IFD; multi-IFD/overview files reject),
//! - single band (`SamplesPerPixel == 1`),
//! - `Float32` or `Int16` samples,
//! - stripped or tiled layout; compression None / LZW / Deflate,
//! - georeferencing via `ModelPixelScale` (33550) + one `ModelTiepoint`
//!   (33922) anchored at raster (0,0,0); `ModelTransformation` (34264)
//!   — i.e. rotation/shear — rejects,
//! - CRS from GeoKeys (34735): `GTModelTypeGeoKey` (1024) selects
//!   projected (`ProjectedCSTypeGeoKey`, 3072) or geographic
//!   (`GeographicTypeGeoKey`, 2048). Code 32767 (user-defined) or absent
//!   GeoKeys yield `epsg: None` — the caller then requires an
//!   operator-declared CRS or rejects the ingest.
//! - NoData from `GDAL_NODATA` (42113, ASCII).
//!
//! After decode, geographic CRSs get the sanity bounds check from
//! `docs/CRS-PIPELINE.md` (lon/lat in range — catches swapped axes).

use std::fs::File;
use std::io::{BufReader, Read, Seek};
use std::path::Path;

use tiff::decoder::{Decoder, DecodingResult};
use tiff::tags::Tag;

/// Sample type of the single accepted band.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum RasterDtype {
    F32,
    I16,
}

/// Decoded pixel data (row-major, top-left origin, `width * height` samples).
#[derive(Debug, Clone)]
pub enum RasterData {
    F32(Vec<f32>),
    I16(Vec<i16>),
}

/// A decoded, validated single-band raster.
#[derive(Debug, Clone)]
pub struct RasterBand {
    pub width: u32,
    pub height: u32,
    pub dtype: RasterDtype,
    pub data: RasterData,
    /// NoData value as declared by `GDAL_NODATA`, if any.
    pub nodata: Option<f64>,
    /// (x, y) pixel size in CRS units; both positive (north-up enforced).
    pub pixel_size: (f64, f64),
    /// Upper-left corner of the upper-left pixel, in CRS units.
    pub origin: (f64, f64),
    /// EPSG code from GeoKeys; `None` when absent or user-defined (32767).
    pub epsg: Option<u32>,
    /// Whether the GeoKeys declared a geographic (vs projected) model.
    pub geographic: bool,
}

impl RasterBand {
    /// (min_x, min_y, max_x, max_y) in CRS units.
    pub fn bounds(&self) -> (f64, f64, f64, f64) {
        let (px, py) = self.pixel_size;
        (
            self.origin.0,
            self.origin.1 - py * self.height as f64,
            self.origin.0 + px * self.width as f64,
            self.origin.1,
        )
    }
}

/// Errors from GeoTIFF reading. Every rejection names what was found and
/// what Phase 0.3 accepts, so operators can act on the message.
#[derive(Debug, thiserror::Error)]
pub enum GeoTiffError {
    #[error("io error reading {path}: {source}")]
    Io {
        path: String,
        source: std::io::Error,
    },
    #[error("tiff decode error in {path}: {detail}")]
    Decode { path: String, detail: String },
    #[error("unsupported geotiff ({path}): {detail} — Phase 0.3 accepts single-image, single-band Float32/Int16, stripped or tiled, None/LZW/Deflate compression, north-up ModelPixelScale+Tiepoint georeferencing")]
    Unsupported { path: String, detail: String },
    #[error("georeferencing invalid in {path}: {detail}")]
    BadGeoreferencing { path: String, detail: String },
}

// GeoKey ids (GeoTIFF spec §6.2).
const GT_MODEL_TYPE_GEO_KEY: u16 = 1024;
const GEOGRAPHIC_TYPE_GEO_KEY: u16 = 2048;
const PROJECTED_CS_TYPE_GEO_KEY: u16 = 3072;
// GTModelTypeGeoKey values.
const MODEL_TYPE_PROJECTED: u16 = 1;
const MODEL_TYPE_GEOGRAPHIC: u16 = 2;
// GeoTIFF sentinel codes: 0 = undefined, 32767 = user-defined. Neither is a
// real EPSG code, so both yield `epsg: None` (caller must then require an
// operator-declared CRS or reject — no silent fallback, per CRS discipline).
const KV_UNDEFINED: u16 = 0;
const KV_USER_DEFINED: u16 = 32767;

/// Read and validate a GeoTIFF per the Phase 0.3 acceptance rules above.
///
/// Rejections are loud and typed: structural narrowness violations return
/// [`GeoTiffError::Unsupported`], broken or missing georeferencing returns
/// [`GeoTiffError::BadGeoreferencing`], and undecodable TIFF structure
/// returns [`GeoTiffError::Decode`].
pub fn read_geotiff(path: &Path) -> Result<RasterBand, GeoTiffError> {
    let file = File::open(path).map_err(|source| GeoTiffError::Io {
        path: path.display().to_string(),
        source,
    })?;
    let mut dec = Decoder::new(BufReader::new(file)).map_err(|e| decode_err(path, e))?;

    // Exactly one image: the decoder is positioned at the first IFD; the
    // presence of any further IFD (overviews, pages, masks) rejects.
    if dec.more_images() {
        return Err(unsupported(
            path,
            "multiple IFDs present (overviews or extra pages); expected exactly one image",
        ));
    }

    let (width, height) = dec.dimensions().map_err(|e| decode_err(path, e))?;
    if width == 0 || height == 0 {
        return Err(unsupported(path, format!("empty image ({width}x{height})")));
    }

    let samples = find_scalar_u64(&mut dec, path, Tag::SamplesPerPixel)?.unwrap_or(1);
    if samples != 1 {
        return Err(unsupported(
            path,
            format!("SamplesPerPixel is {samples}; expected a single band"),
        ));
    }

    // TIFF compression codes: 1 = None, 5 = LZW, 8 / 32946 = Deflate.
    let compression = find_scalar_u64(&mut dec, path, Tag::Compression)?.unwrap_or(1);
    if !matches!(compression, 1 | 5 | 8 | 32946) {
        return Err(unsupported(
            path,
            format!(
                "compression code {compression}; accepted: None (1), LZW (5), Deflate (8/32946)"
            ),
        ));
    }

    // Sample type: BitsPerSample + SampleFormat (1 = unsigned int is the
    // TIFF default when the tag is absent; 2 = signed int, 3 = IEEE float).
    let bits = find_u16_vec(&mut dec, path, Tag::BitsPerSample)?.unwrap_or_else(|| vec![1]);
    let formats = find_u16_vec(&mut dec, path, Tag::SampleFormat)?.unwrap_or_else(|| vec![1]);
    let dtype = match (bits.as_slice(), formats.as_slice()) {
        ([32], [3]) => RasterDtype::F32,
        ([16], [2]) => RasterDtype::I16,
        _ => {
            return Err(unsupported(
                path,
                format!(
                    "sample type BitsPerSample={bits:?} SampleFormat={formats:?}; \
                     expected Float32 (32-bit IEEE float) or Int16 (16-bit signed int)"
                ),
            ));
        }
    };

    // Georeferencing: north-up scale + tiepoint only; a ModelTransformation
    // matrix (rotation/shear) is out of scope for Phase 0.3.
    if dec
        .find_tag(Tag::ModelTransformationTag)
        .map_err(|e| decode_err(path, e))?
        .is_some()
    {
        return Err(unsupported(
            path,
            "ModelTransformation (34264) present — rotated/sheared rasters are out of scope; \
             only north-up ModelPixelScale + ModelTiepoint is accepted",
        ));
    }

    let scale = find_f64_vec(&mut dec, path, Tag::ModelPixelScaleTag)?
        .ok_or_else(|| bad_geo(path, "ModelPixelScale (33550) is missing"))?;
    if scale.len() != 3 {
        return Err(bad_geo(
            path,
            format!("ModelPixelScale has {} values; expected 3", scale.len()),
        ));
    }
    let (px, py) = (scale[0], scale[1]);
    if !px.is_finite() || !py.is_finite() || px <= 0.0 || py <= 0.0 {
        return Err(bad_geo(
            path,
            format!("pixel scale ({px}, {py}) must be finite and positive (north-up)"),
        ));
    }

    let tie = find_f64_vec(&mut dec, path, Tag::ModelTiepointTag)?
        .ok_or_else(|| bad_geo(path, "ModelTiepoint (33922) is missing"))?;
    if tie.len() != 6 {
        return Err(bad_geo(
            path,
            format!(
                "ModelTiepoint has {} values; expected exactly one tiepoint (6 values)",
                tie.len()
            ),
        ));
    }
    if tie[0] != 0.0 || tie[1] != 0.0 || tie[2] != 0.0 {
        return Err(bad_geo(
            path,
            format!(
                "tiepoint is anchored at raster ({}, {}, {}); expected (0, 0, 0)",
                tie[0], tie[1], tie[2]
            ),
        ));
    }
    let origin = (tie[3], tie[4]);
    if !origin.0.is_finite() || !origin.1.is_finite() {
        return Err(bad_geo(
            path,
            format!(
                "tiepoint model coordinates ({}, {}) are not finite",
                origin.0, origin.1
            ),
        ));
    }

    let geo_keys = find_u16_vec(&mut dec, path, Tag::GeoKeyDirectoryTag)?;
    let (geographic, epsg) = parse_geo_keys(geo_keys.as_deref());

    let nodata = match dec
        .find_tag(Tag::GdalNodata)
        .map_err(|e| decode_err(path, e))?
    {
        None => None,
        Some(value) => {
            let raw = value
                .into_string()
                .map_err(|_| bad_geo(path, "GDAL_NODATA (42113) is not an ASCII value"))?;
            let text = raw.trim_matches(|c: char| c == '\0' || c.is_whitespace());
            let parsed = text.parse::<f64>().map_err(|_| {
                bad_geo(path, format!("GDAL_NODATA value {text:?} is not a number"))
            })?;
            Some(parsed)
        }
    };

    // Pixel data: `read_image` handles both stripped and tiled layouts and
    // returns the full image row-major; anything short of exactly
    // width*height samples of the declared type is a decode failure.
    let decoded = dec.read_image().map_err(|e| decode_err(path, e))?;
    let expected = u64::from(width) * u64::from(height);
    let data = match (dtype, decoded) {
        (RasterDtype::F32, DecodingResult::F32(v)) if v.len() as u64 == expected => {
            RasterData::F32(v)
        }
        (RasterDtype::I16, DecodingResult::I16(v)) if v.len() as u64 == expected => {
            RasterData::I16(v)
        }
        _ => {
            return Err(decode_err(
                path,
                format!(
                    "decoded buffer does not match the declared {dtype:?} image of {width}x{height} samples"
                ),
            ));
        }
    };

    let band = RasterBand {
        width,
        height,
        dtype,
        data,
        nodata,
        pixel_size: (px, py),
        origin,
        epsg,
        geographic,
    };

    // CRS pipeline discipline (docs/CRS-PIPELINE.md): a declared-geographic
    // raster must have sane lon/lat bounds — catches swapped axes and
    // projected extents mislabeled as geographic.
    if band.geographic {
        let (w, s, e, n) = band.bounds();
        let lon = -180.0..=180.0;
        let lat = -90.0..=90.0;
        if !(lon.contains(&w) && lon.contains(&e) && lat.contains(&s) && lat.contains(&n)) {
            return Err(bad_geo(
                path,
                format!(
                    "geographic bounds ({w}, {s}, {e}, {n}) are not sane lon/lat — \
                     swapped axes or a projected extent declared geographic?"
                ),
            ));
        }
    }

    Ok(band)
}

/// Parse the GeoKey directory (tag 34735: u16s in groups of four —
/// KeyID, TIFFTagLocation, Count, Value — after a 4-short header).
///
/// Returns `(geographic, epsg)`. Only inline SHORT keys
/// (`TIFFTagLocation == 0`, `Count == 1`) are interpreted; anything else —
/// absent directory, malformed header, non-inline storage, geocentric or
/// unknown model types, undefined (0) or user-defined (32767) codes —
/// yields `epsg: None` so the caller must resolve the CRS explicitly.
fn parse_geo_keys(dir: Option<&[u16]>) -> (bool, Option<u32>) {
    let Some(dir) = dir else {
        return (false, None);
    };
    if dir.len() < 4 {
        return (false, None);
    }
    let count = usize::from(dir[3]);
    let entries: Vec<&[u16]> = (0..count)
        .filter_map(|i| dir.get(4 + i * 4..8 + i * 4))
        .collect();
    let inline_short = |key: u16| -> Option<u16> {
        entries
            .iter()
            .find(|e| e[0] == key)
            .and_then(|e| (e[1] == 0 && e[2] == 1).then_some(e[3]))
    };
    match inline_short(GT_MODEL_TYPE_GEO_KEY) {
        Some(MODEL_TYPE_PROJECTED) => (false, epsg_from(inline_short(PROJECTED_CS_TYPE_GEO_KEY))),
        Some(MODEL_TYPE_GEOGRAPHIC) => (true, epsg_from(inline_short(GEOGRAPHIC_TYPE_GEO_KEY))),
        _ => (false, None),
    }
}

/// Map a raw GeoKey CRS code to an EPSG code, treating the GeoTIFF
/// sentinels (0 undefined, 32767 user-defined) as "no EPSG declared".
fn epsg_from(code: Option<u16>) -> Option<u32> {
    match code {
        None | Some(KV_UNDEFINED | KV_USER_DEFINED) => None,
        Some(c) => Some(u32::from(c)),
    }
}

fn decode_err(path: &Path, detail: impl std::fmt::Display) -> GeoTiffError {
    GeoTiffError::Decode {
        path: path.display().to_string(),
        detail: detail.to_string(),
    }
}

fn unsupported(path: &Path, detail: impl Into<String>) -> GeoTiffError {
    GeoTiffError::Unsupported {
        path: path.display().to_string(),
        detail: detail.into(),
    }
}

fn bad_geo(path: &Path, detail: impl Into<String>) -> GeoTiffError {
    GeoTiffError::BadGeoreferencing {
        path: path.display().to_string(),
        detail: detail.into(),
    }
}

/// Find a scalar unsigned tag value in the current IFD (`None` if absent).
fn find_scalar_u64<R: Read + Seek>(
    dec: &mut Decoder<R>,
    path: &Path,
    tag: Tag,
) -> Result<Option<u64>, GeoTiffError> {
    dec.find_tag_unsigned(tag).map_err(|e| decode_err(path, e))
}

/// Find a u16-vector tag value in the current IFD (`None` if absent).
fn find_u16_vec<R: Read + Seek>(
    dec: &mut Decoder<R>,
    path: &Path,
    tag: Tag,
) -> Result<Option<Vec<u16>>, GeoTiffError> {
    match dec.find_tag(tag).map_err(|e| decode_err(path, e))? {
        None => Ok(None),
        Some(value) => value
            .into_u16_vec()
            .map(Some)
            .map_err(|e| decode_err(path, e)),
    }
}

/// Find an f64-vector tag value in the current IFD (`None` if absent).
fn find_f64_vec<R: Read + Seek>(
    dec: &mut Decoder<R>,
    path: &Path,
    tag: Tag,
) -> Result<Option<Vec<f64>>, GeoTiffError> {
    match dec.find_tag(tag).map_err(|e| decode_err(path, e))? {
        None => Ok(None),
        Some(value) => value
            .into_f64_vec()
            .map(Some)
            .map_err(|e| decode_err(path, e)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::{Seek, Write};
    use std::path::PathBuf;
    use std::sync::atomic::{AtomicU32, Ordering};

    use tiff::encoder::colortype::{ColorType, Gray32Float, Gray8, GrayI16};
    use tiff::encoder::{Compression, DirectoryEncoder, TiffEncoder, TiffKind, TiffValue};
    use tiff::tags::{ExtraSamples, Tag};

    static NEXT_FILE: AtomicU32 = AtomicU32::new(0);

    /// Unique temp-file path per test (synthetic fixtures never enter git).
    fn tmp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join("geobase-ingestor-geotiff-tests");
        std::fs::create_dir_all(&dir).unwrap();
        let n = NEXT_FILE.fetch_add(1, Ordering::Relaxed);
        dir.join(format!("{}-{n}-{name}.tif", std::process::id()))
    }

    #[derive(Default, Clone)]
    struct GeoTags {
        pixel_scale: Option<Vec<f64>>,
        tiepoint: Option<Vec<f64>>,
        geo_keys: Option<Vec<u16>>,
        nodata: Option<&'static str>,
        model_transformation: Option<Vec<f64>>,
    }

    impl GeoTags {
        /// UTM-style projected raster: 10 m pixels anchored at (500000, 5200000).
        fn projected(epsg: u16) -> Self {
            Self {
                pixel_scale: Some(vec![10.0, 10.0, 0.0]),
                tiepoint: Some(vec![0.0, 0.0, 0.0, 500_000.0, 5_200_000.0, 0.0]),
                geo_keys: Some(geo_key_directory(&[
                    (GT_MODEL_TYPE_GEO_KEY, MODEL_TYPE_PROJECTED),
                    (PROJECTED_CS_TYPE_GEO_KEY, epsg),
                ])),
                ..Self::default()
            }
        }

        fn geographic(epsg: u16, origin: (f64, f64), scale: f64) -> Self {
            Self {
                pixel_scale: Some(vec![scale, scale, 0.0]),
                tiepoint: Some(vec![0.0, 0.0, 0.0, origin.0, origin.1, 0.0]),
                geo_keys: Some(geo_key_directory(&[
                    (GT_MODEL_TYPE_GEO_KEY, MODEL_TYPE_GEOGRAPHIC),
                    (GEOGRAPHIC_TYPE_GEO_KEY, epsg),
                ])),
                ..Self::default()
            }
        }
    }

    /// Build a GeoKey directory: header (version 1.1.0, N keys) + inline
    /// SHORT entries.
    fn geo_key_directory(keys: &[(u16, u16)]) -> Vec<u16> {
        let mut dir = vec![1, 1, 0, keys.len() as u16];
        for &(id, value) in keys {
            dir.extend_from_slice(&[id, 0, 1, value]);
        }
        dir
    }

    fn write_geo_tags<W, K>(enc: &mut DirectoryEncoder<'_, W, K>, tags: &GeoTags)
    where
        W: Write + Seek,
        K: TiffKind,
    {
        if let Some(scale) = &tags.pixel_scale {
            enc.write_tag(Tag::ModelPixelScaleTag, &scale[..]).unwrap();
        }
        if let Some(tie) = &tags.tiepoint {
            enc.write_tag(Tag::ModelTiepointTag, &tie[..]).unwrap();
        }
        if let Some(keys) = &tags.geo_keys {
            enc.write_tag(Tag::GeoKeyDirectoryTag, &keys[..]).unwrap();
        }
        if let Some(nodata) = tags.nodata {
            enc.write_tag(Tag::GdalNodata, nodata).unwrap();
        }
        if let Some(matrix) = &tags.model_transformation {
            enc.write_tag(Tag::ModelTransformationTag, &matrix[..])
                .unwrap();
        }
    }

    fn write_with<C>(
        path: &Path,
        (w, h): (u32, u32),
        data: &[C::Inner],
        tags: &GeoTags,
        compression: Compression,
    ) where
        C: ColorType,
        [C::Inner]: TiffValue,
    {
        let mut enc = TiffEncoder::new(File::create(path).unwrap())
            .unwrap()
            .with_compression(compression);
        let mut img = enc.new_image::<C>(w, h).unwrap();
        write_geo_tags(img.encoder(), tags);
        img.write_data(data).unwrap();
    }

    fn write_f32(path: &Path, w: u32, h: u32, data: &[f32], tags: &GeoTags) {
        write_with::<Gray32Float>(path, (w, h), data, tags, Compression::Uncompressed);
    }

    fn expect_unsupported(result: Result<RasterBand, GeoTiffError>) {
        match result {
            Err(GeoTiffError::Unsupported { .. }) => {}
            other => panic!("expected Unsupported, got {other:?}"),
        }
    }

    fn expect_bad_geo(result: Result<RasterBand, GeoTiffError>) {
        match result {
            Err(GeoTiffError::BadGeoreferencing { .. }) => {}
            other => panic!("expected BadGeoreferencing, got {other:?}"),
        }
    }

    // ---------------------------------------------------------------------
    // Happy paths
    // ---------------------------------------------------------------------

    #[test]
    fn happy_path_f32_projected_reads_every_field() {
        let path = tmp("happy-f32");
        let data: Vec<f32> = (0..12).map(|i| i as f32 * 0.5 - 2.0).collect();
        let mut tags = GeoTags::projected(26910);
        tags.nodata = Some("-9999");
        write_f32(&path, 4, 3, &data, &tags);

        let band = read_geotiff(&path).unwrap();
        assert_eq!(band.width, 4);
        assert_eq!(band.height, 3);
        assert_eq!(band.dtype, RasterDtype::F32);
        match &band.data {
            RasterData::F32(v) => assert_eq!(v, &data),
            other => panic!("expected F32 data, got {other:?}"),
        }
        assert_eq!(band.nodata, Some(-9999.0));
        assert_eq!(band.pixel_size, (10.0, 10.0));
        assert_eq!(band.origin, (500_000.0, 5_200_000.0));
        assert_eq!(band.epsg, Some(26910));
        assert!(!band.geographic);
        // origin y - 10*3, origin x + 10*4 — all exactly representable.
        assert_eq!(
            band.bounds(),
            (500_000.0, 5_199_970.0, 500_040.0, 5_200_000.0)
        );
    }

    #[test]
    fn happy_path_i16_lzw() {
        let path = tmp("happy-i16");
        let data: Vec<i16> = vec![-32768, -1, 0, 1, 2, 32767];
        write_with::<GrayI16>(
            &path,
            (3, 2),
            &data,
            &GeoTags::projected(32610),
            Compression::Lzw,
        );

        let band = read_geotiff(&path).unwrap();
        assert_eq!((band.width, band.height), (3, 2));
        assert_eq!(band.dtype, RasterDtype::I16);
        match &band.data {
            RasterData::I16(v) => assert_eq!(v, &data),
            other => panic!("expected I16 data, got {other:?}"),
        }
        assert_eq!(band.nodata, None);
        assert_eq!(band.epsg, Some(32610));
        assert!(!band.geographic);
    }

    #[test]
    fn geographic_with_sane_bounds_reads() {
        let path = tmp("geo-sane");
        let tags = GeoTags::geographic(4326, (-123.0, 47.5), 0.01);
        write_f32(&path, 4, 4, &[1.5; 16], &tags);

        let band = read_geotiff(&path).unwrap();
        assert!(band.geographic);
        assert_eq!(band.epsg, Some(4326));
        let (w, s, e, n) = band.bounds();
        assert_eq!(w, -123.0);
        assert_eq!(n, 47.5);
        assert!((s - 47.46).abs() < 1e-9, "min_y {s}");
        assert!((e - -122.96).abs() < 1e-9, "max_x {e}");
    }

    #[test]
    fn nodata_with_padding_parses() {
        let path = tmp("nodata-pad");
        let mut tags = GeoTags::projected(26910);
        tags.nodata = Some("  -32768 ");
        write_f32(&path, 2, 2, &[0.0; 4], &tags);
        let band = read_geotiff(&path).unwrap();
        assert_eq!(band.nodata, Some(-32768.0));
    }

    // ---------------------------------------------------------------------
    // CRS resolution edge cases
    // ---------------------------------------------------------------------

    #[test]
    fn user_defined_crs_code_yields_epsg_none() {
        let path = tmp("user-defined-crs");
        write_f32(&path, 2, 2, &[0.0; 4], &GeoTags::projected(32767));
        let band = read_geotiff(&path).unwrap();
        assert_eq!(band.epsg, None);
        assert!(!band.geographic);
    }

    #[test]
    fn missing_geokeys_yield_epsg_none() {
        let path = tmp("no-geokeys");
        let mut tags = GeoTags::projected(26910);
        tags.geo_keys = None;
        write_f32(&path, 2, 2, &[0.0; 4], &tags);
        let band = read_geotiff(&path).unwrap();
        assert_eq!(band.epsg, None);
        assert!(!band.geographic);
    }

    // ---------------------------------------------------------------------
    // Rejections
    // ---------------------------------------------------------------------

    #[test]
    fn two_band_image_rejects() {
        let path = tmp("two-band");
        let mut enc = TiffEncoder::new(File::create(&path).unwrap()).unwrap();
        let mut img = enc.new_image::<Gray32Float>(2, 2).unwrap();
        img.extra_samples(&[ExtraSamples::Unspecified]).unwrap();
        write_geo_tags(img.encoder(), &GeoTags::projected(26910));
        img.write_data(&[0.0_f32; 8]).unwrap();
        expect_unsupported(read_geotiff(&path));
    }

    #[test]
    fn u8_dtype_rejects() {
        let path = tmp("u8-dtype");
        write_with::<Gray8>(
            &path,
            (2, 2),
            &[0_u8; 4],
            &GeoTags::projected(26910),
            Compression::Uncompressed,
        );
        expect_unsupported(read_geotiff(&path));
    }

    #[test]
    fn packbits_compression_rejects() {
        let path = tmp("packbits");
        write_with::<Gray32Float>(
            &path,
            (2, 2),
            &[0.0_f32; 4],
            &GeoTags::projected(26910),
            Compression::Packbits,
        );
        expect_unsupported(read_geotiff(&path));
    }

    #[test]
    fn missing_pixel_scale_rejects() {
        let path = tmp("no-pixel-scale");
        let mut tags = GeoTags::projected(26910);
        tags.pixel_scale = None;
        write_f32(&path, 2, 2, &[0.0; 4], &tags);
        expect_bad_geo(read_geotiff(&path));
    }

    #[test]
    fn missing_tiepoint_rejects() {
        let path = tmp("no-tiepoint");
        let mut tags = GeoTags::projected(26910);
        tags.tiepoint = None;
        write_f32(&path, 2, 2, &[0.0; 4], &tags);
        expect_bad_geo(read_geotiff(&path));
    }

    #[test]
    fn tiepoint_not_anchored_at_zero_rejects() {
        let path = tmp("tiepoint-off-origin");
        let mut tags = GeoTags::projected(26910);
        tags.tiepoint = Some(vec![8.0, 8.0, 0.0, 500_000.0, 5_200_000.0, 0.0]);
        write_f32(&path, 2, 2, &[0.0; 4], &tags);
        expect_bad_geo(read_geotiff(&path));
    }

    #[test]
    fn model_transformation_rejects() {
        let path = tmp("model-transformation");
        let mut tags = GeoTags::projected(26910);
        #[rustfmt::skip]
        let identity = vec![
            1.0, 0.0, 0.0, 0.0,
            0.0, 1.0, 0.0, 0.0,
            0.0, 0.0, 1.0, 0.0,
            0.0, 0.0, 0.0, 1.0,
        ];
        tags.model_transformation = Some(identity);
        write_f32(&path, 2, 2, &[0.0; 4], &tags);
        expect_unsupported(read_geotiff(&path));
    }

    #[test]
    fn multi_ifd_rejects() {
        let path = tmp("multi-ifd");
        let data = [0.0_f32; 4];
        let mut enc = TiffEncoder::new(File::create(&path).unwrap()).unwrap();
        let mut img = enc.new_image::<Gray32Float>(2, 2).unwrap();
        write_geo_tags(img.encoder(), &GeoTags::projected(26910));
        img.write_data(&data).unwrap();
        enc.write_image::<Gray32Float>(2, 2, &data).unwrap(); // overview IFD
        expect_unsupported(read_geotiff(&path));
    }

    #[test]
    fn geographic_with_projected_extent_rejects() {
        let path = tmp("geo-insane");
        // Geographic GeoKeys, but a UTM-sized extent: the CRS-PIPELINE
        // sanity check must catch this.
        let tags = GeoTags {
            pixel_scale: Some(vec![10.0, 10.0, 0.0]),
            tiepoint: Some(vec![0.0, 0.0, 0.0, 500_000.0, 5_200_000.0, 0.0]),
            geo_keys: Some(geo_key_directory(&[
                (GT_MODEL_TYPE_GEO_KEY, MODEL_TYPE_GEOGRAPHIC),
                (GEOGRAPHIC_TYPE_GEO_KEY, 4326),
            ])),
            ..GeoTags::default()
        };
        write_f32(&path, 2, 2, &[0.0; 4], &tags);
        expect_bad_geo(read_geotiff(&path));
    }

    #[test]
    fn unparseable_nodata_rejects() {
        let path = tmp("bad-nodata");
        let mut tags = GeoTags::projected(26910);
        tags.nodata = Some("not-a-number");
        write_f32(&path, 2, 2, &[0.0; 4], &tags);
        expect_bad_geo(read_geotiff(&path));
    }

    #[test]
    fn missing_file_is_io_error() {
        let path = tmp("never-written");
        match read_geotiff(&path) {
            Err(GeoTiffError::Io { .. }) => {}
            other => panic!("expected Io, got {other:?}"),
        }
    }

    // ---------------------------------------------------------------------
    // Tiled layout (hand-assembled: the tiff 0.11 encoder is strip-only)
    // ---------------------------------------------------------------------

    struct RawEntry {
        tag: u16,
        ty: u16, // TIFF field type: 2 ASCII, 3 SHORT, 4 LONG, 12 DOUBLE
        count: u32,
        payload: Vec<u8>, // little-endian value bytes
    }

    fn raw_short(tag: u16, v: u16) -> RawEntry {
        RawEntry {
            tag,
            ty: 3,
            count: 1,
            payload: v.to_le_bytes().to_vec(),
        }
    }

    fn raw_shorts(tag: u16, vs: &[u16]) -> RawEntry {
        RawEntry {
            tag,
            ty: 3,
            count: vs.len() as u32,
            payload: vs.iter().flat_map(|v| v.to_le_bytes()).collect(),
        }
    }

    fn raw_long(tag: u16, v: u32) -> RawEntry {
        RawEntry {
            tag,
            ty: 4,
            count: 1,
            payload: v.to_le_bytes().to_vec(),
        }
    }

    fn raw_longs(tag: u16, vs: &[u32]) -> RawEntry {
        RawEntry {
            tag,
            ty: 4,
            count: vs.len() as u32,
            payload: vs.iter().flat_map(|v| v.to_le_bytes()).collect(),
        }
    }

    fn raw_doubles(tag: u16, vs: &[f64]) -> RawEntry {
        RawEntry {
            tag,
            ty: 12,
            count: vs.len() as u32,
            payload: vs.iter().flat_map(|v| v.to_le_bytes()).collect(),
        }
    }

    /// Assemble a minimal little-endian classic TIFF: header, one IFD,
    /// external tag payloads, then tile data. The TileOffsets entry (324)
    /// must be present as a zero placeholder; it is patched here once the
    /// tile data offsets are known.
    fn write_raw_tiff(path: &Path, mut entries: Vec<RawEntry>, tile_data: &[Vec<u8>]) {
        entries.sort_by_key(|e| e.tag);
        let n = entries.len() as u32;
        let ifd_start: u32 = 8;
        let mut cursor = ifd_start + 2 + 12 * n + 4;

        // Lay out external payloads (word-aligned), then tile data.
        let mut placements: Vec<Option<u32>> = Vec::new();
        for e in &entries {
            if e.payload.len() > 4 {
                cursor += cursor % 2;
                placements.push(Some(cursor));
                cursor += e.payload.len() as u32;
            } else {
                placements.push(None);
            }
        }
        cursor += cursor % 2;
        let mut tile_offsets = Vec::with_capacity(tile_data.len());
        for td in tile_data {
            tile_offsets.push(cursor);
            cursor += td.len() as u32;
        }
        for e in entries.iter_mut().filter(|e| e.tag == 324) {
            e.payload = tile_offsets.iter().flat_map(|o| o.to_le_bytes()).collect();
        }

        let mut buf: Vec<u8> = Vec::new();
        buf.extend_from_slice(&[0x49, 0x49, 42, 0]); // "II", magic 42
        buf.extend_from_slice(&ifd_start.to_le_bytes());
        buf.extend_from_slice(&(n as u16).to_le_bytes());
        for (e, place) in entries.iter().zip(&placements) {
            buf.extend_from_slice(&e.tag.to_le_bytes());
            buf.extend_from_slice(&e.ty.to_le_bytes());
            buf.extend_from_slice(&e.count.to_le_bytes());
            match place {
                Some(offset) => buf.extend_from_slice(&offset.to_le_bytes()),
                None => {
                    let mut inline = e.payload.clone();
                    inline.resize(4, 0);
                    buf.extend_from_slice(&inline);
                }
            }
        }
        buf.extend_from_slice(&0_u32.to_le_bytes()); // no next IFD
        for (e, place) in entries.iter().zip(&placements) {
            if let Some(offset) = place {
                buf.resize(*offset as usize, 0);
                buf.extend_from_slice(&e.payload);
            }
        }
        for (td, offset) in tile_data.iter().zip(&tile_offsets) {
            buf.resize(*offset as usize, 0);
            buf.extend_from_slice(td);
        }
        std::fs::write(path, buf).unwrap();
    }

    #[test]
    fn tiled_f32_layout_reads_row_major() {
        let path = tmp("tiled-f32");
        let (w, h, tile_w, tile_h) = (32_u32, 16_u32, 16_u32, 16_u32);
        // Two 16x16 tiles side by side; global sample value = row*100 + col,
        // so any stitching mistake produces a mismatch.
        let mut tiles: Vec<Vec<u8>> = Vec::new();
        for tile_col in 0..2_u32 {
            let mut tile = Vec::with_capacity((tile_w * tile_h * 4) as usize);
            for r in 0..tile_h {
                for c in 0..tile_w {
                    let value = (r * 100 + tile_col * tile_w + c) as f32;
                    tile.extend_from_slice(&value.to_le_bytes());
                }
            }
            tiles.push(tile);
        }
        let byte_counts: Vec<u32> = tiles.iter().map(|t| t.len() as u32).collect();
        let entries = vec![
            raw_long(256, w),   // ImageWidth
            raw_long(257, h),   // ImageLength
            raw_short(258, 32), // BitsPerSample
            raw_short(259, 1),  // Compression: none
            raw_short(262, 1),  // PhotometricInterpretation: BlackIsZero
            raw_short(277, 1),  // SamplesPerPixel
            raw_short(339, 3),  // SampleFormat: IEEE float
            raw_long(322, tile_w),
            raw_long(323, tile_h),
            raw_longs(324, &vec![0; tiles.len()]), // TileOffsets (patched)
            raw_longs(325, &byte_counts),          // TileByteCounts
            raw_doubles(33550, &[10.0, 10.0, 0.0]),
            raw_doubles(33922, &[0.0, 0.0, 0.0, 500_000.0, 5_200_000.0, 0.0]),
            raw_shorts(
                34735,
                &geo_key_directory(&[
                    (GT_MODEL_TYPE_GEO_KEY, MODEL_TYPE_PROJECTED),
                    (PROJECTED_CS_TYPE_GEO_KEY, 26910),
                ]),
            ),
        ];
        write_raw_tiff(&path, entries, &tiles);

        let band = read_geotiff(&path).unwrap();
        assert_eq!((band.width, band.height), (32, 16));
        assert_eq!(band.dtype, RasterDtype::F32);
        assert_eq!(band.epsg, Some(26910));
        assert_eq!(band.pixel_size, (10.0, 10.0));
        let RasterData::F32(data) = &band.data else {
            panic!("expected F32 data");
        };
        assert_eq!(data.len(), 32 * 16);
        for r in 0..16_u32 {
            for c in 0..32_u32 {
                assert_eq!(
                    data[(r * 32 + c) as usize],
                    (r * 100 + c) as f32,
                    "sample at ({r}, {c})"
                );
            }
        }
    }

    // ---------------------------------------------------------------------
    // GeoKey parser unit checks (no file needed)
    // ---------------------------------------------------------------------

    #[test]
    fn geokey_non_inline_storage_yields_none() {
        // ProjectedCSType stored in the double-params tag (34736) instead of
        // inline: not interpreted, so no EPSG.
        let dir = [1, 1, 0, 2, 1024, 0, 1, 1, 3072, 34736, 1, 0];
        assert_eq!(parse_geo_keys(Some(&dir)), (false, None));
    }

    #[test]
    fn geokey_truncated_directory_yields_none() {
        assert_eq!(parse_geo_keys(Some(&[1, 1, 0])), (false, None));
        assert_eq!(parse_geo_keys(None), (false, None));
    }
}
