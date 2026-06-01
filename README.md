# kage-program

Anchor program for proven-kyc on Solana (Groth16 verifier + nullifier PDA).

## Regenerating the on-chain verifying key

The verifying key comes from @kagehq/circuits:

    node scripts/vk-to-rust.js node_modules/@kagehq/circuits/build/verification_key.json \
      > programs/proven-kyc/src/verifying_key.rs

TRUSTED_AX / TRUSTED_AY in programs/proven-kyc/src/lib.rs are the EdDSA public key
of the demo issuer (@kagehq/shared DEMO_ISSUER_PRIV), NOT part of the trusted
setup. If that key changes, recompute AX/AY or verification fails with
UntrustedIssuer.

## Tests (surfpool simnet)

    surfpool start --no-tui --no-deploy -y &   # if not already on :8899
    solana airdrop 100 -u http://localhost:8899
    anchor test --skip-local-validator

## PENDING (deferred from migration — do in a build pass)

- [ ] pnpm install
- [ ] REGENERATE verifying_key.rs from @kagehq/circuits (the committed vk is from the
      OLD trusted setup and will REJECT proofs made with the new @kagehq/circuits zkey):
      node scripts/vk-to-rust.js node_modules/@kagehq/circuits/build/verification_key.json > programs/proven-kyc/src/verifying_key.rs
- [ ] anchor test --skip-local-validator (against surfpool) — confirm proof verifies + replay rejected
- [ ] node scripts/pack-idl.js && (cd idl-pkg && cp ../.npmrc .npmrc && npm publish)  -> @kagehq/program-idl@1.0.0
