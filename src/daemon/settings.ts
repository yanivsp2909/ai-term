import { join } from 'node:path';
import { open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isFsError } from '../shared/paths.js';
import { validateSettings, validateSettingsPatch, validateKeyView } from '../shared/validate.js';
import type { Settings, SettingsPatch } from '../shared/protocol.js';
import { atomicWrite } from './store.js';

const queues = new Map<string, Promise<unknown>>();
export class SettingsStore {
  private readonly path: string;
  constructor(root: string, private readonly onInvalidKey?:()=>void) { this.path = join(root, 'settings.json'); }
  async get(): Promise<Settings> {
    let file;
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (isFsError(error, 'ENOENT')) return { theme: 'graphite' }; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || stat.uid !== process.getuid?.() || stat.size > 16384) throw new Error('Unsafe settings file');
      await file.chmod(0o600);
      const raw:unknown=JSON.parse(await file.readFile('utf8'));
      // KeyStore alone requests per-entry recovery. Protocol settings and routing remain strictly validated.
      if(this.onInvalidKey&&raw&&typeof raw==='object'&&'keys'in raw&&Array.isArray(raw.keys)&&raw.keys.length<=100){
        raw.keys=raw.keys.flatMap((key:unknown)=>{try{return [validateKeyView(key)];}catch{this.onInvalidKey?.();return [];}});
      }
      return validateSettings(raw);
    } finally { await file.close(); }
  }
  set(patch: SettingsPatch): Promise<Settings> {
    const validated = validateSettingsPatch(patch, true);
    // A failed write stays visible to its caller; later requests may retry.
    return this.update(async settings=>({...settings,...validated}));
  }
  update(transform:(settings:Settings)=>Promise<Settings>):Promise<Settings> {
    const next = (queues.get(this.path)??Promise.resolve()).then(async () => { const settings = validateSettings(await transform(await this.get())); await atomicWrite(this.path, settings); return settings; });
    const settled=next.then(()=>undefined,()=>undefined);queues.set(this.path,settled);
    void settled.then(()=>{if(queues.get(this.path)===settled)queues.delete(this.path);});
    return next;
  }
}
