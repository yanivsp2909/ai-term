// Codex's TUI names each new thread by running a temporary structured thread whose output schema is {title}
// (tui/src/app/thread_title.rs, tui/src/temporary_structured_request.rs, rust-v0.160.1). notify fires for that
// thread's turn too, with the JSON object as its last message. It is neither the user's reply nor the end of their turn.
const MAX_TITLE_REPLY_CHARS=4096;
export function isCodexTitleReply(reply:string):boolean{
 if(reply.length>MAX_TITLE_REPLY_CHARS||!reply.trimStart().startsWith('{'))return false;
 let value:unknown;try{value=JSON.parse(reply);}catch{return false;}
 return !!value&&typeof value==='object'&&!Array.isArray(value)&&Object.keys(value).length===1&&typeof (value as Record<string,unknown>).title==='string';
}
