import jwt, { type JwtPayload } from "jsonwebtoken";
import { createHash } from "node:crypto";
import type { NextFunction, Response } from "express";
import type { ControllerRequest } from "../types/express";
export function internalSecret(): string {
  const secret = process.env.INTERNAL_API_SECRET;
  if (!secret || secret.length < 32)
    throw new Error("INTERNAL_API_SECRET must contain at least 32 characters");
  return secret;
}
export function controllerIdentity(mode: "admin" | "tenant") {
  return (req: ControllerRequest, res: Response, next: NextFunction) => {
    try {
      const payload = jwt.verify(
        req.get("x-controller-identity") || "",
        internalSecret(),
        {
          algorithms: ["HS256"],
          issuer: "openhvx-gateway",
          audience: "openhvx-controller",
          maxAge: "30s",
        },
      ) as JwtPayload;
      const hash = createHash("sha256")
        .update(JSON.stringify(req.body || {}))
        .digest("hex");
      if (
        !payload.sub ||
        payload.mode !== mode ||
        payload.method !== req.method ||
        payload.path !== req.originalUrl ||
        payload.bodyHash !== hash
      )
        throw new Error("Invalid request binding");
      if (mode === "admin" && !payload.roles?.includes("global-admin"))
        throw new Error("Missing admin role");
      if (mode === "tenant" && !payload.tenantId)
        throw new Error("Missing tenant");
      req.headers["x-user-id"] = payload.sub;
      req.headers["x-tenant-id"] = payload.tenantId || "";
      req.headers["x-roles"] = (payload.roles || []).join(",");
      req.tenantId = payload.tenantId || undefined;
      req.user = { sub: payload.sub, tenantId: payload.tenantId, roles: payload.roles || [] };
      next();
    } catch {
      res.status(401).json({ error: "Invalid gateway identity" });
    }
  };
}
