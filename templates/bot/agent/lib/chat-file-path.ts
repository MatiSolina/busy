// Where chat_files copies a chat file inside the sandbox. The file's id (a UUID the
// tool's input schema already validated) keeps two versions, or two files with the
// same name, apart and makes a retry land on the same path. The visible name is only
// sanitized so it can never become a directory, a separator or a control byte; the
// name shown to people in the chat does not change.
export const CHAT_DIR = "/workspace/chat";

// Linux allows 255 bytes per name; the id and its dash take 37.
const MAX_NAME_BYTES = 200;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control bytes are exactly what this replaces
const UNSAFE = /[/\\\u0000-\u001f\u007f]/gu;
const encoder = new TextEncoder();

export function safeChatFileName(filename: string): string {
  const name = filename.normalize("NFC").replace(UNSAFE, "_").trim();
  if (name === "" || name === "." || name === "..") {
    return "file";
  }
  let kept = "";
  let bytes = 0;
  for (const char of name) {
    bytes += encoder.encode(char).length;
    if (bytes > MAX_NAME_BYTES) {
      break;
    }
    kept += char;
  }
  return kept;
}

export function chatFilePath(id: string, filename: string): string {
  return `${CHAT_DIR}/${id}-${safeChatFileName(filename)}`;
}
