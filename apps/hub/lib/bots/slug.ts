const MAX = 40;
const DIACRITICS = /[̀-ͯ]/gu;
const NON_ALPHANUMERIC = /[^a-z0-9]+/gu;
const TRAILING_DASHES = /-+$/u;
const LEADING_OR_TRAILING_DASHES = /^-+|-+$/gu;

// A DNS label: it becomes `<slug>.bots.matisolina.com` and the project `bot-<slug>`.
export function slugify(name: string, taken: Set<string>): string {
  const base =
    name
      .normalize("NFD")
      .replace(DIACRITICS, "")
      .toLowerCase()
      .replace(NON_ALPHANUMERIC, "-")
      .replace(LEADING_OR_TRAILING_DASHES, "")
      .slice(0, MAX)
      .replace(TRAILING_DASHES, "") || "bot";
  if (!taken.has(base)) {
    return base;
  }
  for (let n = 2; ; n += 1) {
    const suffix = `-${n}`;
    const candidate = `${base.slice(0, MAX - suffix.length).replace(TRAILING_DASHES, "")}${suffix}`;
    if (!taken.has(candidate)) {
      return candidate;
    }
  }
}
