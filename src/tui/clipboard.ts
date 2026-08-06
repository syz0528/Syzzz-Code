export const MAX_CLIPBOARD_CHARACTERS = 256 * 1024;

export function encodeOsc52Clipboard(text: string): string {
  if (text.length > MAX_CLIPBOARD_CHARACTERS) {
    throw new Error(`Selection exceeds ${MAX_CLIPBOARD_CHARACTERS} characters`);
  }
  return `\u001B]52;c;${Buffer.from(text, 'utf8').toString('base64')}\u0007`;
}
