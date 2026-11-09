import { jwtEcdsa, localDev, vercelOidc } from "eve/channels/auth";
import { eveChannel } from "eve/channels/eve";
import config from "../config.json" with { type: "json" };
import {
  acceptsLegacyPeerOidc,
  consultationVerifier,
} from "../lib/consultation-auth";

const team = process.env.VERCEL_TEAM_SLUG;
const hubKey = process.env.HUB_PUBLIC_KEY;

export default eveChannel({
  auth: [
    // The hub: a 5-minute token it signs for this bot only (aud = slug, hub lib/hub-token.ts),
    // so a bot that receives one can't replay it here. No key, no hub access.
    ...(hubKey
      ? [
          jwtEcdsa({
            algorithm: "ES256",
            audiences: [config.slug],
            issuer: "busy-hub",
            publicKey: hubKey,
          }),
          // Another bot consulting this one with a credential the hub signed for exactly this
          // pair (aud = busy-consultation:<slug>, 5 minutes): read-only, one hop (H-26).
          jwtEcdsa(consultationVerifier(config.slug, hubKey)),
        ]
      : []),
    // Legacy: other bots consulting this one with their own Vercel OIDC token. A static pattern
    // so a bot created later works without redeploying this one (spec 4.7). Retired by setting
    // BUSY_LEGACY_PEER_OIDC=off once every bot sends hub credentials (docs/consultations.md).
    ...(acceptsLegacyPeerOidc()
      ? [
          vercelOidc({
            subjects: team
              ? [`owner:${team}:project:bot-*:environment:production`]
              : [],
          }),
        ]
      : []),
    localDev(),
  ],
});
