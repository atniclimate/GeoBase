//! Typed consent schema — Phase B, item B3 (`docs/CEREMONY-DESIGN.md` §2).
//!
//! These types make invalid authorizations **unconstructible** rather than
//! merely checked: an evidence-thin `ConsentBasis`, a future-dated
//! acknowledgment, a non-T2 `FpicAuthorization`, or a free-text identity
//! cannot be built. Every constructor performs *semantic* validation and
//! returns `Err` on violation — the type system is the first gate.
//!
//! Ratified shapes: identity + consent schema 2026-07-08 (threat model
//! §4–§5), re-ratified richer evidence + authority-of-record split
//! 2026-07-16 (`docs/CEREMONY-DESIGN.md` §2, `docs/DECISIONS.md`).
//!
//! Free text is the enemy here. Where a `String` survives (attestations,
//! purpose limits, authority names), it is *recorded agreement content*
//! copied from the consent store — never a request-supplied claim.

use geobase_tsdf::Tier;
use serde_json::{json, Value};
use time::format_description::well_known::Rfc3339;
use time::OffsetDateTime;

/// Errors from consent-schema constructors. Every variant names the rule
/// that was violated — callers surface these verbatim as `Declined`
/// reasons or recording failures.
#[derive(Debug, thiserror::Error, PartialEq, Eq)]
pub enum ConsentSchemaError {
    #[error("empty value: {0} must be non-empty (evidence-thin authorization is unconstructible)")]
    Empty(&'static str),
    #[error("invalid SHA-256 digest: expected exactly 64 hex characters, got {0}")]
    BadDigest(String),
    #[error("invalid UTC instant '{0}': {1}")]
    BadInstant(String, String),
    #[error("{0} is future-dated ({1}) relative to the node clock ({2}) — evidence cannot postdate its recording")]
    FutureDated(&'static str, String, String),
    #[error(
        "node clock is implausible ({0}) — an invalid or unavailable clock is an \
         infrastructure failure, never an authorization (design §2.5)"
    )]
    ImplausibleClock(String),
    #[error(
        "FpicAuthorization target tier must be T2 — got {0} (T3 is unconstructible by design; \
         T0/T1 need no FPIC authorization)"
    )]
    NotT2(String),
}

/// A validated 32-byte SHA-256 digest. Constructed only from exactly 64
/// hex characters; stored as bytes, displayed as lowercase hex.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Sha256Digest([u8; 32]);

impl Sha256Digest {
    pub fn from_hex(hex: &str) -> Result<Self, ConsentSchemaError> {
        let hex = hex.trim();
        if hex.len() != 64 || !hex.chars().all(|c| c.is_ascii_hexdigit()) {
            return Err(ConsentSchemaError::BadDigest(hex.to_string()));
        }
        let mut bytes = [0u8; 32];
        for (i, byte) in bytes.iter_mut().enumerate() {
            *byte = u8::from_str_radix(&hex[2 * i..2 * i + 2], 16)
                .map_err(|_| ConsentSchemaError::BadDigest(hex.to_string()))?;
        }
        Ok(Self(bytes))
    }

    pub fn to_hex(&self) -> String {
        self.0.iter().map(|b| format!("{b:02x}")).collect()
    }
}

/// A validated UTC instant. Parses strict RFC 3339 and normalizes to UTC;
/// `now()` reads the node clock **checked for plausibility** — an
/// implausible clock is an infrastructure failure (`docs/CEREMONY-DESIGN.md`
/// §2.5, §5.3), never a silently-wrong timestamp in a sovereign record.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub struct UtcInstant(OffsetDateTime);

/// Clock plausibility floor: this code did not exist before 2026 — a node
/// clock reading earlier is broken, not early.
const CLOCK_FLOOR_UNIX: i64 = 1_767_225_600; // 2026-01-01T00:00:00Z

impl UtcInstant {
    /// Parse a strict RFC 3339 instant; any offset is normalized to UTC.
    pub fn parse_rfc3339(s: &str) -> Result<Self, ConsentSchemaError> {
        let parsed = OffsetDateTime::parse(s, &Rfc3339)
            .map_err(|e| ConsentSchemaError::BadInstant(s.to_string(), e.to_string()))?;
        Ok(Self(parsed.to_offset(time::UtcOffset::UTC)))
    }

    /// The node clock, checked: refuses an implausible reading rather than
    /// stamping sovereign records with it.
    pub fn now() -> Result<Self, ConsentSchemaError> {
        let now = OffsetDateTime::now_utc();
        if now.unix_timestamp() < CLOCK_FLOOR_UNIX || now.year() > 9000 {
            return Err(ConsentSchemaError::ImplausibleClock(
                Self(now).to_rfc3339(),
            ));
        }
        Ok(Self(now))
    }

    pub fn to_rfc3339(&self) -> String {
        self.0
            .format(&Rfc3339)
            .unwrap_or_else(|_| format!("(unformattable instant: unix {})", self.0.unix_timestamp()))
    }

    pub fn unix_timestamp(&self) -> i64 {
        self.0.unix_timestamp()
    }
}

/// Who performed an authorization act — the **authenticated** actor, never
/// a free-text claim (ratified 2026-07-08; §2.1). Distinct from the
/// authority-of-record, which is agreement content copied from the store.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ExportIdentity {
    /// The enrolled local operator (opaque enrollment reference; the full
    /// OS-keychain credential lands at B5 — until then the reference names
    /// the interim operator guard that authenticated the request).
    LocalOperator { enrollment_ref: String },
    /// SCHEMA-PRESENT BUT UNISSUABLE (design §7): no production issuance
    /// path exists until the owner ratifies a Tribal-authority issuer
    /// ceremony. The token type has no public constructor.
    TribalDelegate { token: DelegateToken },
}

/// Opaque delegate token. Deliberately unconstructible outside this crate's
/// tests: operator-issued delegation is a sovereignty inversion, so release
/// code CANNOT mint one (`docs/CEREMONY-DESIGN.md` §7).
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DelegateToken(#[allow(dead_code)] String);

impl DelegateToken {
    /// Test-only issuance, for proving the delegate path is refused/inert.
    #[cfg(test)]
    pub(crate) fn test_only(token: &str) -> Self {
        Self(token.to_string())
    }
}

impl ExportIdentity {
    pub fn local_operator(enrollment_ref: &str) -> Result<Self, ConsentSchemaError> {
        let enrollment_ref = enrollment_ref.trim();
        if enrollment_ref.is_empty() {
            return Err(ConsentSchemaError::Empty("enrollment_ref"));
        }
        Ok(Self::LocalOperator {
            enrollment_ref: enrollment_ref.to_string(),
        })
    }

    /// Audit-trail representation: variant-tagged, never bare free text.
    pub fn audit_string(&self) -> String {
        match self {
            Self::LocalOperator { enrollment_ref } => {
                format!("local-operator:{enrollment_ref}")
            }
            Self::TribalDelegate { .. } => "tribal-delegate:(token withheld from audit)".into(),
        }
    }
}

/// A witness identity — non-empty by construction.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Witness(String);

impl Witness {
    pub fn new(name: &str) -> Result<Self, ConsentSchemaError> {
        let name = name.trim();
        if name.is_empty() {
            return Err(ConsentSchemaError::Empty("witness identity"));
        }
        Ok(Self(name.to_string()))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

/// The consent evidence — re-ratified RICHER 2026-07-16 (§2.2) so an
/// evidence-thin authorization is unconstructible. The node cannot verify
/// a human; it binds the recorder's **attestation** that verification
/// happened. Legal-document bytes are never stored: reference + hash only,
/// and `document_ref` is NEVER dereferenced over any network during
/// authorization (no code path exists to do so).
#[derive(Debug, Clone, PartialEq)]
pub enum ConsentBasis {
    /// Tribal data: a formal signed agreement.
    SignedAgreement {
        document_ref: String,
        document_hash: Sha256Digest,
        acknowledged_at: UtcInstant,
    },
    /// Individual data: verbal consent with verified witnesses. The verbal
    /// method is encoded by the variant, not a caller string.
    WitnessedVerbal {
        witnesses: Vec<Witness>,
        verification_attestation: String,
    },
}

impl ConsentBasis {
    /// Construct signed-agreement evidence. `now` is the checked node
    /// clock: an acknowledgment dated after it is refused.
    pub fn signed_agreement(
        document_ref: &str,
        document_hash: Sha256Digest,
        acknowledged_at: UtcInstant,
        now: UtcInstant,
    ) -> Result<Self, ConsentSchemaError> {
        let document_ref = document_ref.trim();
        if document_ref.is_empty() {
            return Err(ConsentSchemaError::Empty("document_ref"));
        }
        if acknowledged_at > now {
            return Err(ConsentSchemaError::FutureDated(
                "acknowledged_at",
                acknowledged_at.to_rfc3339(),
                now.to_rfc3339(),
            ));
        }
        Ok(Self::SignedAgreement {
            document_ref: document_ref.to_string(),
            document_hash,
            acknowledged_at,
        })
    }

    /// Construct witnessed-verbal evidence: at least one witness, plus a
    /// non-empty attestation of who verified the witnesses and how.
    pub fn witnessed_verbal(
        witnesses: Vec<Witness>,
        verification_attestation: &str,
    ) -> Result<Self, ConsentSchemaError> {
        if witnesses.is_empty() {
            return Err(ConsentSchemaError::Empty("witnesses"));
        }
        let attestation = verification_attestation.trim();
        if attestation.is_empty() {
            return Err(ConsentSchemaError::Empty("verification_attestation"));
        }
        Ok(Self::WitnessedVerbal {
            witnesses,
            verification_attestation: attestation.to_string(),
        })
    }

    /// The evidence as an audit-row JSON object — one shape, one writer.
    /// Field names are agreement-time evidence names, deliberately distinct
    /// from export-time resolved-source names (§4).
    pub fn audit_json(&self) -> Value {
        match self {
            Self::SignedAgreement {
                document_ref,
                document_hash,
                acknowledged_at,
            } => json!({
                "kind": "signed_agreement",
                "document_ref": document_ref,
                "agreement_evidence_hash": document_hash.to_hex(),
                "acknowledged_at": acknowledged_at.to_rfc3339(),
            }),
            Self::WitnessedVerbal {
                witnesses,
                verification_attestation,
            } => json!({
                "kind": "witnessed_verbal",
                "method": "verbal",
                "witnesses": witnesses.iter().map(Witness::as_str).collect::<Vec<_>>(),
                "verification_attestation": verification_attestation,
            }),
        }
    }
}

/// Typed conditions attached to a recorded agreement (§2.5). The free-text
/// `Vec<String>` is ABOLISHED. Expiry is enforced fail-closed in 1.0;
/// purpose/geography are recorded-but-advisory (recorded agreement terms,
/// not enforced predicates — the basis string never claims otherwise).
#[derive(Debug, Clone, PartialEq, Eq, Default)]
pub struct Conditions {
    /// Full UTC instant, resolved BY THE HUMAN at recording time — code
    /// never interprets a date.
    pub expires_at: Option<UtcInstant>,
    pub purpose_limit: Option<String>,
    pub geography_limit: Option<String>,
}

impl Conditions {
    pub fn audit_json(&self) -> Value {
        json!({
            "expires_at": self.expires_at.as_ref().map(UtcInstant::to_rfc3339),
            "purpose_limit": self.purpose_limit,
            "geography_limit": self.geography_limit,
            "enforcement": {
                "expires_at": "enforced fail-closed",
                "purpose_limit": "recorded-advisory (1.0)",
                "geography_limit": "recorded-advisory (1.0)",
            },
        })
    }
}

/// The authorization act (§2.3): constructor-enforced so an invalid or T3
/// authorization cannot be built. `fpic_satisfied` is DERIVED — set true by
/// this constructor only, which the gate calls only from an active,
/// evidence-complete store record — never asserted by a caller.
#[derive(Debug, Clone, PartialEq)]
pub struct FpicAuthorization {
    target_tier: Tier,
    fpic_satisfied: bool,
    consent_basis: ConsentBasis,
    authorized_by: ExportIdentity,
    timestamp: UtcInstant,
}

impl FpicAuthorization {
    pub fn new(
        target_tier: Tier,
        consent_basis: ConsentBasis,
        authorized_by: ExportIdentity,
        timestamp: UtcInstant,
    ) -> Result<Self, ConsentSchemaError> {
        if target_tier != Tier::T2 {
            return Err(ConsentSchemaError::NotT2(target_tier.code().to_string()));
        }
        Ok(Self {
            target_tier,
            fpic_satisfied: true,
            consent_basis,
            authorized_by,
            timestamp,
        })
    }

    pub fn target_tier(&self) -> Tier {
        self.target_tier
    }

    pub fn fpic_satisfied(&self) -> bool {
        self.fpic_satisfied
    }

    pub fn consent_basis(&self) -> &ConsentBasis {
        &self.consent_basis
    }

    pub fn authorized_by(&self) -> &ExportIdentity {
        &self.authorized_by
    }

    pub fn timestamp(&self) -> UtcInstant {
        self.timestamp
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn digest() -> Sha256Digest {
        Sha256Digest::from_hex(&"ab".repeat(32)).unwrap()
    }

    fn t(s: &str) -> UtcInstant {
        UtcInstant::parse_rfc3339(s).unwrap()
    }

    #[test]
    fn digest_requires_exactly_64_hex_chars() {
        assert!(Sha256Digest::from_hex(&"ab".repeat(32)).is_ok());
        assert!(Sha256Digest::from_hex(&"AB".repeat(32)).is_ok());
        for bad in ["", "abcd", &"ab".repeat(31), &"zz".repeat(32), &"ab".repeat(33)] {
            assert!(Sha256Digest::from_hex(bad).is_err(), "{bad:?}");
        }
        assert_eq!(digest().to_hex(), "ab".repeat(32));
    }

    #[test]
    fn instant_parses_rfc3339_and_normalizes_to_utc() {
        let utc = t("2026-07-16T12:00:00Z");
        let offset = t("2026-07-16T05:00:00-07:00");
        assert_eq!(utc, offset);
        assert_eq!(utc.to_rfc3339(), "2026-07-16T12:00:00Z");
        assert!(UtcInstant::parse_rfc3339("2026-07-16").is_err());
        assert!(UtcInstant::parse_rfc3339("not a date").is_err());
    }

    #[test]
    fn checked_now_is_plausible() {
        // On any sane test machine the clock is past the 2026 floor.
        let now = UtcInstant::now().unwrap();
        assert!(now.unix_timestamp() >= super::CLOCK_FLOOR_UNIX);
    }

    #[test]
    fn identity_rejects_empty_enrollment_ref_and_never_prints_tokens() {
        assert!(ExportIdentity::local_operator("").is_err());
        assert!(ExportIdentity::local_operator("   ").is_err());
        let op = ExportIdentity::local_operator("op-1").unwrap();
        assert_eq!(op.audit_string(), "local-operator:op-1");
        let delegate = ExportIdentity::TribalDelegate {
            token: DelegateToken::test_only("secret-token"),
        };
        assert!(!delegate.audit_string().contains("secret-token"));
    }

    #[test]
    fn signed_agreement_rejects_thin_or_future_evidence() {
        let now = t("2026-07-16T12:00:00Z");
        let ok = ConsentBasis::signed_agreement(
            "agreements/example-2026-07.pdf",
            digest(),
            t("2026-07-01T00:00:00Z"),
            now,
        );
        assert!(ok.is_ok());
        assert!(ConsentBasis::signed_agreement("", digest(), t("2026-07-01T00:00:00Z"), now).is_err());
        let future = ConsentBasis::signed_agreement(
            "agreements/x.pdf",
            digest(),
            t("2027-01-01T00:00:00Z"),
            now,
        );
        assert!(matches!(future, Err(ConsentSchemaError::FutureDated(..))));
    }

    #[test]
    fn witnessed_verbal_rejects_empty_witnesses_or_attestation() {
        assert!(ConsentBasis::witnessed_verbal(vec![], "verified by operator in person").is_err());
        let w = vec![Witness::new("Witness A").unwrap()];
        assert!(ConsentBasis::witnessed_verbal(w.clone(), "  ").is_err());
        assert!(Witness::new(" ").is_err());
        let basis = ConsentBasis::witnessed_verbal(w, "operator verified both witnesses by ID").unwrap();
        let json = basis.audit_json();
        assert_eq!(json["kind"], "witnessed_verbal");
        assert_eq!(json["method"], "verbal");
    }

    #[test]
    fn fpic_authorization_is_unconstructible_for_non_t2() {
        let now = t("2026-07-16T12:00:00Z");
        let basis = ConsentBasis::signed_agreement(
            "agreements/x.pdf",
            digest(),
            t("2026-07-01T00:00:00Z"),
            now,
        )
        .unwrap();
        let op = ExportIdentity::local_operator("op-1").unwrap();
        for tier in [Tier::T0, Tier::T1, Tier::T3] {
            let err =
                FpicAuthorization::new(tier, basis.clone(), op.clone(), now).unwrap_err();
            assert!(matches!(err, ConsentSchemaError::NotT2(_)), "{tier:?}");
        }
        let auth = FpicAuthorization::new(Tier::T2, basis, op, now).unwrap();
        assert!(auth.fpic_satisfied());
        assert_eq!(auth.target_tier(), Tier::T2);
    }

    #[test]
    fn evidence_audit_json_uses_agreement_time_field_names() {
        let now = t("2026-07-16T12:00:00Z");
        let basis = ConsentBasis::signed_agreement(
            "agreements/x.pdf",
            digest(),
            t("2026-07-01T00:00:00Z"),
            now,
        )
        .unwrap();
        let json = basis.audit_json();
        // Distinct from export-time resolved-source hash field names (§4).
        assert!(json.get("agreement_evidence_hash").is_some());
        assert!(json.get("resolved_source_hashes").is_none());
    }
}
