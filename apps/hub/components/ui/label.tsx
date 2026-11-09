"use client";

import { cn } from "cn";
import { type ComponentProps, createElement } from "react";

function Label({
  className,
  htmlFor,
  ...props
}: ComponentProps<"label"> & { htmlFor: string }) {
  return createElement("label", {
    ...props,
    className: cn(
      "flex items-center gap-2 text-sm leading-none font-medium select-none group-data-[disabled=true]:pointer-events-none group-data-[disabled=true]:opacity-50 peer-disabled:cursor-not-allowed peer-disabled:opacity-50",
      className
    ),
    "data-slot": "label",
    htmlFor,
  });
}

export { Label };
