use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;

mod verifying_key;
use verifying_key::VERIFYINGKEY;

declare_id!("LpL3vjhjoHBgJDEkKaDruSX7XRjQ8DvGLiq3meu3YJy");

/// Trusted issuer EdDSA pubkey (BN254 base field, big-endian 32 bytes each).
/// Corresponds to the fixed demo issuer private key
/// `0001020304050607080900010203040506070809000102030405060708090001`.
/// Ax = 13277427435165878497778222415993513565335242147425444199013288855685581939618
const TRUSTED_AX: [u8; 32] = [
    29, 90, 193, 243, 20, 7, 1, 139, 125, 65, 58, 79, 82, 200, 247, 68, 99, 179, 14, 106, 194, 35,
    130, 32, 173, 139, 37, 77, 228, 234, 163, 162,
];
/// Ay = 13622229784656158136036771217484571176836296686641868549125388198837476602820
const TRUSTED_AY: [u8; 32] = [
    30, 29, 232, 169, 8, 130, 108, 63, 154, 194, 224, 206, 238, 146, 158, 205, 12, 175, 59, 153,
    179, 239, 36, 82, 58, 170, 183, 150, 166, 247, 51, 196,
];

/// Age threshold this gate enforces. The circuit proves age >= minAge for
/// whatever minAge the prover supplied as a public input; without this check a
/// proof generated with minAge = 0 would pass. The program therefore pins the
/// accepted minAge value.
const REQUIRED_MIN_AGE: u64 = 18;

/// Maximum allowed distance (in days) between the proof's committed
/// currentDateInt and the validator's clock. The circuit checks the age
/// predicate against a prover-committed date, so the program must anchor that
/// date to real time or a prover could commit a future date and pass the age
/// check early. One day of slack absorbs timezone offset (proofs are built in
/// local time, the validator clock is UTC).
const MAX_DATE_SKEW_DAYS: i64 = 1;

/// Interpret a 32-byte big-endian field element as a u64, rejecting values
/// that do not fit (the top 24 bytes must be zero).
fn be32_to_u64(b: &[u8; 32]) -> Option<u64> {
    if b[..24].iter().any(|&x| x != 0) {
        return None;
    }
    Some(u64::from_be_bytes(b[24..32].try_into().unwrap()))
}

/// Days since 1970-01-01 for a proleptic-Gregorian civil date
/// (Howard Hinnant's days_from_civil algorithm).
fn days_from_civil(y: i64, m: i64, d: i64) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

#[program]
pub mod kage {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        msg!(
            "Greetings from: {:?} (vk public inputs: {})",
            ctx.program_id,
            VERIFYINGKEY.nr_pubinputs
        );
        Ok(())
    }

    /// Verify a Groth16 proof on-chain and record a one-time nullifier.
    ///
    /// `proof` layout (256 bytes, all field elements 32 big-endian bytes):
    ///   - a = proof[0..64]   G1, with y NEGATED (light-protocol convention)
    ///   - b = proof[64..192] G2, imaginary coord first then real
    ///   - c = proof[192..256] G1
    ///
    /// `public_inputs` (7 entries, IC order):
    ///   [0] Ax, [1] Ay, [2] currentDateInt, [3] currentYY, [4] minAge,
    ///   [5] nullifierHash, [6] scope (per-event binding)
    ///
    /// `scope` is the eventId this verifier gate accepts. It must equal
    /// public_inputs[6], so a proof minted for another event is rejected here
    /// even though it is cryptographically valid. The nullifier is itself scoped
    /// (Poseidon(secret, scope)), so one identity verifies once PER event.
    pub fn verify(
        ctx: Context<Verify>,
        proof: [u8; 256],
        public_inputs: Vec<[u8; 32]>,
        nullifier_hash: [u8; 32],
        scope: [u8; 32],
    ) -> Result<()> {
        require!(public_inputs.len() == 7, KycError::BadPublicInputs);

        // Only proofs signed by the trusted issuer are accepted.
        require!(public_inputs[0] == TRUSTED_AX, KycError::UntrustedIssuer);
        require!(public_inputs[1] == TRUSTED_AY, KycError::UntrustedIssuer);

        // The age threshold is a public input chosen at proof time; the gate
        // only accepts proofs generated against its required threshold.
        let min_age =
            be32_to_u64(&public_inputs[4]).ok_or(error!(KycError::BadPublicInputs))?;
        require!(min_age == REQUIRED_MIN_AGE, KycError::MinAgeMismatch);

        // Anchor the prover-committed date (public input 2, YYYYMMDD) to the
        // validator clock. Without this, a proof committed to a future date
        // would satisfy the circuit's age predicate prematurely.
        let date_int =
            be32_to_u64(&public_inputs[2]).ok_or(error!(KycError::BadPublicInputs))?;
        let (year, month, day) = (date_int / 10_000, (date_int / 100) % 100, date_int % 100);
        require!(
            (1..=12).contains(&month) && (1..=31).contains(&day) && year >= 1970,
            KycError::BadPublicInputs
        );
        // The circuit's century selection compares the NIK's two-digit year
        // against currentYY (public input 3); it must be consistent with the
        // committed date or the century logic can be steered independently.
        let current_yy =
            be32_to_u64(&public_inputs[3]).ok_or(error!(KycError::BadPublicInputs))?;
        require!(current_yy == year % 100, KycError::BadPublicInputs);

        let proof_days = days_from_civil(year as i64, month as i64, day as i64);
        let now_days = Clock::get()?.unix_timestamp.div_euclid(86_400);
        require!(
            (proof_days - now_days).abs() <= MAX_DATE_SKEW_DAYS,
            KycError::StaleProofDate
        );

        // The nullifier seed must equal public_inputs[5] (nullifierHash). This
        // binds the one-time nullifier PDA to the proof's actual nullifier.
        require!(
            nullifier_hash == public_inputs[5],
            KycError::BadPublicInputs
        );

        // Bind the transaction to this gate's event: the proof's scope
        // (public_inputs[6]) must match the scope this verifier declares.
        require!(scope == public_inputs[6], KycError::ScopeMismatch);

        let proof_a: [u8; 64] = proof[0..64].try_into().unwrap();
        let proof_b: [u8; 128] = proof[64..192].try_into().unwrap();
        let proof_c: [u8; 64] = proof[192..256].try_into().unwrap();

        let inputs: [[u8; 32]; 7] = public_inputs
            .clone()
            .try_into()
            .map_err(|_| error!(KycError::BadPublicInputs))?;

        let mut verifier =
            Groth16Verifier::<7>::new(&proof_a, &proof_b, &proof_c, &inputs, &VERIFYINGKEY)
                .map_err(|_| error!(KycError::VerificationFailed))?;
        verifier
            .verify()
            .map_err(|_| error!(KycError::VerificationFailed))?;

        let slot = Clock::get()?.slot;
        let nullifier = &mut ctx.accounts.nullifier;
        nullifier.used = true;
        nullifier.slot = slot;

        emit!(Verified {
            wallet: ctx.accounts.payer.key(),
            slot,
        });

        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}

#[derive(Accounts)]
#[instruction(proof: [u8; 256], public_inputs: Vec<[u8; 32]>, nullifier_hash: [u8; 32])]
pub struct Verify<'info> {
    /// One-time nullifier PDA. `init` fails if it already exists — this IS the
    /// replay guard: a re-submitted proof reuses the same nullifierHash seed and
    /// the second `init` reverts.
    #[account(
        init,
        payer = payer,
        space = 8 + 1 + 8,
        seeds = [b"nullifier", nullifier_hash.as_ref()],
        bump
    )]
    pub nullifier: Account<'info, Nullifier>,

    #[account(mut)]
    pub payer: Signer<'info>,

    pub system_program: Program<'info, System>,
}

#[account]
pub struct Nullifier {
    pub used: bool,
    pub slot: u64,
}

#[event]
pub struct Verified {
    pub wallet: Pubkey,
    pub slot: u64,
}

#[error_code]
pub enum KycError {
    #[msg("public_inputs must have exactly 7 entries")]
    BadPublicInputs,
    #[msg("issuer pubkey is not the trusted issuer")]
    UntrustedIssuer,
    #[msg("proof scope does not match this verifier's event")]
    ScopeMismatch,
    #[msg("proof minAge does not match this gate's required age threshold")]
    MinAgeMismatch,
    #[msg("proof's committed date is too far from the on-chain clock")]
    StaleProofDate,
    #[msg("groth16 proof verification failed")]
    VerificationFailed,
}
