import { expect, it } from 'vitest';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { completeFolder, folderPath } from '../src/client/tui/folders.js';
it('completes matching directories and excludes files without invoking a process',async()=>{
 const root=await mkdtemp('/tmp/ai-folders-');try{await mkdir(join(root,'project'));await writeFile(join(root,'profile'),'file');expect(await completeFolder(root+'/pro',root)).toEqual([root+'/project/']);expect(await completeFolder(root+'/missing/',root)).toEqual([]);expect(folderPath('project',root)).toBe(root+'/project');}finally{await rm(root,{recursive:true,force:true});}
});
