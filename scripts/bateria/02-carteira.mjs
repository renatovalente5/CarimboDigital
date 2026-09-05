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
    return [...document.querySelectorAll('#principal .pilha > .cartao')].map((n) => {
      const grelha = n.querySelector('.carimbos');
      const pronto = n.querySelector('.pronto');
      const e = getComputedStyle(n);
      return {
        nome: n.querySelector('.cartao-nome')?.textContent.trim() ?? null,
        tipo: n.querySelector('.cartao-tipo')?.textContent.trim() ?? null,
        rotulo: n.querySelector('.cartao-rotulo')?.textContent.trim() ?? null,
        premio: n.querySelector('.cartao-premio')?.textContent.trim() ?? null,
        aria: n.getAttribute('aria-label'),
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
      };
    });`);
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
      certo(visto.aria === `${esperado.negocio.nome}. Pronto a levantar: ${premio.descricao}.`,
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
  const seletorTorrado = `#principal .pilha > .cartao:nth-of-type(${indice + 1})`;
  const passosAntes = await palco.js('return history.length');
  await palco.clicar(seletorTorrado);
  await palco.esperar('#principal .cartao-grande', 8000);
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

  /* --- o ritmo da lista -------------------------------------------------- */

  /* O «Juntar outro cartão» estava fora da pilha, como irmão dela. O `gap` é
     da pilha, por isso ele ficava colado ao último cartão, sem um milímetro
     de folga — e numa carteira com um cartão só o efeito era um bloco de cor
     com uma aba tracejada agarrada em baixo.

     Mede-se a folga entre cada item e o seguinte, e exige-se que sejam todas
     iguais: uma lista com um espaçamento diferente no fim lê-se como duas
     listas. */
  const folgas = await palco.js(`
    const itens = [...document.querySelectorAll('#principal .pilha > *')];
    const r = [];
    for (let i = 1; i < itens.length; i++) {
      r.push({
        entre: itens[i - 1].className.split(' ')[0] + '→' + itens[i].className.split(' ')[0],
        px: Math.round(itens[i].getBoundingClientRect().top
                       - itens[i - 1].getBoundingClientRect().bottom),
      });
    }
    return r;`);
  const distintas = new Set(folgas.map((f) => f.px));
  certo(folgas.length >= 2 && distintas.size === 1 && folgas[0].px > 0,
    'carteira: todos os itens da lista têm a mesma folga, incluindo o «juntar outro»',
    folgas.map((f) => `${f.entre} ${f.px}px`).join(' · '));

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

  await palco.clicar('#principal .vazio .btn');
  await palco.esperar('#principal h1.titulo-grande', 8000);
  certo(await palco.texto('#principal h1.titulo-grande') === 'Descobrir',
    'carteira vazia: o botão leva mesmo a Descobrir',
    String(await palco.texto('#principal h1.titulo-grande')));
}
