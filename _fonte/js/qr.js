/* =========================================================================
   Carimbo Digital — gerador de códigos QR
   Escrito de raiz: modo byte, níveis L/M/Q/H, versões 1 a 40, com escolha
   automática da máscara pela penalização da norma (ISO/IEC 18004).

   Porquê de raiz e não uma biblioteca: este ficheiro é servido a cada
   abertura da app e tem de continuar a funcionar daqui a cinco anos sem
   ninguém lhe tocar. São 6 kB e não trazem nada atrás.

   Validado módulo a módulo contra o `segno` — ver scripts/verificar-qr.mjs.
   ========================================================================= */

/* Corretores por bloco e número de blocos, por versão (índice 0 não existe).
   Vêm da tabela 13-22 da norma. */
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
/* Os dois bits com que cada nível entra na informação de formato. */
const BITS_NIVEL = { L: 1, M: 0, Q: 3, H: 2 };

/* Módulos disponíveis para dados numa versão, já descontados os padrões
   fixos. Calcula-se em vez de se tabelar — é a fórmula da norma. */
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

/* ---------- aritmética no corpo de Galois GF(256), polinómio 0x11D ------- */

const EXP = new Uint8Array(512);
const LOG = new Uint8Array(256);
(function tabelas() {
  let x = 1;
  for (let i = 0; i < 255; i++) {
    EXP[i] = x;
    LOG[x] = i;
    x <<= 1;
    if (x & 0x100) x ^= 0x11d;
  }
  for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
})();

function multiplica(a, b) {
  if (a === 0 || b === 0) return 0;
  return EXP[LOG[a] + LOG[b]];
}

/* Coeficientes do polinómio gerador de grau `grau`, ou seja de
   (x - a^0)(x - a^1)...(x - a^(grau-1)), do maior grau para o menor e sem o
   1 inicial, que é implícito. */
function gerador(grau) {
  const g = new Uint8Array(grau);
  g[grau - 1] = 1;
  let raiz = 1;
  for (let i = 0; i < grau; i++) {
    for (let j = 0; j < grau; j++) {
      g[j] = multiplica(g[j], raiz);
      if (j + 1 < grau) g[j] ^= g[j + 1];
    }
    raiz = multiplica(raiz, 2);
  }
  return g;
}

/* Resto da divisão dos dados pelo gerador — são os corretores. */
function corrigir(dados, grau) {
  const g = gerador(grau);
  const resto = new Uint8Array(grau);
  for (const b of dados) {
    const fator = (b ^ resto[0]) & 0xff;
    resto.copyWithin(0, 1);
    resto[grau - 1] = 0;
    for (let i = 0; i < grau; i++) resto[i] ^= multiplica(g[i], fator);
  }
  return resto;
}

/* ---------- fluxo de bits ------------------------------------------------ */

class Bits {
  constructor() { this.b = []; }
  push(valor, n) { for (let i = n - 1; i >= 0; i--) this.b.push((valor >>> i) & 1); }
  get comprimento() { return this.b.length; }
}

/* ---------- codificação -------------------------------------------------- */

function paraBytes(texto) {
  return Array.from(new TextEncoder().encode(texto));
}

function escolherVersao(nBytes, nivel) {
  for (let v = 1; v <= 40; v++) {
    const total = Math.floor(modulosCrus(v) / 8);
    const cap = total - CORRETORES[nivel][v] * BLOCOS[nivel][v];
    const contador = v < 10 ? 8 : 16;
    // 4 bits de modo + contador + os dados
    if (4 + contador + nBytes * 8 <= cap * 8) return v;
  }
  throw new Error('Dados de mais para um código QR');
}

function palavras(bytes, versao, nivel) {
  const total = Math.floor(modulosCrus(versao) / 8);
  const nBlocos = BLOCOS[nivel][versao];
  const porBloco = CORRETORES[nivel][versao];
  const capacidade = total - porBloco * nBlocos;

  const bits = new Bits();
  bits.push(0b0100, 4);                              // modo byte
  bits.push(bytes.length, versao < 10 ? 8 : 16);     // contador
  for (const b of bytes) bits.push(b, 8);

  // Terminador: até 4 zeros, e só os que couberem.
  const sobra = capacidade * 8 - bits.comprimento;
  bits.push(0, Math.min(4, sobra));
  // Alinhar ao byte.
  bits.push(0, (8 - (bits.comprimento % 8)) % 8);
  // Encher com 0xEC / 0x11, alternados, até ao fim.
  for (let i = 0; bits.comprimento < capacidade * 8; i++) bits.push(i % 2 ? 0x11 : 0xec, 8);

  const dados = new Uint8Array(capacidade);
  for (let i = 0; i < dados.length; i++) {
    let v = 0;
    for (let j = 0; j < 8; j++) v = (v << 1) | bits.b[i * 8 + j];
    dados[i] = v;
  }

  // Repartir por blocos: os últimos blocos levam um byte a mais.
  const curtos = nBlocos - (capacidade % nBlocos);
  const base = Math.floor(capacidade / nBlocos);
  const blocosDados = [];
  const blocosEcc = [];
  let off = 0;
  for (let i = 0; i < nBlocos; i++) {
    const n = base + (i < curtos ? 0 : 1);
    const d = dados.slice(off, off + n);
    off += n;
    blocosDados.push(d);
    blocosEcc.push(corrigir(d, porBloco));
  }

  // Intercalar: primeiro os dados coluna a coluna, depois os corretores.
  const saida = new Uint8Array(total);
  let k = 0;
  for (let i = 0; i < base + 1; i++) {
    for (let b = 0; b < nBlocos; b++) {
      if (i < blocosDados[b].length) saida[k++] = blocosDados[b][i];
    }
  }
  for (let i = 0; i < porBloco; i++) {
    for (let b = 0; b < nBlocos; b++) saida[k++] = blocosEcc[b][i];
  }
  return saida;
}

/* ---------- matriz ------------------------------------------------------- */

function novaMatriz(tamanho) {
  return Array.from({ length: tamanho }, () => new Int8Array(tamanho).fill(-1));
}

function padroesFixos(m, versao) {
  const t = m.length;
  const quadrado = (linha, coluna) => {
    for (let dl = -1; dl <= 7; dl++) {
      for (let dc = -1; dc <= 7; dc++) {
        const l = linha + dl, c = coluna + dc;
        if (l < 0 || l >= t || c < 0 || c >= t) continue;
        const borda = Math.max(Math.abs(dl - 3), Math.abs(dc - 3));
        m[l][c] = borda === 2 || borda > 3 ? 0 : 1;
      }
    }
  };
  quadrado(0, 0); quadrado(0, t - 7); quadrado(t - 7, 0);

  // Cadências.
  for (let i = 8; i < t - 8; i++) m[6][i] = m[i][6] = i % 2 === 0 ? 1 : 0;

  // Alinhamento — não se sobrepõe aos localizadores.
  const pos = posicoesAlinhamento(versao);
  for (const l of pos) {
    for (const c of pos) {
      if ((l === 6 && c === 6) || (l === 6 && c === t - 7) || (l === t - 7 && c === 6)) continue;
      for (let dl = -2; dl <= 2; dl++) {
        for (let dc = -2; dc <= 2; dc++) {
          m[l + dl][c + dc] = Math.max(Math.abs(dl), Math.abs(dc)) === 1 ? 0 : 1;
        }
      }
    }
  }

  // O módulo escuro, que existe só porque a norma diz que existe.
  m[t - 8][8] = 1;

  // Reservar o formato (preenchido depois).
  for (let i = 0; i < 9; i++) {
    if (m[8][i] === -1) m[8][i] = 0;
    if (m[i][8] === -1) m[i][8] = 0;
  }
  for (let i = 0; i < 8; i++) {
    if (m[8][t - 1 - i] === -1) m[8][t - 1 - i] = 0;
    if (m[t - 1 - i][8] === -1) m[t - 1 - i][8] = 0;
  }

  // Versão (só a partir da 7).
  if (versao >= 7) {
    let r = versao;
    for (let i = 0; i < 12; i++) r = (r << 1) ^ ((r >>> 11) * 0x1f25);
    const bits = (versao << 12) | r;
    for (let i = 0; i < 18; i++) {
      const b = (bits >>> i) & 1;
      m[Math.floor(i / 3)][t - 11 + (i % 3)] = b;
      m[t - 11 + (i % 3)][Math.floor(i / 3)] = b;
    }
  }
}

/* Marca quais os módulos que são função (não levam dados nem máscara). */
function mapaFuncao(versao) {
  const t = versao * 4 + 17;
  const f = Array.from({ length: t }, () => new Uint8Array(t));
  const marca = (l0, c0, altura, largura) => {
    for (let l = l0; l < l0 + altura; l++) {
      for (let c = c0; c < c0 + largura; c++) {
        if (l >= 0 && l < t && c >= 0 && c < t) f[l][c] = 1;
      }
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

function colocarDados(m, funcao, palavrasCodigo) {
  const t = m.length;
  let i = 0;
  for (let base = t - 1; base >= 1; base -= 2) {
    const coluna = base <= 6 ? base - 1 : base;   // a coluna 6 é de cadência
    for (let passo = 0; passo < t; passo++) {
      const paraCima = ((coluna + 1) & 2) === 0;
      const linha = paraCima ? t - 1 - passo : passo;
      for (const c of [coluna, coluna - 1]) {
        if (funcao[linha][c]) continue;
        const bit = i < palavrasCodigo.length * 8
          ? (palavrasCodigo[i >>> 3] >>> (7 - (i & 7))) & 1
          : 0;                                    // bits de resto: zeros
        m[linha][c] = bit;
        i++;
      }
    }
  }
}

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

function formato(nivel, mascara) {
  const dados = (BITS_NIVEL[nivel] << 3) | mascara;
  let r = dados;
  for (let i = 0; i < 10; i++) r = (r << 1) ^ ((r >>> 9) * 0x537);
  return ((dados << 10) | r) ^ 0x5412;
}

function porFormato(m, nivel, mascara) {
  const t = m.length;
  const bits = formato(nivel, mascara);
  // Os 15 bits ficam em dois sítios, por segurança. Atenção à ordem:
  // a norma fala em (coluna, linha) e a matriz aqui é m[linha][coluna].
  for (let i = 0; i <= 5; i++) m[i][8] = (bits >>> i) & 1;
  m[7][8] = (bits >>> 6) & 1;
  m[8][8] = (bits >>> 7) & 1;
  m[8][7] = (bits >>> 8) & 1;
  for (let i = 9; i < 15; i++) m[8][14 - i] = (bits >>> i) & 1;

  for (let i = 0; i < 8; i++) m[8][t - 1 - i] = (bits >>> i) & 1;
  for (let i = 8; i < 15; i++) m[t - 15 + i][8] = (bits >>> i) & 1;
}

/* =========================================================================
   A penalização da norma (secção 7.8.3). Quanto mais baixa, mais fácil é
   de ler — é por ela que se escolhe entre as oito máscaras.

   A regra 3, a dos padrões parecidos com um localizador, é a que apanha os
   códigos que «parecem bem» e depois nenhum telemóvel lê: a máscara errada
   desenha no meio dos dados uma coisa igual aos três quadrados dos cantos e
   o leitor perde-se a tentar enquadrar. Vale a pena estar certa ao módulo.
   ========================================================================= */

const P1 = 3, P2 = 3, P3 = 40, P4 = 10;

/* O histórico guarda os comprimentos das últimas sete corridas de cor. */
function guardarCorrida(comprimento, hist, tamanho) {
  if (hist[0] === 0) comprimento += tamanho;   // a moldura clara antes da 1.ª
  hist.copyWithin(1, 0, hist.length - 1);
  hist[0] = comprimento;
}

/* Conta padrões 1:1:3:1:1 rodeados de quatro módulos claros. */
function contarLocalizadores(hist) {
  const n = hist[1];
  const nucleo = n > 0 && hist[2] === n && hist[3] === n * 3 && hist[4] === n && hist[5] === n;
  return (nucleo && hist[0] >= n * 4 && hist[6] >= n ? 1 : 0)
       + (nucleo && hist[6] >= n * 4 && hist[0] >= n ? 1 : 0);
}

function terminarCorrida(cor, comprimento, hist, tamanho) {
  if (cor) { guardarCorrida(comprimento, hist, tamanho); comprimento = 0; }
  comprimento += tamanho;                      // a moldura clara depois da última
  guardarCorrida(comprimento, hist, tamanho);
  return contarLocalizadores(hist);
}

function penalizar(m) {
  const t = m.length;
  let p = 0;

  /* Regras 1 e 3, por linhas e depois por colunas. */
  for (const porLinhas of [true, false]) {
    for (let a = 0; a < t; a++) {
      let cor = 0, corrida = 0;
      const hist = new Int32Array(7);
      for (let b = 0; b < t; b++) {
        const v = porLinhas ? m[a][b] : m[b][a];
        if (v === cor) {
          corrida++;
          if (corrida === 5) p += P1;
          else if (corrida > 5) p++;
        } else {
          guardarCorrida(corrida, hist, t);
          if (!cor) p += contarLocalizadores(hist) * P3;
          cor = v; corrida = 1;
        }
      }
      p += terminarCorrida(cor, corrida, hist, t) * P3;
    }
  }

  /* Regra 2: blocos 2x2 da mesma cor. */
  for (let l = 0; l < t - 1; l++) {
    for (let c = 0; c < t - 1; c++) {
      const v = m[l][c];
      if (v === m[l][c + 1] && v === m[l + 1][c] && v === m[l + 1][c + 1]) p += P2;
    }
  }

  /* Regra 4: desequilíbrio entre claro e escuro, em passos de 5 %. */
  let escuros = 0;
  for (const linha of m) for (const v of linha) escuros += v;
  const total = t * t;
  const k = Math.ceil(Math.abs(escuros * 20 - total * 10) / total) - 1;
  p += k * P4;

  return p;
}

/**
 * Gera a matriz de um código QR.
 * @param {string} texto  conteúdo
 * @param {'L'|'M'|'Q'|'H'} nivel  correção de erro (M por omissão)
 * @returns {{tamanho:number, modulos:Int8Array[], versao:number}}
 */
export function gerarQR(texto, nivel = 'M', mascaraForcada = null) {
  const bytes = paraBytes(texto);
  const versao = escolherVersao(bytes.length, nivel);
  const codigo = palavras(bytes, versao, nivel);
  const t = versao * 4 + 17;
  const funcao = mapaFuncao(versao);

  const tentar = mascaraForcada === null ? [0, 1, 2, 3, 4, 5, 6, 7] : [mascaraForcada];
  let melhor = null, melhorP = Infinity, melhorM = 0;
  for (const mascara of tentar) {
    const m = novaMatriz(t);
    padroesFixos(m, versao);
    colocarDados(m, funcao, codigo);
    const f = MASCARAS[mascara];
    for (let l = 0; l < t; l++) {
      for (let c = 0; c < t; c++) if (!funcao[l][c] && f(l, c)) m[l][c] ^= 1;
    }
    porFormato(m, nivel, mascara);
    const p = penalizar(m);
    if (p < melhorP) { melhorP = p; melhor = m; melhorM = mascara; }
  }
  return { tamanho: t, modulos: melhor, versao, mascara: melhorM };
}

/**
 * Desenha o código como SVG. A margem de 4 módulos («quiet zone») é
 * obrigatória: sem ela muitos leitores simplesmente não encontram o código.
 */
export function qrParaSVG(texto, { nivel = 'M', margem = 4, cor = '#000000' } = {}) {
  const { tamanho, modulos } = gerarQR(texto, nivel);
  const lado = tamanho + margem * 2;
  let caminho = '';
  for (let l = 0; l < tamanho; l++) {
    for (let c = 0; c < tamanho; c++) {
      if (modulos[l][c]) caminho += `M${c + margem} ${l + margem}h1v1h-1z`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${lado} ${lado}" `
    + `shape-rendering="crispEdges" role="img" aria-label="Código QR do cartão">`
    + `<rect width="${lado}" height="${lado}" fill="#fff"/>`
    + `<path d="${caminho}" fill="${cor}"/></svg>`;
}
