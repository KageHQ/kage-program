use anchor_lang::prelude::*;
use groth16_solana::groth16::Groth16Verifier;

mod verifying_key;
use verifying_key::VERIFYINGKEY;

declare_id!("2X4ts1PwG6jRUjsU6DCqgcHuLhnLFpJS8HNCjuMLqP5C");

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
    /// `public_inputs` (6 entries, IC order):
    ///   [0] Ax, [1] Ay, [2] currentDateInt, [3] currentYY, [4] minAge, [5] nullifierHash
    pub fn verify(
        ctx: Context<Verify>,
        proof: [u8; 256],
        public_inputs: Vec<[u8; 32]>,
        nullifier_hash: [u8; 32],
    ) -> Result<()> {
        require!(public_inputs.len() == 6, KycError::BadPublicInputs);

        // Only proofs signed by the trusted issuer are accepted.
        require!(public_inputs[0] == TRUSTED_AX, KycError::UntrustedIssuer);
        require!(public_inputs[1] == TRUSTED_AY, KycError::UntrustedIssuer);

        // The nullifier seed must equal public_inputs[5] (nullifierHash). This
        // binds the one-time nullifier PDA to the proof's actual nullifier.
        require!(
            nullifier_hash == public_inputs[5],
            KycError::BadPublicInputs
        );

        let proof_a: [u8; 64] = proof[0..64].try_into().unwrap();
        let proof_b: [u8; 128] = proof[64..192].try_into().unwrap();
        let proof_c: [u8; 64] = proof[192..256].try_into().unwrap();

        let inputs: [[u8; 32]; 6] = public_inputs
            .clone()
            .try_into()
            .map_err(|_| error!(KycError::BadPublicInputs))?;

        let mut verifier =
            Groth16Verifier::<6>::new(&proof_a, &proof_b, &proof_c, &inputs, &VERIFYINGKEY)
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
    #[msg("public_inputs must have exactly 6 entries")]
    BadPublicInputs,
    #[msg("issuer pubkey is not the trusted issuer")]
    UntrustedIssuer,
    #[msg("groth16 proof verification failed")]
    VerificationFailed,
}
