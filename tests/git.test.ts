import { afterEach, expect, it } from 'vitest';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, mkdir, rm, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { repoTopLevel, headCommit, addWorktree, listWorktrees } from '../src/daemon/git.js';
const run = promisify(execFile), roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, {recursive:true,force:true}); });
async function repo(commit=true) {
 const root=await mkdtemp(join(tmpdir(),'ai-git-'));roots.push(root);const path=join(root,'repo with spaces');await mkdir(path);
 await run('/usr/bin/git',['init','--',path]);
 if(commit)await run('/usr/bin/git',['-c','user.name=Test','-c','user.email=test@example.invalid','-c','commit.gpgsign=false','commit','--allow-empty','-m','initial','--'],{cwd:path});
 return {root,path};
}
it('detects a repo from its subfolder and returns HEAD, including spaces',async()=>{
 const {path}=await repo();await mkdir(join(path,'sub'));expect(await repoTopLevel(join(path,'sub'))).toBe(await realpath(path));expect(await headCommit(path)).toMatch(/^[a-f0-9]{40}$/);
});
it('a folder outside a repo and an unborn HEAD have distinct results',async()=>{
 const {root,path}=await repo(false);expect(await repoTopLevel(root)).toBeNull();expect(await repoTopLevel(path)).toBe(await realpath(path));await expect(headCommit(path)).rejects.toThrow('Repo has no commits');
});
it('adds and lists a new branch worktree without changing the checkout; collision is fixed text',async()=>{
 const {root,path}=await repo(),head=await headCommit(path),target=join(root,'tree with spaces');await addWorktree(path,target,'ai/my-agent',head);
 expect(await listWorktrees(path)).toContainEqual({path:await realpath(target),head,branch:'ai/my-agent'});
 const listed=await listWorktrees(path);expect(listed[0]?.branch).toBe('main');
 await expect(addWorktree(path,join(root,'other'),'ai/my-agent',head)).rejects.toThrow(/^Worktree creation failed$/);
});
