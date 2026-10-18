// v1.0 gate: a deck, design or diagram is written by a model, which a repository or a web page can steer. Opened as is,
// its HTML or SVG would run scripts in your browser (file://, with the network). So o opens an inert copy: HTML gets a
// Content-Security-Policy before anything else in it (no script, no fetch, no form, no plugin), and an SVG is shown as
// an image in such a page, where SVG scripts never run. Its own styles and inline images still render.
export const INERT_CSP = "default-src 'none'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; font-src 'self' data:; media-src 'self' data:; form-action 'none'; base-uri 'none'";
const meta = `<meta http-equiv="Content-Security-Policy" content="${INERT_CSP}">`;
// The policy goes right after a doctype (or first), so the parser puts it in <head> ahead of any script it could stop.
export function inertHtml(text: string): string {
  const doctype = text.match(/^﻿?\s*<!doctype[^>]*>/i)?.[0] ?? '';
  return `${doctype}${meta}${text.slice(doctype.length)}`;
}
const escaped = (name: string) => name.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
export function svgPage(name: string): string {
  return `<!doctype html><html><head>${meta}<meta charset="utf-8"><title>${escaped(name)}</title></head><body style="margin:0;background:#fff"><img src="${escaped(name)}" alt="${escaped(name)}" style="max-width:100%"></body></html>\n`;
}
