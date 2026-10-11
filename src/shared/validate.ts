export function isValidModelId(id: string): boolean {
  // Keep the expression identical to the approved architecture §7.2.
  // eslint-disable-next-line no-useless-escape
  return /^[A-Za-z0-9][A-Za-z0-9._:\[\]\/-]{0,79}$/.test(id);
}
