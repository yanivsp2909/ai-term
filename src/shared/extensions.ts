// Extension IDs identify discovered files, never paths supplied by a model or socket client.
export type ExtensionKind = 'skill' | 'agent' | 'command';
export type ExtensionSource = 'Claude' | 'Codex' | 'shared' | 'this project';
export interface ExtensionItem {
  id: string; kind: ExtensionKind; name: string; description: string; source: ExtensionSource;
  enabled: boolean; tokens: number; model?: string;
}
export interface ExtensionCatalog { items: ExtensionItem[]; notes: string[]; tokens: number }
export interface ExtensionFile { item: ExtensionItem; text: string; body: string }
export interface ExtensionAccess {
  list(cwd: string): Promise<ExtensionCatalog>;
  read(cwd: string, id: string): Promise<ExtensionFile>;
  toggle(cwd: string, id: string, enabled: boolean): Promise<ExtensionCatalog>;
}
export const EXTENSION_MAX_ITEMS = 500, EXTENSION_FILE_BYTES = 64 * 1024, EXTENSION_TOTAL_BYTES = 1024 * 1024;
export const EXTENSION_DESCRIPTION_CHARS = 240;
export const isExtensionId = (v: unknown): v is string => typeof v === 'string' && /^[a-f0-9]{16}$/.test(v);
export function extensionManifest(items: readonly ExtensionItem[]): string {
  return items.filter(i => i.enabled && i.kind !== 'command').map(i => `${i.kind} ${i.name}: ${i.description}`).join('\n');
}
// A visible estimate, not a tokenizer measurement or the worst-case budget check. UTF-8 bytes / 3 rounds up.
export const extensionTokens = (text: string): number => Math.ceil(Buffer.byteLength(text) / 3);
export function catalogTokens(items: readonly ExtensionItem[]): number { return extensionTokens(extensionManifest(items)); }
