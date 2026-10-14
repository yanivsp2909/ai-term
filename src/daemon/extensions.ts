import { homedir } from 'node:os';
import { ExtensionReader } from '../agent/extensions/reader.js';
import { validateExtensionRequest } from '../shared/validate.js';
import type { SettingsStore } from './settings.js';
import type { ExtensionCatalog, ExtensionFile } from '../shared/extensions.js';

// Settings owns toggles. The reader owns every extension path, including a full-file preview and lazy tool load.
export class ExtensionService {
  constructor(private readonly settings: SettingsStore, private readonly home = homedir()) {}
  async query(raw: Record<string, unknown>): Promise<{ extensions: ExtensionCatalog } | { extension: ExtensionFile }> {
    validateExtensionRequest(raw);
    const cwd = String(raw.cwd), reader = new ExtensionReader(this.home, cwd), settings = await this.settings.get();
    const catalog = reader.scan(settings.extensions);
    if (raw.kind === 'extensions.list') return { extensions: catalog };
    const file = reader.read(String(raw.extensionId));
    if (raw.kind === 'extensions.read') return { extension: file };
    await this.settings.update(async current => ({ ...current, extensions: { ...current.extensions, [file.item.id]: raw.enabled === true } }));
    return { extensions: reader.scan((await this.settings.get()).extensions) };
  }
}
