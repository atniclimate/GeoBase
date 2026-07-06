//! `.prj` WKT → EPSG identification, per the fallback ladder fixed in
//! docs/DECISIONS.md (2026-07-06):
//!
//! 1. An explicit `AUTHORITY["EPSG","<code>"]` on the **root** node wins.
//! 2. Else, a normalized-name match against the small curated table of CRSs
//!    GeoBase commonly meets (PNW UTM zones, geographic bases, web mercator).
//! 3. Else `Unknown` — the caller must obtain an **operator-declared** CRS
//!    (recorded in the audit trail) or reject. Identification never guesses.
//!
//! WKT1 normalization for matching: uppercase, collapse whitespace and
//! underscores. Matching is by PROJCS/GEOGCS *name only* — parameter-level
//! WKT comparison is deliberately out of scope (datum aliasing and TOWGS84
//! variance make string equality lie; see the adversarial review note).

/// How an EPSG identification was reached — recorded into audit details.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CrsIdentification {
    /// Root-node AUTHORITY["EPSG", code].
    AuthorityNode(u32),
    /// Normalized-name match in the curated table.
    CuratedMatch(u32),
    /// Not identifiable — caller must use an operator declaration or reject.
    Unknown,
}

impl CrsIdentification {
    pub fn epsg(&self) -> Option<u32> {
        match self {
            CrsIdentification::AuthorityNode(c) | CrsIdentification::CuratedMatch(c) => Some(*c),
            CrsIdentification::Unknown => None,
        }
    }

    /// Short method label for audit payloads.
    pub fn method(&self) -> &'static str {
        match self {
            CrsIdentification::AuthorityNode(_) => "authority-node",
            CrsIdentification::CuratedMatch(_) => "curated-match",
            CrsIdentification::Unknown => "unknown",
        }
    }
}

/// The curated table: (normalized WKT name, EPSG code). Kept deliberately
/// small; growth happens by deliberate review, not convenience.
/// NAD83 UTM 9-11N; WGS84 UTM 9-11N; NAD83 / WGS84 / NAD27 geographic;
/// web mercator.
pub const CURATED_CRS_NAMES: &[(&str, u32)] = &[
    ("NAD83 UTM ZONE 9N", 26909),
    ("NAD83 UTM ZONE 10N", 26910),
    ("NAD83 UTM ZONE 11N", 26911),
    ("WGS 84 UTM ZONE 9N", 32609),
    ("WGS 84 UTM ZONE 10N", 32610),
    ("WGS 84 UTM ZONE 11N", 32611),
    ("GCS NORTH AMERICAN 1983", 4269),
    ("NAD83", 4269),
    ("GCS WGS 1984", 4326),
    ("WGS 84", 4326),
    ("WEB MERCATOR AUXILIARY SPHERE", 3857),
    ("WGS 84 PSEUDO-MERCATOR", 3857),
    // ESRI name forms (ArcGIS/pyogrio .prj files carry these, usually with
    // no AUTHORITY node at all — the adversarial-review case that bites).
    ("NAD 1983 UTM ZONE 9N", 26909),
    ("NAD 1983 UTM ZONE 10N", 26910),
    ("NAD 1983 UTM ZONE 11N", 26911),
    ("WGS 1984 UTM ZONE 9N", 32609),
    ("WGS 1984 UTM ZONE 10N", 32610),
    ("WGS 1984 UTM ZONE 11N", 32611),
    ("WGS 1984 WEB MERCATOR AUXILIARY SPHERE", 3857),
];

/// Identify the EPSG code for a `.prj` WKT string per the module ladder.
pub fn identify_prj(wkt: &str) -> CrsIdentification {
    if let Some(code) = root_epsg_authority(wkt) {
        return CrsIdentification::AuthorityNode(code);
    }
    let Some(name) = root_name(wkt) else {
        return CrsIdentification::Unknown;
    };
    let normalized = normalize_name(&name);
    CURATED_CRS_NAMES
        .iter()
        .find_map(|(candidate, epsg)| {
            (normalize_name(candidate) == normalized)
                .then_some(CrsIdentification::CuratedMatch(*epsg))
        })
        .unwrap_or(CrsIdentification::Unknown)
}

fn normalize_name(name: &str) -> String {
    name.replace(['_', '/'], " ")
        .split_whitespace()
        .collect::<Vec<_>>()
        .join(" ")
        .to_ascii_uppercase()
}

fn root_name(wkt: &str) -> Option<String> {
    let trimmed = wkt.trim_start();
    let open = trimmed.find('[')?;
    let node = trimmed[..open].trim().to_ascii_uppercase();
    if node != "PROJCS" && node != "GEOGCS" {
        return None;
    }
    let rest = trimmed[open + 1..].trim_start();
    if !rest.starts_with('"') {
        return None;
    }
    parse_quoted(rest, 0).map(|(name, _)| name)
}

fn root_epsg_authority(wkt: &str) -> Option<u32> {
    let root = root_body(wkt)?;
    let mut search_at = 0;
    while let Some(relative) = root[search_at..].to_ascii_uppercase().find("AUTHORITY[") {
        let start = search_at + relative;
        if bracket_depth_before(&root, start) == 0 {
            if let Some(code) = parse_epsg_authority(&root[start..]) {
                return Some(code);
            }
        }
        search_at = start + "AUTHORITY[".len();
    }
    None
}

fn root_body(wkt: &str) -> Option<String> {
    let open = wkt.find('[')?;
    let mut depth = 0_i32;
    let mut end = None;
    for (idx, ch) in wkt[open..].char_indices() {
        match ch {
            '[' => depth += 1,
            ']' => {
                depth -= 1;
                if depth == 0 {
                    end = Some(open + idx);
                    break;
                }
            }
            _ => {}
        }
    }
    end.map(|e| wkt[open + 1..e].to_string())
}

fn bracket_depth_before(s: &str, byte_idx: usize) -> i32 {
    s[..byte_idx].chars().fold(0, |depth, ch| match ch {
        '[' => depth + 1,
        ']' => depth - 1,
        _ => depth,
    })
}

fn parse_epsg_authority(s: &str) -> Option<u32> {
    let open = s.find('[')?;
    let mut pos = open + 1;
    let (authority, next) = parse_quoted(s, pos)?;
    if !authority.eq_ignore_ascii_case("EPSG") {
        return None;
    }
    pos = next;
    pos += s[pos..].find(',')? + 1;
    let (code, _) = parse_quoted(s, pos)?;
    code.parse().ok()
}

fn parse_quoted(s: &str, start: usize) -> Option<(String, usize)> {
    let bytes = s.as_bytes();
    let mut pos = start;
    while pos < bytes.len() && bytes[pos].is_ascii_whitespace() {
        pos += 1;
    }
    if bytes.get(pos) != Some(&b'"') {
        return None;
    }
    pos += 1;
    let mut out = String::new();
    while pos < bytes.len() {
        match bytes[pos] {
            b'"' => return Some((out, pos + 1)),
            b'\\' if bytes.get(pos + 1) == Some(&b'"') => {
                out.push('"');
                pos += 2;
            }
            b => {
                out.push(char::from(b));
                pos += 1;
            }
        }
    }
    None
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn root_authority_wins_over_nested_authorities() {
        let wkt = r#"PROJCS["NAD83 / UTM zone 10N",GEOGCS["NAD83",AUTHORITY["EPSG","4269"]],AUTHORITY["EPSG","26910"]]"#;
        assert_eq!(identify_prj(wkt), CrsIdentification::AuthorityNode(26910));
    }

    #[test]
    fn nested_authority_does_not_identify_root() {
        let wkt = r#"PROJCS["NAD83 / UTM zone 10N",GEOGCS["NAD83",AUTHORITY["EPSG","4269"]]]"#;
        assert_eq!(identify_prj(wkt), CrsIdentification::CuratedMatch(26910));
    }

    #[test]
    fn curated_match_normalizes_underscores_and_case() {
        assert_eq!(
            identify_prj(r#"PROJCS["NAD83_UTM_zone_10N"]"#),
            CrsIdentification::CuratedMatch(26910)
        );
    }

    #[test]
    fn esri_name_form_matches_curated_table() {
        // Real-world shape of a pyogrio/ArcGIS .prj: ESRI names, no AUTHORITY.
        let wkt = r#"PROJCS["NAD_1983_UTM_Zone_10N",GEOGCS["GCS_North_American_1983",DATUM["D_North_American_1983",SPHEROID["GRS_1980",6378137.0,298.257222101]],PRIMEM["Greenwich",0.0],UNIT["Degree",0.0174532925199433]],PROJECTION["Transverse_Mercator"],UNIT["Meter",1.0]]"#;
        assert_eq!(identify_prj(wkt), CrsIdentification::CuratedMatch(26910));
    }

    #[test]
    fn unknown_stays_unknown() {
        assert_eq!(
            identify_prj(r#"PROJCS["Local grid"]"#),
            CrsIdentification::Unknown
        );
    }
}
