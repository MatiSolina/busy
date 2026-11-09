import { Suspense } from "react";
import { vercelLoginEnabled } from "@/lib/auth/vercel";
import { LoginAvatar } from "./login-avatar";
import { LoginForm } from "./login-form";

// Server component so the Vercel button only renders when its env is set. It's read at build time,
// which is fine: Vercel env changes need a redeploy anyway.
export default function LoginPage() {
  return (
    <main className="flex min-h-dvh flex-col items-center justify-center gap-10 px-4">
      <h1 className="flex flex-col items-center gap-5">
        <LoginAvatar />
        <span className="font-pixel text-5xl leading-none">busy</span>
      </h1>
      <Suspense>
        <LoginForm vercel={vercelLoginEnabled()} />
      </Suspense>
    </main>
  );
}
