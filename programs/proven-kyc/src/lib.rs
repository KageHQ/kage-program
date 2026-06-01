use anchor_lang::prelude::*;

mod verifying_key;
use verifying_key::VERIFYINGKEY;

declare_id!("A6JUWyUESgJWF6w2bZRBnXTG5ZTmKU2HqWjEXSVHK1vS");

#[program]
pub mod proven_kyc {
    use super::*;

    pub fn initialize(ctx: Context<Initialize>) -> Result<()> {
        // Reference the generated verifying key so groth16-solana is linked in
        // and the verifying_key module compiles. The real `verify` instruction
        // (Groth16Verifier::new + verify) lands in the next task.
        msg!(
            "Greetings from: {:?} (vk public inputs: {})",
            ctx.program_id,
            VERIFYINGKEY.nr_pubinputs
        );
        Ok(())
    }
}

#[derive(Accounts)]
pub struct Initialize {}
