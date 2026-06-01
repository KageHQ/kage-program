// Helpers to convert a snarkjs Groth16 proof (BN254 / bn128) into the byte
// layout expected by the on-chain `groth16-solana` (v0.2.0) verifier.
//
// Conventions (must match program/scripts/vk-to-rust.js, which generated the
// on-chain verifying key):
//   - every field element  -> 32 big-endian bytes
//   - proof_a (G1)         -> [x(32), y_negated(32)]   (light-protocol convention)
//   - proof_b (G2)         -> imaginary coord FIRST then real:
//                             [x.c1, x.c0, y.c1, y.c0]  (snarkjs stores [real, imag])
//   - proof_c (G1)         -> [x(32), y(32)]
//
// proof_a's y is negated because groth16-solana expects the G1 point A to be
// negated before being handed to the pairing check.

// BN254 base field prime.
export const FIELD_P =
  21888242871839275222246405745257275088696311157297823662689037894645226208583n;

// Decimal string / bigint -> 32 big-endian bytes (number[]).
export function to32(dec: string | bigint | number): number[] {
  const h = BigInt(dec).toString(16).padStart(64, "0");
  if (h.length > 64) {
    throw new Error(`field element does not fit in 32 bytes: ${dec}`);
  }
  const out: number[] = [];
  for (let i = 0; i < 64; i += 2) out.push(parseInt(h.slice(i, i + 2), 16));
  return out;
}

// bigint -> 32 big-endian bytes Buffer.
export function bnToBytes(x: bigint): Buffer {
  return Buffer.from(to32(x));
}

// snarkjs proof object -> 256-byte on-chain proof (number[256]).
export function formatProof(proof: any): number[] {
  const aX = BigInt(proof.pi_a[0]);
  const aY = BigInt(proof.pi_a[1]);
  // Negate A's y coordinate: (FIELD_P - y) mod FIELD_P.
  const aYNeg = (FIELD_P - (aY % FIELD_P)) % FIELD_P;

  const a = [...to32(aX), ...to32(aYNeg)];

  // G2: snarkjs stores [[x.c0, x.c1], [y.c0, y.c1], [1, 0]] (real, imag).
  // groth16-solana wants imaginary first then real.
  const b = [
    ...to32(proof.pi_b[0][1]),
    ...to32(proof.pi_b[0][0]),
    ...to32(proof.pi_b[1][1]),
    ...to32(proof.pi_b[1][0]),
  ];

  const c = [...to32(proof.pi_c[0]), ...to32(proof.pi_c[1])];

  const out = [...a, ...b, ...c];
  if (out.length !== 256) {
    throw new Error(`formatted proof must be 256 bytes, got ${out.length}`);
  }
  return out;
}
