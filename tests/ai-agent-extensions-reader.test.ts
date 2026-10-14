import { afterEach, expect, it, vi } from 'vitest';
import * as fs from 'node:fs';
import { mkdir, mkdtemp, realpath, writeFile, symlink, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { ExtensionReader, deniedExtensionPath } from '../src/agent/extensions/reader.js';
import { ExtensionService } from '../src/daemon/extensions.js';
import { SettingsStore } from '../src/daemon/settings.js';
import { validateExtensionCatalog, validateExtensionFile, validateRequest, validateSettingsPatch } from '../src/shared/validate.js';
import { EXTENSION_FILE_BYTES, EXTENSION_TOTAL_BYTES, extensionManifest, catalogTokens } from '../src/shared/extensions.js';

vi.mock('node:fs',async importOriginal=>{const actual=await importOriginal<typeof import('node:fs')>();return {...actual,readSync:vi.fn(actual.readSync)};});
const roots: string[] = [];
afterEach(async () => { for (const p of roots.splice(0)) await rm(p, { recursive: true, force: true }); });
async function setup() {
  const temp = await realpath(await mkdtemp(join(tmpdir(), 'ai-extensions-'))); roots.push(temp);
  const home = join(temp, 'home'), project = join(home, 'work'); await mkdir(project, { recursive: true });
  const file = async (path: string, text: string) => { const p = join(home, path); await mkdir(dirname(p), { recursive: true }); await writeFile(p, text); return p; };
  return { temp, home, project, file };
}
const skill = (name: string, description = 'A short description') => `---\nname: ${name}\ndescription: ${description}\n---\nBODY-${name}`;

it('reads exactly the five user roots and four project roots, following shared links inside the home', async () => {
  const { home, project, file } = await setup();
  for (const [folder, name] of [['.claude/skills/a','a'],['.agents/skills/b','b'],['work/.claude/skills/c','c'],['work/.agents/skills/d','d']]) await file(`${folder}/SKILL.md`, skill(name ?? ''));
  for (const folder of ['.claude/agents','work/.claude/agents','.claude/commands','work/.claude/commands','.codex/prompts']) await file(`${folder}/run.md`, `---\ndescription: Do something\n---\nDo $ARGUMENTS`);
  await file('.codex/skills/excluded/SKILL.md', skill('excluded'));
  const shared = await file('shared/e/SKILL.md', skill('e')); await symlink(dirname(shared), join(home,'.agents/skills/e'));
  const reader = new ExtensionReader(home, project), catalog = reader.scan();
  expect(catalog.items).toHaveLength(7); // The duplicate command name prefers this project; agent name does too.
  expect(catalog.items.map(i=>i.name)).not.toContain('excluded');
  expect(catalog.items.find(i=>i.name==='e')?.source).toBe('shared');
  expect(reader.read(catalog.items.find(i=>i.name==='a')?.id ?? '').body).toBe('BODY-a');
  expect(validateExtensionCatalog(catalog)).toBe(catalog);
  expect(validateExtensionFile(reader.read(catalog.items[0]?.id ?? ''))).toBeTruthy();
});

it('denies credential, auth, config, env, history and data paths after symlink resolution, with case folding', async () => {
  const { home, project, file } = await setup();
  const denied = ['.claude.json','.codex/auth.json','.codex/config.toml','.claude/.credentials.json','keys/credentials.yaml','Auth.JSON','settings.local.json','SETTINGS.JSON','service.env','.env.local','history.jsonl','sessions/a.md','logs/a.md','projects/a.md'];
  await mkdir(join(home,'.claude/skills'),{recursive:true});
  for (const [n,path] of denied.entries()) {
    expect(deniedExtensionPath(home,join(home,path))).toBe(true);
    const target=await file(path,skill('leak-'+n));
    await mkdir(join(home,'.claude/skills','link-'+n)); await symlink(target,join(home,'.claude/skills','link-'+n,'SKILL.md'));
  }
  await file('.claude/skills/good/SKILL.md',skill('good'));
  const catalog=new ExtensionReader(home,project).scan();
  expect(catalog.items.map(i=>i.name)).toEqual(['good']);
  expect(catalog.notes.filter(n=>n.includes('denied'))).toHaveLength(denied.length);
});

it('skips links outside home, loops, huge files, binary text and malformed frontmatter without crashing', async () => {
  const { home, project, file, temp }=await setup();
  await file('.claude/skills/huge/SKILL.md','x'.repeat(EXTENSION_FILE_BYTES+1));
  await file('.claude/skills/broken/SKILL.md','---\nname: broken\ndescription: [oops\n---\nbody');
  await file('.claude/skills/unclosed/SKILL.md','---\nname: missing');
  await file('.claude/skills/binary/SKILL.md',skill('binary')+'\0');
  const outside=join(temp,'outside');await mkdir(outside);await writeFile(join(outside,'SKILL.md'),skill('outside'));
  await symlink(outside,join(home,'.claude/skills/outside'));await symlink(join(home,'.claude/skills'),join(home,'.claude/skills/loop'));
  await file('.claude/skills/good/SKILL.md',skill('good'));
  const c=new ExtensionReader(home,project).scan();expect(c.items.map(i=>i.name)).toEqual(['good']);expect(c.notes.length).toBeGreaterThanOrEqual(5);
});

it('caps descriptions, accepts block/quoted metadata, and bounds the total file bytes', async () => {
  const {home,project,file}=await setup();
  await file('.agents/skills/quoted/SKILL.md',skill('quoted',JSON.stringify('word '.repeat(100))));
  await file('.agents/skills/block/SKILL.md','---\nname: block\ndescription: >\n  A block\n  description.\nmetadata:\n  version: 1\n---\nbody');
  for(let n=0;n<22;n++)await file(`.claude/skills/s${n}/SKILL.md`,skill('s'+n)+'x'.repeat(60*1024));
  const c=new ExtensionReader(home,project).scan();expect(c.items.find(i=>i.name==='quoted')?.description.length).toBe(240);
  expect(c.items.find(i=>i.name==='block')?.description).toBe('A block description.');
  expect(c.items.length).toBeLessThan(24);expect(c.notes.some(n=>n.includes('size limit'))).toBe(true);
});

it('saves per-item toggles only in AI Term settings and removes disabled items from the manifest estimate', async()=>{
  const {home,project,file}=await setup();await file('.claude/skills/a/SKILL.md',skill('a'));
  const settingsRoot=join(home,'ai-settings');await mkdir(settingsRoot);const settings=new SettingsStore(settingsRoot),service=new ExtensionService(settings,home);
  const listed=await service.query({kind:'extensions.list',cwd:project});if(!('extensions'in listed))throw new Error('list');
  const item=listed.extensions.items[0];if(!item)throw new Error('item');
  expect(listed.extensions.tokens).toBe(catalogTokens(listed.extensions.items));
  const changed=await service.query({kind:'extensions.toggle',cwd:project,extensionId:item.id,enabled:false});if(!('extensions'in changed))throw new Error('toggle');
  expect(extensionManifest(changed.extensions.items)).toBe('');expect(changed.extensions.tokens).toBe(0);expect((await settings.get()).extensions).toEqual({[item.id]:false});
  await expect(service.query({kind:'extensions.read',cwd:project,extensionId:'0'.repeat(16)})).rejects.toThrow('unavailable');
  await expect(validateRequest({id:'00000000-0000-4000-8000-000000000001',kind:'extensions.read',cwd:project,extensionId:'../../auth.json'})).rejects.toThrow();
  expect(()=>validateSettingsPatch({extensions:{'../../auth.json':true}},true)).toThrow();
});

it('loads auth-related skill directories while still denying actual credential filenames', async()=>{
  const {home,project,file}=await setup();
  await file('.agents/skills/adding-auth/SKILL.md',skill('adding-auth'));
  await file('.agents/skills/oauth/SKILL.md',skill('oauth'));
  await file('.claude/agents/auth.json','private');
  const c=new ExtensionReader(home,project).scan();
  expect(c.items.map(i=>i.name)).toEqual(['adding-auth','oauth']);
  expect(deniedExtensionPath(home,join(home,'auth.json'))).toBe(true);
});

it('charges invalid UTF-8 reads against the total cap before decoding', async()=>{
  const {home,project,file}=await setup();
  for(let n=0;n<20;n++){const path=await file(`.claude/skills/bad-${n}/SKILL.md`,'');await writeFile(path,Buffer.alloc(EXTENSION_FILE_BYTES,0xff));}
  let readBytes=0;const original=(await vi.importActual<typeof import('node:fs')>('node:fs')).readSync;const spy=vi.mocked(fs.readSync).mockImplementation((...args:Parameters<typeof fs.readSync>)=>{const count=original(...args);readBytes+=count;return count;});
  try{const catalog=new ExtensionReader(home,project).scan();expect(catalog.items).toEqual([]);expect(readBytes).toBeLessThanOrEqual(EXTENSION_TOTAL_BYTES);expect(catalog.notes.some(n=>n.includes('size limit'))).toBe(true);}
  finally{spy.mockImplementation(original);}
});
