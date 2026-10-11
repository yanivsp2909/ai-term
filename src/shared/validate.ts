export function isValidModelId(id: string): boolean {
  // Keep the expression identical to the approved architecture §7.2.
  // eslint-disable-next-line no-useless-escape
  return /^[A-Za-z0-9][A-Za-z0-9._:\[\]\/-]{0,79}$/.test(id);
}

export function isUUID(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(value);
}
