import * as anchor from "@coral-xyz/anchor";
import { Program } from "@coral-xyz/anchor";
import { PublicKey } from "@solana/web3.js";
import { assert } from "chai";
import * as path from "path";
import { groth16 } from "snarkjs";
import { ProvenKyc } from "../target/types/proven_kyc";
import { to32, formatProof } from "./proof-format";

// circuits/test/helpers.js is a CommonJS module.
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { buildInput } = require("../../circuits/test/helpers");

const WASM_PATH = path.join(
  __dirname,
  "../../circuits/build/age_kyc_js/age_kyc.wasm"
);
const ZKEY_PATH = path.join(__dirname, "../../circuits/build/age_kyc.zkey");

const ISSUER_PRIV_KEY = Buffer.from(
  "0001020304050607080900010203040506070809000102030405060708090001",
  "hex"
);

describe("proven-kyc", () => {
  anchor.setProvider(anchor.AnchorProvider.env());
  const program = anchor.workspace.provenKyc as Program<ProvenKyc>;
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
