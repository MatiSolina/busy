import { getVercelOidcToken } from "@vercel/oidc";

export type HubFetch = (path: string, init?: RequestInit) => Promise<Response>;

// The hub knows which bot calls from the Vercel OIDC subject (`project:bot-<slug>`).
export const hubFetch: HubFetch = async (path, init = {}) => {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${await getVercelOidcToken()}`);
  if (init.body && !headers.has("Content-Type")) {
    headers.set("Content-Type", "application/json");
  }
  return fetch(`${process.env.HUB_URL}${path}`, {
    ...init,
    headers,
  });
};
