import { StringDecoder } from 'node:string_decoder';
const decoder = new StringDecoder('utf8');
let escape = '';
// Ignore terminal key sequences; retain split UTF-8 across stdin chunks.
export function parseInput(chunk) {
  let text = '';
  for (const char of decoder.write(chunk)) {
    if (escape) {
      escape += char;
      if (escape.length === 2 && char !== '[' && char !== 'O') escape = '';
      else if (escape.length > 2 && /[@-~]/.test(char)) escape = '';
      else if (escape.length > 32) escape = '';
      continue;
    }
    if (char === '\x1b') escape = char;
    else text += char;
  }
  return text;
}
