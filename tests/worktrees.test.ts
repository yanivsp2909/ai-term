import { afterEach, expect, it, vi } from 'vitest';
import { mkdtemp, mkdir, writeFile, readFile, rm, realpath, symlink, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { prepareWorktree, previewWorktree, repoDirectory } from '../src/daemon/worktrees.js';
import { listWorktrees } from '../src/daemon/git.js';
import { getPaths,preparePaths } from '../src/shared/paths.js';
import { SessionManager } from '../src/daemon/session-manager.js';
import { Logger } from '../src/daemon/log.js';
import { SettingsStore } from '../src/daemon/settings.js';
import pty from 'node-pty';
vi.mock('../src/daemon/engines.js',()=>({checkEngine:async()=>({installed:true,path:process.execPath,loggedIn:true,authMethod:'subscription'})}));
const run=promisify(execFile),roots:string[]=[],managers:SessionManager[]=[];
afterEach(async()=>{for(const manager of managers.splice(0))await manager.shutdown();vi.restoreAllMocks();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function fixture(committed=true){
 const temp=await mkdtemp(join(tmpdir(),'ai-trees-'));roots.push(temp);const repo=join(temp,'repo spaces'),home=join(temp,'home');await mkdir(repo);await mkdir(home,{mode:0o700});await mkdir(join(repo,'sub'));
 await writeFile(join(repo,'sub','tracked.txt'),'committed');await run('/usr/bin/git',['init','--',repo]);
 await run('/usr/bin/git',['add','--','sub/tracked.txt'],{cwd:repo});
 if(committed)await run('/usr/bin/git',['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','-m','initial','--'],{cwd:repo});
 return {temp,repo,home};
}
it('preview is read-only and warns that dirty content is excluded; two starts have distinct worktrees and branches',async()=>{
 const {repo,home}=await fixture();await writeFile(join(repo,'sub','tracked.txt'),'dirty');await writeFile(join(repo,'new.txt'),'untracked');await writeFile(join(repo,'.gitignore'),'ignored-local\n');await writeFile(join(repo,'ignored-local'),'local configuration');
 const preview=await previewWorktree(home,join(repo,'sub'),'My Agent');expect(preview).toMatchObject({branch:'ai/my-agent',dirty:true});expect((await listWorktrees(repo)).length).toBe(1);
 const before=(await run('/usr/bin/git',['status','--porcelain','--'],{cwd:repo})).stdout;
 const [a,b]=await Promise.all([prepareWorktree(home,join(repo,'sub'),'My Agent'),prepareWorktree(home,join(repo,'sub'),'My Agent')]);
 expect(a.branch).toBe('ai/my-agent');expect(b.branch).toBe('ai/my-agent-2');expect(a.cwd).toBe(join(a.worktree??'', 'sub'));expect(await readFile(join(a.cwd,'tracked.txt'),'utf8')).toBe('committed');
 await expect(lstat(join(a.worktree??'','ignored-local'))).rejects.toMatchObject({code:'ENOENT'});
 expect((await listWorktrees(repo)).map(w=>w.branch)).toEqual(['main','ai/my-agent','ai/my-agent-2']);expect((await run('/usr/bin/git',['status','--porcelain','--'],{cwd:repo})).stdout).toBe(before);
 for(const path of [home,join(home,'worktrees'),join(home,'worktrees',repoDirectory(await realpath(repo))),a.worktree??'',a.cwd]){const st=await lstat(path);expect(st.isSymbolicLink()).toBe(false);expect(st.mode&0o777).toBe(0o700);}
});
it('not a repo, no commits and a symlinked worktrees root fall back with fixed notes',async()=>{
 const {temp,repo,home}=await fixture(false);expect(await prepareWorktree(home,temp,'a')).toEqual({cwd:temp,worktreeNote:'worktree off: not a git repo'});expect(await prepareWorktree(home,repo,'a')).toEqual({cwd:repo,worktreeNote:'worktree off: repo has no commits'});
 await run('/usr/bin/git',['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','-m','initial','--'],{cwd:repo});
 await symlink(temp,join(home,'worktrees'));expect(await prepareWorktree(home,repo,'a')).toEqual({cwd:repo,worktreeNote:'worktree off: git check failed'});expect((await listWorktrees(repo)).length).toBe(1);
});
it('session start uses isolated cwd, shell and worktrees off use original cwd; remove keeps the tree, resume reuses it and state reload preserves metadata',async()=>{
 const {repo,home}=await fixture(),paths=getPaths(home);await preparePaths(paths);const log=new Logger(paths.log),manager=new SessionManager(paths,log);managers.push(manager);await manager.load();
 // Stub PTY transport only; real git/temp repos and real session persistence stay in the path.
 const spawn=vi.spyOn(pty,'spawn');
 // Node as the installed CLI exits on Claude/Codex flags without a login; persisted cwd is the spawn cwd.
 const a=await manager.create({engine:'codex',model:null,auth:{kind:'account'},cwd:join(repo,'sub'),permission:'ask',title:'isolated'});expect(spawn.mock.calls[0]?.[2]?.cwd).toBe(a.cwd);
 expect(a.cwd).toBe(join(a.worktree??'','sub'));expect(a.branch).toBe('ai/isolated');await expect.poll(()=>manager.get(a.id).status).toBe('error');
 const resumed=await manager.resume(a.id);expect(resumed.worktree).toBe(a.worktree);expect(resumed.branch).toBe(a.branch);expect((await listWorktrees(repo)).length).toBe(2);
 await expect.poll(()=>manager.get(resumed.id).status).toBe('error');await manager.remove(a.id);expect(await lstat(a.worktree??'')).toBeDefined();
 const shell=await manager.create({cwd:repo});expect(shell.worktree).toBeUndefined();expect(shell.cwd).toBe(repo);
 await new SettingsStore(home).set({worktrees:'off'});const off=await manager.create({engine:'codex',model:null,auth:{kind:'account'},cwd:repo,permission:'ask'});expect(off.worktree).toBeUndefined();expect(off.cwd).toBe(repo);
 const restored=new SessionManager(paths,log);managers.push(restored);await restored.load();expect(restored.get(resumed.id)).toMatchObject({worktree:a.worktree,branch:a.branch,cwd:a.cwd});expect(a.cwd).not.toBe(repo);
});

it('preserves an untracked relative subfolder without copying its files',async()=>{
 const {repo,home}=await fixture();await mkdir(join(repo,'untracked-sub'));await writeFile(join(repo,'untracked-sub','local.txt'),'local');
 const started=await prepareWorktree(home,join(repo,'untracked-sub'),'empty');expect(started.branch).toBe('ai/empty');expect(started.cwd).toBe(join(started.worktree??'','untracked-sub'));expect((await lstat(started.cwd)).mode&0o777).toBe(0o700);await expect(lstat(join(started.cwd,'local.txt'))).rejects.toMatchObject({code:'ENOENT'});
});
it('a branch and tag with the same name still reserve the branch slug',async()=>{
 const {repo,home}=await fixture();await run('/usr/bin/git',['branch','--','ai/codex'],{cwd:repo});await run('/usr/bin/git',['tag','--','ai/codex'],{cwd:repo});
 expect(await previewWorktree(home,repo,'Codex')).toMatchObject({branch:'ai/codex-2'});expect(await prepareWorktree(home,repo,'Codex')).toMatchObject({branch:'ai/codex-2'});
});
it('a repo name ending in a space never routes git operations into its sibling',async()=>{
 const {temp,repo,home}=await fixture(),trailing=join(temp,'repo spaces ');await mkdir(trailing);await run('/usr/bin/git',['init','--',trailing]);
 await run('/usr/bin/git',['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-m','different','--'],{cwd:trailing});
 const head=(await run('/usr/bin/git',['show','--no-patch','--format=%H','--'],{cwd:trailing})).stdout.trim();
 expect(await previewWorktree(home,trailing,'space')).toMatchObject({head,branch:'ai/space'});const started=await prepareWorktree(home,trailing,'space');expect(started.branch).toBe('ai/space');
 expect((await listWorktrees(repo))).toHaveLength(1);expect((await listWorktrees(trailing)).map(w=>w.branch)).toEqual(['main','ai/space']);
});
