// @vitest-environment happy-dom
import { cleanup, fireEvent, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  initialBot,
  installFakes,
  json,
  pane,
  renderApp,
  type Server,
  settle,
} from "@/components/components.test-helpers";
import type { LibraryFile, LibraryResponse } from "@/lib/library-types";

vi.mock("@/components/live-view", () => ({ LiveView: () => null }));

const makeFile = (over: Partial<LibraryFile> = {}): LibraryFile => ({
  bot: { avatar: null, name: "Lawyer", slug: "lawyer" },
  contentType: "application/pdf",
  createdAt: "2026-11-02T12:00:00.000Z",
  id: "11111111-1111-4111-8111-111111111111",
  name: "report.pdf",
  size: 12_288,
  version: 1,
  ...over,
});

const page = (
  files: LibraryFile[],
  nextCursor: string | null = null
): LibraryResponse => ({ files, nextCursor });

let server: Server;

async function openLibrary(name = "Lawyer") {
  fireEvent.click(pane(name).getByRole("button", { name: "Bot settings" }));
  fireEvent.click(await screen.findByRole("tab", { name: "Library" }));
}

function closeLibrary() {
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
}

function renderBusy() {
  renderApp([
    initialBot("lawyer", { name: "Lawyer" }),
    initialBot("analyst", { name: "Analyst" }),
  ]);
}

function lastLibraryQuery() {
  const call = server.to("GET", "/api/library").at(-1);
  return call ? new URL(call.url, "https://busy.test").searchParams : null;
}

beforeEach(() => {
  vi.useRealTimers();
  ({ server } = installFakes());
  server.on(
    "GET",
    "/api/account",
    json({
      account: { avatarUrl: null, name: "Matias Solina" },
      tokenPass: {
        dashboardUrl: "https://vercel.com",
        percentUsed: 12.5,
        status: "active",
      },
    })
  );
  server.on("GET", "/api/library", json(page([])));
});

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("library sheet", () => {
  it("opens inside bot settings and scopes the initial request to that bot", async () => {
    const generated = makeFile({
      id: "22222222-2222-4222-8222-222222222222",
      name: "quote.docx",
    });
    server.on("GET", "/api/library", json(page([generated])));
    renderBusy();
    await openLibrary();
    await settle(20);

    expect(
      screen.getByRole("dialog", { name: "Lawyer settings" })
    ).toBeTruthy();
    expect(screen.getByRole("tabpanel", { name: "Library" })).toBeTruthy();
    expect(await screen.findByText("quote.docx")).toBeTruthy();
    expect(lastLibraryQuery()?.get("bot")).toBe("lawyer");
    expect(
      screen.queryByRole("combobox", { name: "Filter by bot" })
    ).toBeNull();
  });

  it("loads tools only after selecting a section and preserves general edits", async () => {
    renderBusy();
    const header = pane("Lawyer");
    for (const name of [
      "Watch live",
      "Library",
      "Routines",
      "Memory",
      "Search history",
    ]) {
      expect(header.queryByRole("button", { name })).toBeNull();
    }
    fireEvent.click(header.getByRole("button", { name: "Bot settings" }));
    const name = await screen.findByRole("textbox", { name: "Name" });
    fireEvent.change(name, { target: { value: "Legal assistant" } });
    expect(server.to("GET", "/api/library")).toHaveLength(0);
    expect(server.to("GET", "/api/bots/lawyer/routines")).toHaveLength(0);
    expect(server.to("GET", "/api/bots/lawyer/memory")).toHaveLength(0);
    for (const section of [
      "General",
      "Live",
      "Library",
      "Routines",
      "Memory",
      "History",
    ]) {
      expect(screen.getByRole("tab", { name: section })).toBeTruthy();
    }
    fireEvent.click(screen.getByRole("tab", { name: "Library" }));
    await screen.findByText("Your library starts here");
    fireEvent.click(screen.getByRole("tab", { name: "General" }));
    expect(
      (screen.getByRole("textbox", { name: "Name" }) as HTMLInputElement).value
    ).toBe("Legal assistant");
  });

  it("downloads from the filename or the download action", async () => {
    const generated = makeFile({
      contentType: "image/png",
      id: "33333333-3333-4333-8333-333333333333",
      name: "design.png",
    });
    server.on("GET", "/api/library", json(page([generated])));
    renderBusy();
    await openLibrary();
    await settle(20);

    const expectedHref = `/api/files/${generated.id}?download`;
    const filenameLink = screen.getByRole("link", { name: "design.png" });
    const downloadLink = screen.getByRole("link", {
      name: "Download design.png",
    });
    expect(filenameLink.getAttribute("href")).toBe(expectedHref);
    expect(filenameLink.getAttribute("download")).toBe("design.png");
    expect(downloadLink.getAttribute("href")).toBe(expectedHref);
    expect(downloadLink.getAttribute("download")).toBe("design.png");
  });

  it("closes without losing the bot draft", async () => {
    renderBusy();
    const message = pane("Lawyer").getByLabelText(
      "Message"
    ) as HTMLTextAreaElement;
    fireEvent.change(message, { target: { value: "keep this draft" } });
    await openLibrary();
    await settle(10);
    closeLibrary();

    expect(
      (pane("Lawyer").getByLabelText("Message") as HTMLTextAreaElement).value
    ).toBe("keep this draft");
  });

  it("appends a page and retries a failed next-page request without duplicating rows", async () => {
    const first = makeFile({
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      id: "44444444-4444-4444-8444-444444444444",
      name: "first.xlsx",
    });
    const second = makeFile({
      contentType:
        "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      id: "55555555-5555-4555-8555-555555555555",
      name: "second.xlsx",
    });
    server.once("GET", "/api/library", json(page([first], "cursor-1")));
    const failed = vi.fn(() => json({ error: "temporary" }, 503));
    server.once("GET", "/api/library", failed);
    server.once("GET", "/api/library", json(page([second])));
    renderBusy();
    await openLibrary();
    await settle(20);
    expect(screen.getByText("first.xlsx")).toBeTruthy();
    expect(lastLibraryQuery()?.get("bot")).toBe("lawyer");

    fireEvent.click(screen.getByRole("button", { name: "Load more files" }));
    await settle(20);
    expect(screen.getByRole("alert").textContent).toContain(
      "Couldn’t load your files"
    );
    expect(screen.getByText("first.xlsx")).toBeTruthy();

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle(20);
    expect(screen.getByText("first.xlsx")).toBeTruthy();
    expect(screen.getByText("second.xlsx")).toBeTruthy();
    expect(screen.getAllByText("first.xlsx")).toHaveLength(1);
    expect(lastLibraryQuery()?.get("bot")).toBe("lawyer");
    expect(failed).toHaveBeenCalledTimes(1);
  });

  it("shows the other bot's files only after closing and reopening its own sheet", async () => {
    const lawyerFile = makeFile({
      id: "88888888-8888-4888-8888-888888888888",
      name: "lawyer.docx",
    });
    const analystFile = makeFile({
      bot: { avatar: null, name: "Analyst", slug: "analyst" },
      id: "99999999-9999-4999-8999-999999999999",
      name: "analysis.xlsx",
    });
    server.on("GET", "/api/library", (call) => {
      const bot = new URL(call.url, "https://busy.test").searchParams.get(
        "bot"
      );
      return json(page([bot === "analyst" ? analystFile : lawyerFile]));
    });
    renderBusy();
    await openLibrary("Lawyer");
    await settle(20);
    expect(screen.getByText("lawyer.docx")).toBeTruthy();
    closeLibrary();

    fireEvent.click(screen.getByRole("button", { name: "Analyst" }));
    await openLibrary("Analyst");
    await settle(20);
    expect(screen.getByText("analysis.xlsx")).toBeTruthy();
    expect(
      within(
        screen.getByRole("dialog", { name: "Analyst settings" })
      ).queryByText("lawyer.docx")
    ).toBeNull();
    expect(lastLibraryQuery()?.get("bot")).toBe("analyst");
  });

  it("offers retry after an initial failure and then shows the empty state", async () => {
    server.once("GET", "/api/library", json({ error: "offline" }, 503));
    server.once("GET", "/api/library", json(page([])));
    renderBusy();
    await openLibrary();
    await settle(20);
    expect(screen.getByRole("alert").textContent).toContain("Try again");

    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    await settle(20);
    expect(
      screen.getByRole("heading", { name: "Your library starts here" })
    ).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });
});
