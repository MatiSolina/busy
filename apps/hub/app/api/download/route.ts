import { readUrl } from "@/lib/files";

const RELEASE_PATH = "releases/Busy-mac-arm64.zip";

// The release zip is private in Blob; each download gets a fresh short-lived URL.
export async function GET() {
  return Response.redirect(await readUrl(RELEASE_PATH), 302);
}
