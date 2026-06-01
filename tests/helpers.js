const { buildEddsa, buildPoseidon } = require("circomlibjs");

// Build a full circuit input object from a NIK string + name + secret.
// Returns { input, eddsa, poseidon } where input is ready for the witness.
async function buildInput({ nik, name, secret, currentDateInt, currentYY, minAge, issuerPrivKey }) {
  const eddsa = await buildEddsa();
  const poseidon = await buildPoseidon();
  const F = poseidon.F;

  if (!/^\d{16}$/.test(nik)) throw new Error("NIK must be 16 digits");
  const nikDigits = nik.split("").map((d) => BigInt(d));
  // nikField = sum digit[i] * 10^i, MSB-first (digit[0] most significant) to match circuit
  let nikField = 0n;
  for (let i = 0; i < 16; i++) nikField = nikField * 10n + nikDigits[i];

  const msg = poseidon([nikField, BigInt(name), BigInt(secret)]);
  const signature = eddsa.signPoseidon(issuerPrivKey, msg);
  const pubKey = eddsa.prv2pub(issuerPrivKey);
  const nullifier = poseidon([BigInt(secret)]);

  const input = {
    nik: nikDigits.map((d) => d.toString()),
    name: name.toString(),
    secret: secret.toString(),
    Ax: F.toObject(pubKey[0]).toString(),
    Ay: F.toObject(pubKey[1]).toString(),
    R8x: F.toObject(signature.R8[0]).toString(),
    R8y: F.toObject(signature.R8[1]).toString(),
    S: signature.S.toString(),
    currentDateInt: currentDateInt.toString(),
    currentYY: currentYY.toString(),
    minAge: minAge.toString(),
    nullifierHash: F.toObject(nullifier).toString(),
  };
  return { input, eddsa, poseidon };
}

module.exports = { buildInput };
