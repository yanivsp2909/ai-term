import {expect,it} from 'vitest';
import {availableWorktreeSlug,isWorktreeSlug,worktreeSlug,validateSettingsPatch} from '../src/shared/validate.js';
import {repoDirectory} from '../src/daemon/worktrees.js';
it('hostile titles always produce the strict git-safe alphabet',()=>{
 for(const title of ['../x','-x','a..b','@{','with spaces','שלום 🐝','a'.repeat(200)]){const slug=worktreeSlug(title);expect(isWorktreeSlug(slug)).toBe(true);expect(slug.length).toBeLessThanOrEqual(40);}
 for(const bad of ['../x','-x','a..b','@{','a b','שלום','a'.repeat(200)])expect(isWorktreeSlug(bad)).toBe(false);
});
it('collisions append numbered suffixes within forty characters',()=>{
 expect(availableWorktreeSlug('My Agent',new Set(['my-agent','my-agent-2']))).toBe('my-agent-3');
 const base='a'.repeat(40);expect(availableWorktreeSlug(base,new Set([base]))).toBe('a'.repeat(38)+'-2');
 expect(repoDirectory('/a/repo')).not.toBe(repoDirectory('/b/repo'));
});
it('worktrees setting accepts only on/off',()=>{for(const value of ['on','off'])expect(validateSettingsPatch({worktrees:value},true).worktrees).toBe(value);for(const value of [true,null,'yes'])expect(()=>validateSettingsPatch({worktrees:value},true)).toThrow();});
