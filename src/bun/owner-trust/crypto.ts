/**
 * P-256 SHA-256 signatures, IEEE P1363 (raw r||s).
 * This is the encoding Secure Enclave uses for ecdsaSignatureMessageX962SHA256.
 * Synthetic keys exist only for protocol tests. They are not a macOS user presence.
 */
import { generateKeyPairSync, sign as signBytes, verify as verifyBytes, createPublicKey, type KeyObject } from "node:crypto";
import { proofMessage, type OwnerProofPayload } from "../../shared/owner-trust/protocol.ts";

export interface SyntheticSigner {
  publicKeySpki: string;
  sign(payload: OwnerProofPayload): string;
}

export function createSyntheticSigner(): SyntheticSigner {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "prime256v1" });
  const spki = publicKey.export({ type: "spki", format: "der" }) as Buffer;
  return {
    publicKeySpki: spki.toString("base64url"),
    sign(payload) {
      const message = Buffer.from(proofMessage(payload));
      return signBytes("sha256", message, { key: privateKey, dsaEncoding: "ieee-p1363" }).toString("base64url");
    },
  };
}

/** Accepts IEEE P1363 and the DER form returned by Secure Enclave X9.62 signatures. */
export function ecdsaSignatureToP1363(signature: Buffer): Buffer | null {
  if (signature.length === 64) return signature;
  if (signature.length < 8 || signature[0] !== 0x30) return null;
  let index = 1;
  const sequenceLength = signature[index]!;
  if (sequenceLength & 0x80) return null;
  index += 1;
  if (sequenceLength !== signature.length - index) return null;
  const read = (): Buffer | null => {
    if (signature[index] !== 0x02) return null;
    index += 1;
    const length = signature[index]!;
    index += 1;
    if (length <= 0 || index + length > signature.length) return null;
    let part = signature.subarray(index, index + length);
    index += length;
    if (part[0] === 0x00) part = part.subarray(1);
    if (part.length === 0 || part.length > 32) return null;
    const out = Buffer.alloc(32);
    part.copy(out, 32 - part.length);
    return out;
  };
  const r = read();
  const s = read();
  if (!r || !s || index !== signature.length) return null;
  return Buffer.concat([r, s]);
}

export function verifyP256(publicKeySpki: string, payload: OwnerProofPayload, signature: string): boolean {
  try {
    const key = createPublicKey({ key: Buffer.from(publicKeySpki, "base64url"), format: "der", type: "spki" });
    if ((key.asymmetricKeyType ?? "") !== "ec") return false;
    const message = Buffer.from(proofMessage(payload));
    const raw = ecdsaSignatureToP1363(Buffer.from(signature, "base64url"));
    if (!raw) return false;
    return verifyBytes("sha256", message, { key, dsaEncoding: "ieee-p1363" }, raw);
  } catch {
    return false;
  }
}

export function publicKeyType(publicKeySpki: string): string | null {
  try {
    const key: KeyObject = createPublicKey({ key: Buffer.from(publicKeySpki, "base64url"), format: "der", type: "spki" });
    return key.asymmetricKeyType ?? null;
  } catch {
    return null;
  }
}
