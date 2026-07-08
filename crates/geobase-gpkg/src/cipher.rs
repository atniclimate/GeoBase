//! `AtRestCipher` — the at-rest encryption **seam** for T3 sovereign data.
//!
//! This is the seam half of Phase 1.2's architectural egress guarantee.
//! Every code path that writes a T3 artifact to disk authorizes through an
//! [`AtRestCipher`] BEFORE any bytes land, exactly as every export passes
//! [`crate::ceremony::CeremonyGate`] before release. The sovereign crypto
//! implementation (SQLCipher-or-equivalent) lands behind this trait in
//! Phase 1.2; freezing the seam now means every new T3-producing write path
//! (sim outputs, LiDAR ingests, the export ledger) is wired through it from
//! day one — no retrofit hunt later.
//!
//! ## The invariant this enforces: fail-closed, never silent plaintext
//!
//! The default is [`FailClosedCipher`]: a node with no cipher configured
//! **refuses to write T3 at rest**. "We forgot to encrypt" becomes a loud
//! runtime refusal, not a plaintext leak. This is the direct fix for the
//! plaintext-ledger class of bug (a T3-tagged artifact written unencrypted).
//!
//! [`DevPlaintextCipher`] is the ONLY escape hatch, and it is deliberately
//! poisoned: it writes T3 in plaintext but forces every such artifact to
//! carry the [`UNENCRYPTED_DEV_STAMP`] in its TSDF tag, so a production node
//! can refuse to treat it as valid sovereign data. It must be opted into by
//! local dev/test config only — never constructed on a production node.
//!
//! ## Lost-key policy (governance, recorded here so the seam reflects it)
//!
//! The sovereign decision (2026-07-07, Patrick) is **deliberately
//! unrecoverable**: no escrow, no master key, no developer backdoor. If a
//! Tribe loses their key, the T3 data on that node is cryptographically
//! destroyed. A backdoor recovery mechanism is a systemic sovereignty
//! compromise and will not be built. The real cipher impl MUST NOT add one.

use geobase_tsdf::Tier;

use crate::requires_encryption;

/// The stamp written into a T3 artifact's TSDF tag when it was produced by
/// [`DevPlaintextCipher`] — i.e. written in plaintext for local dev only.
///
/// Its presence permanently marks the artifact as non-production. A
/// production node MUST refuse to treat an artifact carrying this stamp as
/// valid sovereign data (enforcement lands with the real cipher; the stamp
/// is written now so the poison travels with the bytes from day one).
pub const UNENCRYPTED_DEV_STAMP: &str = "UNENCRYPTED-DEV";

/// The at-rest protection a write actually received — returned by
/// [`AtRestCipher::authorize_at_rest`] so the caller can stamp the artifact.
///
/// Note there is deliberately **no `Encrypted` variant yet**. This seam only
/// *authorizes* a write; it does not *apply* encryption. A variant claiming
/// "encrypted" before a real cipher applies it would be a false assurance
/// (a plaintext GPKG stamped `encrypted`). The Phase 1.2 crypto impl adds the
/// real encryption path (a create/open hook) AND the protection value that
/// truthfully reflects it — not before. See `docs/handoffs/phase-1.2-threat-model.md`.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AtRestProtection {
    /// The tier does not require at-rest encryption (T0–T2). No stamp.
    NotRequired,
    /// Local-dev only: written in plaintext, MUST be stamped
    /// [`UNENCRYPTED_DEV_STAMP`].
    UnencryptedDev,
}

/// Refusal to write tier data at rest without configured encryption — the
/// fail-closed outcome. A first-class, expected result (no panic): the
/// caller surfaces it and writes nothing.
#[derive(Debug, Clone, Copy, thiserror::Error)]
#[error(
    "at-rest encryption is not configured — refusing to write tier {} data in plaintext \
     (fail-closed: T3 never touches disk unencrypted; configure a cipher, or for local \
     dev only opt into the UNENCRYPTED-DEV cipher)",
    .tier.code()
)]
pub struct EncryptionRefused {
    /// The tier whose at-rest write was refused.
    pub tier: Tier,
}

/// The at-rest encryption seam. Frozen interface (the `CeremonyGate` /
/// `PaintTool` doctrine): the sovereign crypto impl replaces the default
/// behind this trait, and callers cannot tell implementations apart except
/// through the [`AtRestProtection`] they return or the refusal they raise.
///
/// `Debug` is a supertrait so a node's configured cipher can live in
/// `Debug`-deriving config/state structs.
pub trait AtRestCipher: std::fmt::Debug + Send + Sync {
    /// Authorize an at-rest write of `tier`, or refuse it. Fail-closed
    /// implementations refuse when `tier` [`requires_encryption`] and no
    /// real cipher backs them; tiers that do not require encryption always
    /// return [`AtRestProtection::NotRequired`].
    fn authorize_at_rest(&self, tier: Tier) -> Result<AtRestProtection, EncryptionRefused>;
}

/// The default: **refuses** to write T3 at rest. A node with no configured
/// cipher cannot produce sovereign artifacts. Carries no configuration —
/// there is nothing to widen.
#[derive(Debug, Clone, Copy, Default)]
pub struct FailClosedCipher;

impl AtRestCipher for FailClosedCipher {
    fn authorize_at_rest(&self, tier: Tier) -> Result<AtRestProtection, EncryptionRefused> {
        if requires_encryption(tier) {
            Err(EncryptionRefused { tier })
        } else {
            Ok(AtRestProtection::NotRequired)
        }
    }
}

/// **LOCAL DEV / TEST ONLY.** Writes T3 in plaintext but forces the
/// [`UNENCRYPTED_DEV_STAMP`] onto the artifact so it can never be mistaken
/// for production sovereign data. Must be opted into explicitly by local
/// config; a production node MUST NOT construct this.
#[derive(Debug, Clone, Copy, Default)]
pub struct DevPlaintextCipher;

impl DevPlaintextCipher {
    /// Construct the dev cipher. Naming the call site is the point: it must
    /// be a deliberate, greppable act, never a default.
    pub fn new() -> Self {
        Self
    }
}

impl AtRestCipher for DevPlaintextCipher {
    fn authorize_at_rest(&self, tier: Tier) -> Result<AtRestProtection, EncryptionRefused> {
        if requires_encryption(tier) {
            Ok(AtRestProtection::UnencryptedDev)
        } else {
            Ok(AtRestProtection::NotRequired)
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// CONTRACT: the default refuses T3 at rest, unconditionally.
    #[test]
    fn fail_closed_refuses_t3_and_permits_lower_tiers() {
        let cipher = FailClosedCipher;
        let err = cipher.authorize_at_rest(Tier::T3).unwrap_err();
        assert_eq!(err.tier, Tier::T3);
        assert!(err.to_string().contains("fail-closed"));
        for tier in [Tier::T0, Tier::T1, Tier::T2] {
            assert_eq!(
                cipher.authorize_at_rest(tier).unwrap(),
                AtRestProtection::NotRequired
            );
        }
    }

    /// CONTRACT: the dev cipher permits T3 but only as poisoned plaintext.
    #[test]
    fn dev_cipher_permits_t3_as_stamped_plaintext() {
        let cipher = DevPlaintextCipher::new();
        assert_eq!(
            cipher.authorize_at_rest(Tier::T3).unwrap(),
            AtRestProtection::UnencryptedDev
        );
        // Lower tiers need no encryption and so carry no dev stamp.
        assert_eq!(
            cipher.authorize_at_rest(Tier::T0).unwrap(),
            AtRestProtection::NotRequired
        );
    }

    /// The poison stamp is a fixed, greppable constant.
    #[test]
    fn dev_stamp_is_stable() {
        assert_eq!(UNENCRYPTED_DEV_STAMP, "UNENCRYPTED-DEV");
    }
}
