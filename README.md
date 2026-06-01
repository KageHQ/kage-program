<h1 align="center">kage-program</h1>

<p align="center">
  <img src="https://img.shields.io/badge/Solana-000?style=flat-square&logo=solana&logoColor=14F195" alt="Solana">
  <img src="https://img.shields.io/badge/Anchor-512BD4?style=flat-square" alt="Anchor">
  <img src="https://img.shields.io/badge/Groth16-2D7FF9?style=flat-square" alt="Groth16">
  <img src="https://img.shields.io/badge/Zero--Knowledge-6E56CF?style=flat-square" alt="Zero-Knowledge">
</p>

On-chain Groth16 verifier + sybil-resistant nullifier PDA for the [Kage](https://github.com/KageHQ) zero-knowledge e-KYC demo on Solana.

This is the Solana Anchor program that proves a valid Indonesian KTP + age >= 18 **without revealing** NIK, name, or date-of-birth. It verifies the Groth16 proof, enforces a trusted-issuer check, and mints a one-time nullifier PDA so the same identity cannot pass twice. The verifier learns only `pass` + a sybil-resistant nullifier.

## Role in the system

`kage-program` is the final, trustless step in the Kage flow:

```
Mobile (PII, on-device proof generation)
  → QR (proof + public signals — NO PII)
    → kage-web (scans QR, builds & submits the transaction)
      → kage-program ← YOU ARE HERE
          • verify Groth16 proof (on-chain BN254 pairing)
          • check trusted issuer pubkey (access control)
          • init nullifier PDA (replay guard)
          • emit Verified event
```

NIK, name, and date-of-birth never reach the chain.

## Build & test

### Prerequisites

- Rust + `solana-cli` + Anchor CLI
- [`surfpool`](https://github.com/txtx/surfpool) (local Solana simnet, RPC at `http://localhost:8899`)
- A funded local keypair (`~/.config/solana/id.json`)
- A local `.npmrc` with GitHub Packages auth (see [Dependencies](#dependencies)) — the program pulls `@kagehq/circuits` and `@kagehq/shared`.

### Run the tests (surfpool simnet)

```sh
pnpm install
surfpool start --no-tui --no-deploy -y &   # if not already on :8899
solana airdrop 100 -u http://localhost:8899
anchor test --skip-local-validator
```

> Tests run via `anchor test` against surfpool — there is no `npm test` script.

The suite generates a **real** Groth16 proof using `@kagehq/circuits` (snarkjs `fullProve`), submits it via the Anchor client, then re-submits the same proof to confirm the nullifier replay rejection.

> **Setup caveat:** the committed `verifying_key.rs` is from the **old** trusted setup and will **REJECT** proofs generated with the current `@kagehq/circuits` zkey until it is regenerated. See [Regenerating the on-chain verifying key](#regenerating-the-on-chain-verifying-key) before running the tests.

---

## Program reference

**Program ID (localnet):** `A6JUWyUESgJWF6w2bZRBnXTG5ZTmKU2HqWjEXSVHK1vS`

### Instructions

#### `initialize`

No-op ping that logs the program ID and the number of public inputs in the embedded verifying key. Used during deployment sanity-checks.

Accounts: none (empty `Initialize` context).

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

`TRUSTED_AX` / `TRUSTED_AY` are the BN254 base-field coordinates of the demo issuer's EdDSA public key (derived from `DEMO_ISSUER_PRIV` in `@kagehq/shared`).

> **Invariant:** this is **not** part of the cryptographic trusted setup — it is a hard-coded access-control check. If the issuer key rotates, recompute the constants and rebuild the program, or verification fails with `UntrustedIssuer`.

## Dependencies

| Package | Used for |
|---|---|
| `@kagehq/circuits` | `verification_key.json` (embedded by `scripts/vk-to-rust.js`); wasm/zkey used in tests to generate proofs |
| `@kagehq/shared` | `DEMO_ISSUER_PRIV` — the fixed demo issuer private key used in tests |
| `@coral-xyz/anchor` `^0.32.1` | Anchor framework |
| `@solana/web3.js` | Solana client (tx building, accounts) |
| `circomlibjs` | EdDSA / Poseidon helpers used in tests |
| `snarkjs` | Proof generation (`fullProve`) in tests |
| `groth16-solana` | On-chain Groth16 verifier (BN254) |

### GitHub Packages

Both `@kagehq/*` packages are published to GitHub Packages. Add to your local `.npmrc`:

```
@kagehq:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=YOUR_GITHUB_PAT
```

PAT scope: `read:packages`. Never commit the token.

## Regenerating the on-chain verifying key

The verifying key embedded in the program comes from `@kagehq/circuits`:

```sh
node scripts/vk-to-rust.js node_modules/@kagehq/circuits/build/verification_key.json \
  > programs/kage/src/verifying_key.rs
```

> **Required before testing:** the committed `verifying_key.rs` is from the **old** trusted setup and will **REJECT** proofs generated with the current `@kagehq/circuits` zkey. Run the command above to regenerate it against the current circuit, then `anchor test --skip-local-validator` should confirm the proof verifies and the replay is rejected.

`TRUSTED_AX` / `TRUSTED_AY` in `programs/kage/src/lib.rs` are the EdDSA public key of the demo issuer (`@kagehq/shared` `DEMO_ISSUER_PRIV`), **not** part of the trusted setup. If that key changes, recompute `AX`/`AY` or verification fails with `UntrustedIssuer`.

## Publishing the IDL (`@kagehq/program-idl`)

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

## Sibling repos

| Repo | Role |
|---|---|
| [kage-shared](https://github.com/KageHQ/kage-shared) | Foundation — shared types, `DEMO_ISSUER_PRIV`, utilities |
| [kage-circuits](https://github.com/KageHQ/kage-circuits) | Circom `age_kyc` circuit + setup → `verification_key.json`, wasm, zkey |
| [kage-issuer](https://github.com/KageHQ/kage-issuer) | Signs the KTP credential |
| [kage-program](https://github.com/KageHQ/kage-program) | **This repo** — on-chain Groth16 verifier + nullifier PDA |
| [kage-web](https://github.com/KageHQ/kage-web) | QR scanner UI; builds and submits the verify transaction |
| [kage-mobile](https://github.com/KageHQ/kage-mobile) | On-device PII entry + proof generation |
| [kage-e2e](https://github.com/KageHQ/kage-e2e) | End-to-end happy-path test (issuer → proof → QR → on-chain) |

## License

ISC
