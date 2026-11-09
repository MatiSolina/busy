import { need } from "../env";

/** Fixed provider registrations belong to the public hub, including behind a proxy. */
export function registeredHubOrigin(requestOrigin?: string): string {
  const url = URL.parse(need("HUB_URL"));
  const localHttp =
    process.env.NODE_ENV === "development" || process.env.NODE_ENV === "test";
  if (
    !url ||
    url.username ||
    url.password ||
    url.pathname !== "/" ||
    url.search ||
    url.hash ||
    (url.protocol !== "https:" && !(localHttp && url.protocol === "http:")) ||
    (requestOrigin !== undefined && requestOrigin !== url.origin)
  ) {
    throw new Error("Registered OAuth requires the configured hub origin");
  }
  return url.origin;
}
