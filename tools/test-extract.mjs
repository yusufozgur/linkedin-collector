// Runs content/selectors.js in the feed page (main world) and prints what it extracts. Read-only.
import { readFileSync } from 'node:fs';
import { page, evaluate } from './cdp.mjs';
const src = readFileSync(new URL('../extension/content/selectors.js', import.meta.url), 'utf8');
const c = await page();
const out = await evaluate(c, `${src};
  LIC.cards().slice(0, ${process.argv[2] ?? 8}).map(card => { const p = LIC.extract(card);
    return { ...p, text: p.text?.slice(0, 90), origText: p.origText?.slice(0, 60), rawText: p.rawText.length + ' chars',
             imageUrls: p.imageUrls.map(u => u.slice(0, 80)) }; })`);
console.log(JSON.stringify(out, null, 1));
c.close();
