import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { navigationPolicy } from "./url-policy.mjs";

const APP_HOST = "app.busybot.dev";
const BASE = `https://${APP_HOST}`;

// Each row is a distinct way a URL can be written; the label says which.
const allow = [
  { label: "the app root", url: `${BASE}/` },
  { label: "the bare origin without a slash", url: BASE },
  {
    label: "a deep link with query and hash",
    url: `${BASE}/b/abogado?mcp=connected#m-1`,
  },
  {
    label: "an app page carrying an external URL in its query",
    url: `${BASE}/login?redirect=https://evil.com`,
  },
  {
    label: "an app page whose path spells another URL",
    url: `${BASE}/https://evil.com`,
  },
  { label: "the explicit default port", url: `https://${APP_HOST}:443/` },
  {
    label: "the default port with a leading zero",
    url: `https://${APP_HOST}:0443/`,
  },
  { label: "an empty port", url: `https://${APP_HOST}:/` },
  {
    label: "an uppercase scheme and host",
    url: "HTTPS://APP.BUSYBOT.DEV/X",
  },
  { label: "a mixed-case host", url: "https://App.BusyBot.Dev/" },
  {
    label: "userinfo on the app's own host",
    url: `https://user:pass@${APP_HOST}/`,
  },
  { label: "a fragment that looks like userinfo", url: `${BASE}#@evil.com` },
  { label: "a query that looks like userinfo", url: `${BASE}?@evil.com` },
  {
    label: "a backslash between the app host and an @",
    url: `${BASE}\\@evil.com`,
  },
  {
    label: "backslashes instead of slashes",
    url: `https:\\\\${APP_HOST}\\login`,
  },
  { label: "no slashes after the scheme", url: `https:${APP_HOST}/x` },
  { label: "one slash after the scheme", url: `https:/${APP_HOST}/x` },
  { label: "three slashes after the scheme", url: `https:///${APP_HOST}/` },
  {
    label: "a percent-encoded dot in the host",
    url: "https://app%2ebusybot.dev/",
  },
  {
    label: "fullwidth letters in the host",
    url: "https://ａｐｐ.busybot.dev/",
  },
  {
    label: "ideographic full stops as dots",
    url: "https://app。busybot。dev/",
  },
  {
    label: "a soft hyphen inside the host",
    url: "https://app.busybo­t.dev/",
  },
  { label: "a zero-width space after the host", url: `https://${APP_HOST}​/` },
  { label: "surrounding whitespace", url: `  ${BASE}/  ` },
  { label: "a newline inside the host", url: "https://app.busybo\nt.dev/" },
  { label: "a leading NUL control character", url: `\u0000${BASE}` },
  {
    label: "dot segments climbing above the root",
    url: `${BASE}/../../etc/passwd`,
  },
  { label: "percent-encoded dot segments", url: `${BASE}/%2e%2e/admin` },
  { label: "a NUL in the path", url: `${BASE}/\u0000` },
  {
    label: "a blob URL the app created",
    url: `blob:${BASE}/6f1c2b0e-9d3a-4c1e-8f00-1a2b3c4d5e6f`,
  },
  { label: "a 10 000-character path", url: `${BASE}/${"a".repeat(10_000)}` },
];

const external = [
  { label: "another site", url: "https://github.com/matisolina" },
  { label: "a subdomain of the app", url: `https://a.${APP_HOST}/` },
  { label: "the parent domain", url: "https://matisolina.com/" },
  { label: "a sibling subdomain", url: "https://hub.matisolina.com/" },
  {
    label: "the app host plus a percent-encoded dot and another domain",
    url: `https://${APP_HOST}%2eevil.com/`,
  },
  {
    label: "an ideographic full stop joining another domain",
    url: `https://${APP_HOST}。evil.com/`,
  },
  {
    label: "a percent-encoded ideographic full stop",
    url: `https://${APP_HOST}%E3%80%82evil.com`,
  },
  { label: "a hyphen instead of a dot", url: "https://busy-matisolina.com/" },
  { label: "a missing dot", url: "https://busymatisolina.com/" },
  { label: "another TLD", url: "https://busy.matisolina.co/" },
  { label: "a trailing dot (a distinct origin)", url: `https://${APP_HOST}./` },
  {
    label: "a percent-encoded trailing dot",
    url: "https://APP.BUSYBOT.DEV%2E/",
  },
  { label: "two trailing dots", url: `https://${APP_HOST}..` },
  { label: "a leading dot", url: `https://.${APP_HOST}/` },
  { label: "an empty label", url: "https://app..busybot.dev/" },
  { label: "a non-default port", url: `https://${APP_HOST}:8443/` },
  { label: "the app host as userinfo", url: `https://${APP_HOST}@evil.com/` },
  {
    label: "the app host and port as userinfo",
    url: `https://${APP_HOST}:443@evil.com/`,
  },
  {
    label: "a backslash before an @ and the app host",
    url: `https://evil.com\\@${APP_HOST}`,
  },
  {
    label: "the app URL in another site's fragment",
    url: `https://evil.com#${BASE}`,
  },
  {
    label: "the app URL in another site's query",
    url: `https://evil.com/?u=${BASE}`,
  },
  {
    label: "an accented look-alike (IDN)",
    url: "https://app.busybót.dev/",
  },
  { label: "a Cyrillic homograph", url: "https://busy.matisоlina.com/" },
  { label: "a punycode host", url: "https://xn--bsy-hoa.matisolina.com/" },
  { label: "a wildcard-looking host", url: "https://*.busybot.dev/" },
  { label: "loopback IPv4", url: "https://127.0.0.1/" },
  { label: "IPv4 in hex shorthand", url: "https://0x7f.1/" },
  { label: "IPv4 as one integer", url: "https://2130706433/" },
  { label: "loopback IPv6", url: "https://[::1]/" },
  { label: "IPv4-mapped IPv6", url: "https://[::ffff:127.0.0.1]/" },
  { label: "localhost over https", url: "https://localhost/" },
];

const blockedSchemes = [
  { label: "http on the app host", url: `http://${APP_HOST}/` },
  { label: "http on the app host at port 443", url: `http://${APP_HOST}:443/` },
  { label: "http to localhost", url: "http://localhost:3000/" },
  { label: "http to an IP", url: "http://127.0.0.1/" },
  { label: "javascript: in mixed case", url: "jAvAsCrIpT:alert(1)" },
  {
    label: "javascript: after leading whitespace",
    url: " javascript:alert(1)",
  },
  {
    label: "javascript: with a newline inside the scheme",
    url: "java\nscript:alert(1)",
  },
  {
    label: "javascript: dressed as the app host",
    url: `javascript://${APP_HOST}/%0aalert(1)`,
  },
  { label: "an empty javascript: URL", url: "javascript:" },
  {
    label: "a data: HTML document",
    url: "data:text/html,<script>alert(1)</script>",
  },
  {
    label: "a file: URL naming the app host",
    url: `file://${APP_HOST}/etc/passwd`,
  },
  { label: "a blob: from another origin", url: "blob:https://evil.com/6f1c" },
  {
    label: "a blob: from the app host over http",
    url: `blob:http://${APP_HOST}/6f1c`,
  },
  { label: "a blob: with an opaque origin", url: "blob:null/6f1c" },
  { label: "about:blank", url: "about:blank" },
  { label: "about:srcdoc", url: "about:srcdoc" },
  { label: "view-source: of the app", url: `view-source:${BASE}/` },
  { label: "filesystem: of the app", url: `filesystem:${BASE}/temporary/x` },
  { label: "a secure websocket to the app host", url: `wss://${APP_HOST}/` },
  { label: "ftp to the app host", url: `ftp://${APP_HOST}/` },
  {
    label: "a scheme that only starts with https",
    url: `https+evil://${APP_HOST}`,
  },
  { label: "mailto:", url: "mailto:soporte@matisolina.com" },
  { label: "tel:", url: "tel:+5491100000000" },
  { label: "a custom app scheme", url: "x-busy://open" },
  { label: "chrome internals", url: "chrome://settings" },
  { label: "devtools", url: "devtools://devtools/bundled/inspector.html" },
  { label: "an Android intent", url: "intent://x#Intent;end" },
];

const unparseable = [
  { label: "an empty string", url: "" },
  { label: "only whitespace", url: "   " },
  { label: "a relative path", url: "/login" },
  { label: "a protocol-relative URL", url: `//${APP_HOST}/x` },
  { label: "a scheme with no host", url: "https://" },
  { label: "a space inside the host", url: "https://exa mple.com" },
  { label: "an unclosed IPv6 literal", url: "https://[::1" },
  { label: "a port out of range", url: `https://${APP_HOST}:99999` },
  { label: "a signed port", url: `https://${APP_HOST}:+443/` },
  { label: "two ports", url: `https://${APP_HOST}:443:443/` },
  {
    label: "a port followed by more host",
    url: `https://${APP_HOST}:443.evil.com/`,
  },
  {
    label: "a percent-encoded @ in the host",
    url: `https://${APP_HOST}%40evil.com/`,
  },
  {
    label: "a percent-encoded slash in the host",
    url: `https://${APP_HOST}%2Fevil.com/`,
  },
  { label: "a NUL inside the host", url: `https://${APP_HOST}\u0000.evil.com` },
  { label: "invalid punycode", url: "https://xn--/" },
  { label: "a lone percent sign as host", url: "https://%" },
];

describe("navigationPolicy corpus", () => {
  it.each(allow)("keeps $label in the window", ({ url }) => {
    expect(navigationPolicy(url, BASE)).toBe("allow");
  });

  it.each(external)("opens $label in the browser", ({ url }) => {
    expect(navigationPolicy(url, BASE)).toBe("external");
  });

  it.each(blockedSchemes)("blocks $label", ({ url }) => {
    expect(navigationPolicy(url, BASE)).toBe("block");
  });

  it.each(unparseable)("blocks $label (unparseable)", ({ url }) => {
    expect(navigationPolicy(url, BASE)).toBe("block");
  });
});

describe("navigationPolicy against other bases", () => {
  const DEV = "http://localhost:3000";
  const PREVIEW = "https://busy-git-main-matisolina.vercel.app";
  it.each([
    {
      base: DEV,
      label: "a dev hub keeps its own http pages",
      policy: "allow",
      url: "http://localhost:3000/c/1",
    },
    {
      base: DEV,
      label: "a dev hub matches its host case-insensitively",
      policy: "allow",
      url: "http://LOCALHOST:3000/",
    },
    {
      base: DEV,
      label: "a dev hub blocks http on another port",
      policy: "block",
      url: "http://localhost:3001/",
    },
    {
      base: DEV,
      label: "a dev hub blocks its IP spelling over http",
      policy: "block",
      url: "http://127.0.0.1:3000/",
    },
    {
      base: DEV,
      label: "a dev hub sends its https twin to the browser",
      policy: "external",
      url: "https://localhost:3000/",
    },
    {
      base: DEV,
      label: "a dev hub sends production to the browser",
      policy: "external",
      url: `${BASE}/`,
    },
    {
      base: PREVIEW,
      label: "a preview hub sends production to the browser",
      policy: "external",
      url: `${BASE}/`,
    },
    {
      base: PREVIEW,
      label: "a preview hub keeps its own pages",
      policy: "allow",
      url: `${PREVIEW}/login`,
    },
    {
      base: `${BASE}/`,
      label: "a base with a trailing slash",
      policy: "allow",
      url: `${BASE}/c/1`,
    },
    {
      base: `${BASE}/some/path?x=1#y`,
      label: "a base with a path, query and hash",
      policy: "allow",
      url: `${BASE}/other`,
    },
    {
      base: `${BASE}:443`,
      label: "a base with the explicit default port",
      policy: "allow",
      url: `${BASE}/`,
    },
    {
      base: "HTTPS://APP.BUSYBOT.DEV",
      label: "an uppercase base",
      policy: "allow",
      url: `${BASE}/`,
    },
  ])("$label", ({ base, url, policy }) => {
    expect(navigationPolicy(url, base)).toBe(policy);
  });
});

const hostArb = fc.constantFrom(
  APP_HOST,
  "APP.BUSYBOT.DEV",
  `${APP_HOST}.`,
  `a.${APP_HOST}`,
  "busybot.dev",
  `${APP_HOST}.evil.com`,
  "evil.com",
  "localhost",
  "127.0.0.1",
  "[::1]",
  "xn--bsy-hoa.matisolina.com"
);
const portArb = fc.constantFrom("", ":443", ":0443", ":8443", ":80", ":3000");
const userinfoArb = fc.constantFrom(
  "",
  "user@",
  "user:pass@",
  `${APP_HOST}@`,
  `${APP_HOST}:443@`
);
const tailArb = fc
  .tuple(
    fc.webPath(),
    fc.option(fc.webQueryParameters(), { nil: undefined }),
    fc.option(fc.webFragments(), { nil: undefined })
  )
  .map(
    ([path, query, hash]) =>
      `${path}${query === undefined ? "" : `?${query}`}${hash === undefined ? "" : `#${hash}`}`
  );
const urlFrom = (schemes: string[]) =>
  fc
    .tuple(fc.constantFrom(...schemes), userinfoArb, hostArb, portArb, tailArb)
    .map(
      ([scheme, user, host, port, tail]) =>
        `${scheme}://${user}${host}${port}${tail}`
    );
const anyUrlArb = urlFrom([
  "https",
  "HTTPS",
  "http",
  "wss",
  "ws",
  "ftp",
  "file",
  "blob:https",
  "javascript",
  "data",
]);
const webUrlArb = urlFrom(["https", "http"]);
const parses = (url: string) => {
  try {
    return new URL(url);
  } catch {
    return null;
  }
};

describe("navigationPolicy properties", () => {
  it("never allows a URL that would not load the app's host over https", () => {
    let allowed = 0;
    fc.assert(
      fc.property(anyUrlArb, (url) => {
        if (navigationPolicy(url, BASE) !== "allow") {
          return;
        }
        allowed += 1;
        const u = new URL(url);
        const loaded = u.protocol === "blob:" ? new URL(u.pathname) : u;
        expect(loaded.protocol).toBe("https:");
        expect(loaded.hostname).toBe(APP_HOST);
        expect(loaded.port).toBe("");
      }),
      { numRuns: 1000, seed: 1 }
    );
    expect(allowed).toBeGreaterThan(5);
  });

  it("sends every https URL of another origin to the browser", () => {
    const urls = fc
      .webUrl({
        authoritySettings: {
          withIPv4: true,
          withIPv4Extended: true,
          withIPv6: true,
          withPort: true,
          withUserInfo: true,
        },
        validSchemes: ["https"],
        withFragments: true,
        withQueryParameters: true,
      })
      .filter((url) => {
        const u = parses(url);
        return u !== null && !(u.hostname === APP_HOST && u.port === "");
      });
    fc.assert(
      fc.property(urls, (url) => {
        expect(navigationPolicy(url, BASE)).toBe("external");
      }),
      { numRuns: 300, seed: 1 }
    );
  });

  it("keeps every path, query and fragment of the app in the window", () => {
    fc.assert(
      fc.property(tailArb, (tail) => {
        expect(navigationPolicy(`${BASE}${tail}`, BASE)).toBe("allow");
      }),
      { numRuns: 300, seed: 1 }
    );
  });

  it("answers allow, external or block for any input without throwing", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.string({ maxLength: 60, unit: "binary" }),
          fc.webUrl(),
          anyUrlArb
        ),
        (url) => {
          expect(["allow", "external", "block"]).toContain(
            navigationPolicy(url, BASE)
          );
        }
      ),
      { numRuns: 500, seed: 1 }
    );
  });

  it("blocks every scheme other than https and blob", () => {
    const scheme = fc
      // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
      .stringMatching(/^[a-z][a-z0-9+.-]{0,8}$/u)
      .filter((s) => s !== "https" && s !== "blob");
    const rest = fc.constantFrom(
      `//${APP_HOST}/`,
      `//${APP_HOST}:443/x`,
      "//evil.com/x",
      "alert(1)",
      APP_HOST,
      ""
    );
    fc.assert(
      fc.property(scheme, rest, (s, r) => {
        expect(navigationPolicy(`${s}:${r}`, BASE)).toBe("block");
      }),
      { numRuns: 300, seed: 1 }
    );
  });

  it("ignores letter case in the scheme and host", () => {
    const origin = fc.mixedCase(
      fc.constantFrom(
        BASE,
        "https://evil.com",
        `http://${APP_HOST}`,
        `https://${APP_HOST}.evil.com`
      )
    );
    fc.assert(
      fc.property(origin, tailArb, (o, tail) => {
        expect(navigationPolicy(`${o}${tail}`, BASE)).toBe(
          navigationPolicy(`${o.toLowerCase()}${tail}`, BASE)
        );
      }),
      { numRuns: 300, seed: 1 }
    );
  });

  it("ignores userinfo in front of the host", () => {
    // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
    const user = fc.stringMatching(/^[a-z0-9.]{1,19}$/u);
    // biome-ignore lint/performance/useTopLevelRegex: this regex is a one-off test assertion, not a production hot path
    const pass = fc.option(fc.stringMatching(/^[a-z0-9]{0,8}$/u), {
      nil: undefined,
    });
    const hostPort = fc.constantFrom(
      APP_HOST,
      `${APP_HOST}:8443`,
      "evil.com",
      "localhost:3000"
    );
    fc.assert(
      fc.property(
        fc.constantFrom("https", "http"),
        user,
        pass,
        hostPort,
        tailArb,
        (s, u, p, h, tail) => {
          const withInfo = `${s}://${u}${p === undefined ? "" : `:${p}`}@${h}${tail}`;
          expect(navigationPolicy(withInfo, BASE)).toBe(
            navigationPolicy(`${s}://${h}${tail}`, BASE)
          );
        }
      ),
      { numRuns: 300, seed: 1 }
    );
  });

  it("treats allow as a symmetric, reflexive relation between real origins", () => {
    fc.assert(
      fc.property(webUrlArb, webUrlArb, (a, b) => {
        expect(navigationPolicy(a, a)).toBe("allow");
        expect(navigationPolicy(a, b) === "allow").toBe(
          navigationPolicy(b, a) === "allow"
        );
      }),
      { numRuns: 500, seed: 1 }
    );
  });
});
