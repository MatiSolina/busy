import { afterEach, describe, expect, it, vi } from "vitest";

const hub = vi.hoisted(() => ({ hubFetch: vi.fn() }));
vi.mock("./hub", () => hub);

const { hubMemoryBackend, prefetchMemory } = await import("./hub-memory");

const doc = (version: number) =>
  Response.json({ content: `v${version}`, version });
const signal = () => new AbortController().signal;
const reads = () =>
  hub.hubFetch.mock.calls.filter(([, init]) => !init?.method).length;

afterEach(() => {
  hub.hubFetch.mockReset();
  vi.useRealTimers();
});

describe("prefetchMemory", () => {
  it("serves the next main read once, then reads again", async () => {
    hub.hubFetch.mockImplementation(() => Promise.resolve(doc(1)));
    const backend = hubMemoryBackend();
    prefetchMemory();
    expect(await backend.read({ key: "k", signal: signal() })).toEqual({
      content: "v1",
      version: "1",
    });
    expect(reads()).toBe(1);
    await backend.read({ key: "k", signal: signal() });
    expect(reads()).toBe(2);
  });

  it("never serves a prefetch from before a write", async () => {
    hub.hubFetch
      .mockImplementationOnce(() => Promise.resolve(doc(1)))
      .mockImplementationOnce(() => Promise.resolve(doc(2)))
      .mockImplementationOnce(() => Promise.resolve(doc(2)));
    const backend = hubMemoryBackend();
    prefetchMemory();
    await backend.write({
      content: "v2",
      expectedVersion: "1",
      key: "k",
      signal: signal(),
    });
    expect(await backend.read({ key: "k", signal: signal() })).toEqual({
      content: "v2",
      version: "2",
    });
  });

  it("ignores a prefetch older than 10 s and a fireside backend never takes it", async () => {
    vi.useFakeTimers();
    hub.hubFetch.mockImplementation(() => Promise.resolve(doc(1)));
    prefetchMemory();
    vi.advanceTimersByTime(10_001);
    await hubMemoryBackend().read({ key: "k", signal: signal() });
    expect(reads()).toBe(2);

    const fireside = vi.fn(() => Promise.resolve(doc(9)));
    prefetchMemory();
    await hubMemoryBackend(fireside).read({ key: "k", signal: signal() });
    expect(fireside).toHaveBeenCalledOnce();
  });

  it("falls back to a fresh read when the prefetch failed", async () => {
    hub.hubFetch
      .mockImplementationOnce(() => Promise.reject(new Error("network")))
      .mockImplementationOnce(() => Promise.resolve(doc(3)));
    prefetchMemory();
    expect(
      await hubMemoryBackend().read({ key: "k", signal: signal() })
    ).toEqual({ content: "v3", version: "3" });
  });
});
