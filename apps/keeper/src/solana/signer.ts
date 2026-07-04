import { readFile } from "node:fs/promises";
import {
  createKeyPairSignerFromBytes,
  getBase58Encoder,
  type KeyPairSigner,
} from "@solana/kit";
import type { KeeperConfig } from "../config.ts";

/**
 * Load the keeper signer from env/file into a Kit KeyPairSigner.
 *
 * Accepts, in order of precedence:
 *   1. KEEPER_KEYPAIR as a JSON array (Solana CLI keypair file contents)
 *   2. KEEPER_KEYPAIR as a base58-encoded 64-byte secret key
 *   3. KEEPER_KEYPAIR_PATH pointing at a JSON-array keypair file
 *
 * Security: this key is authorized on-chain ONLY for activate/freeze/resolve.
 * It never touches user funds or positions. On Railway store it as a secret env
 * var, never a file baked into the image.
 */
export async function loadKeeperSigner(
  config: KeeperConfig,
): Promise<KeyPairSigner> {
  const bytes = await resolveSecretKeyBytes(config);
  if (bytes.length !== 64) {
    throw new Error(
      `keeper secret key must be 64 bytes, got ${bytes.length}. ` +
        "Provide a Solana CLI JSON-array keypair or a base58 secret key.",
    );
  }
  return createKeyPairSignerFromBytes(bytes);
}

async function resolveSecretKeyBytes(
  config: KeeperConfig,
): Promise<Uint8Array> {
  if (config.keeperKeypair) {
    const raw = config.keeperKeypair.trim();
    if (raw.startsWith("[")) {
      return Uint8Array.from(JSON.parse(raw) as number[]);
    }
    return new Uint8Array(getBase58Encoder().encode(raw));
  }
  if (config.keeperKeypairPath) {
    const file = await readFile(config.keeperKeypairPath, "utf8");
    return Uint8Array.from(JSON.parse(file) as number[]);
  }
  throw new Error(
    "No keeper keypair configured (set KEEPER_KEYPAIR or KEEPER_KEYPAIR_PATH).",
  );
}
