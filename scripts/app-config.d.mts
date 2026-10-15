export interface AppBuilderInput { platform: NodeJS.Platform; root: string; out: string; version: string; arch: string }
export function appBuilderConfig(input: AppBuilderInput): Record<string, unknown> & { extraFiles?: { from: string; to: string }[]; linux?: Record<string, unknown>; mac?: Record<string, unknown>; win?: Record<string, unknown>; nsis?: Record<string, unknown> };
