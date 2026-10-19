import { join } from 'node:path';
import { lstat, open } from 'node:fs/promises';
import { constants } from 'node:fs';
import { isFsError } from '../shared/paths.js';
import { validateSettings, validateSettingsPatch, validateKeyView } from '../shared/validate.js';
import type { Settings, SettingsPatch } from '../shared/protocol.js';
import { atomicWrite } from './store.js';
import { ownedByMe } from '../shared/owner.js';

const queues = new Map<string, Promise<unknown>>();
// v1.2 first-run setup: an AI Term folder with no settings and no agent list is new. The daemon marks it pending at its
// first start, so the homepage opens the setup once; a folder that was already in use never gets the mark.
export async function markFreshSetup(root: string, state: string): Promise<boolean> {
  for (const file of [join(root, 'settings.json'), state]) {
    try { await lstat(file); return false; } catch (error) { if (!isFsError(error, 'ENOENT')) throw error; }
  }
  await new SettingsStore(root).set({ setup: 'pending' });
  return true;
}
export class SettingsStore {
  private readonly path: string;
  constructor(root: string, private readonly onInvalidKey?:()=>void) { this.path = join(root, 'settings.json'); }
  async get(): Promise<Settings> { return (await this.read()).settings; }
  private async read():Promise<{settings:Settings;skipped:unknown[]}> {
    let file;
    try { file = await open(this.path, constants.O_RDONLY | constants.O_NOFOLLOW); }
    catch (error) { if (isFsError(error, 'ENOENT')) return {settings:{theme:'graphite'},skipped:[]}; throw error; }
    try {
      const stat = await file.stat();
      if (!stat.isFile() || !ownedByMe(stat) || stat.size > 16384) throw new Error('Unsafe settings file');
      await file.chmod(0o600);
      const raw:unknown=JSON.parse(await file.readFile('utf8'));
      const skipped:unknown[]=[];
      // Recovery exposes valid entries, but skipped entries stay on disk for later credential cleanup.
      if(this.onInvalidKey&&raw&&typeof raw==='object'&&'keys'in raw&&Array.isArray(raw.keys)&&raw.keys.length<=100){
        raw.keys=raw.keys.flatMap((key:unknown)=>{try{return [validateKeyView(key)];}catch{skipped.push(key);this.onInvalidKey?.();return [];}});
      }
      return {settings:validateSettings(raw),skipped};
    } finally { await file.close(); }
  }
  set(patch: SettingsPatch): Promise<Settings> {
    const validated = validateSettingsPatch(patch, true);
    // A failed write stays visible to its caller; later requests may retry.
    return this.update(async settings=>({...settings,...validated}));
  }
  update(transform:(settings:Settings)=>Promise<Settings>):Promise<Settings> {
    const next = (queues.get(this.path)??Promise.resolve()).then(async () => { const current=await this.read();const settings=validateSettings(await transform(current.settings));
      const stored=current.skipped.length?{...settings,keys:[...(Array.isArray(settings.keys)?settings.keys:[]),...current.skipped]}:settings;
      if(Array.isArray(stored.keys)&&stored.keys.length>100)throw new Error('Too many keys');
      validateSettingsPatch(stored);await atomicWrite(this.path,stored);return settings; });
    const settled=next.then(()=>undefined,()=>undefined);queues.set(this.path,settled);
    void settled.then(()=>{if(queues.get(this.path)===settled)queues.delete(this.path);});
    return next;
  }
}
