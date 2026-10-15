// A path that can't go into a sandbox (a Seatbelt profile string, or a bwrap argv that must be a plain absolute path).
export class SandboxPathError extends Error {}
