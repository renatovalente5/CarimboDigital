/* =========================================================================
   Sinete — leitor de códigos QR

   Porque é que isto existe: o `BarcodeDetector` do browser resolve tudo no
   Chrome do Android, mas não existe no Safari. Sem isto, um balcão com
   iPhone — que em Portugal é um balcão em cada três ou quatro — ficava sem
   câmara e só com a entrada manual do número. A promessa do produto é
   «aponta a câmara»; não se pode deixar de fora um terço dos comerciantes.

   O que faz, por ordem:
     1. binariza a imagem por blocos (limiar local, não global)
     2. procura os três olhos do código pela cadência 1:1:3:1:1
     3. arruma-os (canto superior esquerdo, direito, inferior esquerdo)
     4. estima a versão e procura o padrão de alinhamento
     5. monta a transformação de perspectiva e amostra a grelha
     6. lê o formato, desmascara, desintercala
     7. corrige erros por Reed-Solomon e devolve o texto

   O passo 7 é o que distingue isto de um brinquedo: uma leitura de câmara
   real traz sempre módulos trocados, e sem correcção de erros quase nenhuma
   passava.
   ========================================================================= */

/* =========================================================================
   Corpo de Galois GF(256) — o mesmo do gerador, agora também a dividir
   ========================================================================= */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function tabelas() {
  let x = 1;
  for (let i = 0; i < 255; i++) { EXP[i] = x; LOG[x] = i; x <<= 1; if (x & 0x100) x ^= 0x11d; }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);
const div = (a, b) => (a === 0 ? 0 : EXP[LOG[a] + 255 - LOG[b]]);
const inv = (a) => EXP[255 - LOG[a]];

/* Polinómios como arrays do maior grau para o menor. */
function polMul(a, b) {
  const r = new Uint8Array(a.length + b.length - 1);
  for (let i = 0; i < a.length; i++) {
    if (!a[i]) continue;
    for (let j = 0; j < b.length; j++) r[i + j] ^= mul(a[i], b[j]);
  }
  return r;
}

function polAvaliar(p, x) {
  let r = 0;
  for (const c of p) r = mul(r, x) ^ c;
  return r;
}

function podar(p) {
  let i = 0;
  while (i < p.length - 1 && p[i] === 0) i++;
  return p.slice(i);
}

/* =========================================================================
   Correcção de erros
   Síndromes -> Berlekamp-Massey -> Chien -> Forney.

   Aqui os polinómios estão em ordem CRESCENTE de grau (p[0] é o termo
   constante), ao contrário dos do gerador. Não é capricho: as três
   recorrências abaixo escrevem-se com índices directos nesta ordem e com
   índices ao contrário na outra — e foi exactamente aí que a primeira versão
   se enganou, corrigindo bem só os blocos que não tinham erro nenhum.
   ========================================================================= */

/** Horner num polinómio de ordem crescente. */
function avaliar(p, x) {
  let r = 0;
  for (let i = p.length - 1; i >= 0; i--) r = mul(r, x) ^ p[i];
  return r;
}

function corrigirBloco(bytes, nCorretores) {
  const n = bytes.length;

  /* Síndromes: o valor do polinómio do bloco em a^0 ... a^(2t-1). Se forem
     todas zero, não há erro nenhum e não se mexe em nada. */
  const S = new Uint8Array(nCorretores);
  let houveErro = false;
  for (let i = 0; i < nCorretores; i++) {
    let v = 0;
    for (const b of bytes) v = mul(v, EXP[i]) ^ b;   // o bloco vem em ordem decrescente
    S[i] = v;
    if (v) houveErro = true;
  }
  if (!houveErro) return bytes;

  /* --- Berlekamp-Massey: o polinómio que localiza os erros --- */
  let C = [1], B = [1];
  let L = 0, m = 1, b = 1;

  for (let r = 0; r < nCorretores; r++) {
    let d = S[r];
    for (let i = 1; i <= L; i++) d ^= mul(C[i] || 0, S[r - i]);

    if (d === 0) { m++; continue; }

    const escala = div(d, b);
    const novo = C.slice();
    for (let i = 0; i < B.length; i++) {
      const k = i + m;
      novo[k] = (novo[k] || 0) ^ mul(escala, B[i]);
    }
    if (2 * L <= r) {
      const anterior = C;
      C = novo;
      L = r + 1 - L;
      B = anterior;
      b = d;
      m = 1;
    } else {
      C = novo;
      m++;
    }
  }
  while (C.length > 1 && C[C.length - 1] === 0) C.pop();

  const nErros = C.length - 1;
  if (nErros === 0 || nErros * 2 > nCorretores) return null;

  /* --- Chien: as raízes de C dizem onde estão os erros --- */
  const posicoes = [];      // expoentes i tais que X = a^i
  for (let i = 0; i < n; i++) {
    if (avaliar(C, EXP[(255 - i) % 255]) === 0) posicoes.push(i);
  }
  if (posicoes.length !== nErros) return null;

  /* --- Forney: e agora quanto vale cada erro --- */
  /* Omega = (S * C) truncado a x^(2t). */
  const omega = new Uint8Array(nCorretores);
  for (let i = 0; i < nCorretores; i++) {
    let v = 0;
    for (let k = 0; k <= i && k < C.length; k++) v ^= mul(C[k], S[i - k]);
    omega[i] = v;
  }

  /* A derivada formal: em GF(2) sobrevivem só os termos de grau ímpar. */
  const derivada = new Uint8Array(Math.max(1, C.length - 1));
  for (let i = 1; i < C.length; i += 2) derivada[i - 1] = C[i];

  const saida = Uint8Array.from(bytes);
  for (const i of posicoes) {
    const X = EXP[i % 255];
    const Xinv = EXP[(255 - i) % 255];
    const denominador = avaliar(derivada, Xinv);
    if (denominador === 0) return null;
    const valor = mul(X, div(avaliar(omega, Xinv), denominador));
    const indice = n - 1 - i;
    if (indice < 0 || indice >= n) return null;
    saida[indice] ^= valor;
  }

  /* Confere. Uma correcção que deixe síndromes é uma correcção inventada —
     e um código lido errado é pior do que um código não lido. */
  for (let i = 0; i < nCorretores; i++) {
    let v = 0;
    for (const byte of saida) v = mul(v, EXP[i]) ^ byte;
    if (v !== 0) return null;
  }
  return saida;
}

/* =========================================================================
   Tabelas da norma (iguais às do gerador)
   ========================================================================= */

const CORRETORES = {
  L: [-1,7,10,15,20,26,18,20,24,30,18,20,24,26,30,22,24,28,30,28,28,28,28,30,30,26,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  M: [-1,10,16,26,18,24,16,18,22,22,26,30,22,22,24,24,28,28,26,26,26,26,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28,28],
  Q: [-1,13,22,18,26,18,24,18,22,20,24,28,26,24,20,30,24,28,28,26,30,28,30,30,30,30,28,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
  H: [-1,17,28,22,16,22,28,26,26,24,28,24,28,22,24,24,30,28,28,26,28,30,24,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30,30],
};
const BLOCOS = {
  L: [-1,1,1,1,1,1,2,2,2,2,4,4,4,4,4,6,6,6,6,7,8,8,9,9,10,12,12,12,13,14,15,16,17,18,19,19,20,21,22,24,25],
  M: [-1,1,1,1,2,2,4,4,4,5,5,5,8,9,9,10,10,11,13,14,16,17,17,18,20,21,23,25,26,28,29,31,33,35,37,38,40,43,45,47,49],
  Q: [-1,1,1,2,2,4,4,6,6,8,8,8,10,12,16,12,17,16,18,21,20,23,23,25,27,29,34,34,35,38,40,43,45,48,51,53,56,59,62,65,68],
  H: [-1,1,1,2,4,4,4,5,6,8,8,11,11,16,16,18,16,19,21,25,25,25,34,30,32,35,37,40,42,45,48,51,54,57,60,63,66,70,74,77,81],
};
const NIVEL_POR_BITS = { 1: 'L', 0: 'M', 3: 'Q', 2: 'H' };

const MASCARAS = [
  (l, c) => (l + c) % 2 === 0,
  (l) => l % 2 === 0,
  (l, c) => c % 3 === 0,
  (l, c) => (l + c) % 3 === 0,
  (l, c) => (Math.floor(l / 2) + Math.floor(c / 3)) % 2 === 0,
  (l, c) => ((l * c) % 2) + ((l * c) % 3) === 0,
  (l, c) => (((l * c) % 2) + ((l * c) % 3)) % 2 === 0,
  (l, c) => (((l + c) % 2) + ((l * c) % 3)) % 2 === 0,
];

function modulosCrus(versao) {
  let r = (16 * versao + 128) * versao + 64;
  if (versao >= 2) {
    const n = Math.floor(versao / 7) + 2;
    r -= (25 * n - 10) * n - 55;
    if (versao >= 7) r -= 36;
  }
  return r;
}

function posicoesAlinhamento(versao) {
  if (versao === 1) return [];
  const n = Math.floor(versao / 7) + 2;
  const tamanho = versao * 4 + 17;
  const passo = versao === 32 ? 26 : Math.ceil((versao * 4 + 4) / (n * 2 - 2)) * 2;
  const r = [6];
  for (let p = tamanho - 7; r.length < n; p -= passo) r.splice(1, 0, p);
  return r;
}

function mapaFuncao(versao) {
  const t = versao * 4 + 17;
  const f = Array.from({ length: t }, () => new Uint8Array(t));
  const marca = (l0, c0, altura, largura) => {
    for (let l = l0; l < l0 + altura; l++) {
      for (let c = c0; c < c0 + largura; c++) if (l >= 0 && l < t && c >= 0 && c < t) f[l][c] = 1;
    }
  };
  marca(0, 0, 9, 9); marca(0, t - 8, 9, 8); marca(t - 8, 0, 8, 9);
  marca(6, 0, 1, t); marca(0, 6, t, 1);
  const pos = posicoesAlinhamento(versao);
  for (const l of pos) {
    for (const c of pos) {
      if ((l === 6 && c === 6) || (l === 6 && c === t - 7) || (l === t - 7 && c === 6)) continue;
      marca(l - 2, c - 2, 5, 5);
    }
  }
  if (versao >= 7) { marca(0, t - 11, 6, 3); marca(t - 11, 0, 3, 6); }
  return f;
}

/* =========================================================================
   Binarização
   Limiar local, por blocos de 8x8. Um limiar único para a imagem toda falha
   sempre que o balcão tem uma lâmpada de um lado — metade do código fica
   escura e a outra clara, e nenhum valor serve para as duas.
   ========================================================================= */

const BLOCO = 8;
const BLOCO_MIN_VARIACAO = 24;

function binarizar(cinza, largura, altura) {
  const blocosX = Math.max(1, Math.ceil(largura / BLOCO));
  const blocosY = Math.max(1, Math.ceil(altura / BLOCO));
  const medias = new Float32Array(blocosX * blocosY);

  for (let by = 0; by < blocosY; by++) {
    for (let bx = 0; bx < blocosX; bx++) {
      let soma = 0, min = 255, max = 0, n = 0;
      const y0 = by * BLOCO, x0 = bx * BLOCO;
      for (let y = y0; y < Math.min(y0 + BLOCO, altura); y++) {
        for (let x = x0; x < Math.min(x0 + BLOCO, largura); x++) {
          const v = cinza[y * largura + x];
          soma += v; n++;
          if (v < min) min = v;
          if (v > max) max = v;
        }
      }
      let media = n ? soma / n : 128;
      /* Um bloco quase todo da mesma cor não tem informação para decidir:
         herda-se dos vizinhos, senão o interior de um quadrado preto grande
         era cortado ao meio. */
      if (max - min <= BLOCO_MIN_VARIACAO) {
        media = min - 1;
        if (by > 0 && bx > 0) {
          const vizinhos = (medias[(by - 1) * blocosX + bx]
            + medias[by * blocosX + bx - 1]
            + medias[(by - 1) * blocosX + bx - 1]) / 3;
          if (min < vizinhos) media = vizinhos;
        }
      }
      medias[by * blocosX + bx] = media;
    }
  }

  const bits = new Uint8Array(largura * altura);
  for (let by = 0; by < blocosY; by++) {
    for (let bx = 0; bx < blocosX; bx++) {
      /* Média dos 5x5 blocos à volta: suaviza as fronteiras e evita a
         xadrezada que se vê quando cada bloco decide sozinho. */
      const ex = Math.min(Math.max(bx, 2), blocosX - 3);
      const ey = Math.min(Math.max(by, 2), blocosY - 3);
      let soma = 0;
      for (let dy = -2; dy <= 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) soma += medias[(ey + dy) * blocosX + ex + dx];
      }
      const limiar = soma / 25;
      const y0 = by * BLOCO, x0 = bx * BLOCO;
      for (let y = y0; y < Math.min(y0 + BLOCO, altura); y++) {
        for (let x = x0; x < Math.min(x0 + BLOCO, largura); x++) {
          bits[y * largura + x] = cinza[y * largura + x] <= limiar ? 1 : 0;
        }
      }
    }
  }
  return bits;
}

/* =========================================================================
   Os três olhos
   Procura-se a cadência 1:1:3:1:1 (escuro-claro-ESCURO-claro-escuro) ao
   longo de cada linha e confirma-se na vertical e outra vez na horizontal.
   Sem as confirmações, qualquer letra fechada — um O, um 8, um cartaz ao
   fundo — dá um falso positivo e o resto do trabalho vai por água abaixo.
   ========================================================================= */

function cadenciaBoa(contagens) {
  let total = 0;
  for (const c of contagens) { if (c === 0) return false; total += c; }
  if (total < 7) return false;
  const modulo = total / 7;
  const folga = modulo / 2;
  return Math.abs(modulo - contagens[0]) < folga
      && Math.abs(modulo - contagens[1]) < folga
      && Math.abs(modulo * 3 - contagens[2]) < folga * 3
      && Math.abs(modulo - contagens[3]) < folga
      && Math.abs(modulo - contagens[4]) < folga;
}

/** O centro da cadência, contado a partir do fim do último troço escuro. */
const centroCadencia = (c, fim) => fim - c[4] - c[3] - c[2] / 2;

/**
 * Confirma na vertical o que a linha encontrou, e devolve o centro afinado.
 * `maxCentral` limita o troço do meio a pouco mais do que o horizontal viu —
 * sem isso, uma barra preta comprida passava por olho.
 */
function verificarVertical(bits, largura, altura, centroY, centroX, maxCentral, totalOriginal) {
  const escuro = (x, y) => (y >= 0 && y < altura ? bits[y * largura + x] === 1 : false);
  const c = [0, 0, 0, 0, 0];
  let y = centroY;
  while (y >= 0 && escuro(centroX, y)) { c[2]++; y--; }
  if (y < 0) return null;
  while (y >= 0 && !escuro(centroX, y) && c[1] <= maxCentral) { c[1]++; y--; }
  if (y < 0 || c[1] > maxCentral) return null;
  while (y >= 0 && escuro(centroX, y) && c[0] <= maxCentral) { c[0]++; y--; }
  if (c[0] > maxCentral) return null;

  y = centroY + 1;
  while (y < altura && escuro(centroX, y)) { c[2]++; y++; }
  if (y === altura) return null;
  while (y < altura && !escuro(centroX, y) && c[3] < maxCentral) { c[3]++; y++; }
  if (y === altura || c[3] >= maxCentral) return null;
  while (y < altura && escuro(centroX, y) && c[4] < maxCentral) { c[4]++; y++; }
  if (c[4] >= maxCentral) return null;

  const total = c[0] + c[1] + c[2] + c[3] + c[4];
  /* Se o que se vê na vertical for muito diferente do que se viu na
     horizontal, não é o mesmo padrão. */
  if (Math.abs(total - totalOriginal) * 5 >= totalOriginal * 2) return null;
  return cadenciaBoa(c) ? centroCadencia(c, y) : null;
}

/** O mesmo na horizontal, para afinar o centro em x. */
function verificarHorizontal(bits, largura, altura, centroX, centroY, maxCentral, totalOriginal) {
  const escuro = (x, y) => (x >= 0 && x < largura ? bits[y * largura + x] === 1 : false);
  const c = [0, 0, 0, 0, 0];
  let x = centroX;
  while (x >= 0 && escuro(x, centroY)) { c[2]++; x--; }
  if (x < 0) return null;
  while (x >= 0 && !escuro(x, centroY) && c[1] <= maxCentral) { c[1]++; x--; }
  if (x < 0 || c[1] > maxCentral) return null;
  while (x >= 0 && escuro(x, centroY) && c[0] <= maxCentral) { c[0]++; x--; }
  if (c[0] > maxCentral) return null;

  x = centroX + 1;
  while (x < largura && escuro(x, centroY)) { c[2]++; x++; }
  if (x === largura) return null;
  while (x < largura && !escuro(x, centroY) && c[3] < maxCentral) { c[3]++; x++; }
  if (x === largura || c[3] >= maxCentral) return null;
  while (x < largura && escuro(x, centroY) && c[4] < maxCentral) { c[4]++; x++; }
  if (c[4] >= maxCentral) return null;

  const total = c[0] + c[1] + c[2] + c[3] + c[4];
  if (Math.abs(total - totalOriginal) * 5 >= totalOriginal) return null;
  return cadenciaBoa(c) ? centroCadencia(c, x) : null;
}

function encontrarOlhos(bits, largura, altura) {
  const grupos = [];

  const juntar = (x, y, modulo) => {
    for (const g of grupos) {
      if (Math.abs(g.x - x) < g.modulo && Math.abs(g.y - y) < g.modulo) {
        g.x = (g.x * g.n + x) / (g.n + 1);
        g.y = (g.y * g.n + y) / (g.n + 1);
        g.modulo = (g.modulo * g.n + modulo) / (g.n + 1);
        g.n++;
        return;
      }
    }
    grupos.push({ x, y, modulo, n: 1 });
  };

  for (let y = 0; y < altura; y++) {
    const c = [0, 0, 0, 0, 0];
    let estado = 0;
    for (let x = 0; x < largura; x++) {
      if (bits[y * largura + x] === 1) {          // escuro
        if ((estado & 1) === 1) estado++;         // vinha a contar claro
        c[estado]++;
      } else {                                    // claro
        if ((estado & 1) === 0) {                 // vinha a contar escuro
          if (estado === 4) {
            if (cadenciaBoa(c)) {
              const total = c[0] + c[1] + c[2] + c[3] + c[4];
              const modulo = total / 7;
              const cx = Math.round(centroCadencia(c, x));
              const maxCentral = Math.max(c[2], 3);
              const cy = verificarVertical(bits, largura, altura, y, cx, maxCentral, total);
              if (cy !== null) {
                const cxFinal = verificarHorizontal(bits, largura, altura, cx, Math.round(cy), maxCentral, total);
                if (cxFinal !== null) juntar(cxFinal, cy, modulo);
              }
            }
            /* Desliza a janela: os dois últimos troços passam a ser os dois
               primeiros de uma cadência que talvez comece aqui. */
            c[0] = c[2]; c[1] = c[3]; c[2] = c[4]; c[3] = 1; c[4] = 0;
            estado = 3;
          } else {
            estado++;
            c[estado]++;
          }
        } else {
          c[estado]++;
        }
      }
    }
    /* A linha pode acabar em cima de uma cadência completa. */
    if (estado === 4 && cadenciaBoa(c)) {
      const total = c[0] + c[1] + c[2] + c[3] + c[4];
      const cx = Math.round(centroCadencia(c, largura));
      const maxCentral = Math.max(c[2], 3);
      const cy = verificarVertical(bits, largura, altura, y, cx, maxCentral, total);
      if (cy !== null) {
        const cxFinal = verificarHorizontal(bits, largura, altura, cx, Math.round(cy), maxCentral, total);
        if (cxFinal !== null) juntar(cxFinal, cy, total / 7);
      }
    }
  }

  /* Um olho a sério aparece em várias linhas. Os que aparecem uma vez só são
     quase sempre ruído. */
  return grupos.filter((g) => g.n >= 2).sort((a, b) => b.n - a.n);
}

/* =========================================================================
   Arrumar os olhos e medir o código
   ========================================================================= */

const dist = (a, b) => Math.hypot(a.x - b.x, a.y - b.y);

/* =========================================================================
   O tamanho do módulo
   Medido ao longo da linha que liga dois olhos, e não na horizontal.

   Na horizontal parece mais simples, e é o que a procura já dá de borla —
   mas com o telemóvel torto 30° a travessia horizontal de um olho é 1/cos(30)
   mais comprida do que o olho, e o módulo sai 15% maior. Com um módulo
   inflado a dimensão do código sai mais pequena do que é (33 vira 29) e não
   se lê nada. Medindo na direcção certa, a rotação deixa de contar.
   ========================================================================= */

/** Anda em linha de (x0,y0) para (x1,y1) e devolve a distância percorrida
    até completar escuro-claro-escuro. */
function corridaNaLinha(bits, largura, altura, x0, y0, x1, y1) {
  const inclinada = Math.abs(y1 - y0) > Math.abs(x1 - x0);
  if (inclinada) { [x0, y0] = [y0, x0]; [x1, y1] = [y1, x1]; }

  const dx = Math.abs(x1 - x0), dy = Math.abs(y1 - y0);
  let erro = -dx / 2;
  const passoX = x0 < x1 ? 1 : -1;
  const passoY = y0 < y1 ? 1 : -1;
  let estado = 0;
  const limite = x1 + passoX;

  for (let x = x0, y = y0; x !== limite; x += passoX) {
    const rx = inclinada ? y : x;
    const ry = inclinada ? x : y;
    const escuro = rx >= 0 && ry >= 0 && rx < largura && ry < altura
      && bits[ry * largura + rx] === 1;
    if ((estado === 1) === escuro) {
      if (estado === 2) return Math.hypot(x - x0, y - y0);
      estado++;
    }
    erro += dy;
    if (erro > 0) {
      if (y === y1) break;
      y += passoY;
      erro -= dx;
    }
  }
  if (estado === 2) return Math.hypot(limite - x0, y1 - y0);
  return NaN;
}

/** A mesma corrida para os dois lados do centro. Dá cerca de sete módulos. */
function corridaNosDoisSentidos(bits, largura, altura, deX, deY, paraX, paraY) {
  const um = corridaNaLinha(bits, largura, altura, deX, deY, paraX, paraY);

  /* O outro sentido, cortado pelas bordas da imagem se for preciso. */
  let outroX = deX - (paraX - deX);
  let escala = 1;
  if (outroX < 0) { escala = deX / (deX - outroX); outroX = 0; }
  else if (outroX >= largura) { escala = (largura - 1 - deX) / (outroX - deX); outroX = largura - 1; }
  let outroY = Math.round(deY - (paraY - deY) * escala);
  escala = 1;
  if (outroY < 0) { escala = deY / (deY - outroY); outroY = 0; }
  else if (outroY >= altura) { escala = (altura - 1 - deY) / (outroY - deY); outroY = altura - 1; }
  outroX = Math.round(deX + (outroX - deX) * escala);

  const dois = corridaNaLinha(bits, largura, altura, deX, deY, outroX, outroY);
  return um + dois - 1;   // -1: o pixel do meio foi contado duas vezes
}

function tamanhoModulo(bits, largura, altura, a, b) {
  const um = corridaNosDoisSentidos(bits, largura, altura,
    Math.round(a.x), Math.round(a.y), Math.round(b.x), Math.round(b.y));
  const dois = corridaNosDoisSentidos(bits, largura, altura,
    Math.round(b.x), Math.round(b.y), Math.round(a.x), Math.round(a.y));
  if (Number.isNaN(um)) return dois / 7;
  if (Number.isNaN(dois)) return um / 7;
  return (um + dois) / 14;
}

/**
 * Descobre qual dos três olhos é o do canto superior esquerdo: é o que fica
 * no vértice do ângulo recto, ou seja o oposto ao lado mais comprido.
 * Depois separa os outros dois por o sinal do produto externo, que diz de
 * que lado do vector cada um está — é isto que faz o código ser lido na
 * mesma quando o telemóvel está de pernas para o ar.
 */
function arrumarOlhos(a, b, c) {
  const lados = [
    { d: dist(b, c), oposto: a, p: b, q: c },
    { d: dist(a, c), oposto: b, p: a, q: c },
    { d: dist(a, b), oposto: c, p: a, q: b },
  ].sort((x, y) => y.d - x.d);
  const canto = lados[0].oposto;
  let [p, q] = [lados[0].p, lados[0].q];

  const externo = (q.x - canto.x) * (p.y - canto.y) - (q.y - canto.y) * (p.x - canto.x);
  if (externo < 0) [p, q] = [q, p];
  return { cima: canto, direita: q, baixo: p };
}

/** Conta módulos entre dois olhos para estimar a dimensão do código. */
function dimensaoEstimada(cima, outro, modulo) {
  const d = dist(cima, outro) / modulo;
  /* Entre centros de olhos há (dimensão - 7) módulos. */
  const t = Math.round(d) + 7;
  /* As dimensões válidas são 21, 25, 29, ... — ou seja 4n+17. Em vez de
     recusar o que não encaixa (que era o que se fazia, e deitava fora
     leituras boas de fotografias de lado), arredonda-se à válida mais
     próxima. Quem decide se estava certa é a leitura, mais à frente. */
  const arredondada = Math.round((t - 17) / 4) * 4 + 17;
  if (arredondada < 21 || arredondada > 177) return null;
  return arredondada;
}

/* =========================================================================
   Transformação de perspectiva
   Quatro pontos da imagem para quatro pontos da grelha. Uma transformação
   afim não chega: um código fotografado de lado tem os lados a convergir, e
   com afim os módulos do lado de lá saem meio módulo ao lado — o suficiente
   para não ler nada.
   ========================================================================= */

function transformacaoQuadrado(x0, y0, x1, y1, x2, y2, x3, y3) {
  const dx3 = x0 - x1 + x2 - x3;
  const dy3 = y0 - y1 + y2 - y3;
  if (dx3 === 0 && dy3 === 0) {
    return [x1 - x0, x2 - x1, x0, y1 - y0, y2 - y1, y0, 0, 0, 1];
  }
  const dx1 = x1 - x2, dx2 = x3 - x2;
  const dy1 = y1 - y2, dy2 = y3 - y2;
  const denominador = dx1 * dy2 - dx2 * dy1;
  const a13 = (dx3 * dy2 - dx2 * dy3) / denominador;
  const a23 = (dx1 * dy3 - dx3 * dy1) / denominador;
  return [
    x1 - x0 + a13 * x1, x3 - x0 + a23 * x3, x0,
    y1 - y0 + a13 * y1, y3 - y0 + a23 * y3, y0,
    a13, a23, 1,
  ];
}

function multiplicar(a, b) {
  return [
    a[0] * b[0] + a[1] * b[3] + a[2] * b[6], a[0] * b[1] + a[1] * b[4] + a[2] * b[7], a[0] * b[2] + a[1] * b[5] + a[2] * b[8],
    a[3] * b[0] + a[4] * b[3] + a[5] * b[6], a[3] * b[1] + a[4] * b[4] + a[5] * b[7], a[3] * b[2] + a[4] * b[5] + a[5] * b[8],
    a[6] * b[0] + a[7] * b[3] + a[8] * b[6], a[6] * b[1] + a[7] * b[4] + a[8] * b[7], a[6] * b[2] + a[7] * b[5] + a[8] * b[8],
  ];
}

function adjunta(m) {
  return [
    m[4] * m[8] - m[5] * m[7], m[2] * m[7] - m[1] * m[8], m[1] * m[5] - m[2] * m[4],
    m[5] * m[6] - m[3] * m[8], m[0] * m[8] - m[2] * m[6], m[2] * m[3] - m[0] * m[5],
    m[3] * m[7] - m[4] * m[6], m[1] * m[6] - m[0] * m[7], m[0] * m[4] - m[1] * m[3],
  ];
}

function transformacao(origem, destino) {
  const q1 = transformacaoQuadrado(...origem);
  const q2 = transformacaoQuadrado(...destino);
  return multiplicar(q2, adjunta(q1));
}

function aplicar(m, x, y) {
  const d = m[6] * x + m[7] * y + m[8];
  return [(m[0] * x + m[1] * y + m[2]) / d, (m[3] * x + m[4] * y + m[5]) / d];
}

/* =========================================================================
   Alinhamento
   Procura o quadradinho 1:1:1 numa janela à volta de onde ele devia estar.
   É ele que dá o quarto ponto da transformação — e, com ele, a tolerância a
   fotografias tortas.
   ========================================================================= */

function procurarAlinhamento(bits, largura, altura, cx, cy, modulo) {
  const raio = Math.max(5, Math.round(modulo * 4.5));

  const x0 = Math.max(0, Math.round(cx - raio));
  const x1 = Math.min(largura - 1, Math.round(cx + raio));
  const y0 = Math.max(0, Math.round(cy - raio));
  const y1 = Math.min(altura - 1, Math.round(cy + raio));
  const achados = [];

  const bom = (c) => {
    const folga = modulo / 2;
    return Math.abs(modulo - c[0]) < folga
        && Math.abs(modulo - c[1]) < folga
        && Math.abs(modulo - c[2]) < folga;
  };

  /* Confirma na vertical, senão a borda de qualquer módulo isolado passa. */
  const confirmarVertical = (px, py, larguraLocal) => {
    const tecto = larguraLocal * 2;
    const escuro = (y) => (y >= 0 && y < altura ? bits[y * largura + px] === 1 : false);
    if (!escuro(py)) return null;
    let cima = 0, baixo = 0;
    let y = py;
    while (y >= 0 && escuro(y) && cima <= tecto) { cima++; y--; }
    if (cima > tecto) return null;
    y = py + 1;
    while (y < altura && escuro(y) && baixo <= tecto) { baixo++; y++; }
    if (baixo > tecto) return null;
    /* A altura do troço escuro tem de ser da ordem da largura dele. */
    const alto = cima + baixo;
    if (alto < larguraLocal * 0.4 || alto > larguraLocal * 2.4) return null;
    return py + (baixo - cima) / 2;
  };

  for (let y = y0; y <= y1; y++) {
    /* Três troços: claro, ESCURO, claro. O padrão de alinhamento é um
       quadrado de cinco por cinco com um anel claro e um módulo escuro ao
       centro — o que se procura é esse módulo do meio, e não o anel. Procurar
       escuro-claro-escuro (que parece a mesma coisa) devolve o centro do
       anel, um módulo ao lado, e a grelha inteira sai desalinhada. */
    const c = [0, 0, 0];
    let estado = 0;
    for (let x = x0; x <= x1; x++) {
      if (bits[y * largura + x] === 1) {            // escuro
        if (estado === 1) { c[1]++; }
        else if (estado === 2) {
          if (bom(c)) {
            const px = Math.round(x - c[2] - c[1] / 2);
            const py = confirmarVertical(px, y, c[1]);
            if (py !== null) achados.push({ x: px, y: py });
          }
          c[0] = c[2]; c[1] = 1; c[2] = 0; estado = 1;
        } else { estado++; c[estado]++; }
      } else {                                       // claro
        if (estado === 1) estado++;
        c[estado]++;
      }
    }
    if (estado === 2 && bom(c)) {
      const px = Math.round(x1 + 1 - c[2] - c[1] / 2);
      const py = confirmarVertical(px, y, c[1]);
      if (py !== null) achados.push({ x: px, y: py });
    }
  }
  if (!achados.length) return null;

  const grupos = [];
  for (const a of achados) {
    let entrou = false;
    for (const g of grupos) {
      if (Math.abs(g.x - a.x) < modulo && Math.abs(g.y - a.y) < modulo) {
        g.x = (g.x * g.n + a.x) / (g.n + 1);
        g.y = (g.y * g.n + a.y) / (g.n + 1);
        g.n++; entrou = true; break;
      }
    }
    if (!entrou) grupos.push({ x: a.x, y: a.y, n: 1 });
  }
  /* Devolvem-se os dois melhores, e não só o mais perto. A 45 graus, com a
     fotografia de lado, aparece muitas vezes um falso alinhamento mais perto
     do sítio esperado do que o verdadeiro — e com ele a grelha inteira sai
     ao lado. Provar os dois custa uma amostragem e salva a leitura. */
  const bons = grupos.filter((g) => g.n >= 2);
  if (!bons.length) return null;
  return bons
    .sort((a, b) => Math.hypot(a.x - cx, a.y - cy) - Math.hypot(b.x - cx, b.y - cy))
    .slice(0, 2);
}

/* =========================================================================
   Amostrar a grelha
   ========================================================================= */

function amostrar(bits, largura, altura, m, dimensao, modulo) {
  const grelha = Array.from({ length: dimensao }, () => new Int8Array(dimensao));

  /* Vota-se entre o pixel central e os vizinhos — um pixel isolado mal
     binarizado não devia decidir um módulo inteiro. Mas o raio da votação
     tem de caber dentro do módulo: com módulos de quatro pixéis, uma janela
     de 3x3 já está a pedir opinião ao módulo do lado, e com as bordas
     esbatidas pela câmara é essa opinião que ganha. */
  const raio = modulo >= 5 ? 1 : 0;

  for (let l = 0; l < dimensao; l++) {
    for (let c = 0; c < dimensao; c++) {
      const [x, y] = aplicar(m, c + 0.5, l + 0.5);
      const px = Math.round(x), py = Math.round(y);
      if (px < 0 || py < 0 || px >= largura || py >= altura) return null;
      if (raio === 0) { grelha[l][c] = bits[py * largura + px]; continue; }
      let escuros = 0, total = 0;
      for (let dy = -raio; dy <= raio; dy++) {
        for (let dx = -raio; dx <= raio; dx++) {
          const qx = px + dx, qy = py + dy;
          if (qx < 0 || qy < 0 || qx >= largura || qy >= altura) continue;
          escuros += bits[qy * largura + qx];
          total++;
        }
      }
      grelha[l][c] = escuros * 2 > total ? 1 : 0;
    }
  }
  return grelha;
}

/* =========================================================================
   Informação de formato
   Quinze bits, com um código BCH que corrige até três erros. Estão gravados
   duas vezes; tenta-se a cópia que estiver menos estragada.
   ========================================================================= */

const FORMATOS = (() => {
  const tabela = [];
  for (let dados = 0; dados < 32; dados++) {
    let r = dados;
    for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
    tabela.push({ dados, bits: ((dados << 10) | r) ^ 0x5412 });
  }
  return tabela;
})();

function lerFormato(grelha) {
  const t = grelha.length;
  const copia1 = [];
  for (let i = 0; i <= 5; i++) copia1.push(grelha[i][8]);
  copia1.push(grelha[7][8], grelha[8][8], grelha[8][7]);
  for (let i = 9; i < 15; i++) copia1.push(grelha[8][14 - i]);

  const copia2 = [];
  for (let i = 0; i < 8; i++) copia2.push(grelha[8][t - 1 - i]);
  for (let i = 8; i < 15; i++) copia2.push(grelha[t - 15 + i][8]);

  const juntar = (bits) => bits.reduce((acc, b, i) => acc | (b << i), 0);

  let melhor = null, melhorDistancia = Infinity;
  for (const candidato of [juntar(copia1), juntar(copia2)]) {
    for (const f of FORMATOS) {
      let d = 0, x = candidato ^ f.bits;
      while (x) { d += x & 1; x >>>= 1; }
      if (d < melhorDistancia) { melhorDistancia = d; melhor = f.dados; }
    }
  }
  if (melhorDistancia > 3) return null;
  return { nivel: NIVEL_POR_BITS[(melhor >> 3) & 3], mascara: melhor & 7 };
}

/* =========================================================================
   Ler os bytes
   ========================================================================= */

function lerCodewords(grelha, versao, mascara) {
  const t = grelha.length;
  const funcao = mapaFuncao(versao);
  const f = MASCARAS[mascara];
  const bits = [];

  for (let base = t - 1; base >= 1; base -= 2) {
    const coluna = base <= 6 ? base - 1 : base;
    for (let passo = 0; passo < t; passo++) {
      const paraCima = ((coluna + 1) & 2) === 0;
      const linha = paraCima ? t - 1 - passo : passo;
      for (const c of [coluna, coluna - 1]) {
        if (funcao[linha][c]) continue;
        bits.push(grelha[linha][c] ^ (f(linha, c) ? 1 : 0));
      }
    }
  }

  const total = Math.floor(modulosCrus(versao) / 8);
  const bytes = new Uint8Array(total);
  for (let i = 0; i < total; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | (bits[i * 8 + j] || 0);
    bytes[i] = v;
  }
  return bytes;
}

/** Desfaz a intercalação e corrige cada bloco. */
function desintercalarECorrigir(bytes, versao, nivel) {
  const total = bytes.length;
  const nBlocos = BLOCOS[nivel][versao];
  const porBloco = CORRETORES[nivel][versao];
  const capacidade = total - porBloco * nBlocos;
  const curtos = nBlocos - (capacidade % nBlocos);
  const base = Math.floor(capacidade / nBlocos);
  const tamanhos = Array.from({ length: nBlocos }, (_, i) => base + (i < curtos ? 0 : 1));

  const dados = tamanhos.map((n) => new Uint8Array(n));
  const ecc = Array.from({ length: nBlocos }, () => new Uint8Array(porBloco));

  let k = 0;
  for (let i = 0; i < base + 1; i++) {
    for (let b = 0; b < nBlocos; b++) if (i < tamanhos[b]) dados[b][i] = bytes[k++];
  }
  for (let i = 0; i < porBloco; i++) {
    for (let b = 0; b < nBlocos; b++) ecc[b][i] = bytes[k++];
  }

  const saida = [];
  for (let b = 0; b < nBlocos; b++) {
    const completo = new Uint8Array(dados[b].length + porBloco);
    completo.set(dados[b], 0);
    completo.set(ecc[b], dados[b].length);
    const corrigido = corrigirBloco(completo, porBloco);
    if (!corrigido) return null;
    saida.push(corrigido.slice(0, dados[b].length));
  }
  const juntos = new Uint8Array(capacidade);
  let p = 0;
  for (const bloco of saida) { juntos.set(bloco, p); p += bloco.length; }
  return juntos;
}

/* =========================================================================
   Interpretar os segmentos
   ========================================================================= */

const ALFANUM = '0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZ $%*+-./:';

function interpretar(bytes, versao) {
  const bits = [];
  for (const b of bytes) for (let i = 7; i >= 0; i--) bits.push((b >> i) & 1);
  let p = 0;
  const tirar = (n) => {
    let v = 0;
    for (let i = 0; i < n; i++) { if (p >= bits.length) throw new Error('acabou'); v = (v << 1) | bits[p++]; }
    return v;
  };
  const contador = (modo) => {
    if (versao < 10) return { 1: 10, 2: 9, 4: 8, 8: 8 }[modo];
    if (versao < 27) return { 1: 12, 2: 11, 4: 16, 8: 10 }[modo];
    return { 1: 14, 2: 13, 4: 16, 8: 12 }[modo];
  };

  const partes = [];
  const octetos = [];
  for (;;) {
    if (bits.length - p < 4) break;
    const modo = tirar(4);
    if (modo === 0) break;                      // terminador
    if (modo === 7) { tirar(8); continue; }     // ECI: ignora-se o designador
    const n = tirar(contador(modo));
    if (modo === 1) {                           // numérico
      let saida = '';
      let restam = n;
      while (restam >= 3) { saida += String(tirar(10)).padStart(3, '0'); restam -= 3; }
      if (restam === 2) saida += String(tirar(7)).padStart(2, '0');
      else if (restam === 1) saida += String(tirar(4));
      partes.push(saida);
    } else if (modo === 2) {                    // alfanumérico
      let saida = '';
      let restam = n;
      while (restam >= 2) { const v = tirar(11); saida += ALFANUM[Math.floor(v / 45)] + ALFANUM[v % 45]; restam -= 2; }
      if (restam === 1) saida += ALFANUM[tirar(6)];
      partes.push(saida);
    } else if (modo === 4) {                    // byte
      const inicio = octetos.length;
      for (let i = 0; i < n; i++) octetos.push(tirar(8));
      partes.push({ octetos: [inicio, octetos.length] });
    } else {
      break;                                    // kanji e afins: fora do nosso âmbito
    }
  }

  const bruto = new Uint8Array(octetos);
  const decodificador = new TextDecoder('utf-8', { fatal: false });
  return partes.map((x) => (typeof x === 'string'
    ? x
    : decodificador.decode(bruto.slice(x.octetos[0], x.octetos[1])))).join('');
}

/* =========================================================================
   A porta de entrada
   ========================================================================= */

/**
 * Lê um código QR de uma imagem em tons de cinzento.
 *
 * @param {Uint8Array|Uint8ClampedArray} cinza  um byte por pixel
 * @param {number} largura
 * @param {number} altura
 * @returns {string|null}
 */
export function lerQR(cinza, largura, altura) {
  const bits = binarizar(cinza, largura, altura);
  const olhos = encontrarOlhos(bits, largura, altura);
  if (olhos.length < 3) return null;

  /* Se aparecerem mais de três candidatos, prova-se com os melhores —
     cartazes e embalagens têm coisas parecidas com olhos por todo o lado. */
  const limite = Math.min(olhos.length, 5);
  for (let a = 0; a < limite - 2; a++) {
    for (let b = a + 1; b < limite - 1; b++) {
      for (let c = b + 1; c < limite; c++) {
        const texto = tentar(bits, largura, altura, olhos[a], olhos[b], olhos[c]);
        if (texto !== null) return texto;
      }
    }
  }
  return null;
}

function tentar(bits, largura, altura, o1, o2, o3) {
  const { cima, direita, baixo } = arrumarOlhos(o1, o2, o3);

  const mDireita = tamanhoModulo(bits, largura, altura, cima, direita);
  const mBaixo = tamanhoModulo(bits, largura, altura, cima, baixo);
  let modulo = (mDireita + mBaixo) / 2;
  if (!Number.isFinite(modulo) || modulo < 1) {
    modulo = (cima.modulo + direita.modulo + baixo.modulo) / 3;   // recurso
  }
  if (!(modulo > 0.9)) return null;

  const d1 = dimensaoEstimada(cima, direita, modulo);
  const d2 = dimensaoEstimada(cima, baixo, modulo);
  if (!d1 && !d2) return null;

  /* De frente, os dois lados dão o mesmo. De lado, não dão — e nesse caso
     vale a pena provar as duas hipóteses em vez de escolher uma à sorte. */
  const candidatas = [...new Set([
    d1 && d2 ? Math.round((d1 + d2) / 8) * 4 + 1 : null,
    d1, d2,
  ].filter((x) => x && x >= 21 && x <= 177 && (x - 17) % 4 === 0))];

  for (const dimensao of candidatas) {
    const texto = comDimensao(bits, largura, altura, cima, direita, baixo, modulo, dimensao);
    if (texto !== null) return texto;
  }
  return null;
}

function comDimensao(bits, largura, altura, cima, direita, baixo, modulo, dimensao) {
  const versao = (dimensao - 17) / 4;

  /* O quarto ponto: o padrão de alinhamento, se a versão o tiver. Sem ele
     (versão 1) extrapola-se o canto, que chega para códigos pequenos. */
  let quarto = null;   // lista de candidatos
  if (versao >= 2) {
    const posicoes = posicoesAlinhamento(versao);
    const alvo = posicoes[posicoes.length - 1];   // o de baixo à direita

    /* O canto oposto do paralelogramo dos três olhos, recuado do centro do
       olho que lá não está até ao centro do alinhamento — que fica três
       módulos mais para dentro, em cada eixo. Somar o desvio ao olho da
       direita, como parecia natural, não funciona: quando o código está
       direito, `baixo.x - cima.x` é zero e o desvio desaparece. */
    const cantoX = direita.x - cima.x + baixo.x;
    const cantoY = direita.y - cima.y + baixo.y;
    const recuo = 1 - 3 / (dimensao - 7);
    const px = cima.x + recuo * (cantoX - cima.x);
    const py = cima.y + recuo * (cantoY - cima.y);

    /* A procura do alinhamento varre linhas horizontais, mas o módulo foi
       medido na direcção do código. Se o código estiver torto, a travessia
       horizontal de um módulo é mais comprida do que o módulo — a 45 graus,
       1,41 vezes. Sem esta conta havia um ponto cego exactamente nas
       diagonais: a 30° e a 60° lia, a 45° não. */
    const angulo = Math.atan2(direita.y - cima.y, direita.x - cima.x);
    const moduloHorizontal = modulo
      / Math.max(Math.abs(Math.cos(angulo)), Math.abs(Math.sin(angulo)));

    const achados = procurarAlinhamento(bits, largura, altura, px, py, moduloHorizontal);
    if (achados) quarto = achados.map((a) => ({ x: a.x, y: a.y, grelha: alvo + 0.5 }));
  }

  const b = dimensao - 3.5;

  /* Duas tentativas: com o padrão de alinhamento (mais fiel, mas depende de
     o termos encontrado no sítio certo) e sem ele (paralelogramo, que chega
     quando o código está de frente). A primeira que descodificar ganha. */
  const tentativas = [];
  for (const q of quarto || []) {
    tentativas.push(transformacao(
      [3.5, 3.5, b, 3.5, q.grelha, q.grelha, 3.5, b],
      [cima.x, cima.y, direita.x, direita.y, q.x, q.y, baixo.x, baixo.y]));
  }
  tentativas.push(transformacao(
    [3.5, 3.5, b, 3.5, b, b, 3.5, b],
    [cima.x, cima.y, direita.x, direita.y,
     direita.x + baixo.x - cima.x, direita.y + baixo.y - cima.y, baixo.x, baixo.y]));

  for (const m of tentativas) {
    const grelha = amostrar(bits, largura, altura, m, dimensao, modulo);
    if (!grelha) continue;
    const formato = lerFormato(grelha);
    if (!formato) continue;
    const bytes = lerCodewords(grelha, versao, formato.mascara);
    const dados = desintercalarECorrigir(bytes, versao, formato.nivel);
    if (!dados) continue;
    try {
      const texto = interpretar(dados, versao);
      if (texto) return texto;
    } catch { /* tenta a seguinte */ }
  }
  return null;
}

/**
 * Lê a partir de um ImageData (o que sai de um `<canvas>`).
 * A conversão para cinzento usa os pesos da luminância — um QR impresso a
 * azul sobre branco desaparece se se fizer a média simples dos canais.
 */
export function lerDoImageData(imageData) {
  const { data, width, height } = imageData;
  const cinza = new Uint8Array(width * height);
  for (let i = 0, j = 0; i < data.length; i += 4, j++) {
    cinza[j] = (data[i] * 306 + data[i + 1] * 601 + data[i + 2] * 117) >> 10;
  }
  return lerQR(cinza, width, height);
}
