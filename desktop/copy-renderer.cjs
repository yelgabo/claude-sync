const { cpSync, mkdirSync, copyFileSync } = require('node:fs');
const { join } = require('node:path');
const here = __dirname;

// Renderer
const rsrc = join(here, 'src', 'renderer');
const rdst = join(here, 'dist', 'renderer');
mkdirSync(rdst, { recursive: true });
cpSync(rsrc, rdst, { recursive: true });

// Preload (hand-written CJS — bypass tsc since the sandbox needs CJS)
const psrc = join(here, 'src', 'preload', 'index.cjs');
const pdst = join(here, 'dist', 'preload', 'index.cjs');
mkdirSync(join(here, 'dist', 'preload'), { recursive: true });
copyFileSync(psrc, pdst);

console.log('copied renderer + preload');