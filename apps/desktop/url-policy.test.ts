import { describe, expect, it } from "vitest";
import { navigationPolicy } from "./url-policy.mjs";

const BASE = "https://app.busybot.dev";

describe("navigationPolicy", () => {
  it("keeps app pages in the window", () => {
    expect(navigationPolicy(`${BASE}/b/abogado`, BASE)).toBe("allow");
    expect(navigationPolicy(`${BASE}/login`, BASE)).toBe("allow");
  });

  it("does not trust look-alike hosts", () => {
    expect(
      navigationPolicy("https://app.busybot.dev.evil.example/", BASE)
    ).toBe("external");
  });

  it("sends other https pages to the default browser", () => {
    expect(navigationPolicy("https://vercel.com/docs", BASE)).toBe("external");
    expect(navigationPolicy("https://example.com/report", BASE)).toBe(
      "external"
    );
  });

  it("blocks non-https schemes", () => {
    expect(navigationPolicy("javascript:alert(1)", BASE)).toBe("block");
    expect(navigationPolicy("file:///etc/passwd", BASE)).toBe("block");
    expect(navigationPolicy("http://example.com", BASE)).toBe("block");
    expect(navigationPolicy("not a url", BASE)).toBe("block");
  });
});
