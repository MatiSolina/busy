"use client";

import { UserRound } from "lucide-react";
import Image from "next/image";
import { useCallback, useState } from "react";
import { useAccount } from "@/components/account-provider";

const SPACE_RE = /\s+/u;

export function AccountAvatar() {
  const { data } = useAccount();
  const [failedUrl, setFailedUrl] = useState<string | null>(null);
  const name = data?.account.name;
  const avatar = data?.account.avatarUrl;
  const handleAvatarError = useCallback(
    () => setFailedUrl(avatar ?? null),
    [avatar]
  );
  const initials = name
    ?.trim()
    .split(SPACE_RE)
    .slice(0, 2)
    .map((part) => Array.from(part)[0])
    .join("")
    .toLocaleUpperCase();
  return (
    <span
      aria-hidden="true"
      className="border-border bg-muted text-muted-foreground grid size-8 shrink-0 place-items-center overflow-hidden rounded-full border text-xs font-medium"
    >
      {avatar && avatar !== failedUrl ? (
        // The account service permits only Vercel avatar URLs; preserve the initials if it fails.
        <Image
          alt=""
          className="size-full object-cover"
          height={32}
          onError={handleAvatarError}
          src={avatar}
          unoptimized
          width={32}
        />
      ) : (
        initials || <UserRound className="size-4" />
      )}
    </span>
  );
}
