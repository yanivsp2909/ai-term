// Cuts counted in UTF-16 units (String.slice) can split an emoji and leave half a surrogate pair, which the validators
// rightly treat as a control character, so one long description or one secret suffix refused a whole catalog.

// The first `max` UTF-16 units, without a trailing half of a pair.
export function cutText(text: string, max: number): string {
  const cut = text.slice(0, max);
  return /[\uD800-\uDBFF]$/.test(cut) ? cut.slice(0, -1) : cut;
}
// A secret's last four characters for display, only when it is long enough that four reveal little (real provider keys
// are far longer than 16), and nothing
// rather than a suffix that would cut a character or show a control character.
export const SUFFIX_MIN_SECRET = 16;
export function lastFour(secret: string): string {
  const suffix = secret.slice(-4);
  return secret.length >= SUFFIX_MIN_SECRET && !/[\p{C}]/u.test(suffix) ? suffix : '';
}
