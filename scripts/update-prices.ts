import {readFile,writeFile} from 'node:fs/promises';
import {trimPrices} from '../src/daemon/usage-prices.js';
// Offline input lets one explicitly authorized download be reviewed and reused without another fetch.
const path=process.argv[2];if(!path)throw new Error('Usage: npx tsx scripts/update-prices.ts <models.dev-api.json>');
const raw:unknown=JSON.parse(await readFile(path,'utf8'));await writeFile(new URL('../data/usage-prices.json',import.meta.url),JSON.stringify(trimPrices(raw,new Date().toISOString().slice(0,10)),null,2)+'\n');
