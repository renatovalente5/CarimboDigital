/* =========================================================================
   Carimbo Digital — a faixa do passe (strip.png)

   O que este ficheiro faz: devolve um PNG. Não fala com ninguém, não lê a
   base, não assina nada. É a mesma regra do `pkpass.js` e do `wallet.js`, e é
   o que permite prová-lo sem rede e sem carteira nenhuma.

   PORQUE É QUE ISTO EXISTE. O passe da Apple era um rectângulo de cor com
   texto: `logoText`, um campo de cabeçalho com «Carimbos 7/10» e um campo
   secundário com o prémio. Está tudo lá, e não se vê nada — ninguém olha para
   um cartão de fidelidade para LER quantos carimbos tem, olha para ver quantos
   FALTAM. A faixa é o sítio onde isso se vê: a Apple chama-lhe `strip.png` e
   desenha-a por trás dos `primaryFields`, a toda a largura.

   PORQUE É QUE SE DESENHA AQUI E NÃO SE GUARDA UMA IMAGEM PRONTA. Porque a
   imagem depende de três coisas que mudam: a cor do negócio, o objectivo do
   programa e quantos carimbos a pessoa já tem. São `objetivo + 1` imagens
   diferentes por programa, e o programa muda de cor quando o dono quiser.
   Guardar isso à mão era guardar lixo a envelhecer.

   ZERO DEPENDÊNCIAS, e não por gosto: não há `package.json` neste projecto
   nem passo de compilação. O que se usa é o que a plataforma dá — o
   `CompressionStream`, que faz o `deflate` do PNG — e o `crc32` que o
   `pkpass.js` já tinha escrito para o ZIP. É por acaso feliz que o CRC-32 do
   PNG e o do ZIP sejam o mesmo (IEEE 802.3, mesma tabela, mesma inicialização,
   mesmo XOR final): reaproveita-se tal e qual, sem uma linha nova.

   O TECTO DE CPU MANDA EM TUDO O QUE ESTÁ AQUI. Um Worker do plano gratuito
   tem 10 ms de CPU por pedido — https://developers.cloudflare.com/workers/
   platform/limits/ — e passar disso dá «Error 1102: Worker exceeded resource
   limits», que é uma página de erro em vez de um cartão. Daí as três decisões
   que explicam o formato:

     1. PNG INDEXADO (tipo 3), e não cor verdadeira. Um byte por pixel em vez
        de três: o filtro e o `deflate` ficam três vezes mais baratos, e o
        ficheiro fica para metade. Medido: 1125×432 em cor verdadeira custava
        11,2 ms e 38 KB; indexado custa 3,5 ms e 19 KB.
     2. A PALETA É UMA RAMPA, e o índice de cada pixel É a cobertura. Sombra
        (0) → cor da marca (128) → tinta (255). Tudo o que se desenha é a
        mesma tinta com outra opacidade, por isso tudo cabe nesta rampa e o
        desenho passa a ser aritmética de um byte, sem contas de cor por pixel.
     3. NADA DE SUPERAMOSTRAGEM. Um círculo não precisa: a cobertura de um
        pixel na borda é `raio + 0,5 − distância`, saturada a [0,1]. É uma raiz
        quadrada por pixel e dá uma borda tão lisa como uma amostragem ×4 —
        com a diferença de que só se percorrem os pixels DENTRO da caixa de
        cada ficha, e não os 486 000 do quadro. Amostrar ×3 o quadro inteiro
        eram 4,4 milhões de amostras; isto são umas 200 000 visitas.

   O QUE SE MEDE E NÃO SE OLHA. A cor da marca é escolhida pelo comerciante e
   pode ser qualquer uma — preto, branco, amarelo-limão. As opacidades das
   fichas não estão escritas à mão: saem de uma busca binária que procura a
   menor opacidade que chega ao contraste pedido contra o fundo. E o contraste
   pedido não é decorativo: 3:1 é o mínimo da WCAG 2.2 para objectos gráficos
   que dizem alguma coisa (1.4.11 «Non-text Contrast»), e uma ficha por
   carimbar diz que falta um carimbo.

   Há uma garantia por trás disto: seja qual for a cor, uma das duas tintas
   (branco ou preto) chega SEMPRE a pelo menos 4,58:1. A luminância que
   equilibra os dois lados é L = 0,179, e aí ambos dão 1,05/0,229 = 4,58.
   Nenhuma cor de marca pode derrotar isto — nem o cinzento do meio.
   ========================================================================= */

/* =========================================================================
   Bytes — o mínimo, e o `crc32` vem do pkpass.js
   ========================================================================= */

import { crc32 } from './pkpass.js';

const juntar = (...partes) => {
  const total = partes.reduce((s, p) => s + p.length, 0);
  const saida = new Uint8Array(total);
  let i = 0;
  for (const p of partes) { saida.set(p, i); i += p.length; }
  return saida;
};
const texto = (s) => new TextEncoder().encode(s);

/* O PNG é big-endian; o ZIP era little-endian. É a única razão para isto não
   ser o `u32` do `pkpass.js`. */
const u32be = (n) => new Uint8Array([(n >>> 24) & 255, (n >>> 16) & 255, (n >>> 8) & 255, n & 255]);

/* =========================================================================
   O PNG

   Quatro blocos e nada mais: IHDR, PLTE, IDAT, IEND. Sem tRNS (a faixa é
   opaca de uma ponta à outra), sem pHYs (a Apple decide a escala pelo nome do
   ficheiro, não pelos metadados) e sem tEXt (um passe reproduzível não leva
   data lá dentro — a mesma razão pela qual o `zipar` põe a hora a zeros).
   ========================================================================= */

function bloco(tipo, dados) {
  const corpo = juntar(texto(tipo), dados);
  return juntar(u32be(dados.length), corpo, u32be(crc32(corpo)));
}

/* O `deflate` do `CompressionStream` é o formato zlib (RFC 1950), com
   cabeçalho e Adler-32 — que é exactamente o que o IDAT de um PNG quer.
   `deflate-raw` daria um PNG que nenhum descodificador abre. */
async function desinflar(bytes) {
  const cs = new CompressionStream('deflate');
  const escritor = cs.writable.getWriter();
  escritor.write(bytes);
  escritor.close();
  return new Uint8Array(await new Response(cs.readable).arrayBuffer());
}

/**
 * Um PNG indexado a partir de `indices` (um byte por pixel) e de `paleta`
 * (768 bytes, RGB de 256 entradas).
 *
 * O FILTRO É SEMPRE O «Up» (tipo 2), e não é preguiça. Um PNG deixa escolher
 * o filtro linha a linha, e escolher bem custa uma passagem de heurística por
 * linha. Aqui não é preciso: a faixa é um degradê vertical com fichas por
 * cima, e cada linha é quase igual à de cima — a diferença dá quase tudo
 * zeros, que é o que o `deflate` come melhor. Medido: com «Up», o fundo de
 * 1125×432 comprime para 2,2 KB.
 */
async function pngIndexado(largura, altura, indices, paleta) {
  const bruto = new Uint8Array((largura + 1) * altura);
  for (let y = 0; y < altura; y += 1) {
    const destino = y * (largura + 1);
    const origem = y * largura;
    bruto[destino] = 2;
    if (y === 0) { bruto.set(indices.subarray(0, largura), destino + 1); continue; }
    const acima = origem - largura;
    for (let i = 0; i < largura; i += 1) {
      bruto[destino + 1 + i] = (indices[origem + i] - indices[acima + i]) & 255;
    }
  }
  return juntar(
    new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]),
    bloco('IHDR', juntar(u32be(largura), u32be(altura),
      new Uint8Array([8, 3, 0, 0, 0]))),   // 8 bits, tipo 3 (paleta)
    bloco('PLTE', paleta),
    bloco('IDAT', await desinflar(bruto)),
    bloco('IEND', new Uint8Array(0)),
  );
}

/* =========================================================================
   Cor — as mesmas contas que o `pkpass.js` e a app fazem, e de propósito

   Se a tinta da faixa e a tinta do texto do passe fossem escolhidas por
   regras diferentes, um cartão podia acabar com fichas brancas por cima de
   uma faixa e texto preto por baixo dela, no mesmo cartão.
   ========================================================================= */

export function lerCor(valor, alternativa = [23, 22, 28]) {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(valor || ''));
  if (!m) return alternativa;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

const canal = (v) => { const s = v / 255; return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4; };
export const luminancia = ([r, g, b]) => 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
export function contraste(a, b) {
  const la = luminancia(a); const lb = luminancia(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}
const mistura = (a, b, t) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];

/**
 * A menor opacidade de `tinta` sobre `fundo` que chega a `alvo` de contraste.
 *
 * Busca binária, 14 voltas, sobre uma função monótona — a opacidade só pode
 * afastar a cor do fundo, nunca aproximá-la. Se nem a opacidade 1 chegar ao
 * alvo (só acontece com um alvo absurdo), devolve 1 e fica o melhor possível
 * em vez de rebentar: uma faixa com pouco contraste é melhor do que um cartão
 * que não sai.
 */
function opacidadePara(fundo, tinta, alvo, minimo = 0.16) {
  let baixo = minimo; let alto = 1;
  if (contraste(mistura(fundo, tinta, alto), fundo) < alvo) return alto;
  for (let i = 0; i < 14; i += 1) {
    const meio = (baixo + alto) / 2;
    if (contraste(mistura(fundo, tinta, meio), fundo) >= alvo) alto = meio; else baixo = meio;
  }
  return alto;
}

/* =========================================================================
   O quadro

   Um `Uint8Array` de índices. 128 é a cor da marca pura; acima é tinta, abaixo
   é sombra. O valor guardado é a OPACIDADE, não a cor — é por isso que
   compor duas camadas é uma linha de aritmética e não três multiplicações
   por canal.
   ========================================================================= */

const NEUTRO = 128;

/* Quanto o fundo desce para o lado da sombra, do topo ao pé da faixa. */
const LAVAGEM = 0.10;

/** Compõe `a` (de −1, sombra cheia, a +1, tinta cheia) por cima do que lá está. */
function compor(quadro, i, a) {
  const actual = (quadro[i] - NEUTRO) / 127;
  const novo = a + actual * (1 - Math.abs(a));
  const v = NEUTRO + Math.round(novo * 127);
  quadro[i] = v < 0 ? 0 : (v > 255 ? 255 : v);
}

/**
 * Um disco com borda analítica.
 *
 * A cobertura de um pixel cujo centro está a `d` do centro do círculo é
 * `raio + 0,5 − d`, saturada. Não é a área exacta do pixel dentro do círculo
 * — é a distância assinada à borda — mas para um raio acima de uns 4 pixels
 * o erro fica abaixo de 2 % de cobertura num anel de 1 pixel, que ninguém vê.
 * O que se vê é o que isto EVITA: a escada que sai de um teste `d < raio`.
 */
function disco(quadro, W, H, cx, cy, raio, alfa) {
  const x0 = Math.max(0, Math.floor(cx - raio - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + raio + 1));
  const y0 = Math.max(0, Math.floor(cy - raio - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + raio + 1));
  for (let y = y0; y <= y1; y += 1) {
    const dy = y + 0.5 - cy; const dy2 = dy * dy;
    let i = y * W + x0;
    for (let x = x0; x <= x1; x += 1, i += 1) {
      const dx = x + 0.5 - cx;
      let c = raio + 0.5 - Math.sqrt(dx * dx + dy2);
      if (c <= 0) continue;
      if (c > 1) c = 1;
      compor(quadro, i, c * alfa);
    }
  }
}

/**
 * Um anel. A cobertura é o produto de «dentro da borda de fora» por «fora da
 * borda de dentro». O produto só está certo quando as duas bordas estão a
 * mais de um pixel uma da outra — e estão: a grossura mínima é de 3 pixels.
 */
function anel(quadro, W, H, cx, cy, raio, grossura, alfa) {
  const interior = raio - grossura;
  const x0 = Math.max(0, Math.floor(cx - raio - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + raio + 1));
  const y0 = Math.max(0, Math.floor(cy - raio - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + raio + 1));
  for (let y = y0; y <= y1; y += 1) {
    const dy = y + 0.5 - cy; const dy2 = dy * dy;
    let i = y * W + x0;
    for (let x = x0; x <= x1; x += 1, i += 1) {
      const dx = x + 0.5 - cx;
      const d = Math.sqrt(dx * dx + dy2);
      let fora = raio + 0.5 - d;
      if (fora <= 0) continue;
      if (fora > 1) fora = 1;
      let dentro = d - interior + 0.5;
      if (dentro <= 0) continue;
      if (dentro > 1) dentro = 1;
      compor(quadro, i, fora * dentro * alfa);
    }
  }
}

/**
 * A sombra por baixo de uma ficha cheia.
 *
 * Um disco só, deslocado, dava um crescente com borda — parecia um erro de
 * registo de impressão e não profundidade. Um desfoque a sério custava uma
 * convolução sobre a caixa toda. O meio-termo são TRÊS discos concêntricos de
 * raios crescentes e opacidades decrescentes: a soma das bordas faz uma rampa
 * de três degraus, que a este tamanho o olho lê como desfoque. Custa três
 * varreduras de uma caixa pequena e nenhuma linha de convolução.
 */
function sombraDeFicha(quadro, W, H, cx, cy, raio) {
  disco(quadro, W, H, cx, cy + raio * 0.075, raio * 1.09, -0.045);
  disco(quadro, W, H, cx, cy + raio * 0.060, raio * 1.05, -0.055);
  disco(quadro, W, H, cx, cy + raio * 0.045, raio * 1.01, -0.065);
}

/**
 * Devolve um disco ao fundo — à cor da marca com a lavagem daquela linha.
 *
 * Serve para abrir o buraco de um marco por cima da barra já desenhada.
 * Compor uma sombra por cima da barra não abria buraco nenhum: escurecia a
 * barra e ficava um borrão. Um buraco é a ausência de tinta, e a ausência
 * escreve-se, não se compõe.
 */
function limparDisco(quadro, W, H, cx, cy, raio, lavagem) {
  const x0 = Math.max(0, Math.floor(cx - raio - 1));
  const x1 = Math.min(W - 1, Math.ceil(cx + raio + 1));
  const y0 = Math.max(0, Math.floor(cy - raio - 1));
  const y1 = Math.min(H - 1, Math.ceil(cy + raio + 1));
  for (let y = y0; y <= y1; y += 1) {
    const dy = y + 0.5 - cy; const dy2 = dy * dy;
    const alvo = NEUTRO - Math.round(lavagem * (y / (H - 1)) * 127);
    let i = y * W + x0;
    for (let x = x0; x <= x1; x += 1, i += 1) {
      const dx = x + 0.5 - cx;
      let c = raio + 0.5 - Math.sqrt(dx * dx + dy2);
      if (c <= 0) continue;
      if (c > 1) c = 1;
      quadro[i] = Math.round(quadro[i] + (alvo - quadro[i]) * c);
    }
  }
}

/** Um traço de pontas redondas, para a barra dos programas de pontos. */
function traco(quadro, W, H, x0, x1, y, grossura, alfa) {
  const r = grossura / 2;
  const yy0 = Math.max(0, Math.floor(y - r - 1));
  const yy1 = Math.min(H - 1, Math.ceil(y + r + 1));
  const xx0 = Math.max(0, Math.floor(x0 - r - 1));
  const xx1 = Math.min(W - 1, Math.ceil(x1 + r + 1));
  for (let yy = yy0; yy <= yy1; yy += 1) {
    const dy = yy + 0.5 - y; const dy2 = dy * dy;
    for (let x = xx0; x <= xx1; x += 1) {
      const px = x + 0.5;
      const alvo = px < x0 ? x0 : (px > x1 ? x1 : px);
      const dx = px - alvo;
      let c = r + 0.5 - Math.sqrt(dx * dx + dy2);
      if (c <= 0) continue;
      if (c > 1) c = 1;
      compor(quadro, yy * W + x, c * alfa);
    }
  }
}

/* =========================================================================
   Os selos

   A referência tem um ícone dentro de cada ficha, e nós temos 24 selos
   desenhados — o `CHEIO` do `_fonte/js/nucleo.js`, que é o mesmo conjunto que
   a app mostra no cartão do ecrã. São caminhos SVG com curvas cúbicas, arcos,
   traços com largura e preenchimentos com opacidade. Rasterizar isso à mão
   dentro de um Worker era escrever um rasterizador de caminhos: analisador de
   `d`, achatamento de Bézier, conversão de arcos, preenchimento por varrimento
   com regra par-ímpar E traçado — umas trezentas linhas para desenhar um
   ícone de 70 pixels. Não se faz.

   O QUE SE FAZ: rasteriza-se UMA VEZ, na construção, com o browser que este
   projecto já usa para a bateria de provas — ele já sabe desenhar SVG — e
   guarda-se o resultado como uma máscara de 1 bit a 192×192, comprimida por
   corridas. As 24 máscaras inteiras dão 11 134 bytes; o ficheiro gerado, com o
   base64 e os nomes, dá 15 296 bytes. É o peso de uma fotografia pequena, e é
   uma vez no pacote em vez de uma vez por pedido.

   PORQUE 1 BIT E NÃO 8. Porque a suavização não vem da máscara — vem da
   REDUÇÃO. A máscara é gravada a 192 e usada a uns 70: cada pixel de saída é a
   média de uns 7×7 pixels de entrada, o que dá cinquenta níveis de cobertura
   sem guardar um único byte de cobertura. Guardar 8 bits por pixel dava
   884 736 bytes para o mesmo resultado.

   QUE ESTE FICHEIRO ENVELHECE EM SILÊNCIO. O mapa é uma cópia do `CHEIO`, e
   uma cópia de uma coisa que vive noutro ficheiro desactualiza-se sem avisar:
   mudar um selo no `nucleo.js` deixava a app com um desenho e o passe com
   outro, e ninguém reparava. Por isso o ficheiro gerado leva o SHA-256 do
   `CHEIO` de que saiu, e há uma guarda no CI que o recalcula e falha se não
   bater certo. A guarda é a parte que não se pode saltar.
   ========================================================================= */

let MASCARAS = null;   /* preguiçoso: só se paga quem usa um selo */

function mascaraDoSelo(nome, SELOS) {
  if (!MASCARAS) {
    MASCARAS = new Map();
    const bruto = Uint8Array.from(atob(SELOS.SELOS_RLE), (c) => c.charCodeAt(0));
    let p = 0;
    for (const chave of SELOS.SELOS_NOMES) {
      const tamanho = bruto[p] | (bruto[p + 1] << 8);
      MASCARAS.set(chave, bruto.subarray(p + 2, p + 2 + tamanho));
      p += 2 + tamanho;
    }
  }
  return MASCARAS.get(nome) || null;
}

/**
 * Expande a máscara, corta-a pela caixa do desenho e reduz-a para caber em
 * `alvo` pixels do lado maior. Devolve `{ w, h, alfa }` com cobertura 0–255.
 *
 * PORQUE É QUE SE CORTA PELA CAIXA. Os 24 selos foram desenhados para a
 * interface, num `viewBox` de 24×24, e não têm todos a mesma margem lá dentro:
 * a estrela toca as bordas, a chávena tem folga dos dois lados. Desenhados ao
 * mesmo tamanho, a chávena sai visivelmente mais pequena do que a estrela
 * dentro da mesma ficha — não porque alguém o quis, mas porque o desenho
 * original tinha outro fim. Corta-se pela caixa do que está pintado e
 * normaliza-se por ela, e os 24 passam a pesar o mesmo no olho.
 *
 * A caixa é medida uma vez por selo e fica guardada: é uma varredura de
 * 36 864 pixels, e repeti-la por ficha era fazer dez vezes a mesma conta.
 */
const CAIXAS = new Map();

function selo(nome, alvo, SELOS) {
  const rle = mascaraDoSelo(nome, SELOS);
  if (!rle) return null;
  const N = SELOS.SELOS_N;
  const bits = new Uint8Array(N * N);
  let i = 0; let valor = 0;
  for (const corrida of rle) {
    if (valor) bits.fill(1, i, i + corrida);
    i += corrida;
    valor ^= 1;
  }

  let caixa = CAIXAS.get(nome);
  if (!caixa) {
    let x0 = N; let y0 = N; let x1 = -1; let y1 = -1;
    for (let y = 0; y < N; y += 1) {
      const linha = y * N;
      for (let x = 0; x < N; x += 1) {
        if (!bits[linha + x]) continue;
        if (x < x0) x0 = x; if (x > x1) x1 = x;
        if (y < y0) y0 = y; if (y > y1) y1 = y;
      }
    }
    if (x1 < 0) return null;
    caixa = { x0, y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
    CAIXAS.set(nome, caixa);
  }

  const escala = Math.max(caixa.w, caixa.h) / alvo;
  const lw = Math.max(1, Math.round(caixa.w / escala));
  const lh = Math.max(1, Math.round(caixa.h / escala));
  const saida = new Uint8Array(lw * lh);
  for (let ty = 0; ty < lh; ty += 1) {
    const sy0 = caixa.y0 + Math.floor(ty * caixa.h / lh);
    const sy1 = Math.max(sy0 + 1, caixa.y0 + Math.floor((ty + 1) * caixa.h / lh));
    for (let tx = 0; tx < lw; tx += 1) {
      const sx0 = caixa.x0 + Math.floor(tx * caixa.w / lw);
      const sx1 = Math.max(sx0 + 1, caixa.x0 + Math.floor((tx + 1) * caixa.w / lw));
      let soma = 0;
      for (let sy = sy0; sy < sy1; sy += 1) {
        const base = sy * N;
        for (let sx = sx0; sx < sx1; sx += 1) soma += bits[base + sx];
      }
      saida[ty * lw + tx] = (soma * 255 / ((sy1 - sy0) * (sx1 - sx0))) | 0;
    }
  }
  return { w: lw, h: lh, alfa: saida };
}

/**
 * Carimba o selo DENTRO de uma ficha cheia, tirando tinta em vez de a pôr.
 *
 * O ícone não se desenha por cima com outra cor: recorta-se. Onde o selo
 * cobre, a opacidade da ficha volta para zero e reaparece a cor da marca —
 * que é como a referência o faz, e a única forma que não precisa de uma
 * terceira cor na rampa.
 */
function recortar(quadro, W, H, cx, cy, g) {
  const x0 = Math.round(cx - g.w / 2);
  const y0 = Math.round(cy - g.h / 2);
  for (let ty = 0; ty < g.h; ty += 1) {
    const y = y0 + ty;
    if (y < 0 || y >= H) continue;
    for (let tx = 0; tx < g.w; tx += 1) {
      const c = g.alfa[ty * g.w + tx];
      if (!c) continue;
      const x = x0 + tx;
      if (x < 0 || x >= W) continue;
      const i = y * W + x;
      const actual = (quadro[i] - NEUTRO) / 127;
      if (actual <= 0) continue;
      quadro[i] = NEUTRO + Math.round(actual * (1 - c / 255) * 127);
    }
  }
}

/* =========================================================================
   A disposição

   Escolhe-se o número de linhas que faz as fichas MAIORES, e não um número
   fixo: com 10 carimbos dá 5×2, que é o da referência; com 3 dá uma linha só;
   com 30 dá 10×3. O tecto existe porque três carimbos numa faixa larga davam
   três discos do tamanho da própria faixa — grande não é o mesmo que legível.
   ========================================================================= */

function disposicao(n, W, alturaUtil, margemX, margemY) {
  let melhor = null;
  for (let linhas = 1; linhas <= 4; linhas += 1) {
    const colunas = Math.ceil(n / linhas);
    const lado = Math.min((W - 2 * margemX) / colunas, (alturaUtil - 2 * margemY) / linhas) * 0.84;
    if (!melhor || lado > melhor.lado) melhor = { linhas, colunas, lado };
  }
  melhor.lado = Math.min(melhor.lado, alturaUtil * 0.60);
  return melhor;
}

/* =========================================================================
   A faixa
   ========================================================================= */

/* A APPLE DÁ DOIS TAMANHOS À FAIXA, e a documentação dela não desfaz a
   dúvida: o guia diz «375 x 144 points for gift cards and coupons, and
   375 x 123 in all other cases», e um `storeCard` é a tal «gift card» ou é
   «all other cases» conforme quem lê. Desenha-se pelo maior — 375×144 pt, que
   a 3× são 1125×432 — e mete-se tudo o que interessa dentro de uma banda de
   123 pt centrada. Se o iOS cortar para 123, corta os 10,5 pt de cima e de
   baixo, onde não há nada; se não cortar, a faixa enche. As duas leituras
   ficam certas sem se saber qual é a verdadeira. */
const BANDA_SEGURA = 369 / 432;

/* Acima disto uma ficha não cabe com tamanho para se ver. Medido a 750×288:
   com 40 fichas o disco fica com 47 px, que a 2× são 23 pt. */
const FICHAS_MAX = 40;
export const CARIMBOS_MAX_GRELHA = FICHAS_MAX;

/* AS MEDIDAS DAS DUAS CARTEIRAS, num sítio só.
 
   A Apple mede em PONTOS: a faixa de um `storeCard` são 375 × 144 pt (Human
   Interface Guidelines, «Wallet», edição de Junho de 2026). Quem escreve o
   ficheiro multiplica pela escala — e o nome do ficheiro TEM de dizer a escala:
   um `strip.png` com 750 px de largura diz ao iOS que aquilo são 750 PONTOS, e
   ele desenha-o ao dobro, cortado, sem erro nenhum.
 
   A Google mede em píxeis e quer a imagem por ENDEREÇO, não por bytes. */
export const APPLE_STRIP = { largura: 375, altura: 144 };
export const GOOGLE_HERO = { largura: 1032, altura: 812 };

export async function faixaDeCartao({
  cor,
  tipo = 'carimbos',
  selo: nomeSelo = 'carimbo',
  feitos = 0,
  objetivo = 10,
  marcos = null,
  largura = 750,
  altura = 288,
  selos = null,            /* o módulo gerado; sem ele, fichas lisas */
}) {
  const W = largura; const H = altura;
  const base = lerCor(cor);

  /* A TINTA É A QUE GANHA, medida e não escolhida por um limiar de gosto.
     É a mesma decisão do `tintaSobre` no `pkpass.js`, escrita do mesmo modo:
     preto se o preto contrastar mais, branco se for o branco. */
  const paraBranco = contraste(base, [255, 255, 255]);
  const paraPreto = contraste(base, [0, 0, 0]);
  const tinta = paraPreto > paraBranco ? [0, 0, 0] : [255, 255, 255];
  const sombra = tinta[0] === 0 ? [255, 255, 255] : [0, 0, 0];

  /* A PALETA. 0 é sombra cheia, 128 é a cor da marca, 255 é tinta cheia.
     256 entradas dão 127 níveis de cobertura de cada lado — mais do que
     suficiente para uma borda de um pixel, e a olho não há degrau nenhum. */
  const paleta = new Uint8Array(768);
  for (let i = 0; i <= NEUTRO; i += 1) {
    const c = mistura(sombra, base, i / NEUTRO);
    paleta[i * 3] = Math.round(c[0]); paleta[i * 3 + 1] = Math.round(c[1]); paleta[i * 3 + 2] = Math.round(c[2]);
  }
  for (let i = NEUTRO + 1; i < 256; i += 1) {
    const c = mistura(base, tinta, (i - NEUTRO) / (255 - NEUTRO));
    paleta[i * 3] = Math.round(c[0]); paleta[i * 3 + 1] = Math.round(c[1]); paleta[i * 3 + 2] = Math.round(c[2]);
  }

  /* O FUNDO. Um degradê de 10 % para o lado da SOMBRA, de cima para baixo.
     Para o lado da sombra e não para o da tinta de propósito: assim o fundo
     afasta-se da tinta à medida que desce, e as fichas de baixo ficam com MAIS
     contraste do que as de cima em vez de menos. Com a lavagem ao contrário, o
     par pior do cartão ficava logo na última linha de carimbos.

     O degradê é representável na rampa porque é a própria sombra a opacidades
     crescentes — não é uma cor nova. Sai de graça. */
  const quadro = new Uint8Array(W * H);
  for (let y = 0; y < H; y += 1) {
    const a = LAVAGEM * (y / (H - 1));
    quadro.fill(NEUTRO - Math.round(a * 127), y * W, y * W + W);
  }
  const fundoBaixo = mistura(base, sombra, LAVAGEM);

  /* AS OPACIDADES SAEM DE UMA MEDIÇÃO, contra o fundo MAIS EXIGENTE de cada
     uma — a ficha cheia mede-se contra o topo, onde o fundo está mais perto da
     tinta, e a vazia contra o mesmo topo pela mesma razão.
     4,5:1 para a cheia porque é ela que diz o número; 3:1 para a vazia porque
     é o mínimo da WCAG 1.4.11 para um objecto gráfico com significado. */
  const alfaCheia = Math.max(0.86, opacidadePara(base, tinta, 4.5));
  const alfaVazia = opacidadePara(base, tinta, 3.0, 0.22);

  const alturaUtil = Math.round(H * BANDA_SEGURA);
  const topoUtil = (H - alturaUtil) / 2;

  /* UM PROGRAMA COM SESSENTA CARIMBOS EXISTE, e a faixa tinha de escolher
     entre desenhar sessenta fichas de doze pixels — ilegíveis — ou desenhar
     quarenta e MENTIR sobre o objectivo. A primeira versão fazia a segunda
     coisa, em silêncio, por causa de um `Math.min(40, …)` posto para proteger
     o CPU. Acima de FICHAS_MAX passa-se à barra, que diz a mesma verdade sem
     inventar um objectivo mais curto. */
  if (tipo === 'pontos' || Math.round(objetivo) > FICHAS_MAX) {
    desenharPontos(quadro, W, H, topoUtil, alturaUtil, feitos, objetivo, marcos, alfaCheia, alfaVazia);
  } else {
    desenharCarimbos(quadro, W, H, topoUtil, alturaUtil, feitos, objetivo,
      alfaCheia, alfaVazia, tinta[0] === 255, nomeSelo, selos);
  }

  return {
    bytes: await pngIndexado(W, H, quadro, paleta),
    /* Devolvidos para as provas poderem MEDIR o que saiu, em vez de olharem. */
    medida: {
      tinta,
      cheiaSobreTopo: contraste(mistura(base, tinta, alfaCheia), base),
      cheiaSobreBaixo: contraste(mistura(base, tinta, alfaCheia), fundoBaixo),
      vaziaSobreTopo: contraste(mistura(base, tinta, alfaVazia), base),
      vaziaSobreBaixo: contraste(mistura(base, tinta, alfaVazia), fundoBaixo),
      alfaCheia, alfaVazia,
    },
  };
}

function desenharCarimbos(quadro, W, H, topoUtil, alturaUtil, feitos, objetivo,
  alfaCheia, alfaVazia, temSombra, nomeSelo, selos) {
  /* O TECTO DE 40 não é um número bonito: é o ponto a partir do qual um
     carimbo deixa de caber com tamanho para se ver. Um programa com 60
     carimbos existe — e para esse a faixa mostra a barra, que não mente. */
  const n = Math.max(1, Math.min(FICHAS_MAX, Math.round(objetivo)));
  const cheios = Math.max(0, Math.min(n, Math.round(feitos)));
  const L = disposicao(n, W, alturaUtil, Math.round(W * 0.045), Math.round(H * 0.06));
  const raio = L.lado / 2;
  const espaco = Math.min(L.lado * 0.34,
    (W - 2 * Math.round(W * 0.045) - L.colunas * L.lado) / Math.max(1, L.colunas - 1));

  /* O SELO REDUZ-SE UMA VEZ e carimba-se muitas. Reduzi-lo por ficha era
     percorrer os 36 864 pixels da máscara dez vezes para dar dez vezes o
     mesmo resultado. */
  const ladoSelo = Math.max(8, Math.round(L.lado * 0.56));
  const glifo = selos && cheios > 0 ? selo(nomeSelo, ladoSelo, selos) : null;

  const alturaTotal = L.linhas * L.lado + (L.linhas - 1) * (L.lado * 0.24);
  let y = topoUtil + (alturaUtil - alturaTotal) / 2 + raio;

  for (let linha = 0; linha < L.linhas; linha += 1) {
    const nesta = Math.min(L.colunas, n - linha * L.colunas);
    if (nesta <= 0) break;
    const total = nesta * L.lado + (nesta - 1) * espaco;
    let x = (W - total) / 2 + raio;
    for (let k = 0; k < nesta; k += 1) {
      const indice = linha * L.colunas + k;
      if (indice < cheios) {
        /* A SOMBRA SÓ EXISTE SOBRE MARCA ESCURA. Numa marca clara a tinta é
           preta, a «sombra» da rampa é branca, e um halo branco por baixo de
           um disco preto não é profundidade — é um erro de impressão. */
        if (temSombra) sombraDeFicha(quadro, W, H, x, y, raio);
        disco(quadro, W, H, x, y, raio, alfaCheia);
        if (glifo) recortar(quadro, W, H, x, y, glifo);
      } else {
        anel(quadro, W, H, x, y, raio, Math.max(3, raio * 0.14), alfaVazia);
      }
      x += L.lado + espaco;
    }
    y += L.lado + L.lado * 0.24;
  }
}

/* Um programa de pontos não tem fichas para contar: tem uma distância até ao
   marco seguinte. Desenha-se a distância, e não um número — escrever «237 pt»
   obrigava a embutir uma tipografia, e o cabeçalho do passe já diz o número.
   Aqui mostra-se o que o número não mostra: quanto falta. */
function desenharPontos(quadro, W, H, topoUtil, alturaUtil, pontos, objetivo, marcos, alfaCheia, alfaVazia) {
  /* OS MARCOS CHEGAM COMO LINHAS DA BASE, `{ pontos, premio }` — e não como
     números. O `map(Number)` sobre um objecto dá NaN, o filtro deitava os três
     fora, a lista ficava vazia, e o `|| 1` punha o fim em 1 ponto. Resultado:
     `237 / 1` saturava em 1 e saía uma BARRA CHEIA, sem marco nenhum, em todos
     os cartões de pontos. Cheia quer dizer «já chegaste»: é a mentira mais
     cara que este cartão pode contar, e não dava erro nenhum.

     Aceitam-se as duas formas, e quando não se percebe nada cai-se no
     objectivo do programa — nunca num número pequeno que encha a barra. */
  const numero = (m) => Number(m && typeof m === 'object' ? m.pontos : m);
  let lista = (Array.isArray(marcos) ? marcos : [])
    .map(numero).filter((m) => Number.isFinite(m) && m > 0).sort((a, b) => a - b);
  if (!lista.length) {
    const alvo = Number(objetivo);
    lista = Number.isFinite(alvo) && alvo > 0 ? [alvo] : [];
  }
  /* SEM FIM CONHECIDO, DESENHA-SE A CALHA VAZIA e mais nada. Inventar um fim
     é inventar um progresso. */
  if (!lista.length) {
    traco(quadro, W, H, Math.round(W * 0.08), W - Math.round(W * 0.08),
      topoUtil + alturaUtil / 2, Math.max(8, Math.round(alturaUtil * 0.13)), alfaVazia);
    return;
  }
  const fim = lista[lista.length - 1];
  const x0 = Math.round(W * 0.08);
  const x1 = W - x0;
  const y = topoUtil + alturaUtil / 2;
  const grossura = Math.max(8, Math.round(alturaUtil * 0.13));

  traco(quadro, W, H, x0, x1, y, grossura, alfaVazia);
  const fracao = Math.max(0, Math.min(1, pontos / fim));
  if (fracao > 0) traco(quadro, W, H, x0, x0 + (x1 - x0) * fracao, y, grossura, alfaCheia);

  for (const m of lista) {
    const cx = x0 + (x1 - x0) * Math.min(1, m / fim);
    const r = grossura * 1.35;
    if (pontos >= m) disco(quadro, W, H, cx, y, r, alfaCheia);
    else {
      limparDisco(quadro, W, H, cx, y, r, LAVAGEM);
      anel(quadro, W, H, cx, y, r, Math.max(3, r * 0.26), alfaVazia);
    }
  }
}
