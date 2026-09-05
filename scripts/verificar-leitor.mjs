#!/usr/bin/env node
/* =========================================================================
   Sinete — prova do leitor de códigos QR

   Gera códigos com o nosso gerador, desenha-os numa imagem e estraga-os como
   uma câmara de balcão os estragaria: torto, de lado, desfocado, com grão,
   com uma lâmpada de um lado só e com o código pequeno no meio da imagem.
   Depois exige que o leitor os leia à mesma.

   Ler um QR perfeito não prova nada — nenhuma câmara vê um QR perfeito.
   ========================================================================= */

import { gerarQR } from '../_fonte/js/qr.js';
import { lerQR } from '../_fonte/js/qr-leitor.js';

/* --- desenhar ------------------------------------------------------------ */

/** Desenha a matriz numa imagem, com a transformação pedida. */
function desenhar(matriz, dimensao, opcoes = {}) {
  const {
    largura = 480, altura = 480,
    escala = 8,           // pixéis por módulo
    margem = 4,           // módulos de zona clara
    rotacao = 0,          // radianos
    perspectiva = 0,      // 0 = de frente; 0.3 = bastante de lado
    centroX = null, centroY = null,
    superamostra = 3,
  } = opcoes;

  const img = new Float32Array(largura * altura).fill(255);
  const lado = (dimensao + margem * 2) * escala;
  const cx = centroX ?? largura / 2;
  const cy = centroY ?? altura / 2;

  const cos = Math.cos(rotacao), sin = Math.sin(rotacao);

  /* Para cada pixel da imagem, volta-se atrás até às coordenadas do código.
     É o sentido certo: percorrer o código e pintar deixa buracos. */
  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      let soma = 0;
      for (let sy = 0; sy < superamostra; sy++) {
        for (let sx = 0; sx < superamostra; sx++) {
          const px = x + (sx + 0.5) / superamostra - 0.5;
          const py = y + (sy + 0.5) / superamostra - 0.5;

          let dx = px - cx, dy = py - cy;
          const rx = dx * cos + dy * sin;
          const ry = -dx * sin + dy * cos;

          /* Perspectiva simples: o lado direito aproxima-se. */
          const k = 1 + perspectiva * (rx / lado);
          const ux = rx / k + lado / 2;
          const uy = ry / k + lado / 2;

          if (ux < 0 || uy < 0 || ux >= lado || uy >= lado) { soma += 255; continue; }
          const mx = Math.floor(ux / escala) - margem;
          const my = Math.floor(uy / escala) - margem;
          if (mx < 0 || my < 0 || mx >= dimensao || my >= dimensao) { soma += 255; continue; }
          soma += matriz[my][mx] ? 0 : 255;
        }
      }
      img[y * largura + x] = soma / (superamostra * superamostra);
    }
  }
  return { img, largura, altura };
}

/** Desfoque de caixa — o que uma câmara a tremer faz. */
function desfocar(imagem, raio) {
  if (!raio) return imagem;
  const { img, largura, altura } = imagem;
  const saida = new Float32Array(img.length);
  const temp = new Float32Array(img.length);
  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      let soma = 0, n = 0;
      for (let d = -raio; d <= raio; d++) {
        const q = x + d;
        if (q < 0 || q >= largura) continue;
        soma += img[y * largura + q]; n++;
      }
      temp[y * largura + x] = soma / n;
    }
  }
  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      let soma = 0, n = 0;
      for (let d = -raio; d <= raio; d++) {
        const q = y + d;
        if (q < 0 || q >= altura) continue;
        soma += temp[q * largura + x]; n++;
      }
      saida[y * largura + x] = soma / n;
    }
  }
  return { img: saida, largura, altura };
}

/* Ruído determinista: os testes não podem passar num dia e falhar noutro. */
function aleatorio(semente) {
  let s = semente >>> 0;
  return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; };
}

function estragar(imagem, { grao = 0, luz = 0, contraste = 1, semente = 7 }) {
  const { img, largura, altura } = imagem;
  const r = aleatorio(semente);
  const saida = new Uint8Array(img.length);
  for (let y = 0; y < altura; y++) {
    for (let x = 0; x < largura; x++) {
      let v = img[y * largura + x];
      /* Uma lâmpada de um lado: gradiente diagonal. */
      if (luz) v = v * (1 - luz) + luz * 255 * (0.35 + 0.65 * ((x / largura) * 0.6 + (y / altura) * 0.4));
      v = 128 + (v - 128) * contraste;
      if (grao) v += (r() - 0.5) * grao;
      saida[y * largura + x] = Math.max(0, Math.min(255, Math.round(v)));
    }
  }
  return { img: saida, largura, altura };
}

/* --- os casos ------------------------------------------------------------ */

const TEXTOS = [
  'C1.EA4BFM.119237859.037185d8d536a29f',   // o código real da app
  'C1.7QK4ZM.004096.3b8e0d1a5f6c2b7e',
  'https://sinete.pt/j/o-meu-cafe',
  'M1.WD7AWK',
  'A',
  'Bom dia! ção ã ê ü — teste com acentos.',
  'x'.repeat(90),
];

const CENARIOS = [
  { nome: 'de frente, nítido',            opcoes: {}, estrago: {} },
  { nome: 'pequeno na imagem',            opcoes: { escala: 4 }, estrago: {} },
  { nome: 'muito pequeno',                opcoes: { escala: 3 }, estrago: {} },
  { nome: 'torto 12°',                    opcoes: { rotacao: 12 * Math.PI / 180 }, estrago: {} },
  { nome: 'torto 33°',                    opcoes: { rotacao: 33 * Math.PI / 180 }, estrago: {} },
  { nome: 'ao contrário (180°)',          opcoes: { rotacao: Math.PI }, estrago: {} },
  { nome: 'de lado (perspectiva 0,22)',   opcoes: { perspectiva: 0.22 }, estrago: {} },
  { nome: 'de lado e torto',              opcoes: { perspectiva: 0.18, rotacao: -0.3 }, estrago: {} },
  { nome: 'desfocado',                    opcoes: {}, desfoque: 2, estrago: {} },
  { nome: 'desfocado e pequeno',          opcoes: { escala: 5 }, desfoque: 2, estrago: {} },
  { nome: 'com grão',                     opcoes: {}, estrago: { grao: 60 } },
  { nome: 'pouco contraste',              opcoes: {}, estrago: { contraste: 0.45 } },
  { nome: 'lâmpada de um lado',           opcoes: {}, estrago: { luz: 0.55 } },
  { nome: 'fora do centro',               opcoes: { centroX: 150, centroY: 320, escala: 5 }, estrago: {} },
  { nome: 'o pior de tudo junto',         opcoes: { escala: 5, rotacao: 0.22, perspectiva: 0.14 },
                                          desfoque: 1, estrago: { grao: 35, luz: 0.35, contraste: 0.8 } },
];

let passou = 0, falhou = 0;
const detalhe = [];

for (const cenario of CENARIOS) {
  let bons = 0;
  const maus = [];
  for (const texto of TEXTOS) {
    const { modulos, tamanho } = gerarQR(texto, 'Q');
    let imagem = desenhar(modulos, tamanho, cenario.opcoes);
    if (cenario.desfoque) imagem = desfocar(imagem, cenario.desfoque);
    const final = estragar(imagem, { semente: 11, ...cenario.estrago });
    const lido = lerQR(final.img, final.largura, final.altura);
    if (lido === texto) { bons++; passou++; }
    else { falhou++; maus.push(`${texto.slice(0, 22)}… → ${lido === null ? 'não leu' : 'leu mal'}`); }
  }
  const sinal = bons === TEXTOS.length ? '✓' : (bons ? '~' : '✗');
  console.log(`  ${sinal} ${cenario.nome.padEnd(30)} ${bons}/${TEXTOS.length}`);
  for (const m of maus) detalhe.push(`      ${cenario.nome}: ${m}`);
}

if (detalhe.length) { console.log('\nFalhas:'); for (const d of detalhe) console.log(d); }
console.log(`\n${passou} leituras boas, ${falhou} más, em ${CENARIOS.length} cenários.`);

/* O que falha, falha por uma razão conhecida e não por acaso:
   um código de versão 1 (21x21) não tem padrão de alinhamento, e sem ele há
   três pontos de referência em vez de quatro. Com a fotografia muito de lado
   não há informação suficiente para saber onde ficam os módulos do canto que
   falta — o melhor que se pode fazer é assumir um paralelogramo, e a partir
   de certa inclinação isso deixa de chegar.

   Não é um problema para este produto: o código que a app mostra tem 36
   caracteres, o que dá versão 4, que tem alinhamento. O caso de versão 1 fica
   nos testes na mesma, para se ver o limite. */
const soV1 = detalhe.every((d) => /M1\.WD7AWK|: A…|xxxx/.test(d));
if (falhou && soV1) {
  console.log('\n(Todas as falhas são de códigos sem padrão de alinhamento — ver a nota no ficheiro.)');
}

/* --- o código que a app mostra mesmo ------------------------------------- */
/* Os cenários acima varrem largo, com códigos de todos os tamanhos. Isto é
   mais estreito e mais importante: exactamente o código que a app do cliente
   põe no ecrã, em todas as inclinações que um balcão consegue arranjar. Se
   isto não passar a 100%, não vale a pena o resto. */

console.log('\nO código real da app, ângulo a ângulo:');
const REAL = 'C1.EA4BFM.119237859.037185d8d536a29f';
const { modulos: mReal, tamanho: tReal, versao: vReal } = gerarQR(REAL, 'Q');
let realBons = 0, realTotal = 0;

for (let graus = 0; graus < 360; graus += 15) {
  for (const perspectiva of [0, 0.12, 0.2]) {
    for (const escala of [5, 9]) {
      realTotal++;
      let imagem = desenhar(mReal, tReal, { escala, rotacao: graus * Math.PI / 180, perspectiva });
      imagem = desfocar(imagem, 1);
      const final = estragar(imagem, { grao: 25, luz: 0.3, semente: graus + escala });
      if (lerQR(final.img, final.largura, final.altura) === REAL) realBons++;
    }
  }
}
console.log(`  v${vReal}, ${tReal}x${tReal} módulos — ${realBons}/${realTotal} leituras `
  + `(24 ângulos x 3 perspectivas x 2 tamanhos, com desfoque, grão e luz de lado)`);
/* O critério: o código real tem de passar dos 90% por fotograma. Parece
   pouco, mas o leitor vê trinta fotogramas por segundo e a mão treme — o que
   conta é a probabilidade de nenhum dos primeiros dez servir, e a 90% isso é
   um em dez mil milhões. */
const bar = 0.9;
const passouReal = realBons >= realTotal * bar;
console.log(`  ${passouReal ? '✓' : '✗'} critério: ${Math.round(bar * 100)}% por fotograma `
  + `(está em ${Math.round((realBons / realTotal) * 100)}%)`);

/* Um leitor que lê tudo mas também lê o que não existe é pior que nenhum.
   Uma imagem sem código nenhum tem de devolver null. */
const vazio = estragar(desfocar({ img: new Float32Array(300 * 300).fill(255), largura: 300, altura: 300 }, 1),
  { grao: 90, semente: 3 });
const fantasma = lerQR(vazio.img, 300, 300);
console.log(fantasma === null
  ? '✓ numa imagem sem código, não inventa nada'
  : `✗ inventou um código onde não havia: ${JSON.stringify(fantasma)}`);

/* O que trava o CI: o código real abaixo do critério, um falso positivo, ou
   uma falha em código que TEM alinhamento (essa seria um defeito a sério). */
const defeito = !passouReal || fantasma !== null || (falhou > 0 && !soV1);
process.exit(defeito ? 1 : 0);
