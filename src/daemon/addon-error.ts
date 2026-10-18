// v1.0 gate: an add-on's own refusal, written by AI Term for the person who typed the command (it may name their path,
// test command or ref). The daemon passes these to the popup with control characters removed; any other error stays a
// fixed line, since it may carry a system message or a path nobody typed.
export class AddonError extends Error {}
export const shownAddonError = (message: string): string => message.replace(/[\p{C}]/gu, '?').slice(0, 300);
