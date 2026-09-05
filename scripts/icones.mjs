#!/usr/bin/env node
/* =========================================================================
   Sinete — gerador dos ícones

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
const TEMP = join(tmpdir(), 'sinete-icones');

/* O sinete: disco de lacre com a borda espalmada e a marca gravada. O
   caminho está calculado (13 bicos, ondulação de 0,62) e escrito à mão aqui
   em vez de ser gerado a cada arranque — assim o ficheiro é o desenho. */
const SELO = 'M14.94 6.63Q16.00 5.88 17.06 6.63Q18.13 7.38 19.41 7.21Q20.70 7.04 21.30 8.20Q21.89 9.35 23.11 9.80Q24.33 10.25 24.32 11.55Q24.30 12.85 25.17 13.82Q26.05 14.78 25.43 15.93Q24.82 17.07 25.14 18.33Q25.46 19.59 24.39 20.32Q23.31 21.04 23.01 22.31Q22.71 23.57 21.42 23.72Q20.13 23.86 19.27 24.84Q18.42 25.83 17.21 25.35Q16.00 24.88 14.79 25.35Q13.58 25.83 12.73 24.84Q11.87 23.86 10.58 23.72Q9.29 23.57 8.99 22.31Q8.69 21.04 7.61 20.32Q6.54 19.59 6.86 18.33Q7.18 17.07 6.57 15.93Q5.95 14.78 6.83 13.82Q7.70 12.85 7.68 11.55Q7.67 10.25 8.89 9.80Q10.11 9.35 10.70 8.20Q11.30 7.04 12.59 7.21Q13.87 7.38 14.94 6.63Z';
const GLIFO = (tinta, fundo) =>
  `<path d="${SELO}" fill="${tinta}"/>`
  + `<circle cx="16" cy="16" r="4.6" fill="none" stroke="${fundo}" stroke-width="1.7"/>`
  + `<circle cx="16" cy="16" r="1.25" fill="${fundo}"/>`;

const LETRA = '-apple-system, BlinkMacSystemFont, Helvetica Neue, Arial, sans-serif';

/** A marca completa: quadrado de canto redondo com o carimbo lá dentro. */
function marca(lado, { fundo = '#5A31E8', tinta = '#fff', raio = 8.5 } = {}) {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${lado}" height="${lado}">`
    + `<rect width="32" height="32" rx="${raio}" fill="${fundo}"/>`
    + GLIFO(tinta, fundo) + `</svg>`;
}

/** Máscara do Android: o fundo tem de ir de ponta a ponta porque o sistema
    corta em círculo, e o glifo tem de caber na zona segura (80% do lado). */
function mascara(lado) {
  const escala = 0.72;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" width="${lado}" height="${lado}">`
    + `<rect width="32" height="32" fill="#5A31E8"/>`
    + `<g transform="translate(16 16) scale(${escala}) translate(-16 -16)">`
    + GLIFO('#fff', '#5A31E8') + `</g></svg>`;
}

/** A imagem que aparece quando se partilha o link. */
function social() {
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1200 630" width="1200" height="630">
  <rect width="1200" height="630" fill="#FBFAF7"/>
  <g transform="translate(84 84)">
    <svg viewBox="0 0 32 32" width="96" height="96" x="0" y="0">
      <rect width="32" height="32" rx="8.5" fill="#5A31E8"/>
      ${GLIFO('#fff', '#5A31E8')}
    </svg>
  </g>
  <text x="84" y="330" font-family="${LETRA}" font-size="80" font-weight="800"
        letter-spacing="-3" fill="#17161C">O cartão de carimbos.</text>
  <text x="84" y="418" font-family="${LETRA}" font-size="80" font-weight="800"
        letter-spacing="-3" fill="#17161C">Sem o papel.</text>
  <text x="84" y="492" font-family="${LETRA}" font-size="34" font-weight="500"
        fill="#5B5966">Todos os teus cartões de fidelidade num só sítio.</text>
  <text x="84" y="552" font-family="${LETRA}" font-size="30" font-weight="700"
        fill="#5A31E8">sinete.pt</text>
</svg>`;
}

const TRABALHOS = [
  { nome: 'apple-touch-icon.png', lado: 180, svg: marca(180) },
  { nome: '192.png',              lado: 192, svg: marca(192) },
  { nome: '512.png',              lado: 512, svg: marca(512) },
  { nome: 'mascara.png',          lado: 512, svg: mascara(512) },
  { nome: 'balcao-192.png',       lado: 192, svg: marca(192, { fundo: '#17161C' }) },
  { nome: 'balcao-512.png',       lado: 512, svg: marca(512, { fundo: '#17161C' }) },
  { nome: 'social.png',           lado: 1200, svg: social() },
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

rmSync(TEMP, { recursive: true, force: true });
console.log(`\n${TRABALHOS.length} ícones em _fonte/imagens/.`);
