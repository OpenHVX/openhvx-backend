import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
interface Sealed {
  version: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}
function key() {
  const secret =
    process.env.OUTBOX_ENCRYPTION_KEY || process.env.INTERNAL_API_SECRET;
  if (!secret || secret.length < 32)
    throw new Error(
      "Outbox encryption requires a secret of at least 32 characters",
    );
  return createHash("sha256")
    .update(`openhvx-durable-payload-v1:${secret}`)
    .digest();
}
export function seal(value: unknown): Sealed {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  const ciphertext = Buffer.concat([
    cipher.update(JSON.stringify(value), "utf8"),
    cipher.final(),
  ]);
  return {
    version: 1,
    iv: iv.toString("base64"),
    tag: cipher.getAuthTag().toString("base64"),
    ciphertext: ciphertext.toString("base64"),
  };
}
export function unseal<T>(value: Sealed): T {
  if (value.version !== 1)
    throw new Error("Unsupported durable payload encryption version");
  const cipher = createDecipheriv(
    "aes-256-gcm",
    key(),
    Buffer.from(value.iv, "base64"),
  );
  cipher.setAuthTag(Buffer.from(value.tag, "base64"));
  return JSON.parse(
    Buffer.concat([
      cipher.update(Buffer.from(value.ciphertext, "base64")),
      cipher.final(),
    ]).toString("utf8"),
  ) as T;
}
