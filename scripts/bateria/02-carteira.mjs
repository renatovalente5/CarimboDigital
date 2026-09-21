/* =========================================================================
   Bateria · 02 — a carteira e o cartão do cliente

   O ecrã que a pessoa abre todos os dias. Aqui prova-se o que um cartão de
   papel prova sozinho e um cartão desenhado por JavaScript não: que a grelha
   tem tantas casas quantas o programa pede, que estão carimbadas as certas,
   que a conta do «faltam N» bate, e que o texto se lê por cima da cor que o
   dono do café escolheu.

   As expectativas não são escritas à mão: leem-se da própria demonstração
   (`carimbo-demo:demo` no localStorage) e comparam-se com o que está no ecrã.
   Assim o módulo continua a valer se a semente mudar — e uma semente que
   mude sem o ecrã mudar passa a ser uma falha, que é o que se quer.
   ========================================================================= */

import { abrirNoMaco, abrirOCartaoTodo } from './01-arranque.mjs';

export const nome = '02 · A carteira e o cartão';

/* =========================================================================
   Contraste — medido aqui, de raiz

   Não se importa o `contraste()` da app de propósito: se a fórmula dela
   estiver errada, um teste que a usasse concordaria com o erro. Isto é a
   WCAG 2 escrita outra vez, do zero.
   ========================================================================= */

function corParaRGB(css) {
  const t = String(css).trim();
  if (t.startsWith('#')) {
    let h = t.slice(1);
    if (h.length === 3) h = h.split('').map((c) => c + c).join('');
    if (!/^[0-9a-fA-F]{6}$/.test(h)) return null;
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16),
             b: parseInt(h.slice(4, 6), 16), a: 1 };
  }
  const n = t.match(/[\d.]+/g);
  if (!n || n.length < 3) return null;
  return { r: +n[0], g: +n[1], b: +n[2], a: n.length > 3 ? +n[3] : 1 };
}

function misturar(frente, atras, alfa) {
  return {
    r: frente.r * alfa + atras.r * (1 - alfa),
    g: frente.g * alfa + atras.g * (1 - alfa),
    b: frente.b * alfa + atras.b * (1 - alfa),
  };
}

function luz({ r, g, b }) {
  const canal = (v) => {
    const s = v / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * canal(r) + 0.7152 * canal(g) + 0.0722 * canal(b);
}

function razao(a, b) {
  const la = luz(a), lb = luz(b);
  return (Math.max(la, lb) + 0.05) / (Math.min(la, lb) + 0.05);
}

/** O mínimo da WCAG AA: 3 para texto grande, 4,5 para o resto. */
function minimoPara(px, peso) {
  const grande = px >= 24 || (px >= 18.66 && peso >= 700);
  return grande ? 3 : 4.5;
}

/* =========================================================================
   Ajudas
   ========================================================================= */

/** Passa as boas-vindas se estiverem lá. Devolve quantos passos deu. */
async function passarBoasVindas(palco) {
  if (!(await palco.ver('#boas-vindas'))) return 0;
  for (let i = 0; i < 8; i++) {
    if (!(await palco.visivel('#boas-vindas'))) return i;
    await palco.clicar('#bv-seguinte');
  }
  return 8;
}

/**
 * Começa do zero: sem localStorage e sem cofre.
 *
 * Os módulos partilham o browser e, com ele, o armazenamento da origem — um
 * módulo anterior deixa lá conta e cartões. Sem isto a carteira que se testa
 * é a que outro deixou, e as contas deixam de ser previsíveis.
 */
async function comecarLimpo(palco) {
  await palco.ir('/app/?demo=1');
  await palco.limparArmazenamento();
  await palco.js(`await new Promise((pronto) => {
    const p = indexedDB.deleteDatabase('carimbo');
    p.onsuccess = p.onerror = p.onblocked = () => pronto();
  });
  return true`);
  await palco.ir('/app/?demo=1');
  await passarBoasVindas(palco);
  await palco.esperar('#principal .pilha .cartao', 10000);
}

/** O estado da demonstração, tal como está guardado. */
async function dados(palco) {
  return palco.js(`const cru = localStorage.getItem('carimbo-demo:demo');
    return cru ? JSON.parse(cru) : null`);
}

async function gravarDados(palco, estado) {
  await palco.js(`localStorage.setItem('carimbo-demo:demo',
    ${JSON.stringify(JSON.stringify(estado))}); return true`);
}

/** O programa e o negócio de um cartão guardado. */
function programaDe(estado, cartao) {
  for (const n of estado.negocios) {
    const p = (n.programas || []).find((x) => x.id === cartao.programaId);
    if (p) return { negocio: n, programa: p };
  }
  return null;
}

/**
 * O que o cartão devia dizer no rodapé. É a regra escrita outra vez, de
 * propósito: se a app mudar a conta sem querer, os dois textos deixam de
 * coincidir e o teste diz qual é qual.
 */
function rotuloEsperado(estado, cartao) {
  const { programa: p } = programaDe(estado, cartao);
  const porResgatar = estado.premios.filter((x) => x.cartaoId === cartao.id && !x.resgatadoEm).length;
  if (porResgatar) return 'Pronto a levantar';
  if (p.tipo === 'pontos') {
    const marcos = (p.marcos || []).slice().sort((a, b) => a.pontos - b.pontos);
    const seguinte = marcos.find((m) => m.pontos > cartao.pontos);
    return seguinte ? `faltam ${seguinte.pontos - cartao.pontos} pontos` : 'Prémio seguinte';
  }
  const faltam = p.objetivo - cartao.carimbos;
  return faltam === 1 ? 'falta 1 carimbo' : `faltam ${faltam} carimbos`;
}

/** Os cartões do cliente, pela ordem em que a app os põe na carteira. */
function carteiraEsperada(estado) {
  const cliente = estado.clientes[estado.clientes.length - 1];
  return estado.cartoes
    .filter((c) => c.clienteId === cliente.id)
    .map((c) => {
      const { negocio, programa } = programaDe(estado, c);
      const porResgatar = estado.premios.filter((x) => x.cartaoId === c.id && !x.resgatadoEm).length;
      return { ...c, negocio, programa, porResgatar };
    })
    .sort((a, b) => (b.porResgatar - a.porResgatar)
      || (new Date(b.ultimoEm || b.aderiuEm) - new Date(a.ultimoEm || a.aderiuEm)));
}

/** Despejo do que está desenhado em cada cartão da lista. */
async function lerCarteira(palco) {
  return palco.js(`
    const cartoes = [...document.querySelectorAll('#principal .pilha > .cartao')];
    const lidos = [];
    /* Abrir um cartão traz-lhe o que falta para dentro do ecrã, portanto ler o
       maço todo deixa a página no fundo — e a afirmação seguinte, que pergunta
       se a faixa do prémio está à vista, passava a medir um ecrã que a leitura
       criou. Guarda-se onde se estava e devolve-se no fim. */
    const rolagem = scrollY;
    for (const n of cartoes) {
      /* ABRE-SE CADA UM PARA O LER, e é a única maneira honesta.

         O maço só deixa um cartão aberto de cada vez, e o que está fechado tem
         o painel em 'display: none' — sem geometria nenhuma. Ler assim devolvia
         zeros e NaN às medidas que dependem de layout (as colunas que o CSS
         pinta mesmo, a largura da barra de pontos, a posição dos marcos) e o
         teste ficava a concordar com um ecrã que ninguém vê.

         E de caminho isto passa o maço todo, um a um, em cada corrida. */
      const aba = n.querySelector('.cartao-aba');
      if (aba && aba.getAttribute('aria-expanded') !== 'true') aba.click();
      /* E ESPERA-SE QUE ACABE DE ABRIR. O painel entra com um desvanecimento,
         e uma medição feita a meio lê o texto a 11% de opacidade: a varredura
         do contraste acusou quatro pares ilegíveis que ninguém chega a ver.
         Espera-se só pelas animações que ACABAM — uma infinita nunca cumpre a
         promessa e deixava isto pendurado para sempre. */
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      await Promise.all(n.getAnimations({ subtree: true })
        .filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity)
        .map((a) => a.finished.catch(() => {})));

      const grelha = n.querySelector('.carimbos');
      const pronto = n.querySelector('.pronto');
      const e = getComputedStyle(n);
      lidos.push({
        nome: n.querySelector('.cartao-nome')?.textContent.trim() ?? null,
        tipo: n.querySelector('.cartao-tipo')?.textContent.trim() ?? null,
        rotulo: n.querySelector('.cartao-rotulo')?.textContent.trim() ?? null,
        premio: n.querySelector('.cartao-premio')?.textContent.trim() ?? null,
        aria: aba ? aba.getAttribute('aria-label') : null,
        casas: grelha ? grelha.querySelectorAll('.carimbo').length : null,
        cheias: grelha ? grelha.querySelectorAll('.carimbo[data-estado="cheio"]').length : null,
        ariaGrelha: grelha ? grelha.getAttribute('aria-label') : null,
        colunas: grelha ? Number(getComputedStyle(grelha).getPropertyValue('--colunas')) : null,
        colunasPintadas: grelha
          ? getComputedStyle(grelha).gridTemplateColumns.split(/\\s+/).filter(Boolean).length : null,
        pronto: pronto ? pronto.textContent.replace(/\\s+/g, ' ').trim() : null,
        recomeco: n.querySelector('.recomeco')?.textContent.replace(/\\s+/g, ' ').trim() ?? null,
        recomecoPontos: n.querySelectorAll('.recomeco-ponto').length || null,
        recomecoCheios: n.querySelectorAll('.recomeco-ponto[data-cheio="sim"]').length || null,
        pontos: n.querySelector('.pontos-valor b')?.textContent.trim() ?? null,
        unidade: n.querySelector('.pontos-valor span')?.textContent.trim() ?? null,
        marcos: [...n.querySelectorAll('.marco')].map((m) => ({
          valor: m.querySelector('.marco-valor')?.textContent.trim() ?? null,
          atingido: m.dataset.atingido,
        })),
        fundo: e.backgroundColor,
        m: n.style.getPropertyValue('--m').trim(),
        mTxt: n.style.getPropertyValue('--m-txt').trim(),
        claro: n.dataset.claro ?? null,
      });
    }
    scrollTo({ top: rolagem, behavior: 'instant' });
    return lidos;`);
}

/**
 * Mede o texto de um cartão contra o fundo em que assenta.
 *
 * A parte que interessa é a opacidade: `--m-txt` pode estar perfeito e o
 * texto ser ilegível na mesma, porque o CSS o desmaia para 62%. O que chega
 * aos olhos é a mistura, e é a mistura que se mede.
 */
async function medirTextos(palco, seletorCartao) {
  return palco.js(`
    const cartao = document.querySelector(${JSON.stringify(seletorCartao)});
    if (!cartao) return null;
    const opaco = (cor) => { const p = String(cor).match(/[\\d.]+/g);
      return p && (p.length < 4 || Number(p[3]) > 0.95); };

    const alvos = [...cartao.querySelectorAll(
      '.cartao-nome, .cartao-tipo, .cartao-id b, .cartao-id span, .cartao-rotulo,'
      + ' .cartao-premio, .pronto-texto b, .pronto-texto span, .pontos-valor b,'
      + ' .pontos-valor span, .marco-valor')];

    return alvos.map((n) => {
      const e = getComputedStyle(n);
      /* Sobe até quem pinta mesmo um fundo, multiplicando as opacidades pelo
         caminho — o elemento do fundo não conta, porque desmaia o texto e o
         fundo ao mesmo tempo e a razão entre eles não muda. */
      let alfa = Number(e.opacity);
      let p = n.parentElement, fundo = null;
      while (p) {
        const pe = getComputedStyle(p);
        if (opaco(pe.backgroundColor)) { fundo = pe.backgroundColor; break; }
        alfa *= Number(pe.opacity);
        p = p.parentElement;
      }
      return {
        onde: n.className || n.tagName.toLowerCase(),
        texto: n.textContent.replace(/\\s+/g, ' ').trim().slice(0, 24),
        cor: e.color,
        fundo: fundo || 'rgb(255, 255, 255)',
        alfa,
        px: parseFloat(e.fontSize),
        peso: Number(e.fontWeight) || 400,
      };
    });`);
}

/** Junta a medição com a conta do contraste. */
function avaliarTextos(medidos) {
  return medidos.map((t) => {
    const cor = corParaRGB(t.cor), fundo = corParaRGB(t.fundo);
    const efectiva = misturar(cor, fundo, t.alfa * (cor.a ?? 1));
    return {
      ...t,
      contraste: razao(efectiva, fundo),
      minimo: minimoPara(t.px, t.peso),
    };
  });
}

const MESES = ['jan', 'fev', 'mar', 'abr', 'mai', 'jun',
               'jul', 'ago', 'set', 'out', 'nov', 'dez'];

/** «23 ago 2026 · 14:32» → um número comparável. */
function quandoFoi(texto) {
  const m = String(texto).match(/(\d{1,2}) (\w{3}) (\d{4}) · (\d{2}):(\d{2})/);
  if (!m) return null;
  const mes = MESES.indexOf(m[2]);
  if (mes < 0) return null;
  return new Date(+m[3], mes, +m[1], +m[4], +m[5]).getTime();
}

/* =========================================================================
   O módulo
   ========================================================================= */

export async function correr(palco, certo) {
  await comecarLimpo(palco);

  const estado = await dados(palco);
  const esperados = carteiraEsperada(estado);
  const vistos = await lerCarteira(palco);
  await palco.captura('02-carteira');

  /* --- a carteira com cartões ------------------------------------------- */

  certo(await palco.texto('#principal h1.titulo-grande') === 'Os meus cartões',
    'carteira: o título é «Os meus cartões»',
    String(await palco.texto('#principal h1.titulo-grande')));

  certo(vistos.length === esperados.length,
    `carteira: desenha os ${esperados.length} cartões que a demonstração semeou`,
    `desenhou ${vistos.length}`);

  certo(vistos.map((c) => c.nome).join(' | ') === esperados.map((c) => c.negocio.nome).join(' | '),
    'carteira: os cartões vêm pela ordem certa (prémio à espera primeiro, depois o mais recente)',
    vistos.map((c) => c.nome).join(' | '));

  const comPremio = esperados.filter((c) => c.porResgatar).length;
  certo(await palco.visivel('.faixa-premio'),
    'carteira: a faixa do prémio está à vista quando há prémio por levantar',
    `há ${comPremio} prémio(s) por levantar`);
  const faixa = await palco.texto('.faixa-premio');
  certo(faixa === 'Tens um prémio à espera. Mostra o código no balcão para levantar.',
    'carteira: a faixa diz quantos prémios esperam, no singular', String(faixa));

  /* --- a grelha contra o objectivo do programa -------------------------- */

  for (const esperado of esperados) {
    const visto = vistos.find((c) => c.nome === esperado.negocio.nome);
    if (!visto) continue;                       /* já reprovou na contagem  */
    const p = esperado.programa;

    if (p.tipo === 'pontos' || esperado.porResgatar) {
      certo(visto.casas === null,
        `${esperado.negocio.nome}: não desenha grelha de carimbos (${p.tipo === 'pontos' ? 'é de pontos' : 'tem prémio à espera'})`,
        `desenhou ${visto.casas} casas`);
      continue;
    }

    certo(visto.casas === p.objetivo,
      `${esperado.negocio.nome}: a grelha tem ${p.objetivo} casas, o objectivo do programa`,
      `tem ${visto.casas}`);
    certo(visto.cheias === esperado.carimbos,
      `${esperado.negocio.nome}: ${esperado.carimbos} casas carimbadas`,
      `estão ${visto.cheias}`);
    certo(visto.ariaGrelha === `${esperado.carimbos} de ${p.objetivo} carimbos`,
      `${esperado.negocio.nome}: o rótulo de acessibilidade da grelha diz a mesma conta`,
      String(visto.ariaGrelha));
    /* O comentário do código promete linhas cheias — «com uma linha de seis e
       outra de quatro parece um erro». Isso mede-se. */
    certo(visto.colunas > 0 && p.objetivo % visto.colunas === 0,
      `${esperado.negocio.nome}: ${p.objetivo} carimbos em ${visto.colunas} colunas dão linhas cheias`,
      `${p.objetivo} % ${visto.colunas} = ${p.objetivo % visto.colunas}`);
    certo(visto.colunasPintadas === visto.colunas,
      `${esperado.negocio.nome}: o CSS pinta mesmo as ${visto.colunas} colunas`,
      `pintou ${visto.colunasPintadas}`);
  }

  /* Uma âncora à mão, para o teste não ser só a regra a olhar para si
     própria: o cartão do café é de 10 e tem 7. */
  const torrado = vistos.find((c) => c.nome === 'Café Torrado');
  certo(torrado && torrado.casas === 10 && torrado.cheias === 7,
    'Café Torrado: 10 casas, 7 carimbadas',
    torrado ? `${torrado.cheias} de ${torrado.casas}` : 'não está na carteira');

  /* --- «faltam N carimbos» ---------------------------------------------- */

  for (const esperado of esperados) {
    const visto = vistos.find((c) => c.nome === esperado.negocio.nome);
    if (!visto) continue;
    const rotulo = rotuloEsperado(estado, esperado);
    if (esperado.porResgatar) {
      certo(visto.rotulo === null,
        `${esperado.negocio.nome}: com prémio à espera não mostra rodapé de contagem`,
        String(visto.rotulo));
      const premio = estado.premios.find((x) => x.cartaoId === esperado.id && !x.resgatadoEm);
      certo(visto.aria === `${esperado.negocio.nome}, ${esperado.programa.nome}. Pronto a levantar: ${premio.descricao}.`,
        `${esperado.negocio.nome}: o rótulo lido em voz alta diz «Pronto a levantar»`,
        String(visto.aria));
    } else {
      certo(visto.rotulo === rotulo,
        `${esperado.negocio.nome}: o rodapé diz «${rotulo}»`,
        String(visto.rotulo));
      certo(visto.premio === esperado.programa.premio,
        `${esperado.negocio.nome}: e mostra o prémio que se ganha`,
        `${visto.premio} ≠ ${esperado.programa.premio}`);
    }
  }

  certo(torrado && torrado.rotulo === 'faltam 3 carimbos',
    'Café Torrado: «faltam 3 carimbos» (10 − 7)', torrado ? String(torrado.rotulo) : '');

  /* --- o cartão cheio: o painel em vez da grelha ------------------------- */

  const cheio = esperados.find((c) => c.porResgatar);
  const vistoCheio = vistos.find((c) => c.nome === cheio.negocio.nome);
  certo(vistoCheio.pronto !== null,
    `${cheio.negocio.nome}: um cartão completo mostra o painel «pronto», não uma grelha a zeros`,
    String(vistoCheio.pronto));
  certo(vistoCheio.pronto === `${cheio.programa.premio}Mostra o código no balcão`,
    `${cheio.negocio.nome}: o painel nomeia o prémio e diz o que fazer`,
    String(vistoCheio.pronto));

  /* --- o cartão de pontos ------------------------------------------------ */

  const camelia = esperados.find((c) => c.programa.tipo === 'pontos');
  const vistoCamelia = vistos.find((c) => c.nome === camelia.negocio.nome);
  const marcos = camelia.programa.marcos.slice().sort((a, b) => a.pontos - b.pontos);

  certo(vistoCamelia.pontos === String(camelia.pontos) && vistoCamelia.unidade === 'pt',
    `${camelia.negocio.nome}: mostra ${camelia.pontos} pontos`,
    `${vistoCamelia.pontos} ${vistoCamelia.unidade}`);
  certo(vistoCamelia.marcos.length === marcos.length,
    `${camelia.negocio.nome}: o trilho tem os ${marcos.length} marcos do programa`,
    `tem ${vistoCamelia.marcos.length}`);
  certo(vistoCamelia.marcos.map((m) => m.valor).join(',') === marcos.map((m) => String(m.pontos)).join(','),
    `${camelia.negocio.nome}: os marcos estão pela ordem e com os valores certos`,
    vistoCamelia.marcos.map((m) => m.valor).join(','));
  const atingidos = marcos.filter((m) => camelia.pontos >= m.pontos).length;
  certo(vistoCamelia.marcos.filter((m) => m.atingido === 'sim').length === atingidos,
    `${camelia.negocio.nome}: ${atingidos} marcos marcados como atingidos`,
    `marcou ${vistoCamelia.marcos.filter((m) => m.atingido === 'sim').length}`);

  /* A barra cheia é a única parte do trilho que se lê à distância: tem de
     valer a fracção verdadeira, não uma aproximação. */
  await abrirNoMaco(palco, camelia.negocio.nome);
  const trilho = await palco.js(`
    const t = document.querySelector('#principal .pilha .trilho');
    if (!t) return null;
    const c = t.querySelector('.trilho-cheio');
    return { largura: t.getBoundingClientRect().width, cheia: c.getBoundingClientRect().width };`);
  const fraccaoEsperada = camelia.pontos / marcos[marcos.length - 1].pontos;
  const fraccaoVista = trilho ? trilho.cheia / trilho.largura : -1;
  certo(Math.abs(fraccaoVista - fraccaoEsperada) < 0.02,
    `${camelia.negocio.nome}: a barra está a ${Math.round(fraccaoEsperada * 100)}% (${camelia.pontos} de ${marcos[marcos.length - 1].pontos})`,
    `está a ${(fraccaoVista * 100).toFixed(1)}%`);

  /* O CSS promete que o primeiro e o último número «encostam às pontas para
     não saírem do cartão». Um número cortado pelo overflow do cartão é uma
     informação perdida — mede-se. */
  const pontas = await palco.js(`
    const cartao = [...document.querySelectorAll('#principal .pilha > .cartao')]
      .find((n) => n.querySelector('.trilho'));
    if (!cartao) return null;
    const caixa = cartao.getBoundingClientRect();
    const numeros = [...cartao.querySelectorAll('.marco .marco-valor')];
    const ler = (v) => { if (!v) return null; const r = v.getBoundingClientRect();
      return { texto: v.textContent.trim(),
               empurrao: getComputedStyle(v).transform,
               saiEsquerda: Math.round(caixa.left - r.left),
               saiDireita: Math.round(r.right - caixa.right) }; };
    return { primeiro: ler(numeros[0]), ultimo: ler(numeros[numeros.length - 1]) };`);
  certo(pontas && pontas.ultimo && pontas.ultimo.saiDireita <= 0,
    'trilho: o número do último marco cabe dentro do cartão',
    pontas && pontas.ultimo ? `«${pontas.ultimo.texto}» sai ${pontas.ultimo.saiDireita}px pela direita` : 'não medi');
  certo(pontas && pontas.primeiro && pontas.primeiro.saiEsquerda <= 0,
    'trilho: o número do primeiro marco cabe dentro do cartão',
    pontas && pontas.primeiro ? `«${pontas.primeiro.texto}» sai ${pontas.primeiro.saiEsquerda}px pela esquerda` : 'não medi');
  /* O CSS diz «o primeiro e o último encostam às pontas para não saírem do
     cartão» e dá a cada um o seu empurrão. Se um deles ficar sem transform,
     a regra não está a apanhar o elemento que julga apanhar. */
  certo(pontas && pontas.primeiro && pontas.primeiro.empurrao !== 'none',
    'trilho: o primeiro número recebe o empurrão que o CSS lhe promete',
    pontas && pontas.primeiro ? `transform=${pontas.primeiro.empurrao}` : 'não medi');
  certo(pontas && pontas.ultimo && pontas.ultimo.empurrao !== 'none',
    'trilho: o último número recebe o empurrão que o CSS lhe promete',
    pontas && pontas.ultimo ? `transform=${pontas.ultimo.empurrao}` : 'não medi');

  /* --- as cores do comerciante ------------------------------------------ */

  for (const esperado of esperados) {
    const visto = vistos.find((c) => c.nome === esperado.negocio.nome);
    if (!visto) continue;
    const cor = corParaRGB(visto.fundo);
    const pedida = corParaRGB(visto.m);
    certo(visto.m.toLowerCase() !== '' && cor && pedida
      && Math.abs(cor.r - pedida.r) < 2 && Math.abs(cor.g - pedida.g) < 2 && Math.abs(cor.b - pedida.b) < 2,
      `${esperado.negocio.nome}: o cartão está pintado com a cor do negócio (${esperado.negocio.cor})`,
      `--m=${visto.m}, fundo=${visto.fundo}`);
  }
  certo(new Set(vistos.map((c) => c.fundo)).size === vistos.length,
    'carteira: cada negócio tem a sua cor — não há dois cartões iguais',
    vistos.map((c) => `${c.nome}=${c.fundo}`).join(' · '));

  /* --- o texto lê-se por cima da cor ------------------------------------ */

  const falhas = [];
  const desmaiados = [];
  for (let i = 0; i < vistos.length; i++) {
    const seletor = `#principal .pilha > .cartao:nth-of-type(${i + 1})`;
    /* Cada cartão mede-se ABERTO: o rodapé, a grelha e o número do cartão só
       existem no painel, e um painel fechado não tem texto para medir. */
    await abrirNoMaco(palco, i + 1);
    const medidos = avaliarTextos(await medirTextos(palco, seletor));
    for (const t of medidos) {
      if (t.contraste >= t.minimo) continue;
      const onde = `${vistos[i].nome} · .${String(t.onde).split(' ').join('.')}`;
      (t.alfa > 0.99 ? falhas : desmaiados).push({ ...t, linha:
        `${onde} «${t.texto}» ${t.contraste.toFixed(2)}:1 (pede ${t.minimo}, opacidade ${t.alfa.toFixed(2)})` });
    }
  }
  const piores = (lista) => lista.slice().sort((a, b) => a.contraste - b.contraste)
    .map((t) => t.linha);

  /* Isto é a promessa do marcaSegura(): a tinta cheia por cima da cor da
     marca passa sempre, seja qual for a cor que o dono do café escolheu. */
  certo(falhas.length === 0,
    'contraste: o texto do cartão a cheio passa o mínimo da WCAG por cima da cor do negócio',
    piores(falhas).slice(0, 3).join(' · '));

  /* E isto é o que a marcaSegura() não pode garantir sozinha: o CSS desmaia
     metade do texto do cartão, e o que chega aos olhos é a mistura. */
  certo(desmaiados.length === 0,
    'contraste: também o texto desmaiado pela opacidade passa o mínimo',
    `${desmaiados.length} pares abaixo — ${piores(desmaiados).slice(0, 5).join(' · ')}`);

  /* --- abrir um cartão --------------------------------------------------- */

  const indice = vistos.findIndex((c) => c.nome === 'Café Torrado');
  const passosAntes = await palco.js('return history.length');
  await abrirOCartaoTodo(palco, indice + 1);
  const passosDepois = await palco.js('return history.length');
  await palco.captura('02-cartao-aberto');

  certo(await palco.visivel('#principal .cartao-grande'),
    'cartão: abre e mostra o cartão em grande');
  certo(await palco.texto('#principal .cartao-grande .cartao-nome') === 'Café Torrado',
    'cartão: é o cartão em que se carregou',
    String(await palco.texto('#principal .cartao-grande .cartao-nome')));
  certo(await palco.contar('#principal .pilha > .cartao') === 1,
    'cartão: a lista da carteira deu lugar a um cartão só',
    `${await palco.contar('#principal .pilha > .cartao')} cartões`);

  const grandeCasas = await palco.contar('#principal .cartao-grande .carimbo');
  const grandeCheias = await palco.contar('#principal .cartao-grande .carimbo[data-estado="cheio"]');
  certo(grandeCasas === 10 && grandeCheias === 7,
    'cartão: a grelha grande repete a mesma conta (7 de 10)',
    `${grandeCheias} de ${grandeCasas}`);

  certo(await palco.visivel('#principal .voltar'),
    'cartão: há um botão para voltar à carteira');

  /* Numa app instalada, o botão «para trás» do telemóvel é o gesto natural
     para fechar um cartão. Se abrir não deixa marca no histórico, esse gesto
     sai da app em vez de voltar à carteira. */
  certo(passosDepois > passosAntes,
    'cartão: abrir um cartão deixa um passo no histórico do browser',
    `history.length ${passosAntes} → ${passosDepois}`);

  /* --- o histórico de movimentos ---------------------------------------- */

  const ecraCartao = await palco.js(`
    const seccoes = [...document.querySelectorAll('#principal .seccao')].map((s) => ({
      titulo: s.querySelector('.seccao-titulo')?.textContent.trim() ?? null,
      linhas: [...s.querySelectorAll('.linha')].map((l) => ({
        titulo: l.querySelector('.linha-texto b')?.textContent.trim() ?? null,
        quando: l.querySelector('.linha-texto span')?.textContent.trim() ?? null,
        fim: l.querySelector('.linha-fim')?.textContent.trim() ?? null,
      })),
    }));
    return {
      seccoes,
      comoFunciona: document.querySelector('#principal .caixa-texto')?.textContent
        .replace(/\\s+/g, ' ').trim() ?? null,
      telefone: document.querySelector('#principal a.linha[href^="tel:"]')?.getAttribute('href') ?? null,
      botaoCodigo: [...document.querySelectorAll('#principal button')]
        .map((b) => b.textContent.trim()).find((t) => t.includes('código')) ?? null,
    };`);

  const historico = ecraCartao.seccoes.find((s) => s.titulo === 'Histórico');
  const meus = estado.movimentos.filter((m) => m.cartaoId === esperados[indice].id);
  certo(!!historico, 'cartão: tem uma secção «Histórico»',
    ecraCartao.seccoes.map((s) => s.titulo).join(' | '));
  certo(historico && historico.linhas.length === Math.min(12, meus.length),
    `cartão: o histórico mostra os ${Math.min(12, meus.length)} movimentos do cartão (1 adesão + 7 carimbos)`,
    historico ? `mostra ${historico.linhas.length}` : 'sem secção');

  const datas = (historico ? historico.linhas : []).map((l) => quandoFoi(l.quando));
  certo(datas.length > 0 && datas.every((d) => d !== null),
    'cartão: cada movimento traz data e hora legíveis',
    (historico ? historico.linhas.map((l) => l.quando).slice(0, 3).join(' · ') : ''));
  certo(datas.length > 1 && datas.every((d, i) => i === 0 || d <= datas[i - 1]),
    'cartão: o histórico vem do mais recente para o mais antigo',
    datas.map((d) => (d ? new Date(d).toISOString().slice(0, 10) : '?')).join(' > '));
  certo(historico && historico.linhas[0] && historico.linhas[0].titulo === 'Carimbo',
    'cartão: o movimento mais recente é um carimbo',
    historico && historico.linhas[0] ? String(historico.linhas[0].titulo) : '');
  certo(historico && historico.linhas.some((l) => l.titulo === 'Cartão criado'),
    'cartão: a adesão também aparece no histórico',
    historico ? historico.linhas.map((l) => l.titulo).join(' | ') : '');
  certo(historico && historico.linhas.every((l) => l.fim && l.fim.length > 0),
    'cartão: cada linha diz há quanto tempo foi',
    historico ? historico.linhas.map((l) => l.fim).slice(0, 3).join(' · ') : '');

  certo(String(ecraCartao.comoFunciona).includes('Ao fim de 10'),
    'cartão: «Como funciona» explica a regra do programa',
    String(ecraCartao.comoFunciona).slice(0, 80));
  certo(ecraCartao.telefone === 'tel:234000000',
    'cartão: o telefone do negócio é uma ligação que marca',
    String(ecraCartao.telefone));
  certo(await palco.textoTodo().then((t) => t.includes('Rua Dr. Oliveira Salazar 12')),
    'cartão: mostra a morada do negócio');
  certo(!!ecraCartao.botaoCodigo,
    'cartão: há o botão de mostrar o código ao balcão', String(ecraCartao.botaoCodigo));

  /* --- o botão da Carteira do Google -------------------------------------
     Estava aqui uma linha no perfil que prometia «em breve» e não fazia nada.
     Agora há passe a sério, e o botão é da Google: as normas de marca dela
     proíbem desenhar um por nós, e obrigam a 48 dp de altura e 8 dp de folga
     de todos os lados. Isso mede-se — não se confia em ter escrito o CSS.

     Primeiro prova-se a AUSÊNCIA. Sem logótipo não há classe de fidelização
     possível, e um botão que só falha quando se lhe toca é pior do que um
     botão que não está lá. A semente não traz logótipo, por isso o estado em
     que este ecrã está agora já é o caso a provar.
     -------------------------------------------------------------------- */
  /* =======================================================================
     A FAIXA — e o aro medido contra ELA, não contra o cartão

     Um cartão de uma cor só é um rectângulo pintado. A faixa é o que lhe dá
     planos, e as duas pontas dela nascem MEDIDAS no `panoSeguro`: a que se
     aproxima da tinta anda de dois em dois por cento e pára no último passo
     que ainda dá 4,5:1 ao texto.

     O QUE ESTA GUARDA PERSEGUE: os carimbos por fazer vivem DENTRO da faixa.
     Uma cor de aro que passasse os 3:1 contra a cor do cartão e não contra a
     ponta clara do gradiente ficava ilegível exactamente onde é desenhada — e
     uma medição contra o cartão dizia que estava tudo bem. Foi assim que o
     `aroSeguro` ficou meses a receber um fundo só quando aceitava uma lista
     desde que nasceu.
     ======================================================================= */
  {
    const faixa = await palco.js(`
      const c = [...document.querySelectorAll('#principal .cartao')]
        .find((x) => x.querySelector('.carimbos'));
      if (!c) return null;
      const s = getComputedStyle(c);
      const grelha = getComputedStyle(c.querySelector('.carimbos'));
      const r = (n) => n.getBoundingClientRect();
      return {
        m: s.getPropertyValue('--m').trim(),
        a: s.getPropertyValue('--m-faixa-a').trim(),
        b: s.getPropertyValue('--m-faixa-b').trim(),
        aro: s.getPropertyValue('--m-aro').trim(),
        fundo: grelha.backgroundImage,
        sangra: Math.abs(r(c).left - r(c.querySelector('.carimbos')).left) < 0.5
             && Math.abs(r(c).right - r(c.querySelector('.carimbos')).right) < 0.5,
      }`);

    certo(!!faixa && /linear-gradient/.test(faixa.fundo),
      'faixa: os carimbos assentam num gradiente e não na cor lisa do cartão',
      faixa ? String(faixa.fundo).slice(0, 60) : 'sem cartão de carimbos');
    certo(!!faixa && faixa.sangra,
      'faixa: sangra até ao bordo do cartão — um `<button>` traz 6px de preenchimento do browser que deixavam uma nesga da cor por fora',
      faixa ? JSON.stringify([faixa.m, faixa.a]) : 'não medida');
    certo(!!faixa && !!faixa.a && !!faixa.b && !!faixa.aro,
      'faixa: as duas pontas e o aro vêm CALCULADOS do nucleo.js, e não escritos na folha de estilo',
      faixa ? `a=${faixa.a} b=${faixa.b} aro=${faixa.aro}` : 'não medida');

    if (faixa && faixa.aro) {
      const { contraste } = await import('../../_fonte/js/nucleo.js');
      const pares = [['cartão', faixa.m], ['ponta clara', faixa.a], ['ponta escura', faixa.b]]
        .map(([nome, cor]) => [nome, cor, contraste(faixa.aro, cor)]);
      const pior = Math.min(...pares.map((x) => x[2]));
      certo(pior >= 3,
        'faixa: o aro do carimbo por fazer passa os 3:1 contra AS TRÊS superfícies — cartão e as duas pontas do gradiente',
        pares.map(([n, c, r]) => `${n} ${c} ${r.toFixed(2)}`).join(' · '));
    }
  }

  certo(!(await palco.ver('.btn-wallet')),
    'wallet: sem logótipo do negócio não aparece botão nenhum — a Google exigiria um');

  /* E NÃO CHEGA NÃO HAVER BOTÃO: tem de se dizer porquê.

     Isto era silêncio, e «nada» não se distingue de «esta app não faz isso».
     Quem tem dois cartões, um com botão e outro sem, não conclui «falta o
     logótipo daquele café» — conclui que a app está avariada. E o perfil
     promete a carteira do telemóvel a toda a gente.

     A frase não pede nada nem culpa ninguém: quem tem de carregar o logótipo
     é o dono, e é no balcão que ele é avisado. */
  const explicacao = await palco.js(`
    return [...document.querySelectorAll('#principal p.miudo')]
      .map((p) => p.textContent).filter((t) => /logótipo/i.test(t))[0] || null`);
  certo(!!explicacao && /carteira/i.test(explicacao),
    'wallet: e a app DIZ PORQUÊ — o silêncio lê-se como app avariada',
    String(explicacao));

  {
    /* E agora com logótipo, pelo caminho por onde a pessoa lá chega. */
    await palco.js(`
      const e = JSON.parse(localStorage.getItem('carimbo-demo:demo'));
      for (const n of e.negocios) {
        n.logotipo = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';
        n.logotipo_em = new Date().toISOString();
      }
      localStorage.setItem('carimbo-demo:demo', JSON.stringify(e));
      return true;`);
    await palco.clicar('#principal .voltar');
    await palco.esperar('#principal .pilha .cartao', 8000);
    await abrirOCartaoTodo(palco, indice + 1);
    /* Espera-se SEM deixar rebentar. Um `esperar` que atira mata o módulo, e
       com ele as duas dezenas de afirmações que vêm a seguir — o botão
       desaparecia e o que se lia era «o módulo rebentou», com o resto do ecrã
       do cartão por verificar. Uma coisa partida tem de dar UMA falha. */
    const apareceu = await palco.esperar('.btn-wallet', 8000).then(() => true, () => false);
    certo(apareceu, 'wallet: com logótipo, o cartão passa a ter o botão da Carteira');

    /* UM BOTÃO SÓ, quando se sabe qual. Estavam os dois empilhados, e num
       iPhone o da Google é ruído que ocupa 55 píxeis no meio do ecrã do
       cartão. A demonstração só liga a Google e não tem certificado da Apple,
       por isso o que se conta AQUI é «nunca mais do que um por carteira» — a
       escolha em si mede-se logo a seguir, a conduzir a função com cada
       sistema à vez. O que esta afirmação apanha é a duplicação: se um dia a
       pintura correr duas vezes, ficam dois botões iguais e ninguém repara a
       ler o código. */
    const quantos = await palco.js(`
      const b = [...document.querySelectorAll('.btn-wallet')].map((x) => x.dataset.carteira);
      return { b, unicos: new Set(b).size }`);
    certo(quantos.b.length === quantos.unicos,
      'wallet: não há dois botões da mesma carteira no mesmo ecrã',
      quantos.b.join(',') || 'nenhum');
    certo(!quantos.b.includes('apple'),
      'wallet: e a Apple não aparece na demonstração, onde não há certificado nenhum para assinar',
      quantos.b.join(',') || 'nenhum');

    /* --- QUAL DAS DUAS CARTEIRAS É QUE ESTE APARELHO TEM ------------------

       Nove ramos, cinco condições e zero afirmações — foi assim durante meses,
       e o defeito que lá estava só apareceu porque alguém olhou para o ecrã do
       computador e viu os dois botões. Um `.pkpass` num Windows descarrega e
       não há aplicação nenhuma que o abra: o botão da Apple ali não estava
       escondido a quem podia usá-lo, estava a prometer uma coisa impossível.

       Conduz-se a FUNÇÃO A SÉRIO, importada da página, com o `navigator`
       fingido à volta dela — e devolve-se o verdadeiro no fim, senão tudo o que
       vier a seguir nesta bateria corre a pensar que é um iPhone. */
    const escolhas = await palco.js(`
      const m = await import('/js/nucleo.js');
      const real = {
        ua: navigator.userAgent,
        uad: navigator.userAgentData,
        toques: navigator.maxTouchPoints,
      };
      const finge = (ua, plataforma, toques) => {
        Object.defineProperty(navigator, 'userAgent', { configurable: true, value: ua });
        Object.defineProperty(navigator, 'userAgentData',
          { configurable: true, value: plataforma ? { platform: plataforma } : undefined });
        Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: toques });
        return m.carteiraProvavel();
      };
      const casos = [
        ['Windows', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/140 Safari/537.36', 'Windows', 0],
        ['Windows sem UA-CH', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Gecko/20100101 Firefox/140.0', '', 0],
        ['Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Version/18 Safari/605', 'macOS', 0],
        ['iPad a fingir-se de Mac', 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605 Version/18 Safari/605', '', 5],
        ['iPhone', 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605 Version/18 Safari/604', 'iOS', 5],
        ['Android', 'Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 Chrome/140 Mobile Safari/537.36', 'Android', 5],
        ['ChromeOS', 'Mozilla/5.0 (X11; CrOS x86_64 14541.0.0) AppleWebKit/537.36 Chrome/140 Safari/537.36', 'Chrome OS', 0],
        ['Linux', 'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 Chrome/140 Safari/537.36', 'Linux', 0],
        ['desconhecido', 'AlgoQueNinguemConhece/1.0', '', 0],
      ];
      const r = {};
      for (const [nome, ua, plataforma, toques] of casos) r[nome] = finge(ua, plataforma, toques);
      Object.defineProperty(navigator, 'userAgent', { configurable: true, value: real.ua });
      Object.defineProperty(navigator, 'userAgentData', { configurable: true, value: real.uad });
      Object.defineProperty(navigator, 'maxTouchPoints', { configurable: true, value: real.toques });
      return r;`);

    const ESPERADO = {
      Windows: 'google',
      'Windows sem UA-CH': 'google',
      Mac: 'apple',
      'iPad a fingir-se de Mac': 'ambas',
      iPhone: 'apple',
      Android: 'google',
      ChromeOS: 'google',
      Linux: 'google',
      desconhecido: 'ambas',
    };
    const erradas = Object.entries(ESPERADO)
      .filter(([nome, q]) => escolhas[nome] !== q)
      .map(([nome, q]) => `${nome}: esperava «${q}» e deu «${escolhas[nome]}»`);
    certo(Object.keys(escolhas).length === Object.keys(ESPERADO).length && erradas.length === 0,
      'wallet: cada sistema leva a carteira que consegue mesmo guardar o passe',
      erradas.join(' · ') || `só medi ${Object.keys(escolhas).length} sistemas`);

    /* E o `navigator` ficou como estava. Uma prova que muda o mundo à volta e
       não o repõe não estraga esta afirmação — estraga as trinta seguintes,
       noutro módulo, sem nada que aponte para aqui. */
    const reposto = await palco.js(`return {
      ua: navigator.userAgent, toques: navigator.maxTouchPoints }`);
    certo(!/AlgoQueNinguemConhece|Windows NT|iPhone/.test(reposto.ua),
      'wallet: e o navegador fica como estava depois de se fingir nove sistemas',
      JSON.stringify(reposto));

    const b = !apareceu ? null : await palco.js(`
      const botao = document.querySelector('.btn-wallet');
      if (!botao) return null;
      const img = botao.querySelector('img');
      if (img && !img.complete) await new Promise((r) => { img.onload = r; img.onerror = r; });
      const rb = botao.getBoundingClientRect();
      const ri = img ? img.getBoundingClientRect() : null;
      const cs = getComputedStyle(botao);
      const folga = ['Top', 'Right', 'Bottom', 'Left'].map((l) => parseFloat(cs['padding' + l]));
      /* Onde está em relação ao código: o passe é uma comodidade, o código é
         o que serve o cliente ao balcão hoje. */
      const codigo = [...document.querySelectorAll('#principal button')]
        .find((x) => x.textContent.includes('código'));
      return {
        existe: true,
        fonte: img ? img.getAttribute('src') : null,
        carregou: Boolean(img && img.complete && img.naturalWidth > 0),
        natural: img ? [img.naturalWidth, img.naturalHeight] : null,
        altura: Math.round(ri ? ri.height : 0),
        largura: Math.round(ri ? ri.width : 0),
        folga,
        nome: botao.getAttribute('aria-label') || botao.textContent.trim(),
        cabe: Math.round(rb.width) <= Math.round(document.querySelector('#principal').clientWidth),
        depoisDoCodigo: Boolean(codigo
          && (codigo.compareDocumentPosition(botao) & Node.DOCUMENT_POSITION_FOLLOWING)),
      };`);

    certo(b && b.carregou && b.natural[0] === 240 && b.natural[1] === 55,
      'wallet: e a imagem é a que a Google distribui, carregada de facto',
      JSON.stringify(b && { fonte: b.fonte, natural: b.natural, carregou: b.carregou }));
    certo(b && b.altura >= 48,
      'wallet: com os 48 dp de altura mínima que as normas da Google exigem',
      String(b && b.altura));
    certo(b && b.folga.every((f) => f >= 8),
      'wallet: e os 8 dp de folga de todos os lados',
      JSON.stringify(b && b.folga));
    certo(b && b.cabe,
      'wallet: o botão cabe na coluna do telemóvel sem a rebentar',
      JSON.stringify(b && { largura: b.largura }));
    certo(b && /carteira do google/i.test(String(b.nome)),
      'wallet: quem ouve o ecrã ouve o que o botão faz — a imagem sozinha não diz nada',
      String(b && b.nome));
    certo(b && b.depoisDoCodigo,
      'wallet: fica DEPOIS do «mostrar o código» — o código é o que serve ao balcão hoje');

    /* E tocar nele faz alguma coisa, e diz a verdade. Na demonstração não há
       chave para assinar o passe: o botão tem de o dizer, e não ficar quieto
       nem abrir uma página de erro da Google. */
    if (apareceu) {
      await palco.clicar('.btn-wallet');
      await palco.esperar('.aviso, .brinde, [role="status"]', 6000).then(() => {}, () => {});
      const dito = await palco.textoTodo();
      certo(/demonstra/i.test(dito),
        'wallet: na demonstração o botão diz que não há passe a sério, em vez de ficar quieto',
        dito.slice(0, 160));
      certo(!String(await palco.js('return location.href')).includes('pay.google.com'),
        'wallet: e não atira ninguém para uma página de erro da Google',
        String(await palco.js('return location.href')).slice(0, 80));
    }
  }

  /* As cores do comerciante têm de acompanhar o cartão para o ecrã grande. */
  const corGrande = await palco.estilo('#principal .cartao-grande', 'background-color');
  const corLista = vistos[indice].fundo;
  certo(corGrande === corLista,
    'cartão: o cartão grande tem a mesma cor que tinha na carteira',
    `${corGrande} ≠ ${corLista}`);

  const medidosGrande = avaliarTextos(await medirTextos(palco, '#principal .cartao-grande'));
  const maus = medidosGrande.filter((t) => t.alfa > 0.99 && t.contraste < t.minimo);
  certo(maus.length === 0,
    'cartão: o texto a cheio do cartão grande também se lê por cima da cor',
    maus.map((t) => `${t.onde} ${t.contraste.toFixed(2)}:1`).join(' · '));

  /* --- voltar à carteira ------------------------------------------------- */

  await palco.clicar('#principal .voltar');
  await palco.esperar('#principal .pilha .cartao', 8000);
  certo(await palco.texto('#principal h1.titulo-grande') === 'Os meus cartões',
    'voltar: o botão devolve a carteira',
    String(await palco.texto('#principal h1.titulo-grande')));
  certo(await palco.contar('#principal .pilha > .cartao') === esperados.length,
    'voltar: com os cartões todos outra vez',
    `${await palco.contar('#principal .pilha > .cartao')} de ${esperados.length}`);

  /* --- o maço: como os cartões se encaixam uns nos outros ---------------- */

  /* Os cartões da carteira estão EMPILHADOS, não alinhados: cada um entra por
     cima do anterior e vê-se só a faixa de cima de cada um. É o que faz caber
     dez cartões num ecrã, e é o que a carteira do telemóvel faz.

     Mede-se em dois estados, porque a forma muda com eles: fechados, todos com
     o mesmo encaixe negativo — um encaixe que fosse diferente entre dois pares
     lia-se como duas pilhas; e com um aberto, ele sai do maço, com ar de cada
     lado, senão não se percebe qual é que está aberto.

     O «Juntar outro cartão» não é um cartão e não entra no maço: fica com
     folga POSITIVA. Esteve fora da pilha e colado ao último cartão, e essa é a
     razão de esta afirmação existir desde o princípio. */
  const FOLGAS = `
    const itens = [...document.querySelectorAll('#principal .pilha > *')];
    const r = [];
    for (let i = 1; i < itens.length; i++) {
      r.push({
        entre: itens[i - 1].className.split(' ')[0] + '→' + itens[i].className.split(' ')[0],
        px: Math.round(itens[i].getBoundingClientRect().top
                       - itens[i - 1].getBoundingClientRect().bottom),
      });
    }
    return r;`;

  /* Fecha-se o que estivesse aberto — as afirmações de cima abriram cartões, e
     medir a seguir a elas era medir o estado que a leitura criou. */
  await palco.js(`
    const a = document.querySelector('#principal .cartao[data-aberto="sim"] .cartao-aba');
    if (a) a.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    return true;`);

  const encaixe = await palco.js(`
    const p = document.querySelector('#principal .pilha-baralho');
    return p ? parseFloat(getComputedStyle(p).getPropertyValue('--baralho-encaixe')) : null;`);
  certo(encaixe > 0,
    'maço: o encaixe dos cartões é um número que sai da folha de estilo',
    String(encaixe));

  const folgas = await palco.js(FOLGAS);
  const entreCartoes = folgas.filter((f) => f.entre === 'cartao→cartao');
  const ateAoJuntar = folgas.find((f) => f.entre.endsWith('→linha'));
  certo(entreCartoes.length >= 2
    && entreCartoes.every((f) => f.px === -encaixe),
    `maço: fechados, todos os cartões encaixam os mesmos ${encaixe}px no anterior`,
    folgas.map((f) => `${f.entre} ${f.px}px`).join(' · '));
  certo(!!ateAoJuntar && ateAoJuntar.px > 0,
    'maço: e o «juntar outro» não entra no maço — fica com folga a sério',
    ateAoJuntar ? `${ateAoJuntar.entre} ${ateAoJuntar.px}px` : 'não encontrei a placa');

  await abrirNoMaco(palco, 2);
  const comUmAberto = await palco.js(FOLGAS);
  certo(comUmAberto[0] && comUmAberto[0].px > 0 && comUmAberto[1] && comUmAberto[1].px > 0,
    'maço: o cartão aberto sai do maço, com ar de um lado e do outro',
    comUmAberto.map((f) => `${f.entre} ${f.px}px`).join(' · '));

  /* --- e nunca mais do que um aberto ------------------------------------ */

  /* A regra do produto tem uma palavra só: UM. Toca-se em três seguidos e
     conta-se — se dois ficarem abertos, o maço deixou de ser um maço e passou
     a ser uma lista comprida sem ninguém a decidir.

     Conta-se pelas TRÊS coisas ao mesmo tempo: a marca no cartão, o
     `aria-expanded` da faixa e o painel escondido. Contar só uma delas deixava
     passar o caso em que o ecrã diz uma coisa e o leitor de ecrã diz outra. */
  const umSo = await palco.js(`
    const abas = [...document.querySelectorAll('#principal .cartao-aba')];
    const olhar = () => [...document.querySelectorAll('#principal .pilha > .cartao')]
      .map((n) => ({
        marca: n.dataset.aberto === 'sim',
        aria: n.querySelector('.cartao-aba').getAttribute('aria-expanded') === 'true',
        painel: !n.querySelector('.cartao-painel').hidden,
      }));
    const passos = [];
    for (const i of [0, 2, 1, 1]) {
      abas[Math.min(i, abas.length - 1)].click();
      await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
      const v = olhar();
      passos.push({
        abertos: v.filter((x) => x.marca).length,
        coerente: v.every((x) => x.marca === x.aria && x.marca === x.painel),
      });
    }
    return passos;`);
  certo(umSo.length === 4 && umSo.every((x) => x.abertos <= 1),
    'maço: por mais cartões em que se toque, nunca fica mais do que um aberto',
    umSo.map((x, i) => `toque ${i + 1}: ${x.abertos}`).join(' · '));
  certo(umSo.every((x) => x.coerente),
    'maço: e o que se vê, o que o leitor de ecrã ouve e o painel dizem sempre o mesmo',
    umSo.map((x, i) => `toque ${i + 1}: ${x.coerente ? 'ok' : 'discordam'}`).join(' · '));
  certo(umSo[3] && umSo[3].abertos === 0,
    'maço: e tocar outra vez no que está aberto fecha-o',
    umSo[3] ? `ficaram ${umSo[3].abertos} abertos` : 'não medi');

  /* --- o que está fechado não se conduz às escuras ----------------------- */

  /* Um painel com altura zero continua a ter lá dentro botões que o teclado
     alcança e o leitor de ecrã lê: a pessoa tabula para dentro de um cartão
     fechado e fica a carregar em coisas que não vê. Por isso ele é `hidden` de
     verdade — e isto prova-o pelo que o browser diz, não pelo CSS. */
  const escondidos = await palco.js(`
    const dentroDeFechado = [...document.querySelectorAll(
      '#principal .cartao[data-aberto="nao"] .cartao-painel button, ' +
      '#principal .cartao[data-aberto="nao"] .cartao-painel a')];
    return {
      quantos: dentroDeFechado.length,
      alcancaveis: dentroDeFechado.filter((n) => n.getClientRects().length).length,
    };`);
  certo(escondidos.quantos > 0 && escondidos.alcancaveis === 0,
    'maço: os botões de um cartão fechado não são alcançáveis por teclado',
    `${escondidos.alcancaveis} de ${escondidos.quantos} ainda alcançáveis`);

  certo((await palco.contar('#principal .pilha > .adicionar')) === 1,
    'carteira: e o «juntar outro» está dentro da pilha, não pendurado a seguir a ela',
    `${await palco.contar('#principal .pilha > .adicionar')} dentro, `
    + `${await palco.contar('#principal > .adicionar')} fora`);

  /* --- falta um só carimbo ---------------------------------------------- */

  /* O singular é um caso à parte no código («falta 1 carimbo», não «faltam 1
     carimbos») e não aparece na semente. Põe-se lá. */
  const emFalta = JSON.parse(JSON.stringify(estado));
  emFalta.cartoes.find((c) => c.programaId === 'p-navalha').carimbos = 7;
  /* E o cartão que já ganhou prémio e já recomeçou: o painel tem de dizer as
     duas coisas de uma vez, sem parecer que o progresso se perdeu. */
  emFalta.cartoes.find((c) => c.programaId === 'p-gelato').carimbos = 2;
  await gravarDados(palco, emFalta);
  await palco.recarregar();
  await palco.esperar('#principal .pilha .cartao', 8000);

  const depoisDoPremio = (await lerCarteira(palco)).find((c) => c.nome === 'Gelataria Luar');
  certo(depoisDoPremio && depoisDoPremio.recomeco === 'e já levas 2 do cartão seguinte',
    'prémio à espera: o painel diz também quanto já leva do cartão seguinte',
    depoisDoPremio ? String(depoisDoPremio.recomeco) : 'o cartão desapareceu');
  certo(depoisDoPremio && depoisDoPremio.recomecoPontos === 9 && depoisDoPremio.recomecoCheios === 2,
    'prémio à espera: o recomeço mostra 2 pontos cheios em 9',
    depoisDoPremio ? `${depoisDoPremio.recomecoCheios} de ${depoisDoPremio.recomecoPontos}` : '');

  const quaseLa = (await lerCarteira(palco)).find((c) => c.nome === 'Barbearia Navalha');
  certo(quaseLa && quaseLa.rotulo === 'falta 1 carimbo',
    'a faltar um: diz «falta 1 carimbo», no singular',
    quaseLa ? String(quaseLa.rotulo) : 'o cartão desapareceu');
  certo(quaseLa && quaseLa.cheias === 7 && quaseLa.casas === 8,
    'a faltar um: a grelha mostra sete casas cheias e uma vazia',
    quaseLa ? `${quaseLa.cheias} de ${quaseLa.casas}` : '');
  certo(quaseLa && String(quaseLa.aria).includes('falta 1 carimbo'),
    'a faltar um: o rótulo lido em voz alta também está no singular',
    quaseLa ? String(quaseLa.aria) : '');

  /* --- a carteira vazia -------------------------------------------------- */

  const vazio = JSON.parse(JSON.stringify(estado));
  vazio.cartoes = []; vazio.premios = []; vazio.movimentos = [];
  await gravarDados(palco, vazio);
  await palco.recarregar();
  await palco.esperar('#principal .vazio', 8000);
  await palco.captura('02-carteira-vazia');

  certo(await palco.contar('#principal .cartao') === 0,
    'carteira vazia: não sobra nenhum cartão',
    `${await palco.contar('#principal .cartao')} cartões`);
  certo(!(await palco.ver('.faixa-premio')),
    'carteira vazia: nem a faixa do prémio');
  certo(await palco.texto('#principal .vazio h3') === 'Ainda não tens cartões',
    'carteira vazia: explica que ainda não há cartões',
    String(await palco.texto('#principal .vazio h3')));
  certo(await palco.visivel('#principal .vazio .btn'),
    'carteira vazia: tem um caminho para a frente');

  /* O BOTÃO DO VAZIO MUDOU DE DESTINO, e com ele o que esta afirmação
     persegue. Levava ao «Descobrir», que era uma montra de sítios; esse ecrã
     saiu, porque um cartão passou a ganhar-se de uma maneira só — no
     estabelecimento. Agora abre a folha do código, que é a porta que nunca
     falha: o balcão lê, e o cartão nasce ao primeiro carimbo. */
  await palco.clicar('#principal .vazio .btn');
  await palco.esperar('#folha-codigo', 8000);
  certo(await palco.contar('#codigo-qr svg') === 1,
    'carteira vazia: o botão abre mesmo o código — é a porta que não depende de haver cartaz',
    `${await palco.contar('#codigo-qr svg')} desenhos`);
  certo((await palco.textoTodo()).includes('cartaz'),
    'carteira vazia: e o ecrã diz que também se ganha um cartão apontando a câmara a um cartaz');
}
