import { z } from "zod";
import { getBot } from "@/lib/bots/service";
import { capabilityError, capabilityJson } from "@/lib/capabilities/http";
import {
  publicCapability,
  removeCapability,
  updateCapability,
} from "@/lib/capabilities/store";
import { parseCapabilityPatch } from "@/lib/capabilities/validation";

interface Context {
  params: Promise<{ slug: string; id: string }>;
}

export async function PATCH(req: Request, { params }: Context) {
  try {
    const { slug, id } = await params;
    if (!z.uuid().safeParse(id).success) {
      return capabilityJson({ error: "Capability not found." }, 404);
    }
    const bot = await getBot(slug);
    if (!bot) {
      return capabilityJson({ error: "Bot not found." }, 404);
    }
    const row = await updateCapability(
      id,
      parseCapabilityPatch(await req.json().catch(() => null))
    );
    return capabilityJson({ capability: publicCapability(row) });
  } catch (error) {
    return capabilityError(error);
  }
}

export async function DELETE(_req: Request, { params }: Context) {
  try {
    const { slug, id } = await params;
    if (!z.uuid().safeParse(id).success) {
      return capabilityJson({ error: "Capability not found." }, 404);
    }
    const bot = await getBot(slug);
    if (!bot) {
      return capabilityJson({ error: "Bot not found." }, 404);
    }
    await removeCapability(id);
    return new Response(null, {
      headers: { "Cache-Control": "no-store" },
      status: 204,
    });
  } catch (error) {
    return capabilityError(error);
  }
}
