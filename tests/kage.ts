import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import { groth16 } from "snarkjs";
import { wasmPath as WASM_PATH, zkeyPath as ZKEY_PATH } from "@kagehq/circuits";
import { Kage } from "../target/types/kage";
import { to32, formatProof } from "./proof-format";

// circuits/test/helpers.js is a CommonJS module.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildInput } = require("./helpers");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { DEMO_ISSUER_PRIV } = require("@kagehq/shared");

const ISSUER_PRIV_KEY = Buffer.from(DEMO_ISSUER_PRIV, "hex");
// A rogue issuer: any 32-byte key that is NOT the trusted demo issuer. The
// circuit accepts a self-consistent signature under this key (Ax/Ay are public
// inputs), so the proof is cryptographically valid — the program is what must
// reject it (TRUSTED_AX/AY mismatch -> UntrustedIssuer).
const ROGUE_ISSUER_PRIV_KEY = Buffer.from(
  "0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20",
  "hex"
);

// Event scope this verifier gate accepts. Non-zero so the scope-binding path is
// actually exercised (a 6-input pre-scope harness could never test this).
const EVENT_SCOPE = 88n;

// The program now anchors the proof's committed date to the validator clock
// (±1 day), so proofs must be built against today's UTC date, not a constant.
const NOW = new Date();
const CURRENT_DATE_INT =
  NOW.getUTCFullYear() * 10000 + (NOW.getUTCMonth() + 1) * 100 + NOW.getUTCDate();
const CURRENT_YY = NOW.getUTCFullYear() % 100;

describe("kage", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.kage as Program<Kage>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  // Build a real v1.1.0 (7-input, scoped) proof and everything the program needs
  // to verify it. Distinct `secret`/`scope` -> distinct nullifier -> distinct
  // PDA, so each test gets a fresh nullifier account.
  async function buildProof(opts: {
    secret: bigint;
    scope: bigint;
    issuerPrivKey: Buffer;
    currentDateInt?: number;
    currentYY?: number;
    minAge?: number;
  }) {
    const { input } = await buildInput({
      nik: "3174071708950001",
      name: 12345n,
      secret: opts.secret,
      scope: opts.scope,
      currentDateInt: opts.currentDateInt ?? CURRENT_DATE_INT,
      currentYY: opts.currentYY ?? CURRENT_YY,
      minAge: opts.minAge ?? 18,
      issuerPrivKey: opts.issuerPrivKey,
    });

    const { proof, publicSignals } = await groth16.fullProve(
      input,
      WASM_PATH,
      ZKEY_PATH
    );

    const formattedProof = formatProof(proof);
    // Instruction arg type is Vec<[u8;32]> -> each input as a 32-number array.
    const publicInputArgs = publicSignals.map((s: string) => to32(s));
    // Public signal order: [Ax,Ay,currentDateInt,currentYY,minAge,nullifierHash,scope]
    const nullifierHash = Buffer.from(to32(publicSignals[5]));
    const scopeBytes = to32(publicSignals[6]);
    const [nullifierPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), nullifierHash],
      program.programId
    );

    return { formattedProof, publicInputArgs, nullifierHash, scopeBytes, nullifierPda };
  }

  // Shared happy-path proof, reused by the replay test.
  let happy: Awaited<ReturnType<typeof buildProof>>;

  before(async function () {
    this.timeout(120000);
    happy = await buildProof({
      secret: 99n,
      scope: EVENT_SCOPE,
      issuerPrivKey: ISSUER_PRIV_KEY,
    });
  });

  it("verifies a real proof on-chain, records the nullifier, and reports cost", async () => {
    const sig = await program.methods
      .verify(happy.formattedProof, happy.publicInputArgs, [...happy.nullifierHash], happy.scopeBytes)
      .accountsPartial({
        nullifier: happy.nullifierPda,
        payer: provider.wallet.publicKey,
      })
      .rpc();

    const nullifier = await program.account.nullifier.fetch(happy.nullifierPda);
    assert.isTrue(nullifier.used, "nullifier.used should be true");
    assert.isTrue(nullifier.slot.toNumber() > 0, "nullifier.slot should be set");

    // H3: capture on-chain cost from the confirmed transaction meta — no program
    // change needed. These are the numbers the paper's Results table needs.
    await provider.connection.confirmTransaction(sig, "confirmed");
    const tx = await provider.connection.getTransaction(sig, {
      commitment: "confirmed",
      maxSupportedTransactionVersion: 0,
    });
    const cu = tx?.meta?.computeUnitsConsumed;
    const fee = tx?.meta?.fee;
    console.log(`\n[ON-CHAIN COST] compute units consumed: ${cu}`);
    console.log(`[ON-CHAIN COST] transaction fee (lamports): ${fee}`);
    console.log(`[ON-CHAIN COST] signature: ${sig}\n`);
    assert.isTrue((cu ?? 0) > 0, "computeUnitsConsumed should be reported");
  });

  it("rejects a replayed proof (nullifier already used)", async () => {
    let threw = false;
    try {
      await program.methods
        .verify(happy.formattedProof, happy.publicInputArgs, [...happy.nullifierHash], happy.scopeBytes)
        .accountsPartial({
          nullifier: happy.nullifierPda,
          payer: provider.wallet.publicKey,
        })
        .rpc();
    } catch (e) {
      threw = true;
    }
    assert.isTrue(threw, "replayed proof should be rejected (PDA already init)");
  });

  // H1: a cryptographically valid proof signed by an UNTRUSTED issuer. Circuit
  // accepts it; program must reject with UntrustedIssuer.
  it("rejects a proof from an untrusted issuer", async () => {
    const rogue = await buildProof({
      secret: 101n,
      scope: EVENT_SCOPE,
      issuerPrivKey: ROGUE_ISSUER_PRIV_KEY,
    });

    let err: any;
    try {
      await program.methods
        .verify(rogue.formattedProof, rogue.publicInputArgs, [...rogue.nullifierHash], rogue.scopeBytes)
        .accountsPartial({
          nullifier: rogue.nullifierPda,
          payer: provider.wallet.publicKey,
        })
        .rpc();
    } catch (e) {
      err = e;
    }
    assert.isDefined(err, "untrusted-issuer proof should be rejected");
    assert.match(
      (err.toString?.() ?? String(err)),
      /UntrustedIssuer/,
      "rejection should be UntrustedIssuer"
    );
  });

  // H2: a valid proof minted for scope=EVENT_SCOPE, but submitted to a gate that
  // declares a DIFFERENT scope. Program must reject with ScopeMismatch.
  it("rejects a proof whose scope does not match this gate", async () => {
    const p = await buildProof({
      secret: 103n,
      scope: EVENT_SCOPE,
      issuerPrivKey: ISSUER_PRIV_KEY,
    });
    const wrongScope = to32(EVENT_SCOPE + 1n); // gate declares a different event

    let err: any;
    try {
      await program.methods
        .verify(p.formattedProof, p.publicInputArgs, [...p.nullifierHash], wrongScope)
        .accountsPartial({
          nullifier: p.nullifierPda,
          payer: provider.wallet.publicKey,
        })
        .rpc();
    } catch (e) {
      err = e;
    }
    assert.isDefined(err, "scope-mismatched proof should be rejected");
    assert.match(
      (err.toString?.() ?? String(err)),
      /ScopeMismatch/,
      "rejection should be ScopeMismatch"
    );
  });

  // H4: a cryptographically valid proof generated against a weaker age
  // threshold (minAge = 0). The circuit accepts it; the program must reject it
  // because the gate pins REQUIRED_MIN_AGE = 18.
  it("rejects a proof generated with the wrong minAge", async function () {
    this.timeout(120000);
    const p = await buildProof({
      secret: 105n,
      scope: EVENT_SCOPE,
      issuerPrivKey: ISSUER_PRIV_KEY,
      minAge: 0,
    });

    let err: any;
    try {
      await program.methods
        .verify(p.formattedProof, p.publicInputArgs, [...p.nullifierHash], p.scopeBytes)
        .accountsPartial({
          nullifier: p.nullifierPda,
          payer: provider.wallet.publicKey,
        })
        .rpc();
    } catch (e) {
      err = e;
    }
    assert.isDefined(err, "wrong-minAge proof should be rejected");
    assert.match(
      (err.toString?.() ?? String(err)),
      /MinAgeMismatch/,
      "rejection should be MinAgeMismatch"
    );
  });

  // H5: a valid proof committed to a future date. The circuit's age predicate
  // is checked against the prover-committed date, so without the program's
  // clock anchor a holder could pass the age check early. The program must
  // reject any committed date more than MAX_DATE_SKEW_DAYS from the validator
  // clock.
  it("rejects a proof committed to a date far from the on-chain clock", async function () {
    this.timeout(120000);
    const future = new Date(NOW.getTime() + 30 * 86400 * 1000); // +30 days
    const futureDateInt =
      future.getUTCFullYear() * 10000 +
      (future.getUTCMonth() + 1) * 100 +
      future.getUTCDate();
    const p = await buildProof({
      secret: 107n,
      scope: EVENT_SCOPE,
      issuerPrivKey: ISSUER_PRIV_KEY,
      currentDateInt: futureDateInt,
      currentYY: future.getUTCFullYear() % 100,
    });

    let err: any;
    try {
      await program.methods
        .verify(p.formattedProof, p.publicInputArgs, [...p.nullifierHash], p.scopeBytes)
        .accountsPartial({
          nullifier: p.nullifierPda,
          payer: provider.wallet.publicKey,
        })
        .rpc();
    } catch (e) {
      err = e;
    }
    assert.isDefined(err, "stale/future-dated proof should be rejected");
    assert.match(
      (err.toString?.() ?? String(err)),
      /StaleProofDate/,
      "rejection should be StaleProofDate"
    );
  });
});
