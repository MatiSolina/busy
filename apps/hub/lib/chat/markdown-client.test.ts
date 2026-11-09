import { afterEach, describe, expect, it, vi } from "vitest";
import {
  closeMarkdownWorker,
  requestMarkdown,
  warmMarkdownWorker,
} from "./markdown-client";
import type { MarkdownRequest, MarkdownResult } from "./markdown-protocol";

class FixtureWorker extends EventTarget {
  static instances: FixtureWorker[] = [];
  readonly requests: MarkdownRequest[] = [];
  readonly terminate = vi.fn();

  constructor() {
    super();
    FixtureWorker.instances.push(this);
  }

  readonly postMessage = vi.fn((request: MarkdownRequest) => {
    this.requests.push(request);
  });

  reply(index: number, result: MarkdownResult) {
    this.dispatchEvent(
      new MessageEvent("message", {
        data: { id: this.requests[index].id, result },
      })
    );
  }
}

const empty: MarkdownResult = { blocks: [], hideCaret: false };
const other: MarkdownResult = { blocks: [], hideCaret: true };

function setup() {
  vi.stubGlobal("Worker", FixtureWorker);
  warmMarkdownWorker();
  return FixtureWorker.instances.at(-1) as FixtureWorker;
}

afterEach(() => {
  closeMarkdownWorker();
  FixtureWorker.instances = [];
  vi.unstubAllGlobals();
});

describe("Markdown worker lifecycle", () => {
  it("shares one worker and routes replies by request ID", async () => {
    const worker = setup();
    warmMarkdownWorker();
    const first = requestMarkdown("first", true);
    const second = requestMarkdown("second", false);
    expect(FixtureWorker.instances).toHaveLength(1);
    expect(
      worker.requests.map(({ text, streaming }) => ({ streaming, text }))
    ).toEqual([
      { streaming: true, text: "first" },
      { streaming: false, text: "second" },
    ]);
    worker.reply(1, other);
    worker.reply(0, empty);
    expect(await first).toEqual(empty);
    expect(await second).toEqual(other);
  });

  it.each(["error", "messageerror"])(
    "rejects every pending request on %s and permits fallback",
    async (eventName) => {
      const worker = setup();
      const results = Promise.allSettled([
        requestMarkdown("first", true),
        requestMarkdown("second", false),
      ]);
      worker.dispatchEvent(new Event(eventName, { cancelable: true }));
      expect((await results).map(({ status }) => status)).toEqual([
        "rejected",
        "rejected",
      ]);
      expect(worker.terminate).toHaveBeenCalledOnce();
      await expect(requestMarkdown("third", false)).rejects.toThrow(
        "Markdown worker unavailable"
      );
      expect(FixtureWorker.instances).toHaveLength(1);
    }
  );

  it("ignores messages and failures from a closed worker after reopening", async () => {
    const previous = setup();
    const closed = Promise.allSettled([requestMarkdown("old", true)]);
    closeMarkdownWorker();
    expect((await closed)[0].status).toBe("rejected");
    const current = setup();
    const next = requestMarkdown("new", false);
    previous.dispatchEvent(new Event("error"));
    previous.dispatchEvent(
      new MessageEvent("message", {
        data: { id: current.requests[0].id, result: other },
      })
    );
    current.reply(0, empty);
    expect(await next).toEqual(empty);
    expect(current.terminate).not.toHaveBeenCalled();
  });

  it("rejects a failed post without losing subsequent requests", async () => {
    const worker = setup();
    worker.postMessage.mockImplementationOnce(() => {
      throw new Error("Unable to clone message");
    });
    await expect(requestMarkdown("bad", false)).rejects.toThrow(
      "Markdown worker unavailable"
    );
    const next = requestMarkdown("good", false);
    worker.reply(0, empty);
    expect(await next).toEqual(empty);
  });

  it("permits fallback when workers are unsupported or fail to construct", async () => {
    vi.stubGlobal("Worker", undefined);
    await expect(requestMarkdown("text", false)).rejects.toThrow(
      "Markdown worker unavailable"
    );
    vi.stubGlobal(
      "Worker",
      class {
        constructor() {
          throw new Error("Worker blocked");
        }
      }
    );
    await expect(requestMarkdown("text", false)).rejects.toThrow(
      "Markdown worker unavailable"
    );
  });
});
