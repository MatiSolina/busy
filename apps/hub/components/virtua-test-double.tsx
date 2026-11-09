// Happy DOM has no layout, so a real virtualizer would mount almost nothing. Tests that
// exercise the whole chat pane render every row through this stand-in instead.
import { Children, type ReactNode, type Ref, useImperativeHandle } from "react";

export function Virtualizer({
  children,
  ref,
}: {
  children: ReactNode;
  ref?: Ref<unknown>;
}) {
  useImperativeHandle(ref, () => ({
    findItemIndex: () => Number.POSITIVE_INFINITY,
    scrollOffset: 0,
  }));
  return (
    <ol>
      {Children.map(children, (row) => (
        <li>{row}</li>
      ))}
    </ol>
  );
}
