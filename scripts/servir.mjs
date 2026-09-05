#!/usr/bin/env node
/* Servidor estático para ver o site em casa. Node puro.
   Serve _site já debaixo do prefixo que o GitHub Pages vai usar, para as
   ligações se partirem aqui e não lá. */
import { createServer } from 'node:http';
import { readFile, stat } from 'node:fs/promises';
import { join, extname, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { existsSync, readFileSync } from 'node:fs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const SAIDA = join(RAIZ, '_site');
const BASE = existsSync(join(RAIZ, 'CNAME')) ? '' : '/CarimboDigital';
const PORTA = Number(process.env.PORTA || 4321);

const TIPOS = {
  '.html': 'text/html; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8', '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.webmanifest': 'application/manifest+json',
  '.svg': 'image/svg+xml', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.webp': 'image/webp', '.ico': 'image/x-icon', '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8', '.woff2': 'font/woff2',
};

createServer(async (pedido, resposta) => {
  try {
    let caminho = decodeURIComponent(new URL(pedido.url, 'http://x').pathname);
    if (BASE && caminho.startsWith(BASE)) caminho = caminho.slice(BASE.length);
    if (caminho.endsWith('/')) caminho += 'index.html';
    if (!caminho) caminho = '/index.html';
    let ficheiro = join(SAIDA, caminho);
    try {
      const s = await stat(ficheiro);
      if (s.isDirectory()) ficheiro = join(ficheiro, 'index.html');
    } catch {
      const alternativa = join(SAIDA, caminho, 'index.html');
      if (existsSync(alternativa)) ficheiro = alternativa;
    }
    const corpo = await readFile(ficheiro);
    resposta.writeHead(200, {
      'content-type': TIPOS[extname(ficheiro)] || 'application/octet-stream',
      'cache-control': 'no-store',
    });
    resposta.end(corpo);
  } catch {
    const erro = join(SAIDA, '404.html');
    if (existsSync(erro)) {
      resposta.writeHead(404, { 'content-type': 'text/html; charset=utf-8' });
      resposta.end(readFileSync(erro));
    } else { resposta.writeHead(404); resposta.end('404'); }
  }
}).listen(PORTA, () => {
  console.log(`Carimbo Digital em http://localhost:${PORTA}${BASE}/`);
  console.log(`  app do cliente : http://localhost:${PORTA}${BASE}/app/`);
  console.log(`  balcão         : http://localhost:${PORTA}${BASE}/balcao/`);
});
