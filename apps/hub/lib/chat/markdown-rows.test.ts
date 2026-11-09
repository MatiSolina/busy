import { expect, it as test } from "vitest";
import { type ClientRow, toChatView } from "./items";
import { parseMarkdown } from "./markdown";
import { prepareMarkdownRows } from "./markdown-rows";
import { decodeMarkdown } from "./markdown-transport";

test("serializes sanitized display metadata without changing stored facts", () => {
  const value = "<script>bad()</script>**Hello**";
  const row: ClientRow = {
    data: {
      data: { kind: "text", phase: "reply", value },
      type: "content.completed",
    },
    index: 0,
    line: 1,
    type: "content.completed",
  };
  const [prepared] = prepareMarkdownRows([row]);
  expect(typeof prepared.md).toBe("string");
  expect(decodeMarkdown(prepared.md ?? "null", value)).toEqual(
    parseMarkdown(value)
  );
  expect(prepared.md).not.toContain("bad()");
  expect(prepared.data).toBe(row.data);
  expect(row).not.toHaveProperty("md");
});

test("does not decorate user, tool or non-text facts", () => {
  const rows: ClientRow[] = [
    "delivery.consumed",
    "call.settled",
    "content.completed",
  ].map((type, line) => ({
    data: { data: { kind: "file", phase: "reply", value: "file.pdf" }, type },
    index: 0,
    line,
    type,
  }));
  expect(prepareMarkdownRows(rows)).toEqual(rows);
});

test("compacts large tool bodies without changing the chat projection", () => {
  const big = "x".repeat(5000);
  const plan = {
    id: "p",
    revision: 1,
    steps: [
      {
        assignee: "me",
        dependsOn: [],
        expectedResult: "done",
        id: "s1",
        status: "pending",
        title: "Step",
      },
    ],
    title: "Plan",
  };
  const facts: [string, Record<string, unknown>][] = [
    ["turn.started", { turnId: "t" }],
    [
      "call.requested",
      {
        callId: "bash",
        capability: { name: "bash" },
        input: { command: "ls", script: big },
      },
    ],
    ["call.settled", { callId: "bash", outcome: "completed", output: big }],
    [
      "call.requested",
      { callId: "plan", capability: { name: "manage_plan" }, input: {} },
    ],
    [
      "call.settled",
      { callId: "plan", outcome: "completed", output: { log: big, plan } },
    ],
    [
      "call.requested",
      { callId: "file", capability: { name: "make_file" }, input: {} },
    ],
    [
      "call.settled",
      {
        callId: "file",
        outcome: "completed",
        output: {
          body: big,
          contentType: "text/plain",
          fileId: "f",
          name: "a.txt",
          size: 1,
        },
      },
    ],
    [
      "call.requested",
      { callId: "mcp", capability: { name: "mcp__app__show" }, input: {} },
    ],
    [
      "call.settled",
      {
        callId: "mcp",
        outcome: "completed",
        output: [
          { data: big, type: "image" },
          {
            text: JSON.stringify({
              _busyMcpApp: {
                snapshotId: "0f8fad5b-d9cb-469f-a165-70867728950e",
              },
            }),
            type: "text",
          },
        ],
      },
    ],
    ["content.completed", { kind: "reasoning", value: big }],
    [
      "content.completed",
      { kind: "text", partId: "r", phase: "reply", value: "Hi" },
    ],
    ["turn.settled", { outcome: "completed", turnId: "t" }],
  ];
  const rows: ClientRow[] = facts.map(([type, data], line) => ({
    data: { data, type },
    index: 0,
    line,
    type,
  }));
  const prepared = prepareMarkdownRows(rows);
  const view = (list: ClientRow[]) =>
    toChatView(list, new Map(), new Map()).items;
  expect(view(prepared)).toEqual(
    view(prepareMarkdownRows(rows.map((r) => ({ ...r }))))
  );
  expect(view(prepared)).toEqual(
    view(rows).map((item) =>
      item.kind === "bot" ? { ...item, markdown: expect.any(String) } : item
    )
  );
  expect(view(prepared).map((item) => item.kind)).toEqual([
    "activity",
    "plan",
    "activity",
    "file",
    "activity",
    "mcp-app",
    "bot",
  ]);
  expect(JSON.stringify(prepared).length).toBeLessThan(3000);
  expect(JSON.stringify(rows).length).toBeGreaterThan(25_000);
});
