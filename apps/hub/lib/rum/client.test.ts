import { describe, expect, it } from "vitest";
import { beaconReporter, createChatRum, type RumSample } from "./client";

function harness() {
  let now = 0;
  const frames: (() => void)[] = [];
  const samples: RumSample[] = [];
  const rum = createChatRum({
    frame: (callback) => frames.push(callback),
    now: () => now,
    report: (sample) => samples.push(sample),
  });
  return {
    advance: (ms: number) => {
      now += ms;
    },
    paint: () => {
      for (const frame of frames.splice(0)) {
        frame();
      }
    },
    rum,
    samples,
  };
}

describe("chat RUM", () => {
  it("measures send ack and TTFT to the paint after the first text", () => {
    const h = harness();
    h.rum.send("ana");
    h.advance(120);
    h.rum.ack("ana", true);
    h.advance(800);
    h.rum.firstText("ana");
    h.advance(16);
    h.paint();
    h.rum.firstText("ana");
    h.paint();
    expect(h.samples).toEqual([
      { name: "chat.send_ack", value: 120 },
      { name: "chat.ttft", value: 936 },
    ]);
  });

  it("keeps the first send's clock and ignores text nobody waited for", () => {
    const h = harness();
    h.rum.firstText("ana");
    h.paint();
    h.rum.send("ana");
    h.advance(100);
    h.rum.send("ana");
    h.advance(100);
    h.rum.firstText("ana");
    h.paint();
    expect(h.samples).toEqual([{ name: "chat.ttft", value: 200 }]);
  });

  it("drops a failed send", () => {
    const h = harness();
    h.rum.send("ana");
    h.rum.ack("ana", false);
    h.rum.firstText("ana");
    h.paint();
    expect(h.samples).toEqual([]);
  });

  it("batches rounded samples into one idle beacon", () => {
    const sent: string[] = [];
    const idle: (() => void)[] = [];
    const report = beaconReporter(
      (body) => sent.push(body),
      (callback) => idle.push(callback)
    );
    report({ name: "chat.ttft", value: 812.6 });
    report({ name: "chat.send_ack", value: 90.2 });
    expect(idle).toHaveLength(1);
    expect(sent).toEqual([]);
    idle[0]?.();
    expect(JSON.parse(sent[0] ?? "")).toEqual({
      samples: [
        { name: "chat.ttft", value: 813 },
        { name: "chat.send_ack", value: 90 },
      ],
    });
  });
});
