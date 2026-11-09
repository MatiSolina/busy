import { expect, it as test } from "vitest";
import { archiveContainsMarker } from "./verify-ui";

test("checks the newest archived session payload instead of the active pane", () => {
  expect(
    archiveContainsMarker(
      [
        {
          rows: [
            {
              data: {
                data: { value: "Evaluation 0/1/69." },
              },
            },
          ],
          sessionId: "oldest",
        },
        {
          rows: [
            {
              data: {
                data: { value: "Evaluation 0/2/69." },
              },
            },
          ],
          sessionId: "newest-archived",
        },
      ],
      "Evaluation 0/2/69."
    )
  ).toBe(true);
  expect(
    archiveContainsMarker(
      [
        {
          rows: [{ data: { data: { value: "Evaluation 0/1/69." } } }],
          sessionId: "oldest",
        },
      ],
      "Evaluation 0/2/69."
    )
  ).toBe(false);
});
