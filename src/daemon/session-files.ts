import {join} from 'node:path';
import {unlink} from 'node:fs/promises';
import {privateDirectory,isFsError} from '../shared/paths.js';
import {isUUID} from '../shared/validate.js';
import {removeClaudeSettings} from './claude-settings.js';
// AI Term's agent appends its transcript here (src/agent/transcript.ts): the per-session 0700 folder Claude's hook
// settings already use. The daemon makes the folder; the agent creates the file 0600 with O_NOFOLLOW.
export async function agentTranscript(root:string,id:string):Promise<string>{
 if(!isUUID(id))throw new Error('Invalid session UUID');
 const sessions=join(root,'sessions'),directory=join(sessions,id);await privateDirectory(sessions);await privateDirectory(directory);
 return join(directory,'transcript.jsonl');
}
// Removing an agent removes what it left in its session folder. removeClaudeSettings checks the folders first (real
// directories of ours, no symlinks), so the transcript unlink below only runs inside a checked folder.
export async function removeSessionFiles(root:string,id:string):Promise<void>{
 await removeClaudeSettings(root,id);
 try{await unlink(join(root,'sessions',id,'transcript.jsonl'));}catch(error){if(!isFsError(error,'ENOENT'))throw error;}
}
