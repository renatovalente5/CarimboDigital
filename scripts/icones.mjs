#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — gerador dos ícones

   Desenha os PNG a partir do SVG da marca. O rasterizador é o `qlmanage`, o
   QuickLook do macOS: já está na máquina, não se instala nada e é instantâneo.
   (Tentei o Chrome em modo headless primeiro — fica pendurado à espera de um
   perfil e demora minutos. Não vale a pena.)

   Corre-se à mão quando a marca mudar:  node scripts/icones.mjs
   Os PNG ficam no repositório, por isso o CI e o Linux não precisam disto.
   ========================================================================= */

import { writeFileSync, mkdirSync, rmSync, renameSync, existsSync } from 'node:fs';
import { execFileSync } from 'node:child_process';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DESTINO = join(AQUI, '..', '_fonte', 'imagens');
const TEMP = join(tmpdir(), 'carimbodigital-icones');

/* O carimbo: disco de lacre com a borda espalmada e a marca gravada. O
   caminho está calculado (13 bicos, ondulação de 0,62) e escrito à mão aqui
   em vez de ser gerado a cada arranque — assim o ficheiro é o desenho. */
/* Três casas carimbadas e uma por carimbar — a mesma grelha que o cartão da
   app mostra. A casa vazia leva o tracejado das casas vazias do cartão, para
   a marca e o produto serem a mesma coisa. */
const CASAS = [[11.2, 11.2], [20.8, 11.2], [11.2, 20.8], [20.8, 20.8]];
const RAIO = 4.35;

const GLIFO = (tinta) => CASAS.map(([cx, cy], i) => (i < 3
  ? `<circle cx="${cx}" cy="${cy}" r="${RAIO}" fill="${tinta}"/>`
  : `<circle cx="${cx}" cy="${cy}" r="${RAIO - 0.75}" fill="none" stroke="${tinta}"`
    + ` stroke-width="1.5" stroke-opacity=".55" stroke-dasharray="2.6 2.2"`
    + ` stroke-linecap="round"/>`)).join('');

const LETRA = '-apple-system, BlinkMacSystemFont, Helvetica Neue, Arial, sans-serif';

/** A marca completa: quadrado de canto redondo com o carimbo lá dentro. */
function marca(lado, { fundo = '#5A31E8', tinta = '#fff', raio = 8.5 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${lado}" height="${lado}">`
    + `<rect width="32" height="32" rx="${raio}" fill="${fundo}"/>`
    + GLIFO(tinta) + `</svg>`;
}

/** Máscara do Android: o fundo tem de ir de ponta a ponta porque o sistema
    corta em círculo, e o glifo tem de caber na zona segura (80% do lado). */
function mascara(lado) {
  const escala = 0.72;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${lado}" height="${lado}">`
    + `<rect width="32" height="32" fill="#5A31E8"/>`
    + `<g transform="translate(16 16) scale(${escala}) translate(-16 -16)">`
    + GLIFO('#fff') + `</g></svg>`;
}

/** A imagem que aparece quando se partilha o link.
    Esta não é quadrada (1200x630), e o QuickLook só sabe fazer quadrados —
    por isso é a única que vai pelo Chrome. */
function social() {
  return `<!doctype html><meta charset="utf-8"><style>
    *{margin:0;padding:0;box-sizing:border-box}
    html,body{width:1200px;height:630px;overflow:hidden;background:#FBFAF7;
      font-family:${LETRA};-webkit-font-smoothing:antialiased}
    .p{padding:84px}
    .marca{display:flex;align-items:center;gap:22px}
    .marca svg{width:84px;height:84px}
    .nome{font-size:41px;letter-spacing:-.03em}
    .nome b{font-weight:800;color:#17161C}
    .nome span{font-weight:500;color:#5B5966}
    h1{margin-top:62px;font-size:78px;font-weight:800;letter-spacing:-.042em;
      line-height:1.09;color:#17161C}
    .sub{margin-top:28px;font-size:33px;font-weight:500;color:#5B5966}
    .end{margin-top:22px;font-size:29px;font-weight:700;color:#5A31E8}
  </style>
  <div class="p">
    <div class="marca">
      <svg viewBox="0 0 32 32" xmlns="http://www.w3.org/2000/svg">
        <rect width="32" height="32" rx="8.5" fill="#5A31E8"/>${GLIFO('#fff')}
      </svg>
      <div class="nome"><b>Carimbo</b> <span>Digital</span></div>
    </div>
    <h1>O cartão de carimbos.<br>Sem o papel.</h1>
    <div class="sub">Todos os teus cartões de fidelidade num só sítio.</div>
    <div class="end">carimbodigital.pt</div>
  </div>`;
}

/* O Chrome, com os sinalizadores que o impedem de ficar pendurado à espera
   de um perfil, de extensões e da sincronização. */
function comChrome(html, ficheiro, largura, altura) {
  const CHROME = [
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
    '/Applications/Chromium.app/Contents/MacOS/Chromium',
    '/usr/bin/google-chrome', '/usr/bin/chromium',
  ].find(existsSync);
  if (!CHROME) return false;
  const pagina = join(TEMP, 'social.html');
  const saida = join(TEMP, 'social.png');
  writeFileSync(pagina, html);
  try {
    execFileSync(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox', '--no-first-run',
      '--no-default-browser-check', '--disable-extensions',
      '--disable-background-networking', '--disable-sync', '--hide-scrollbars',
      '--virtual-time-budget=4000', '--force-device-scale-factor=1',
      `--window-size=${largura},${altura}`, `--screenshot=${saida}`,
      `--user-data-dir=${join(TEMP, 'perfil')}`, 'file://' + pagina,
    ], { stdio: ['ignore', 'ignore', 'ignore'], timeout: 60000 });
  } catch { /* pode devolver código de erro e ter escrito a imagem */ }
  if (!existsSync(saida)) return false;
  renameSync(saida, ficheiro);
  return true;
}

const TRABALHOS = [
  { nome: 'apple-touch-icon.png', lado: 180, svg: marca(180) },
  { nome: '192.png',              lado: 192, svg: marca(192) },
  { nome: '512.png',              lado: 512, svg: marca(512) },
  { nome: 'mascara.png',          lado: 512, svg: mascara(512) },
  { nome: 'balcao-192.png',       lado: 192, svg: marca(192, { fundo: '#17161C' }) },
  { nome: 'balcao-512.png',       lado: 512, svg: marca(512, { fundo: '#17161C' }) },
];

if (process.platform !== 'darwin') {
  console.log('Este gerador precisa do QuickLook do macOS. Os PNG já estão '
    + 'no repositório — não é preciso voltar a gerá-los.');
  process.exit(0);
}

rmSync(TEMP, { recursive: true, force: true });
mkdirSync(TEMP, { recursive: true });
mkdirSync(DESTINO, { recursive: true });

for (const t of TRABALHOS) {
  const base = t.nome.replace('.png', '');
  const svg = join(TEMP, base + '.svg');
  writeFileSync(svg, t.svg);
  execFileSync('qlmanage', ['-t', '-s', String(t.lado), '-o', TEMP, svg],
    { stdio: ['ignore', 'ignore', 'ignore'] });
  const gerado = join(TEMP, base + '.svg.png');
  if (!existsSync(gerado)) { console.error(`  ✗ ${t.nome}`); continue; }
  renameSync(gerado, join(DESTINO, t.nome));
  console.log(`  ${t.nome}`);
}

const social_ok = comChrome(social(), join(DESTINO, 'social.png'), 1200, 630);
console.log(social_ok ? '  social.png  1200×630' : '  ✗ social.png (sem Chrome)');

try { rmSync(TEMP, { recursive: true, force: true }); } catch { /* fica */ }
console.log(`\n${TRABALHOS.length + (social_ok ? 1 : 0)} ícones em _fonte/imagens/.`);
