/* =========================================================================
   Carimbo Digital — o mapa

   Desenha Portugal a partir de `dados/portugal.json` — as fronteiras dos 308
   concelhos, já projectadas — e põe os estabelecimentos em cima. NÃO VAI
   BUSCAR NADA A LADO NENHUM: não há mosaicos, não há servidor de mapas, não há
   chave de API. É isso que deixa a página de privacidade continuar a dizer, à
   letra, que «não carrega tipos de letra, mapas ou scripts de terceiros» — e é
   isso que faz o mapa abrir sem rede, porque os dados estão no casco do
   service worker como qualquer outro ficheiro do site.

   O QUE ESTE MAPA NÃO TEM, e é melhor dizê-lo do que deixar descobrir: não tem
   ruas. Mostra a forma do concelho e onde o estabelecimento cai lá dentro.
   Responde a «isto é perto de mim?»; não responde a «é naquela esquina?». Para
   essa, cada negócio tem um «Como chegar» que abre o mapa do próprio telemóvel.

   TRÊS DECISÕES QUE VALEM A PENA EXPLICAR

   · OS ALFINETES SÃO `<button>` DE HTML, numa camada por cima do SVG, e não
     formas dentro dele. Um `<circle>` não é tabulável, não tem estado de foco
     e não se anuncia a um leitor de ecrã sem três atributos escritos à mão —
     e a experiência desta casa com o `aria-modal` é que promessas assim não
     se cumprem sozinhas. Como `<button>`, tudo isso vem de graça, e o tamanho
     do alfinete deixa de encolher quando se afasta o mapa.

   · O ARRASTAR E O AMPLIAR MEXEM NO `viewBox`, não num `transform`. É uma
     conta só, é o que mantém os traços das fronteiras com a mesma espessura
     (`vector-effect`), e é o que permite converter um ponto do mapa para
     píxeis do ecrã com uma regra de três — que é o que os alfinetes precisam
     a cada fotograma.

   · PONTEIROS, e não `mouse` mais `touch`. Um caminho só para o rato, o dedo e
     a caneta. O `touch-action: none` no elemento é o que impede a página de
     rolar por baixo do dedo de quem arrasta o mapa — sem ele, dentro de uma
     PWA instalada num iPhone, arrastar o mapa arrasta a app.
   ========================================================================= */

import { el } from './nucleo.js';

/* Até onde se pode aproximar. Os contornos foram simplificados para se verem
   à escala do país: a partir daqui deixam de ser a costa e passam a ser a
   linha quebrada com que a desenhámos. Neste tecto, um telemóvel mostra uns
   seis quilómetros de ponta a ponta — a vila, não a rua. Deixar ampliar mais
   seria prometer uma precisão que o desenho não tem. */
/* Quantos quilómetros, no mínimo, o mapa mostra de ponta a ponta. Abaixo
   disto os contornos deixam de ser a costa e passam a ser a linha quebrada com
   que a desenhámos.

   EM QUILÓMETROS E NÃO NUMA DIVISÃO DA FOLHA. Dividir a largura da folha por um
   número fixo parece a mesma coisa e não é: as três folhas têm escalas
   diferentes — 1,73 unidades por km no continente, 1,08 nos Açores e 6,43 na
   Madeira —, e o mesmo divisor dava um tecto de 6 km no continente, 12 nos
   Açores e 2 na Madeira. Um açoriano nunca chegava a ver a rua; um madeirense
   aproximava até ver o desenho a desfazer-se. */
const KM_MINIMOS = 6;

/* O que sobra quando a folha não diz a sua escala — ficheiros gerados antes
   desta linha existir. */
const AMPLIACAO_MAXIMA = 48;

/* Quanto respiro fica à volta dos alfinetes quando o mapa se enquadra neles.
   Sem isto, um negócio sozinho fica colado a um canto. */
const RESPIRO = 0.35;

let dadosEmCache = null;

/**
 * Lê `dados/portugal.json` uma vez por sessão.
 *
 * O `base` vem de quem chama porque o site vive na raiz com domínio próprio e
 * em `/CarimboDigital/` sem ele — e um caminho escrito à mão aqui era o mesmo
 * defeito que já fez treze capturas darem 404.
 */
export async function carregarPortugal(base = '') {
  if (dadosEmCache) return dadosEmCache;
  /* A VERSÃO TEM DE IR NO PEDIDO. O service worker guarda este ficheiro com
     `?v=` no endereço — é a regra da casa para o que é imutável: cache
     primeiro, sem ir à rede confirmar. Pedido sem a versão, a chave não bate
     certo, o mapa vai à rede a cada abertura e deixa de funcionar sem ela.
     A versão sai do endereço deste próprio módulo, que já a traz. */
  const versao = new URL(import.meta.url).searchParams.get('v');
  const endereco = `${base}/dados/portugal.json${versao ? `?v=${versao}` : ''}`;
  const r = await fetch(endereco);
  if (!r.ok) throw new Error('Não deu para carregar o mapa.');
  dadosEmCache = await r.json();
  return dadosEmCache;
}

/** Em que folha cai um ponto — ou `null`, se cair fora de Portugal. */
export function folhaDe(dados, lat, lon) {
  return dados.folhas.find((f) =>
    lat >= f.janela.latMin && lat <= f.janela.latMax
    && lon >= f.janela.lonMin && lon <= f.janela.lonMax) || null;
}

/**
 * O ponto cai em terra portuguesa?
 *
 * A JANELA DE UMA FOLHA É UM RECTÂNGULO, e Portugal não é. A janela do
 * continente inclui uma faixa de Espanha a leste e uma boa parte do Atlântico
 * a oeste: um alfinete em Badajoz ou a cem quilómetros da costa passava a
 * conferência e ficava gravado. Aqui pergunta-se às FORMAS que já estão
 * desenhadas — as mesmas que a pessoa está a ver — e a resposta é a que ela
 * espera: está ou não está em cima do país.
 *
 * O servidor continua a ter a sua caixa, e é bom que tenha: ele não conhece
 * estes desenhos, e uma caixa é a defesa certa contra o disparate. Esta é a
 * defesa contra o engano — que é outra coisa, e acontece muito mais.
 */
export function emPortugal(dados, lat, lon) {
  const folha = folhaDe(dados, lat, lon);
  if (!folha) return false;
  const { x, y } = projectar(folha, lat, lon);
  return folha.concelhos.some((c) => dentroDoCaminho([x, y], c.d));
}

/**
 * Quantos quilómetros há entre dois pontos, pela fórmula do semiverseno.
 *
 * É a distância EM LINHA RECTA, e é preciso dizê-lo onde ela aparece: a pé ou
 * de carro é sempre mais, e num sítio com um rio ou uma auto-estrada pelo meio
 * pode ser muito mais. Serve para ordenar uma lista — «este é mais perto do
 * que aquele» — e não para dizer a alguém quanto tempo demora.
 */
export function distanciaKm(a, b) {
  const R = 6371;
  const rad = (g) => (g * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s = Math.sin(dLat / 2) ** 2
    + Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.min(1, Math.sqrt(s)));
}

/** Uma distância como uma pessoa a diz. */
export function distanciaEmPalavras(km) {
  if (km < 1) return `${Math.round(km * 1000 / 50) * 50} m`;
  if (km < 10) return `${km.toFixed(1).replace('.', ',')} km`;
  return `${Math.round(km)} km`;
}

/** Ponto dentro de um `<path>`, lido comando a comando. */
function dentroDoCaminho(ponto, d) {
  const aneis = [];
  let anel = null, ax = 0, ay = 0;
  for (const [, cmd, a1, a2] of d.matchAll(/([MlL])\s*(-?[\d.]+)[ ,]+(-?[\d.]+)/g)) {
    const [n1, n2] = [Number(a1), Number(a2)];
    if (cmd === 'M') { if (anel) aneis.push(anel); ax = n1; ay = n2; anel = [[ax, ay]]; }
    else { if (cmd === 'L') { ax = n1; ay = n2; } else { ax += n1; ay += n2; } anel.push([ax, ay]); }
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

/** Graus para unidades da folha. É a projecção do gerador, ao contrário. */
export function projectar(folha, lat, lon) {
  const { lon0, latRef, latTopo, k, dx, dy } = folha.proj;
  const cos = Math.cos((latRef * Math.PI) / 180);
  return { x: (lon - lon0) * cos * k + dx, y: (latTopo - lat) * k + dy };
}

/** E de volta: unidades da folha para graus. É o que o balcão usa para saber
    que ponto é que o dono escolheu quando arrastou o mapa. */
export function desprojectar(folha, x, y) {
  const { lon0, latRef, latTopo, k, dx, dy } = folha.proj;
  const cos = Math.cos((latRef * Math.PI) / 180);
  return { lat: latTopo - (y - dy) / k, lon: lon0 + (x - dx) / (cos * k) };
}

/* =========================================================================
   O mapa
   ========================================================================= */

/**
 * @param {object} opcoes
 * @param {object} opcoes.dados      o `portugal.json` já lido
 * @param {Array}  opcoes.pontos     [{ id, nome, lat, lon, fonte, cor }]
 * @param {Function} opcoes.aoEscolher  chamada com o ponto quando se toca nele
 * @param {string} opcoes.rotulo     o que um leitor de ecrã ouve ao chegar
 */
export function criarMapa({ dados, pontos = [], aoEscolher = () => {},
                            rotulo = 'Mapa', atribuicao = true,
                            folhasSempre = false }) {
  /* --- que folha mostrar ------------------------------------------------
     A que tem mais estabelecimentos. Quem está nos Açores não quer abrir o
     mapa no continente para depois ter de o procurar. */
  const porFolha = new Map();
  for (const p of pontos) {
    const f = folhaDe(dados, p.lat, p.lon);
    if (!f) continue;                       /* fora de Portugal: fica na lista */
    if (!porFolha.has(f.nome)) porFolha.set(f.nome, []);
    porFolha.get(f.nome).push(p);
  }
  const folhasComPontos = dados.folhas.filter((f) => porFolha.has(f.nome));
  let folha = folhasComPontos.length
    ? folhasComPontos.reduce((a, b) =>
      (porFolha.get(b.nome).length > porFolha.get(a.nome).length ? b : a))
    : dados.folhas[0];

  /* --- os elementos ------------------------------------------------------ */
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
  svg.setAttribute('class', 'mapa-desenho');
  /* O desenho não se anuncia: quem fala por ele são os botões dos alfinetes,
     que dizem o nome de cada sítio. Um leitor de ecrã a ler «imagem» por cima
     de uma lista de botões só atrapalha. */
  svg.setAttribute('aria-hidden', 'true');
  svg.setAttribute('focusable', 'false');

  const camadaPinos = el('div', { class: 'mapa-pinos' });
  /* COMO É QUE ISTO SE CONDUZ, dito a quem não vê. Um `role="group"` tabulável
     anuncia-se como «grupo» e mais nada: quem lá chega com o teclado não tem
     como saber que as setas arrastam e o zero reenquadra. A mesma linha fica
     visível por baixo do mapa, porque quem vê também não adivinha. */
  const ajuda = el('p', { class: 'mapa-ajuda', id: `mapa-ajuda-${Math.random().toString(36).slice(2, 8)}`,
    texto: 'As setas arrastam o mapa, o mais e o menos aproximam, e o zero '
      + 'volta ao princípio.' });
  const caixa = el('div', {
    class: 'mapa', role: 'group', 'aria-label': rotulo, tabindex: '0',
    'aria-describedby': ajuda.id,
  });
  caixa.append(svg, camadaPinos);

  /* --- a vista -----------------------------------------------------------
     A MEDIDA É A DO `<svg>`, e não a da caixa. A caixa tem um bordo de 1 px e o
     `box-sizing: border-box` desta casa: o desenho fica 2 px mais estreito e
     2 px mais baixo do que ela. Medindo pela caixa, a escala dos alfinetes
     ficava 0,56% maior do que a do desenho — e um alfinete a 1,7 px do sítio
     é um alfinete do outro lado da rua. */
  const medidaDoDesenho = () => svg.getBoundingClientRect();

  let vista = { x: 0, y: 0, largura: 1, altura: 1 };
  const larguraDaFolha = () => folha.viewBox[2];
  const alturaDaFolha = () => folha.viewBox[3];
  /* A vista mais estreita que esta folha aceita, em unidades dela. */
  const vistaMinima = () => (folha.proj && folha.proj.k
    ? (folha.proj.k / 111.32) * KM_MINIMOS
    : larguraDaFolha() / AMPLIACAO_MAXIMA);

  function aplicar() {
    svg.setAttribute('viewBox',
      `${vista.x} ${vista.y} ${vista.largura} ${vista.altura}`);
    colocarPinos();
  }

  /** Enquadra um rectângulo em unidades da folha, respeitando a proporção. */
  function enquadrar(x, y, largura, altura) {
    const proporcao = proporcaoDaCaixa();
    let l = largura, a = altura;
    if (l / a > proporcao) a = l / proporcao; else l = a * proporcao;
    /* O tecto de ampliação em unidades: não se deixa a janela ficar mais
       pequena do que isto, senão o mapa promete uma precisão que não tem. */
    const minimo = vistaMinima();
    if (l < minimo) { a = (minimo / l) * a; l = minimo; }
    vista = { x: x - (l - largura) / 2, y: y - (a - altura) / 2, largura: l, altura: a };
    primeira = false;
    travar();
    aplicar();
  }

  /* Fica ligado até alguém enquadrar o mapa — seja o observador do tamanho,
     seja quem o criou. Ver o comentário do `ResizeObserver`, mais abaixo. */
  let primeira = true;

  /** A proporção da caixa, com defesa para quando ela ainda não tem tamanho. */
  function proporcaoDaCaixa() {
    const r = medidaDoDesenho();
    return (r.width && r.height) ? r.width / r.height : 1;
  }

  /** Não se deixa fugir o mapa para fora do ecrã. */
  function travar() {
    const L = larguraDaFolha(), A = alturaDaFolha();
    /* O TECTO MEDE-SE SOBRE A FOLHA JÁ ENQUADRADA, e não sobre a folha crua.

       Media-se `L * 1.4` e `A * 1.4` em cada eixo, e isso parecia generoso.
       Não era: o continente tem proporção 0,49 e o ecrã de um telemóvel 0,75,
       por isso para o país caber de alto a baixo a vista tem de ser MAIS LARGA
       do que a folha — 750 unidades para uma folha de 493,8. O tecto de 691
       cortava-a, e a conta seguinte empurrava a vista para dentro.

       O que se via: o «Descobrir» a abrir com um estabelecimento de fora do
       enquadramento. Com quatro negócios de Viana a Faro, o alfinete de Faro
       nascia escondido — e não havia gesto nenhum que o trouxesse de volta,
       porque a tecla `0` chama o mesmo enquadramento e volta a bater no mesmo
       tecto. Um mapa que esconde um dos sítios que existe para mostrar. */
    const proporcao = proporcaoDaCaixa();
    let folhaL = L, folhaA = A;
    if (L / A > proporcao) folhaA = L / proporcao; else folhaL = A * proporcao;
    const maxL = folhaL * 1.4;
    if (vista.largura > maxL) {
      const f = maxL / vista.largura;
      vista.largura *= f; vista.altura *= f;
    }
    const folgaX = Math.max(0, (vista.largura - L) / 2) + L * 0.15;
    const folgaY = Math.max(0, (vista.altura - A) / 2) + A * 0.15;
    vista.x = Math.min(Math.max(vista.x, -folgaX), L + folgaX - vista.largura);
    vista.y = Math.min(Math.max(vista.y, -folgaY), A + folgaY - vista.altura);
  }

  /* --- desenhar a folha -------------------------------------------------- */
  function desenharFolha() {
    svg.innerHTML = '';
    const g = document.createElementNS('http://www.w3.org/2000/svg', 'g');
    for (const c of folha.concelhos) {
      const p = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      p.setAttribute('d', c.d);
      /* `non-scaling-stroke`: a fronteira tem a mesma espessura ampliada ou
         afastada. Sem isto, ao aproximar o país fica com contornos de um
         dedo de largura, e ao afastar desaparecem. */
      p.setAttribute('vector-effect', 'non-scaling-stroke');
      g.append(p);
    }
    svg.append(g);
  }

  /* --- onde está quem está a ver -----------------------------------------
     Um ponto de outra natureza: não é um sítio que se possa visitar, é a
     pessoa. Por isso não é `<button>` — não há nada para lhe fazer — e não
     entra na ordem de tabulação. */
  let euAqui = null;
  const marcaEu = el('div', { class: 'mapa-eu', hidden: true, 'aria-hidden': 'true' });
  camadaPinos.append(marcaEu);

  /* --- os alfinetes ------------------------------------------------------ */
  const botoes = [];
  function construirPinos() {
    camadaPinos.innerHTML = '';
    camadaPinos.append(marcaEu);
    botoes.length = 0;
    for (const p of (porFolha.get(folha.nome) || [])) {
      const aproximado = p.fonte === 'concelho';
      const botao = el('button', {
        class: `mapa-pino${aproximado ? ' mapa-pino-aproximado' : ''}`,
        type: 'button',
        /* O nome é o que um leitor de ecrã diz, e é por isso que ele traz o
           aviso quando o ponto é do concelho inteiro: «aproximado» dito em voz
           alta vale mais do que um alfinete com outra forma, que ninguém vê. */
        'aria-label': aproximado
          ? `${p.nome} — localização aproximada, ao nível do concelho`
          : p.nome,
        title: p.nome,
        /* Se o dedo arrastou, isto foi um gesto de mapa e não um toque num
           sítio. Abrir o estabelecimento aqui seria abrir-lhe a ficha porque
           ele estava no caminho. */
        aoClick: () => { if (!arrastou) aoEscolher(p); },
      }, el('span', { class: 'mapa-pino-ponto' }));
      if (p.cor) botao.style.setProperty('--pino', p.cor);
      camadaPinos.append(botao);
      botoes.push({ p, botao });
    }
  }

  function colocarPinos() {
    const r = medidaDoDesenho();
    if (!r.width) return;
    const escalaX = r.width / vista.largura;
    const escalaY = r.height / vista.altura;
    for (const { p, botao } of botoes) {
      const { x, y } = projectar(folha, p.lat, p.lon);
      const px = (x - vista.x) * escalaX;
      const py = (y - vista.y) * escalaY;
      /* Fora do enquadramento não se desenha — e sobretudo não se deixa
         tabulável: senão o Tab leva o foco a um botão que ninguém vê. */
      const foraDoEcra = px < -40 || py < -40 || px > r.width + 40 || py > r.height + 40;
      /* ESCONDER O QUE TEM O FOCO É PERDER O FOCO. Quem está a arrastar o mapa
         pelas setas empurra o alfinete focado para fora, ele fica `hidden`, e o
         foco volta para o `body`: a partir daí as setas deixam de fazer nada e
         o teclado perde o mapa. Devolve-se o foco à caixa, que é quem responde
         às setas. */
      if (foraDoEcra && !botao.hidden && botao.contains(document.activeElement)) {
        caixa.focus({ preventScroll: true });
      }
      botao.hidden = foraDoEcra;
      botao.style.left = `${px}px`;
      botao.style.top = `${py}px`;
    }

    /* E a pessoa, se ela quiser aparecer. */
    if (euAqui && folhaDe(dados, euAqui.lat, euAqui.lon)?.nome === folha.nome) {
      const { x, y } = projectar(folha, euAqui.lat, euAqui.lon);
      const px = (x - vista.x) * escalaX;
      const py = (y - vista.y) * escalaY;
      marcaEu.hidden = px < -20 || py < -20 || px > r.width + 20 || py > r.height + 20;
      marcaEu.style.left = `${px}px`;
      marcaEu.style.top = `${py}px`;
    } else {
      marcaEu.hidden = true;
    }
  }

  /* --- arrastar e ampliar ------------------------------------------------ */
  const dedos = new Map();
  let pinca = null;
  let arrastou = false;

  caixa.addEventListener('pointerdown', (ev) => {
    /* UM DESLIZE QUE COMEÇA NUM ALFINETE TAMBÉM ARRASTA O MAPA. Os alfinetes
       têm 44 px de alvo e ficam por cima das cidades, que é exactamente onde o
       dedo pousa para arrastar; ignorá-los aqui fazia com que um em cada
       poucos gestos não fizesse nada. Regista-se o ponteiro na mesma, e é o
       clique do botão que decide: se o dedo se mexeu, foi um arrasto e o
       estabelecimento não se abre. */
    caixa.setPointerCapture(ev.pointerId);
    dedos.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    arrastou = false;
    if (dedos.size === 2) {
      const [a, b] = [...dedos.values()];
      pinca = { distancia: Math.hypot(a.x - b.x, a.y - b.y), vista: { ...vista } };
    }
  });

  caixa.addEventListener('pointermove', (ev) => {
    const antes = dedos.get(ev.pointerId);
    if (!antes) return;
    const r = medidaDoDesenho();

    if (dedos.size === 2 && pinca) {
      dedos.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
      const [a, b] = [...dedos.values()];
      const agora = Math.hypot(a.x - b.x, a.y - b.y);
      if (!agora || !pinca.distancia) return;
      const meio = { x: (a.x + b.x) / 2 - r.left, y: (a.y + b.y) / 2 - r.top };
      ampliarEm(meio, pinca.distancia / agora, pinca.vista);
      arrastou = true;
      return;
    }

    const dx = (ev.clientX - antes.x) * (vista.largura / r.width);
    const dy = (ev.clientY - antes.y) * (vista.altura / r.height);
    if (Math.abs(ev.clientX - antes.x) + Math.abs(ev.clientY - antes.y) > 3) arrastou = true;
    dedos.set(ev.pointerId, { x: ev.clientX, y: ev.clientY });
    vista.x -= dx; vista.y -= dy;
    travar();
    aplicar();
  });

  const largar = (ev) => {
    dedos.delete(ev.pointerId);
    if (dedos.size < 2) pinca = null;
    /* O `arrastou` vive até ao `click`, que chega logo a seguir a isto — e
       morre no fim desta volta do ciclo de eventos. Deixá-lo ligado era pior
       do que o problema que resolve: quem arrastasse o mapa e depois chegasse
       a um alfinete PELO TECLADO carregava no Enter e não acontecia nada. */
    if (arrastou) setTimeout(() => { arrastou = false; }, 0);
  };
  caixa.addEventListener('pointerup', largar);
  caixa.addEventListener('pointercancel', largar);

  /**
   * Amplia à volta de um ponto do ECRÃ, e não do centro.
   *
   * É o que faz o mapa obedecer: quem põe o dedo em cima da sua vila e
   * aproxima espera que a vila fique onde está. A partir do centro, ela foge.
   */
  function ampliarEm(ponto, factor, base = vista) {
    const r = medidaDoDesenho();
    const alvoX = base.x + (ponto.x / r.width) * base.largura;
    const alvoY = base.y + (ponto.y / r.height) * base.altura;
    let largura = base.largura * factor;
    largura = Math.max(vistaMinima(), largura);
    const altura = largura * (base.altura / base.largura);
    vista = {
      largura, altura,
      x: alvoX - (ponto.x / r.width) * largura,
      y: alvoY - (ponto.y / r.height) * altura,
    };
    travar();
    aplicar();
  }

  /* A RODA SIMPLES NÃO É NOSSA. Um mapa no meio de uma página que come a roda
     é uma armadilha: quem está a descer a lista pára em cima dele e a página
     deixa de responder. A ampliação pede um gesto que só pode querer dizer
     isso — `ctrl`/`⌘` mais roda, que é também o que uma pinça de trackpad
     envia. É a regra de qualquer mapa embebido, e pela mesma razão. */
  caixa.addEventListener('wheel', (ev) => {
    if (!ev.ctrlKey && !ev.metaKey) return;      /* deixa a página rolar */
    ev.preventDefault();
    const r = medidaDoDesenho();
    ampliarEm({ x: ev.clientX - r.left, y: ev.clientY - r.top },
      Math.exp(ev.deltaY * 0.0016));
  }, { passive: false });

  /* --- teclado -----------------------------------------------------------
     Um mapa que só obedece ao dedo é um mapa que não existe para quem navega
     por teclado. As setas arrastam, o mais e o menos ampliam, e o zero volta
     ao princípio. */
  caixa.addEventListener('keydown', (ev) => {
    const passo = 0.18;
    const teclas = {
      ArrowLeft: () => { vista.x -= vista.largura * passo; },
      ArrowRight: () => { vista.x += vista.largura * passo; },
      ArrowUp: () => { vista.y -= vista.altura * passo; },
      ArrowDown: () => { vista.y += vista.altura * passo; },
    };
    const r = medidaDoDesenho();
    const meio = { x: r.width / 2, y: r.height / 2 };
    if (teclas[ev.key]) { teclas[ev.key](); travar(); aplicar(); }
    else if (ev.key === '+' || ev.key === '=') ampliarEm(meio, 1 / 1.4);
    else if (ev.key === '-' || ev.key === '_') ampliarEm(meio, 1.4);
    else if (ev.key === '0') { enquadrarNosPontos(); return; }
    else return;
    ev.preventDefault();
  });

  /* --- enquadrar --------------------------------------------------------- */
  function enquadrarNosPontos() {
    const meus = porFolha.get(folha.nome) || [];
    if (!meus.length) {
      enquadrar(0, 0, larguraDaFolha(), alturaDaFolha());
      return;
    }
    let minX = Infinity, maxX = -Infinity, minY = Infinity, maxY = -Infinity;
    for (const p of meus) {
      const { x, y } = projectar(folha, p.lat, p.lon);
      if (x < minX) minX = x; if (x > maxX) maxX = x;
      if (y < minY) minY = y; if (y > maxY) maxY = y;
    }
    /* UM SÓ ESTABELECIMENTO NÃO TEM LARGURA, e um rectângulo de largura zero
       amplia até ao infinito — ou até ao tecto, que é onde o mapa deixa de
       dizer alguma coisa. Dá-se-lhe uma vizinhança de doze quilómetros, que é
       o que faz sentido ver à volta de um café — e em QUILÓMETROS, pela mesma
       razão que o tecto: vinte unidades valiam 11 km no continente, 19 nos
       Açores e 3 na Madeira. */
    const minimo = (folha.proj && folha.proj.k)
      ? (folha.proj.k / 111.32) * 12 : 20;
    let largura = Math.max(maxX - minX, minimo);
    let altura = Math.max(maxY - minY, minimo);
    largura += largura * RESPIRO;
    altura += altura * RESPIRO;
    enquadrar((minX + maxX) / 2 - largura / 2, (minY + maxY) / 2 - altura / 2,
      largura, altura);
  }

  /* --- trocar de folha --------------------------------------------------- */
  const barra = el('div', { class: 'mapa-folhas' });
  function construirBarra() {
    barra.innerHTML = '';
    /* A barra só existe quando há mesmo escolha. Com tudo no continente, três
       botões dos quais dois abrem mapas vazios são três botões a mais.

       MENOS NO SELECTOR DE PONTO DO BALCÃO (`folhasSempre`), e a razão é que
       ali NÃO HÁ pontos por definição — é o ecrã onde se marca o primeiro. Sem
       barra, o mapa abria no continente e não havia gesto que lá chegasse: com
       o tecto de ampliação, arrastar dos Açores ao continente é impossível.
       Um café do Funchal ficava sem forma de se pôr no mapa, num painel que
       lhe diz por escrito «podes marcar o ponto à mão». */
    const oferecidas = folhasSempre ? dados.folhas : folhasComPontos;
    if (oferecidas.length < 2) { barra.hidden = true; return; }
    barra.hidden = false;
    for (const f of oferecidas) {
      barra.append(el('button', {
        class: 'mapa-folha-botao', type: 'button',
        'aria-pressed': f.nome === folha.nome ? 'true' : 'false',
        texto: f.nome,
        aoClick: () => { if (f.nome !== folha.nome) irPara(f); },
      }));
    }
  }

  function irPara(nova) {
    folha = nova;
    desenharFolha();
    construirPinos();
    construirBarra();
    enquadrarNosPontos();
  }

  /* --- montar ------------------------------------------------------------ */
  /* A ATRIBUIÇÃO É DE QUEM MOSTRA O MAPA, e não de quem o usa para marcar um
     ponto. No ecrã do balcão, onde o mapa é uma ferramenta de três segundos, a
     linha da Carta Administrativa fica entre o mapa e a leitura das
     coordenadas — a dizer uma coisa verdadeira no sítio errado. */
  const raiz = el('div', { class: 'mapa-caixa' }, caixa, ajuda, barra,
    atribuicao
      ? el('p', { class: 'mapa-fonte', texto:
        'Fronteiras dos concelhos: Carta Administrativa Oficial de Portugal.' })
      : null);

  desenharFolha();
  construirPinos();
  construirBarra();

  /* O tamanho só se sabe depois de o elemento estar na página. Um
     `ResizeObserver` resolve os dois casos — o primeiro desenho e a rotação do
     telemóvel — sem um `setTimeout` a adivinhar. */
  /* A PRIMEIRA MEDIÇÃO NÃO ATROPELA QUEM JÁ ENQUADROU.

     O tamanho só se sabe depois de o elemento estar na página, por isso o
     primeiro enquadramento acontece aqui. Mas quem chama pode ter enquadrado
     entretanto — é o que o balcão faz, a centrar no ponto que o negócio já
     tem — e essa chamada corria ANTES desta, que a deitava fora e devolvia o
     mapa ao centro do país.

     O que se via: abrir «Onde fica» num negócio já marcado e carregar em
     «Guardar este ponto» sem tocar em nada movia o estabelecimento sessenta
     quilómetros. O `enquadrar()` marca-se a si próprio como feito. */
  const observador = new ResizeObserver(() => {
    if (!medidaDoDesenho().width) return;
    if (primeira) { primeira = false; enquadrarNosPontos(); }
    else { travar(); aplicar(); }
  });
  observador.observe(caixa);

  return {
    elemento: raiz,
    enquadrar: enquadrarNosPontos,
    /* Levar o mapa a um estabelecimento: muda de folha se for preciso. */
    mostrar(ponto) {
      const f = folhaDe(dados, ponto.lat, ponto.lon);
      if (!f) return;
      if (f.nome !== folha.nome) irPara(f);
      const { x, y } = projectar(f, ponto.lat, ponto.lon);
      enquadrar(x - 12, y - 12, 24, 24);
    },
    /* Onde está o meio do que se está a ver, em graus. É o que faz o selector
       de ponto do balcão funcionar sem arrastar alfinete nenhum: o alfinete
       fica quieto no centro e move-se o mapa por baixo dele, que é o gesto que
       toda a gente já conhece de qualquer app de mapas. */
    centro() {
      return desprojectar(folha,
        vista.x + vista.largura / 2, vista.y + vista.altura / 2);
    },
    /* Levar o mapa a um ponto, com uma vizinhança em unidades da folha. */
    centrarEm(lat, lon, vizinhanca = 14) {
      const f = folhaDe(dados, lat, lon);
      if (!f) return false;
      if (f.nome !== folha.nome) irPara(f);
      const { x, y } = projectar(f, lat, lon);
      enquadrar(x - vizinhanca, y - vizinhanca, vizinhanca * 2, vizinhanca * 2);
      return true;
    },
    get folha() { return folha.nome; },
    /* Mostrar onde está quem está a ver. A posição fica NESTA variável e mais
       nada: não vai a endereço nenhum, não é guardada, não sai do telemóvel. */
    ondeEstou(lat, lon) {
      euAqui = (typeof lat === 'number' && typeof lon === 'number') ? { lat, lon } : null;
      colocarPinos();
    },
    parar() { observador.disconnect(); },
    /* Para os testes: quantos alfinetes estão mesmo desenhados. */
    get pinos() { return botoes.length; },
  };
}

/**
 * Um endereço que abre o mapa do PRÓPRIO telemóvel, com direções.
 *
 * É a outra metade da promessa. O nosso mapa diz «é neste concelho, aqui»; a
 * pergunta seguinte é «como é que lá chego», e essa responde-se com a app que
 * a pessoa já tem e já sabe usar. O `geo:` é o esquema da norma (RFC 5870) e é
 * o que o Android entende; o iOS abre o `maps.apple.com`. Nenhum dos dois nos
 * contacta a nós nem nós a eles — é um toque da pessoa, na app dela.
 */
export function comoChegar({ lat, lon, nome }) {
  const rotulo = encodeURIComponent(nome || 'Estabelecimento');
  const agente = navigator.userAgent || '';
  const iOS = /iPad|iPhone|iPod/.test(agente)
    || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  if (iOS) return `https://maps.apple.com/?ll=${lat},${lon}&q=${rotulo}`;
  /* O `geo:` é o esquema da norma (RFC 5870) e o Android abre-o. UM COMPUTADOR
     NÃO ABRE NADA COM ELE — fica um link que não faz absolutamente nada, que é
     pior do que não haver link. Fora do telemóvel manda-se para o
     OpenStreetMap, que é uma LIGAÇÃO e não um carregamento: nada é pedido a
     ninguém enquanto a pessoa não lhe tocar. */
  if (/Android/.test(agente)) return `geo:${lat},${lon}?q=${lat},${lon}(${rotulo})`;
  return `https://www.openstreetmap.org/?mlat=${lat}&mlon=${lon}#map=17/${lat}/${lon}`;
}
