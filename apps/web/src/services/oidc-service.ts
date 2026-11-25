import { apiFetch, ApiError } from "@/lib/api-client";
import { apiEmptySuccessResponseSchema } from "@renewlet/shared/schemas/api";
import { loginResponseSchema, sessionResponseSchema } from "@renewlet/shared/schemas/auth";
import {
  oidcSettingsSchema,
  oidcRedirectSchema,
  oidcLinkSchema,
  oidcReviewSchema,
} from "@renewlet/shared/schemas/oidc";
import { writeProductSession } from "./product-session";

const admin = "/api/app/admin/auth-security/oidc";
const auth = "/api/app/auth/oidc";
const post = (body: unknown = {}) => ({ method: "POST", body: JSON.stringify(body) });
export const oidcKeys = { site: ["oidc", "site"], link: (userId: string) => ["oidc", "link", userId] };
export const oidcService = {
  settings: () => apiFetch(admin, oidcSettingsSchema, { cache: "no-store" }),
  link: () => apiFetch(auth + "/link", oidcLinkSchema, { cache: "no-store" }),
  review: () => apiFetch(auth + "/review", oidcReviewSchema, { cache: "no-store" }),
  disable: (revision: string) =>
    apiFetch(admin + "/disable", apiEmptySuccessResponseSchema, post({ revision })),
  enable: () => apiFetch(admin + "/enable", apiEmptySuccessResponseSchema, post()),
  async confirm() {
    writeProductSession(await apiFetch(auth + "/link/confirm", sessionResponseSchema, post()));
  },
  async unlink(currentPassword: string) {
    writeProductSession(await apiFetch(auth + "/unlink", sessionResponseSchema, post({ currentPassword })));
  },
  async test(draft: { issuer: string; clientId: string; secret: string; revision: string }) {
    const { url } = await apiFetch(admin + "/test", oidcRedirectSchema, post(draft));
    window.location.assign(url);
  },
  async bind(currentPassword: string) {
    const { url } = await apiFetch(auth + "/link/start", oidcRedirectSchema, post({ currentPassword }));
    window.location.assign(url);
  },
  async login(next: string) {
    const { url } = await apiFetch(auth + "/start", oidcRedirectSchema, {
      ...post({ next }),
      authMode: "none",
    });
    window.location.assign(url);
  },
  async finish(shouldPersist: () => boolean) {
    const result = await apiFetch(auth + "/finish", loginResponseSchema, { ...post(), authMode: "none" });
    if (result.type === "session" && shouldPersist()) writeProductSession(result);
    return result;
  },
};

export function oidcErrorKey(error: unknown) {
  switch (error instanceof ApiError ? error.code : "") {
    case "OIDC_UNLINKED":
      return "auth.oidcUnlinked";
    case "OIDC_PASSWORD":
      return "auth.oidcPasswordError";
    case "OIDC_CONFLICT":
      return "auth.oidcConflict";
    case "OIDC_CHANGED":
    case "OIDC_EXPIRED":
      return "auth.oidcExpired";
    case "OIDC_ORIGIN":
      return "auth.oidcOrigin";
    case "OIDC_INVALID":
      return "auth.oidcInvalid";
    default:
      return "auth.oidcFailed";
  }
}
