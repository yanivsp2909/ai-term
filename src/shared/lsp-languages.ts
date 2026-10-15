import { findExecutable } from './executable.js';

// The languages v0.9.3 diagnostics cover, their language servers and how to install each. Shared so /settings can say
// which are found (Yaniv: with none installed the switch did nothing, quietly).
export interface LspLanguage { id: string; label: string; server: string; args: string[]; exts: readonly string[]; install: string; languageId: (ext: string) => string }
export const LSP_LANGUAGES: readonly LspLanguage[] = [
  { id: 'typescript', label: 'TypeScript/JavaScript', server: 'typescript-language-server', args: ['--stdio'], exts: ['.ts', '.tsx', '.mts', '.cts', '.js', '.jsx', '.mjs', '.cjs'], install: 'npm i -g typescript-language-server typescript', languageId: ext => ext.includes('ts') ? (ext === '.tsx' ? 'typescriptreact' : 'typescript') : ext === '.jsx' ? 'javascriptreact' : 'javascript' },
  { id: 'python', label: 'Python', server: 'pyright-langserver', args: ['--stdio'], exts: ['.py', '.pyi'], install: 'npm i -g pyright', languageId: () => 'python' },
  { id: 'go', label: 'Go', server: 'gopls', args: [], exts: ['.go'], install: 'go install golang.org/x/tools/gopls@latest', languageId: () => 'go' },
  { id: 'rust', label: 'Rust', server: 'rust-analyzer', args: [], exts: ['.rs'], install: 'rustup component add rust-analyzer', languageId: () => 'rust' },
];
// The labels of the languages whose server is on PATH.
export async function serversFound(path = process.env.PATH ?? ''): Promise<string[]> {
  const found = await Promise.all(LSP_LANGUAGES.map(async language => await findExecutable(language.server, path) ? language.label : null));
  return found.filter((label): label is string => label !== null);
}
