/**
 * Happy DOM exposes a partial Web Animations API whose native `finished` promise
 * rejects when an animation is canceled. Motion's native path does not observe
 * that promise, so test cleanup reports an unhandled AbortError. Removing only
 * this test-runtime method makes Motion use its JavaScript fallback while still
 * exercising Motion itself and keeps browser coverage on the real WAAPI path.
 */
export function disableHappyDomWebAnimations() {
  const elementPrototype = globalThis.Element?.prototype;
  if (!elementPrototype || typeof elementPrototype.animate !== "function") {
    return false;
  }
  return Reflect.deleteProperty(elementPrototype, "animate");
}
