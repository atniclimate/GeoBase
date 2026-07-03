//! The CRS pipeline contract: validate → store native → reproject to the
//! viewer CRS, asserting at every hop. See `docs/CRS-PIPELINE.md`.
//!
//! This module carries the *contract* — parse/validate CRS identifiers,
//! sanity-check bounds (the swapped lon/lat and wrong-UTM-zone class of bug),
//! and assert that a pipeline hop preserved what it claimed to preserve.
//! Raster reprojection itself arrives with Weir proper (Phase 0.3).

use crate::Crs;

/// Errors from CRS validation and hop assertions.
#[derive(Debug, thiserror::Error, PartialEq)]
pub enum CrsError {
    #[error("CRS '{0}' is not an EPSG code of the form 'EPSG:<number>'")]
    NotEpsg(String),
    #[error("bounds are not sane lon/lat (swapped axes or wrong CRS?): {0:?}")]
    BadLonLatBounds([f64; 4]),
    #[error("CRS changed across hop '{hop}': expected {expected}, got {actual}")]
    HopMismatch {
        hop: String,
        expected: String,
        actual: String,
    },
}

impl Crs {
    /// The numeric EPSG code, if this is a well-formed `EPSG:<code>` identifier.
    pub fn epsg_code(&self) -> Option<u32> {
        self.0
            .strip_prefix("EPSG:")
            .and_then(|code| code.parse::<u32>().ok())
            .filter(|&code| code != 0)
    }

    /// Validate on ingest: every CRS must be a known, parseable identifier.
    /// Missing or unparseable CRS is rejected — never assumed.
    pub fn validate(&self) -> Result<u32, CrsError> {
        self.epsg_code()
            .ok_or_else(|| CrsError::NotEpsg(self.0.clone()))
    }
}

/// Geographic bounds as `[west, south, east, north]` in degrees.
///
/// The sanity check catches the prototype's silent-mismatch pitfalls: swapped
/// lon/lat (latitude outside ±90), inverted extents, and projected coordinates
/// masquerading as degrees.
pub fn validate_lonlat_bounds(bounds: [f64; 4]) -> Result<(), CrsError> {
    let [west, south, east, north] = bounds;
    let sane = (-180.0..=180.0).contains(&west)
        && (-180.0..=180.0).contains(&east)
        && (-90.0..=90.0).contains(&south)
        && (-90.0..=90.0).contains(&north)
        && west < east
        && south < north;
    if sane {
        Ok(())
    } else {
        Err(CrsError::BadLonLatBounds(bounds))
    }
}

/// Assert a pipeline hop preserved the CRS it claimed to preserve.
/// Never swallow a CRS error — a failed hop is a loud stop, not a warning.
pub fn assert_hop(hop: &str, expected: &Crs, actual: &Crs) -> Result<(), CrsError> {
    if expected == actual {
        Ok(())
    } else {
        Err(CrsError::HopMismatch {
            hop: hop.to_string(),
            expected: expected.0.clone(),
            actual: actual.0.clone(),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn epsg_codes_parse_and_validate() {
        assert_eq!(Crs::epsg(26910).validate(), Ok(26910));
        assert_eq!(Crs("EPSG:3857".into()).validate(), Ok(3857));
        assert!(Crs("utm10n".into()).validate().is_err());
        assert!(Crs("EPSG:".into()).validate().is_err());
        assert!(Crs("EPSG:0".into()).validate().is_err());
    }

    #[test]
    fn swapped_axes_are_caught() {
        // Squaxin AOI, correct order: fine.
        assert!(validate_lonlat_bounds([-123.15, 47.1, -122.85, 47.25]).is_ok());
        // lat/lon swapped: latitude 123 is impossible.
        assert!(validate_lonlat_bounds([47.1, -123.15, 47.25, -122.85]).is_err());
        // UTM meters masquerading as degrees.
        assert!(validate_lonlat_bounds([492090.0, 5218600.0, 508280.0, 5230300.0]).is_err());
        // Inverted extent.
        assert!(validate_lonlat_bounds([-122.85, 47.1, -123.15, 47.25]).is_err());
    }

    #[test]
    fn hop_mismatch_is_loud() {
        let native = Crs::epsg(26910);
        assert!(assert_hop("store-native", &native, &Crs::epsg(26910)).is_ok());
        let err = assert_hop("reproject", &Crs::epsg(3857), &native).unwrap_err();
        assert!(matches!(err, CrsError::HopMismatch { .. }));
    }
}
