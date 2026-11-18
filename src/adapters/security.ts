// Compares secrets without returning early on the first different character, so response
// timing doesn't reveal how much of a guess was right
export function constantTimeEqual(provided: string, expected: string): boolean {
  const encoder = new TextEncoder();
  const providedBytes = encoder.encode(provided);
  const expectedBytes = encoder.encode(expected);
  let difference = providedBytes.length ^ expectedBytes.length;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= (providedBytes[index] ?? 0) ^ expectedBytes[index]!;
  }
  return difference === 0 && expectedBytes.length > 0;
}

export function readBearerToken(authorizationHeader: string | null): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(authorizationHeader ?? "");
  return match ? match[1]!.trim() : null;
}
