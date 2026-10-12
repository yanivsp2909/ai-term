import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isFsError } from '../shared/paths.js';
import { validateSettings, validateSettingsPatch } from '../shared/validate.js';
import type { Settings, SettingsPatch } from '../shared/protocol.js';
import { atomicWrite } from './store.js';

export class SettingsStore {
  private queue: Promise<unknown> = Promise.resolve();
  private readonly path: string;
  constructor(root: string) { this.path = join(root, 'settings.json'); }
  async get(): Promise<Settings> {
    let file;
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (isFsError(error, 'ENOENT')) return { theme: 'graphite' }; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 16384) throw new Error('Unsafe settings file');
      await file.chmod(0o600);
      return validateSettings(JSON.parse(await file.readFile('utf8')) as unknown);
    } finally { await file.close(); }
  }
  set(patch: SettingsPatch): Promise<Settings> {
    const validated = validateSettingsPatch(patch, true);
    // A failed write stays visible to its caller; later requests may retry.
    return this.update(async settings=>({...settings,...validated}));
  }
  update(transform:(settings:Settings)=>Promise<Settings>):Promise<Settings> {
    const next = this.queue.then(async () => { const settings = validateSettings(await transform(await this.get())); await atomicWrite(this.path, settings); return settings; });
    this.queue = next.then(() => undefined, () => undefined);
    return next;
  }
}
