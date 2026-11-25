import { z } from "zod";
import { apiSuccessResponseSchema } from "./api";

export const oidcDraftSchema = z
  .object({
    issuer: z.string().trim().min(1).max(2048),
    clientId: z.string().trim().min(1).max(512),
    secret: z.string().max(4096),
    revision: z.string().max(128),
  })
  .strict();
export const oidcSettingsSchema = apiSuccessResponseSchema(
  oidcDraftSchema.omit({ secret: true }).extend({
    issuer: z.string(),
    clientId: z.string(),
    enabled: z.boolean(),
    secretConfigured: z.boolean(),
    callback: z.string(),
  }),
);
export const oidcRevisionSchema = oidcDraftSchema.pick({ revision: true });
export const oidcStartSchema = z.object({ next: z.string().max(2048) }).strict();
export const oidcRedirectSchema = apiSuccessResponseSchema(
  z.object({ url: z.url({ protocol: /^https$/ }) }).strict(),
);
export const oidcLinkSchema = apiSuccessResponseSchema(z.object({ issuer: z.string() }).strict());
export const oidcReviewSchema = apiSuccessResponseSchema(
  z
    .object({
      purpose: z.enum(["test", "link"]),
      issuer: z.string(),
      clientId: z.string(),
      subject: z.string(),
    })
    .strict(),
);
