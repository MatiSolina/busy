// @vitest-environment happy-dom
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { Profiler } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { Composer, type useAttachments } from "./composer";

const store = vi.hoisted(() => ({
  send: vi.fn(),
  stop: vi.fn(async () => true),
}));

vi.mock("@/components/chat-app", () => ({ useStore: () => store }));

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});

const attachments = () =>
  ({
    add: vi.fn(),
    clear: vi.fn(),
    items: [],
    remove: vi.fn(),
  }) as unknown as ReturnType<typeof useAttachments>;

class DictationFixture {
  static current: DictationFixture | undefined;
  onresult: ((event: { results: SpeechRecognitionResultList }) => void) | null =
    null;
  onend: (() => void) | null = null;
  readonly start = vi.fn();
  readonly abort = vi.fn(() => this.onend?.());
  readonly stop = vi.fn(() => this.onend?.());
  constructor() {
    DictationFixture.current = this;
  }
  result(text: string) {
    this.onresult?.({
      results: [
        [{ transcript: text }],
      ] as unknown as SpeechRecognitionResultList,
    });
  }
}

describe("Composer stop control", () => {
  it("does not carry a completed stop into the next turn", async () => {
    const attachmentState = attachments();
    const view = render(
      <Composer
        attachments={attachmentState}
        slug="assistant"
        turnId="turn-1"
        working
      />
    );

    await act(() => {
      fireEvent.click(screen.getByRole("button", { name: "Stop" }));
    });
    expect(screen.getByRole("button", { name: "Stopping…" })).toBeTruthy();

    view.rerender(
      <Composer
        attachments={attachmentState}
        slug="assistant"
        turnId={null}
        working={false}
      />
    );
    view.rerender(
      <Composer
        attachments={attachmentState}
        slug="assistant"
        turnId="turn-2"
        working
      />
    );

    expect(screen.getByRole("button", { name: "Stop" })).toBeTruthy();
    expect(screen.queryByRole("button", { name: "Stopping…" })).toBeNull();
  });
});

describe("Composer text", () => {
  it("preserves typed prefixes through dictation and clears the native draft on send", async () => {
    vi.stubGlobal("SpeechRecognition", DictationFixture);
    render(
      <Composer
        attachments={attachments()}
        slug="assistant"
        turnId={null}
        working={false}
      />
    );
    const message = screen.getByRole("textbox", {
      name: "Message",
    }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "Typed prefix" } });
    fireEvent.click(screen.getByRole("button", { name: "Dictate" }));
    const recognition = DictationFixture.current;
    if (!recognition) {
      throw new Error("Dictation did not start");
    }
    await act(() => recognition.result("dictated words"));
    expect(message.value).toBe("Typed prefix dictated words");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(store.send).toHaveBeenCalledWith(
      "assistant",
      expect.objectContaining({ text: "Typed prefix dictated words" })
    );
    expect(recognition.abort).toHaveBeenCalled();
    expect(message.value).toBe("");
  });

  it("keeps whitespace and composition from sending before a completed Enter", () => {
    render(
      <Composer
        attachments={attachments()}
        slug="assistant"
        turnId={null}
        working={false}
      />
    );
    const message = screen.getByRole("textbox", {
      name: "Message",
    }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "  " } });
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
    fireEvent.change(message, { target: { value: "  Current draft  " } });
    fireEvent.keyDown(message, { isComposing: true, key: "Enter" });
    fireEvent.keyDown(message, { key: "Enter", shiftKey: true });
    expect(store.send).not.toHaveBeenCalled();
    fireEvent.keyDown(message, { key: "Enter" });
    expect(store.send).toHaveBeenCalledWith(
      "assistant",
      expect.objectContaining({ text: "Current draft" })
    );
    expect(message.value).toBe("");
  });

  it("keeps typing native without committing the controls for every character", () => {
    const rendered = vi.fn();
    const attachmentState = attachments();
    const content = (turnId: string | null) => (
      <Profiler id="composer" onRender={rendered}>
        <Composer
          attachments={attachmentState}
          slug="assistant"
          turnId={turnId}
          working={false}
        />
      </Profiler>
    );
    const view = render(content(null));
    const message = screen.getByRole("textbox", {
      name: "Message",
    }) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "a" } });
    fireEvent.change(message, { target: { value: "ab" } });
    const commits = rendered.mock.calls.length;
    fireEvent.change(message, { target: { value: "abc" } });
    fireEvent.change(message, { target: { value: "abcd" } });
    expect(rendered.mock.calls.length).toBe(commits);
    view.rerender(content("next-turn"));
    expect(message.value).toBe("abcd");
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(store.send).toHaveBeenCalledWith(
      "assistant",
      expect.objectContaining({ text: "abcd" })
    );
    expect(message.value).toBe("");
    expect(
      (screen.getByRole("button", { name: "Send" }) as HTMLButtonElement)
        .disabled
    ).toBe(true);
  });

  it("has no skill picker and sends what was typed, slash and dollar included", () => {
    render(
      <Composer
        attachments={attachments()}
        slug="assistant"
        turnId={null}
        working={false}
      />
    );
    expect(screen.queryByRole("button", { name: "Add skill" })).toBeNull();
    const message = screen.getByRole("textbox", { name: "Message" });
    fireEvent.change(message, { target: { value: "/research $5 budget" } });
    expect(screen.queryByRole("listbox")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Send" }));
    expect(store.send).toHaveBeenCalledWith("assistant", {
      files: [],
      id: expect.any(String),
      text: "/research $5 budget",
    });
  });
});

describe("Second opinion command", () => {
  it("opens the fireside directly and never sends the command as an ordinary model prompt", () => {
    const open = vi.fn();
    render(
      <Composer
        attachments={attachments()}
        onSecondOpinion={open}
        slug="assistant"
        turnId={null}
        working={false}
      />
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "/second opinion" },
    });
    fireEvent.keyDown(screen.getByRole("textbox"), { key: "Enter" });
    expect(open).toHaveBeenCalledOnce();
    expect(store.send).not.toHaveBeenCalled();
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe("");
  });
});
