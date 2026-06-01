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

describe("kage", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.kage as Program<Kage>;
  const provider = anchor.getProvider() as anchor.AnchorProvider;

  // Shared across tests: a single real proof reused to test replay rejection.
  let formattedProof: number[];
  let publicInputArgs: number[][];
  let nullifierHash: Buffer;
  let nullifierPda: PublicKey;

  before(async function () {
    this.timeout(120000);

    const { input } = await buildInput({
      nik: "3174071708950001",
      name: 12345n,
      secret: 99n,
      currentDateInt: 20260601,
      currentYY: 26,
      minAge: 18,
      issuerPrivKey: ISSUER_PRIV_KEY,
    });

    const { proof, publicSignals } = await groth16.fullProve(
      input,
      WASM_PATH,
      ZKEY_PATH
    );

    formattedProof = formatProof(proof);
    // Instruction arg type is Vec<[u8;32]> -> each input as a 32-number array.
    publicInputArgs = publicSignals.map((s: string) => to32(s));

    // nullifierHash is the 6th public signal (index 5).
    nullifierHash = Buffer.from(to32(publicSignals[5]));
    [nullifierPda] = PublicKey.findProgramAddressSync(
      [Buffer.from("nullifier"), nullifierHash],
      program.programId
    );
  });

  it("verifies a real proof on-chain and records the nullifier", async () => {
    await program.methods
      .verify(formattedProof, publicInputArgs, [...nullifierHash])
      .accountsPartial({
        nullifier: nullifierPda,
        payer: provider.wallet.publicKey,
      })
      .rpc();

    const nullifier = await program.account.nullifier.fetch(nullifierPda);
    assert.isTrue(nullifier.used, "nullifier.used should be true");
    assert.isTrue(
      nullifier.slot.toNumber() > 0,
      "nullifier.slot should be set"
    );
  });

  it("rejects a replayed proof (nullifier already used)", async () => {
    let threw = false;
    try {
      await program.methods
        .verify(formattedProof, publicInputArgs, [...nullifierHash])
        .accountsPartial({
          nullifier: nullifierPda,
          payer: provider.wallet.publicKey,
        })
        .rpc();
    } catch (e) {
      threw = true;
    }
    assert.isTrue(threw, "replayed proof should be rejected (PDA already init)");
  });
});
