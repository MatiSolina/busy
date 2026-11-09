import assert from "node:assert/strict";

export function defined<T>(value: T | null | undefined): T {
  assert(value !== null && value !== undefined);
  return value;
}
