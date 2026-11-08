import jwt from "jsonwebtoken";
import { createHash } from "node:crypto";
import type { ClientRequest } from "node:http";
import type { Request } from "express";
export function internalSecret(): string {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("INTERNAL_API_SECRET must contain at least 32 characters");
  return secret;
}
export function signControllerRequest(
  proxy: ClientRequest,
  req: Request,
  mode: "admin" | "tenant",
  tenantId: string,
) {
  const token = jwt.sign(
    {
      mode,
      tenantId,
      roles: req.user?.roles || [],
      method: req.method,
      path: proxy.path,
      bodyHash: createHash("sha256")
        .update(JSON.stringify(req.body || {}))
        .digest("hex"),
    },
    internalSecret(),
    {
      algorithm: "HS256",
      issuer: "openhvx-gateway",
      audience: "openhvx-controller",
      subject: req.user?.sub,
      expiresIn: 30,
    },
  );
  proxy.setHeader("x-controller-identity", token);
}
