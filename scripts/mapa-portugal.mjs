#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — o mapa de Portugal, desenhado uma vez

   Escreve `_fonte/dados/portugal.json`: as fronteiras dos 308 concelhos já
   PROJECTADAS em coordenadas de ecrã, prontas a pôr num `<path>`. A app não
   projecta nada em tempo real e não vai buscar imagem nenhuma a lado nenhum —
   é o que permite a página de privacidade continuar a dizer, à letra, que
   «não carrega tipos de letra, mapas ou scripts de terceiros».

   TRÊS FOLHAS, e não uma. Os Açores ficam a 1500 km do continente e a Madeira
   a 1000: num mapa à escala verdadeira, o continente ficava do tamanho de uma
   unha. Como em qualquer mapa de Portugal, os arquipélagos vão em caixas
   próprias, cada uma com a sua escala, numa coluna à esquerda. A vista de
   abertura enquadra só o continente; quem afastar encontra as caixas, com o
   nome escrito por cima.

   DE ONDE VÊM OS DADOS
   · Continente: `Portfolio/_source/dados/mapa-continente.json`, que o autor já
     tinha gerado a partir da CAOP (json.geoapi.pt) e simplificado. Copia-se em
     vez de voltar a descarregar 278 municípios de uma API pequena e gratuita.
   · Ilhas: os 30 municípios descarregados para `_dev/geoapi/` (ver o LEIA-ME
     dessa pasta). Fora do repositório, porque são 32 MB para produzir 25 KB.

   Uso:  node scripts/mapa-portugal.mjs
   ========================================================================= */

import { readFileSync, writeFileSync, existsSync, readdirSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const GEOAPI = join(RAIZ, '_dev', 'geoapi');
const CONTINENTE = join(RAIZ, '..', 'Portfolio', '_source', 'dados', 'mapa-continente.json');
const DESTINO = join(RAIZ, '_fonte', 'dados');

/* --- três folhas, e não uma tela ------------------------------------------
   A primeira tentativa foi a clássica: o continente à direita e os
   arquipélagos em caixas na coluna da esquerda, tudo numa tela só. Ficou mal,
   e por uma razão de aritmética — os Açores medem 570 km de ponta a ponta, e
   numa caixa de 234 unidades São Miguel fica com 26. A Graciosa fica com três.
   Uma caixa de mapa que não se lê é pior do que caixa nenhuma.

   Cada folha passou a ser um mapa INTEIRO, com a sua escala. O componente
   mostra a folha onde estão os negócios, e só oferece as outras quando houver
   negócios nelas. Um português a procurar um café não precisa de ver uma caixa
   vazia dos Açores — e um açoriano precisa dos Açores em grande, não ao canto. */
const LARGURA_ILHAS = 620;     /* a largura a que uma folha de ilhas é desenhada */
const FOLGA = 16;              /* respiro à volta do desenho, dentro da folha */

/* Ilhéus mais pequenos do que isto não se desenham. Meio quilómetro quadrado
   deixa passar o Corvo (17 km²), que é um concelho inteiro, e deita fora as
   pedras que só engordam o ficheiro. */
const AREA_MINIMA_KM2 = 0.5;

/* AS SELVAGENS FICAM DE FORA, e é preciso dizê-lo. Pertencem ao concelho do
   Funchal e estão a 250 km a sul da Madeira — mais perto de Tenerife do que
   do Funchal. Com elas dentro, a caixa da Madeira passava a ter dois terços
   de oceano vazio para mostrar duas pedras sem ninguém. O centróide oficial
   do Funchal, aliás, cai no mar por causa delas: 31,699 N, quando a cidade
   está a 32,65. É por isso que o centróide de concelho é a ÚLTIMA fonte de
   coordenadas deste produto, e nunca a primeira. */
const RECORTES = {
  Madeira: { lonMin: -17.4, lonMax: -16.2, latMin: 32.3, latMax: 33.2 },
  Açores: { lonMin: -31.4, lonMax: -24.9, latMin: 36.8, latMax: 39.8 },
};

const ARQUIPELAGO = (nomeIlha) =>
  /Madeira|Porto Santo/i.test(nomeIlha || '') ? 'Madeira' : 'Açores';

/* --- geometria ------------------------------------------------------------ */

/** Os anéis exteriores de uma geometria GeoJSON, sejam Polygon ou MultiPolygon. */
function aneisDe(geometria) {
  if (geometria.type === 'Polygon') return geometria.coordinates;
  if (geometria.type === 'MultiPolygon') return geometria.coordinates.flat();
  throw new Error(`geometria que não sei ler: ${geometria.type}`);
}

/** Área de um anel em km², pela fórmula do agrimensor sobre graus projectados. */
function areaKm2(anel, latRef) {
  const cos = Math.cos((latRef * Math.PI) / 180);
  let s = 0;
  for (let i = 0, j = anel.length - 1; i < anel.length; j = i++) {
    const [x1, y1] = [anel[j][0] * cos, anel[j][1]];
    const [x2, y2] = [anel[i][0] * cos, anel[i][1]];
    s += x1 * y2 - x2 * y1;
  }
  return Math.abs(s / 2) * 111.32 * 111.32;
}

/**
 * Douglas-Peucker sobre uma linha aberta.
 *
 * Sem isto o ficheiro seria de megabytes: a CAOP tem a costa ao metro, e num
 * mapa de mil unidades de altura ninguém vê a diferença.
 */
function simplificarLinha(pontos, tolerancia) {
  if (pontos.length < 3) return pontos;
  const [inicio, fim] = [pontos[0], pontos[pontos.length - 1]];
  let pior = 0, distanciaPior = 0;
  const [x1, y1] = inicio, [x2, y2] = fim;
  const dx = x2 - x1, dy = y2 - y1;
  const norma = Math.hypot(dx, dy) || 1;
  for (let i = 1; i < pontos.length - 1; i++) {
    const [x, y] = pontos[i];
    const d = Math.abs(dy * x - dx * y + x2 * y1 - y2 * x1) / norma;
    if (d > distanciaPior) { distanciaPior = d; pior = i; }
  }
  if (distanciaPior <= tolerancia) return [inicio, fim];
  return [
    ...simplificarLinha(pontos.slice(0, pior + 1), tolerancia).slice(0, -1),
    ...simplificarLinha(pontos.slice(pior), tolerancia),
  ];
}

/**
 * E agora sobre um ANEL, que é outra coisa.
 *
 * Num anel fechado o primeiro ponto é igual ao último, e o Douglas-Peucker
 * mede a distância de cada ponto à recta que os une — uma recta de comprimento
 * ZERO. Toda a ilha fica «perto» dessa recta e a resposta é dois pontos
 * iguais: um `M x yZ` que não desenha nada. Foi assim que as Lajes das Flores
 * desapareceram do mapa, e é o género de erro que não se vê a olho — vê-se uma
 * ilha a menos e pensa-se que é assim mesmo.
 *
 * O que se faz é partir o anel no ponto mais LONGE do primeiro, simplificar as
 * duas metades como linhas abertas, e voltar a fechar. E, aconteça o que
 * acontecer, um anel que entrou com forma não sai com menos de quatro pontos.
 */
function simplificarAnel(anel, tolerancia) {
  const fechado = anel.length > 2
    && anel[0][0] === anel[anel.length - 1][0]
    && anel[0][1] === anel[anel.length - 1][1];
  const pontos = fechado ? anel.slice(0, -1) : anel;
  if (pontos.length < 5) return anel;

  let oposto = 0, maior = -1;
  for (let i = 1; i < pontos.length; i++) {
    const d = Math.hypot(pontos[i][0] - pontos[0][0], pontos[i][1] - pontos[0][1]);
    if (d > maior) { maior = d; oposto = i; }
  }
  const saida = [
    ...simplificarLinha(pontos.slice(0, oposto + 1), tolerancia).slice(0, -1),
    ...simplificarLinha([...pontos.slice(oposto), pontos[0]], tolerancia).slice(0, -1),
  ];
  if (saida.length < 4) return anel;
  return [...saida, saida[0]];
}

/** Um `d` de `<path>` a partir de anéis já em unidades de ecrã. */
function caminho(aneis) {
  const casas = (n) => Math.round(n * 10) / 10;
  return aneis.map((anel) => {
    /* ACUMULA-SE NA POSIÇÃO DESENHADA, e não na verdadeira.

       Cada deslocamento vai arredondado a uma casa decimal. Medindo sempre a
       partir do ponto VERDADEIRO, os arredondamentos somam-se num passeio
       aleatório: em Machico, 259 vértices davam 1,1 unidades de desvio — 171
       metros, três vezes mais do que a simplificação deliberada, que ali vale
       54. Medindo a partir do ponto já desenhado, cada deslocamento corrige o
       erro do anterior e o desvio nunca passa de meia casa. */
    const partes = [`M${casas(anel[0][0])} ${casas(anel[0][1])}`];
    let ax = casas(anel[0][0]), ay = casas(anel[0][1]);
    for (const [x, y] of anel.slice(1)) {
      const [rx, ry] = [casas(x - ax), casas(y - ay)];
      if (rx === 0 && ry === 0) continue;
      partes.push(`l${rx} ${ry}`);
      ax = casas(ax + rx); ay = casas(ay + ry);
    }
    return partes.join('') + 'Z';
  }).join('');
}

/* --- sítios de prova -------------------------------------------------------
   Coordenadas de sítios que toda a gente sabe onde ficam, com o concelho a que
   pertencem. Não vão para o ficheiro: servem só para a guarda do fim provar
   que a projecção e os desenhos falam da mesma coisa. */
const PROVAS = [
  { nome: 'Sé do Porto', lat: 41.1429, lon: -8.6110, concelho: 'Porto' },
  { nome: 'Praça do Comércio', lat: 38.7078, lon: -9.1366, concelho: 'Lisboa' },
  { nome: 'Sé de Braga', lat: 41.5503, lon: -8.4279, concelho: 'Braga' },
  { nome: 'Universidade de Coimbra', lat: 40.2077, lon: -8.4265, concelho: 'Coimbra' },
  { nome: 'Sé de Faro', lat: 37.0146, lon: -7.9352, concelho: 'Faro' },
  { nome: 'Templo de Évora', lat: 38.5726, lon: -7.9077, concelho: 'Évora' },
  { nome: 'Castelo de Bragança', lat: 41.8072, lon: -6.7511, concelho: 'Bragança' },
  { nome: 'Ria de Aveiro', lat: 40.6405, lon: -8.6538, concelho: 'Aveiro' },
  { nome: 'Sé do Funchal', lat: 32.6485, lon: -16.9082, concelho: 'Funchal' },
  { nome: 'Vila Baleira', lat: 33.0640, lon: -16.3389, concelho: 'Porto Santo' },
  { nome: 'Machico', lat: 32.7175, lon: -16.7666, concelho: 'Machico' },
  { nome: 'Portas da Cidade', lat: 37.7412, lon: -25.6690, concelho: 'Ponta Delgada' },
  { nome: 'Sé de Angra', lat: 38.6553, lon: -27.2178, concelho: 'Angra do Heroísmo' },
  { nome: 'Porto Pim, Horta', lat: 38.5290, lon: -28.6320, concelho: 'Horta' },
];

/**
 * Ponto dentro de um `<path>`, lido comando a comando.
 *
 * Trata os vários `M` de um concelho com ilhas (Lisboa, Peniche, Montijo) como
 * anéis independentes, e um ponto dentro de qualquer um deles conta.
 */
function dentroDoCaminho(ponto, d) {
  const aneis = [];
  let anel = null, x = 0, y = 0;
  for (const [, cmd, a1, a2] of d.matchAll(/([MlL])\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g)) {
    const [n1, n2] = [Number(a1), Number(a2)];
    if (cmd === 'M') { if (anel) aneis.push(anel); x = n1; y = n2; anel = [[x, y]]; }
    else { if (cmd === 'L') { x = n1; y = n2; } else { x += n1; y += n2; } anel.push([x, y]); }
  }
  if (anel) aneis.push(anel);
  return aneis.some((a) => {
    let dentro = false;
    for (let i = 0, j = a.length - 1; i < a.length; j = i++) {
      const [xi, yi] = a[i], [xj, yj] = a[j];
      if ((yi > ponto[1]) !== (yj > ponto[1])
        && ponto[0] < ((xj - xi) * (ponto[1] - yi)) / (yj - yi) + xi) dentro = !dentro;
    }
    return dentro;
  });
}

/* --- as folhas ----------------------------------------------------------- */

/** A folha do continente, reaproveitada tal e qual do Portfolio. */
function folhaDoContinente() {
  if (!existsSync(CONTINENTE)) {
    console.error(`Falta ${CONTINENTE}.`);
    console.error('É o mapa do continente que o Portfolio já gerou a partir da CAOP.');
    process.exit(1);
  }
  const d = JSON.parse(readFileSync(CONTINENTE, 'utf8'));
  const [, , largura, altura] = d.viewBox;
  const k = d.K;
  /* A projecção do Portfolio, escrita na forma que a app vai usar:
       x = (lon - lon0) * cos(latRef) * k + dx
       y = (latTopo - lat) * k + dy
     Os `minx`/`miny` de lá viram `dx`/`dy` aqui, que é a mesma conta com menos
     passos do lado do browser. Os caminhos ficam EXACTAMENTE como estavam: é
     por isso que o `dx`/`dy` não leva deslocamento nenhum de folha. */
  return {
    nome: 'Continente',
    viewBox: [0, 0, largura, altura],
    proj: { lon0: d.lon0, latRef: d.lat_ref, latTopo: 42.20, k, dx: -d.minx * k, dy: -d.miny * k },
    /* A janela geográfica que esta folha atende — é o que decide, do lado da
       app, em que folha cai um negócio. */
    janela: { lonMin: -9.7, lonMax: -6.1, latMin: 36.9, latMax: 42.2 },
    concelhos: d.concelhos.map((c) => ({ nome: c.nome, ine: c.ine, d: c.d })),
  };
}

/** Uma folha de arquipélago, gerada dos ficheiros do geoapi. */
function folhaDeIlhas(nome, municipios) {
  const corte = RECORTES[nome];
  const latRef = (corte.latMin + corte.latMax) / 2;
  const cos = Math.cos((latRef * Math.PI) / 180);

  /* Primeiro os anéis que ficam, e só depois a escala: escolher a escala com
     ilhéus que vão ser deitados fora dava uma folha com margens a mais. */
  const preparados = [];
  for (const m of municipios) {
    const aneis = aneisDe(m.geojson.geometry).filter((anel) => {
      const dentro = anel.every(([lon, lat]) =>
        lon >= corte.lonMin && lon <= corte.lonMax
        && lat >= corte.latMin && lat <= corte.latMax);
      return dentro && areaKm2(anel, latRef) >= AREA_MINIMA_KM2;
    });
    if (aneis.length) preparados.push({ nome: m.nome, ine: m.codigoine, aneis });
  }

  let lonMin = Infinity, lonMax = -Infinity, latMin = Infinity, latMax = -Infinity;
  for (const p of preparados) {
    for (const anel of p.aneis) {
      for (const [lon, lat] of anel) {
        if (lon < lonMin) lonMin = lon;
        if (lon > lonMax) lonMax = lon;
        if (lat < latMin) latMin = lat;
        if (lat > latMax) latMax = lat;
      }
    }
  }

  const util = LARGURA_ILHAS - FOLGA * 2;
  const k = util / ((lonMax - lonMin) * cos);
  const altura = (latMax - latMin) * k + FOLGA * 2;
  const proj = { lon0: lonMin, latRef, latTopo: latMax, k, dx: FOLGA, dy: FOLGA };
  const px = (lon, lat) => [
    (lon - proj.lon0) * cos * k + proj.dx,
    (proj.latTopo - lat) * k + proj.dy,
  ];

  /* A tolerância vai em unidades de ECRÃ e não em graus: é o que faz a
     simplificação custar o mesmo a olho em folhas com escalas diferentes. */
  const concelhos = preparados.map((p) => ({
    nome: p.nome,
    ine: p.ine,
    d: caminho(p.aneis.map((anel) => simplificarAnel(anel.map(([lo, la]) => px(lo, la)), 0.35))),
  }));

  return {
    nome,
    viewBox: [0, 0, LARGURA_ILHAS, Math.round(altura * 10) / 10],
    proj,
    janela: { ...corte },
    concelhos,
  };
}

/* --- a correr ------------------------------------------------------------- */

if (!existsSync(GEOAPI)) {
  console.error(`Falta a pasta ${GEOAPI} com os municípios das ilhas.`);
  console.error('Ver _dev/geoapi/LEIA-ME.md.');
  process.exit(1);
}

const ilhas = readdirSync(GEOAPI)
  .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
  .map((f) => JSON.parse(readFileSync(join(GEOAPI, f), 'utf8')))
  .filter((m) => m.geojson);

if (ilhas.length !== 30) {
  console.error(`Esperava 30 municípios de ilha e encontrei ${ilhas.length}.`);
  process.exit(1);
}

const porArquipelago = { Madeira: [], Açores: [] };
for (const m of ilhas) porArquipelago[ARQUIPELAGO(m.distrito_ilha)].push(m);

const folhas = [
  folhaDoContinente(),
  folhaDeIlhas('Açores', porArquipelago['Açores']),
  folhaDeIlhas('Madeira', porArquipelago.Madeira),
];

/* --- guardas -------------------------------------------------------------
   Um mapa errado não se vê a olho — vê-se um país com uma forma estranha e
   pensa-se que é assim mesmo. Estas afirmações são o que impede isso. */

const total = folhas.reduce((n, f) => n + f.concelhos.length, 0);
if (total !== 308) {
  console.error(`GUARDA: ${total} concelhos, e Portugal tem 308.`);
  for (const f of folhas) console.error(`  ${f.nome}: ${f.concelhos.length}`);
  process.exit(1);
}

for (const f of folhas) {
  const [, , largura, altura] = f.viewBox;
  for (const c of f.concelhos) {
    /* UM `d` COM QUATRO VÉRTICES, no mínimo, e não um comprimento em
       caracteres. Um `M120.5 340.2l0.1 0Z` tem vinte caracteres e não desenha
       nada — e era exactamente o que saía de um anel colapsado. Conta-se o que
       interessa: quantos pontos é que aquilo tem. */
    const vertices = (c.d.match(/[MlL]/g) || []).length;
    const aneis = (c.d.match(/M/g) || []).length;
    if (!c.d || vertices < aneis * 4) {
      console.error(`GUARDA: ${c.nome} (${f.nome}) ficou sem desenho `
        + `(${aneis} anéis, ${vertices} vértices).`);
      process.exit(1);
    }
    /* E o desenho tem de CABER na folha. Um caminho que sai do `viewBox` não
       dá erro nenhum: dá um concelho invisível, e ninguém procura o que não
       sabe que falta.

       LÊ-SE COMANDO A COMANDO, e não como uma fila de números. Um concelho com
       ilhas — Montijo, Lisboa, Peniche — tem VÁRIOS `M` no mesmo `d`, um por
       anel, e cada `M` é ABSOLUTO. Somados como se fossem deslocamentos, o
       Montijo dava 1337 numa folha de 1000 e esta guarda reprovava um mapa que
       estava certo. Uma guarda que acusa o inocente gasta-se depressa. */
    let x = 0, y = 0, minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const [, cmd, a1, a2] of c.d.matchAll(/([MlL])\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g)) {
      const [n1, n2] = [Number(a1), Number(a2)];
      if (cmd === 'M' || cmd === 'L') { x = n1; y = n2; } else { x += n1; y += n2; }
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    if (minX < -1 || minY < -1 || maxX > largura + 1 || maxY > altura + 1) {
      console.error(`GUARDA: ${c.nome} (${f.nome}) sai da folha: `
        + `x[${minX.toFixed(0)},${maxX.toFixed(0)}] y[${minY.toFixed(0)},${maxY.toFixed(0)}] `
        + `numa folha de ${largura}x${altura}.`);
      process.exit(1);
    }
  }

  /* A PROJECÇÃO TEM DE CAIR EM CIMA DOS DESENHOS, e não apenas dentro da
     folha.

     A primeira versão desta guarda projectava o centro da janela geográfica e
     exigia que caísse dentro do `viewBox`. Parecia razoável e não provava
     nada: no continente esse ponto cai a 240 unidades de cada margem, por isso
     havia 240 unidades de folga. Deslocar o `dx` em 200 unidades — 111 km, com
     Lisboa a aparecer ao pé de Évora — passava. Trocar o `latTopo` passava.
     Trocar o `lon0` passava. Uma guarda que só apanha o disparate total não
     apanha nada do que costuma acontecer a sério.

     Agora projectam-se sítios CONHECIDOS e exige-se, por ponto-em-polígono
     sobre o `d` que acabou de ser gerado, que cada um caia dentro do seu
     próprio concelho. É a mesma pergunta que a app faz ao desenhar um
     alfinete, feita no sítio onde ainda dá para a corrigir. */
  const provas = PROVAS.filter((c) =>
    c.lat >= f.janela.latMin && c.lat <= f.janela.latMax
    && c.lon >= f.janela.lonMin && c.lon <= f.janela.lonMax);
  if (provas.length < 2) {
    console.error(`GUARDA: só há ${provas.length} sítios de prova em ${f.nome} — `
      + 'a guarda da projecção não está a provar nada.');
    process.exit(1);
  }
  const cos = Math.cos((f.proj.latRef * Math.PI) / 180);
  for (const prova of provas) {
    const px = (prova.lon - f.proj.lon0) * cos * f.proj.k + f.proj.dx;
    const py = (f.proj.latTopo - prova.lat) * f.proj.k + f.proj.dy;
    const concelho = f.concelhos.find((c) => c.nome === prova.concelho);
    if (!concelho) {
      console.error(`GUARDA: ${prova.concelho} não está na folha ${f.nome}.`);
      process.exit(1);
    }
    if (!dentroDoCaminho([px, py], concelho.d)) {
      console.error(`GUARDA: ${prova.nome} projecta em ${px.toFixed(1)},${py.toFixed(1)} `
        + `e isso NÃO cai dentro de ${prova.concelho} — a projecção da folha `
        + `${f.nome} não concorda com os desenhos.`);
      process.exit(1);
    }
  }
}

const saida = {
  gerado: new Date().toISOString().slice(0, 10),
  fonte: 'Carta Administrativa Oficial de Portugal, via json.geoapi.pt',
  /* A folha por omissão é a primeira. O componente troca-a se os negócios
     estiverem noutra. */
  folhas,
};

mkdirSync(DESTINO, { recursive: true });
const ficheiro = join(DESTINO, 'portugal.json');
writeFileSync(ficheiro, JSON.stringify(saida));

const bytes = readFileSync(ficheiro).length;
console.log(`portugal.json: ${(bytes / 1024).toFixed(1)} KB, ${total} concelhos`);
for (const f of folhas) {
  console.log(`  ${f.nome.padEnd(11)} ${String(f.concelhos.length).padStart(3)} concelhos  `
    + `folha ${f.viewBox[2]}x${f.viewBox[3]}  ${(f.proj.k / 111.32).toFixed(2)} un/km`);
}
