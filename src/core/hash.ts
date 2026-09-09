/** Computes SHA-256 over exactly the supplied byte view and returns lowercase hex. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  if (globalThis.crypto?.subtle === undefined) {
    throw new Error("Web Crypto SHA-256 is unavailable in this runtime");
  }

  // Copy the view so a byteOffset into a larger backing buffer cannot affect the digest.
  const exactBytes = Uint8Array.from(bytes);
  const digest = await globalThis.crypto.subtle.digest("SHA-256", exactBytes.buffer);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Encodes text as UTF-8 before hashing; no newline or normalization is added. */
export async function sha256Text(text: string): Promise<string> {
  return sha256Hex(new TextEncoder().encode(text));
}
