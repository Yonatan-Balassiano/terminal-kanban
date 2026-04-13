export function extractLastOsc7Cwd(data: string): string | null {
  const matches = Array.from(
    data.matchAll(/\u001b]7;file:\/\/[^/\u0007\u001b]*(\/[^\u0007\u001b]*?)(?:\u0007|\u001b\\)/g),
  );
  const rawPath = matches.at(-1)?.[1];
  if (!rawPath) {
    return null;
  }

  try {
    return decodeURIComponent(rawPath);
  } catch {
    return rawPath;
  }
}
