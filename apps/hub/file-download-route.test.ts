import { afterEach, expect, it as test, vi } from "vitest";
import { GET } from "./app/api/files/[id]/route";

const row = vi.hoisted(() => ({ current: {} as Record<string, string> }));
vi.mock("@/lib/db", () => ({
  db: () => ({
    select: () => ({ from: () => ({ where: () => [row.current] }) }),
  }),
  files: { id: "id" },
}));
vi.mock("@/lib/files", () => ({
  readUrl: (pathname: string) => `https://blob.example/${pathname}?sig=1`,
}));

const id = "22222222-2222-4222-8222-222222222222";
const get = (query = "?download") =>
  GET(new Request(`https://busy.test/api/files/${id}${query}`), {
    params: Promise.resolve({ id }),
  });

afterEach(() => vi.unstubAllGlobals());

test("streams a content-addressed library file under its real name", async () => {
  row.current = {
    contentType: "text/markdown",
    name: "cer0 brief.md",
    pathname: "library/sha256/74/7409",
    status: "ready",
  };
  vi.stubGlobal("fetch", async () => new Response("# hi"));
  const res = await get();
  expect(res.headers.get("content-disposition")).toBe(
    "attachment; filename*=UTF-8''cer0%20brief.md"
  );
  expect(await res.text()).toBe("# hi");
});

test("redirects when the blob path already carries the name", async () => {
  row.current = {
    contentType: "video/mp4",
    name: "a.mp4",
    pathname: "bots/x/1-a.mp4",
    status: "ready",
  };
  const res = await get();
  expect(res.status).toBe(302);
  expect(res.headers.get("location")).toContain("download=1");
});
