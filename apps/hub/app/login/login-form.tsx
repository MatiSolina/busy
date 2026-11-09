"use client";

import { useRouter, useSearchParams } from "next/navigation";
import { useCallback, useState } from "react";
import { Button, buttonVariants } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { safeNext } from "@/lib/auth/next-path";

const MESSAGES = {
  limited: "Too many attempts. Try again in 15 minutes.",
  network: "Can't reach Busy. Try again.",
  password: "Wrong username or password.",
  vercel: "Couldn't sign in with Vercel.",
};

export function LoginForm({ vercel }: { vercel: boolean }) {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next");
  const [error, setError] = useState<keyof typeof MESSAGES | null>(
    params.get("error") === "vercel" ? "vercel" : null
  );
  const [pending, setPending] = useState(false);

  const onSubmit = useCallback(
    async (e: React.FormEvent<HTMLFormElement>) => {
      e.preventDefault();
      setPending(true);
      setError(null);
      const form = new FormData(e.currentTarget);
      const res = await fetch("/api/auth/login", {
        body: JSON.stringify({
          password: form.get("password"),
          user: form.get("user"),
        }),
        headers: { "Content-Type": "application/json" },
        method: "POST",
      }).catch(() => null);
      if (res?.ok) {
        router.replace(safeNext(next, window.location.origin));
      } else {
        if (!res) {
          setError("network");
        } else if (res.status === 429) {
          setError("limited");
        } else {
          setError("password");
        }
        setPending(false);
      }
    },
    [next, router]
  );

  return (
    <form className="flex w-full max-w-xs flex-col gap-5" onSubmit={onSubmit}>
      <div className="flex flex-col gap-2">
        <Label htmlFor="user">Username</Label>
        <Input
          autoComplete="username"
          autoFocus
          id="user"
          name="user"
          required
        />
      </div>
      <div className="flex flex-col gap-2">
        <Label htmlFor="password">Password</Label>
        <Input
          autoComplete="current-password"
          id="password"
          name="password"
          required
          type="password"
        />
      </div>
      <p className="text-destructive min-h-5 text-sm" role="alert">
        {error ? MESSAGES[error] : null}
      </p>
      <Button disabled={pending} type="submit">
        {pending ? "Signing in…" : "Sign in"}
      </Button>
      {vercel ? (
        <>
          <div className="text-muted-foreground flex items-center gap-3 text-xs">
            <span className="bg-border h-px flex-1" />
            or
            <span className="bg-border h-px flex-1" />
          </div>
          {/* A plain link: the start route answers with a redirect to Vercel, not a page. */}
          <a
            className={buttonVariants({ variant: "outline" })}
            href={
              next
                ? `/api/auth/vercel?${new URLSearchParams({ next })}`
                : "/api/auth/vercel"
            }
          >
            <svg aria-hidden="true" className="size-3" viewBox="0 0 76 65">
              <path
                d="M37.5274 0L75.0548 65H0L37.5274 0Z"
                fill="currentColor"
              />
            </svg>
            Continue with Vercel
          </a>
        </>
      ) : null}
    </form>
  );
}
