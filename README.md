# kage-program

On-chain Groth16 verifier + sybil-resistant nullifier PDA for the proven-kyc system.

## Role in the system

`kage-program` is the final, trustless step in the [proven-kyc](https://github.com/KageHQ) flow:

```
Mobile (on-device proof)
  → QR (proof + public signals)
    → kage-web (builds & submits the transaction)
      → kage-program ← YOU ARE HERE
          • verify Groth16 proof
          • check trusted issuer pubkey
          • init nullifier PDA (replay guard)
          • emit Verified event
```

The verifier learns only `pass` + a sybil-resistant nullifier. NIK, name, and date-of-birth are never revealed on-chain.

## Program

**Program ID (localnet):** `A6JUWyUESgJWF6w2bZRBnXTG5ZTmKU2HqWjEXSVHK1vS`

### Instructions

#### `initialize`

No-op ping that logs the program ID and the number of public inputs in the embedded verifying key. Used during deployment sanity-checks.

Accounts: none (empty `Initialize` context).

---

#### `verify`

Verifies a Groth16 KYC proof on-chain and mints a one-time nullifier PDA.

**Arguments**

| Name | Type | Description |
|---|---|---|
| `proof` | `[u8; 256]` | Groth16 proof (A‖B‖C, 64+128+64 bytes, light-protocol byte layout: A.y negated, B imaginary-coord first) |
| `public_inputs` | `Vec<[u8; 32]>` | 6 BN254 field elements (big-endian 32 bytes each); see below |
| `nullifier_hash` | `[u8; 32]` | Must equal `public_inputs[5]`; used as the nullifier PDA seed |

**Public inputs layout**

| Index | Signal | Notes |
|---|---|---|
| 0 | `Ax` | Issuer EdDSA pubkey X — must equal `TRUSTED_AX` |
| 1 | `Ay` | Issuer EdDSA pubkey Y — must equal `TRUSTED_AY` |
| 2 | `currentDateInt` | Fixed date integer committed at proof time (no date oracle) |
| 3 | `currentYY` | Current year component |
| 4 | `minAge` | Minimum age threshold (typically 18) |
| 5 | `nullifierHash` | Sybil-resistant one-time nullifier |

**Accounts**

| Account | Role |
|---|---|
| `nullifier` | `init`-constrained PDA (`seeds = ["nullifier", nullifier_hash]`). `init` reverts if the PDA already exists — this is the replay guard. |
| `payer` | `mut` signer; pays PDA rent. |
| `system_program` | Required for PDA creation. |

**Checks performed (in order)**

1. `public_inputs.len() == 6` — otherwise `BadPublicInputs`.
2. `public_inputs[0] == TRUSTED_AX` and `public_inputs[1] == TRUSTED_AY` — otherwise `UntrustedIssuer`.
3. `nullifier_hash == public_inputs[5]` — binds the PDA seed to the proof's actual nullifier.
4. `Groth16Verifier::<6>::verify()` — on-chain BN254 pairing check against the embedded verifying key; otherwise `VerificationFailed`.
5. Nullifier PDA `init` — reverts with an account-already-in-use error on replay.

**Emitted event on success**

```rust
pub struct Verified {
    pub wallet: Pubkey,   // submitter's wallet
    pub slot:   u64,      // slot at which verification was recorded
}
```

**Error codes**

| Code | Meaning |
|---|---|
| `BadPublicInputs` | Wrong number of public inputs, or `nullifier_hash` mismatch |
| `UntrustedIssuer` | `Ax`/`Ay` do not match the trusted demo issuer |
| `VerificationFailed` | Groth16 pairing check failed |

### Trusted issuer

`TRUSTED_AX` / `TRUSTED_AY` are the BN254 base-field coordinates of the demo issuer's EdDSA public key (derived from `DEMO_ISSUER_PRIV` in `@kagehq/shared`). This is **not** part of the cryptographic trusted setup — it is a hard-coded access-control check. If the issuer key rotates, recompute the constants and rebuild the program.

## Dependencies

| Package | Used for |
|---|---|
| `@kagehq/circuits` | `verification_key.json` (embedded by `scripts/vk-to-rust.js`); wasm/zkey used in tests to generate proofs |
| `@kagehq/shared` | `DEMO_ISSUER_PRIV` — the fixed demo issuer private key used in tests |
| `@coral-xyz/anchor` `^0.32.1` | Anchor framework |
| `groth16-solana` | On-chain Groth16 verifier (BN254) |

Both `@kagehq/*` packages are published to GitHub Packages. Add to your local `.npmrc`:

```
@kagehq:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

(PAT scope: `read:packages`. Never commit the token.)

## Build & test

### Prerequisites

- Rust + `solana-cli` + Anchor CLI
- `surfpool` (local Solana simnet)
- A funded local keypair (`~/.config/solana/id.json`)

### Tests (surfpool simnet)

```sh
surfpool start --no-tui --no-deploy -y &   # if not already on :8899
solana airdrop 100 -u http://localhost:8899
anchor test --skip-local-validator
```

The test suite generates a real Groth16 proof using `@kagehq/circuits` (snarkjs fullProve), submits it via the Anchor client, then re-submits the same proof to confirm the nullifier replay rejection.

## Regenerating the on-chain verifying key

The verifying key comes from @kagehq/circuits:

    node scripts/vk-to-rust.js node_modules/@kagehq/circuits/build/verification_key.json \
      > programs/kage/src/verifying_key.rs

TRUSTED_AX / TRUSTED_AY in programs/kage/src/lib.rs are the EdDSA public key
of the demo issuer (@kagehq/shared DEMO_ISSUER_PRIV), NOT part of the trusted
setup. If that key changes, recompute AX/AY or verification fails with
UntrustedIssuer.

## @kagehq/program-idl

`kage-program` publishes its Anchor IDL and program address as the `@kagehq/program-idl` npm package so downstream consumers (e.g. `kage-e2e`) can import typed clients without rebuilding the program.

**To publish a new version:**

```sh
node scripts/pack-idl.js          # writes idl-pkg/ with IDL + address
cd idl-pkg
cp ../.npmrc .npmrc               # bring GitHub Packages auth (never commit)
npm publish
```

This publishes `@kagehq/program-idl` to `https://npm.pkg.github.com`.

## Honest limitations

- **Global nullifier** — the nullifier PDA is keyed only by `nullifierHash`, not by verifier or use-case. The same proof cannot be reused anywhere in the system, but a verifier cannot scope nullifiers to its own context alone (all verifiers share one namespace).
- **No date oracle** — `currentDateInt` and `currentYY` are fixed public inputs committed at proof-generation time. The program does not check them against a live clock, so a proof generated with a past date passes as long as the signature and Groth16 check are valid.
- **Single-contributor trusted setup** — the BN254 powers-of-tau ceremony used for `@kagehq/circuits` has only one contribution. This is a demo; a production deployment would require a multi-party ceremony.

## PENDING (deferred from migration — do in a build pass)

- [ ] pnpm install
- [ ] REGENERATE verifying_key.rs from @kagehq/circuits (the committed vk is from the
      OLD trusted setup and will REJECT proofs made with the new @kagehq/circuits zkey):
      node scripts/vk-to-rust.js node_modules/@kagehq/circuits/build/verification_key.json > programs/kage/src/verifying_key.rs
- [ ] anchor test --skip-local-validator (against surfpool) — confirm proof verifies + replay rejected
- [ ] node scripts/pack-idl.js && (cd idl-pkg && cp ../.npmrc .npmrc && npm publish)  -> @kagehq/program-idl@1.0.0

## Sibling repos

| Repo | Role |
|---|---|
| [kage-shared](https://github.com/KageHQ/kage-shared) | Shared types, `DEMO_ISSUER_PRIV`, utilities |
| [kage-circuits](https://github.com/KageHQ/kage-circuits) | Circom circuit + trusted setup → `verification_key.json`, wasm, zkey |
| [kage-issuer](https://github.com/KageHQ/kage-issuer) | Signs KTP credential, produces witness inputs |
| [kage-program](https://github.com/KageHQ/kage-program) | **This repo** — on-chain Groth16 verifier + nullifier PDA |
| [kage-web](https://github.com/KageHQ/kage-web) | QR scanner UI; builds and submits the verify transaction |
| [kage-mobile](https://github.com/KageHQ/kage-mobile) | On-device PII entry + proof generation |
| [kage-e2e](https://github.com/KageHQ/kage-e2e) | End-to-end happy-path test (issuer → proof → QR → on-chain) |
