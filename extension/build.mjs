import { build } from 'esbuild';
import { cp, mkdir } from 'node:fs/promises';

const outdir = new URL('./dist/', import.meta.url).pathname;
const src = new URL('./src/', import.meta.url).pathname;

await mkdir(outdir, { recursive: true });

await build({
  entryPoints: [
    `${src}background.ts`,
    `${src}recorder.ts`,
    `${src}nettap.ts`,
    `${src}popup.ts`,
  ],
  outdir,
  bundle: true,
  format: 'iife',
  target: 'chrome120',
  logLevel: 'info',
});

await cp(new URL('./manifest.json', import.meta.url).pathname, `${outdir}manifest.json`);
await cp(`${src}popup.html`, `${outdir}popup.html`);
await cp(`${src}popup.css`, `${outdir}popup.css`);
