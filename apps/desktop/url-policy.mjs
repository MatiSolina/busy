// Where a URL may open from the app window. Pure, so it is unit-tested.
//   allow    → navigate inside the window (the app itself)
//   external → hand to the default browser (docs, deployments, any other site)
//   block    → drop (non-https schemes, garbage)

/** @returns {"allow" | "external" | "block"} */
export function navigationPolicy(url, base) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return "block";
  }
  if (u.origin === new URL(base).origin) {
    return "allow";
  }
  if (u.protocol !== "https:") {
    return "block";
  }
  return "external";
}
