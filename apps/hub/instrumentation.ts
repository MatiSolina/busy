import { registerOTel } from "@vercel/otel";

// Route handlers, outgoing fetch (eve, AI providers) and the spans from lib/trace.ts land in
// Vercel Observability → Traces.
export function register() {
  registerOTel({ serviceName: "busy-hub" });
}
