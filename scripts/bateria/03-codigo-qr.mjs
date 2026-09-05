/* =========================================================================
   Bateria · 03 — o ecrã do código QR

   É o ecrã que justifica a app: a pessoa levanta o telemóvel ao balcão e o
   código tem de estar lá, desenhado, legível, e vivo — a rodar de quinze em
   quinze segundos para que uma fotografia ao ecrã não valha um carimbo.

   Três coisas que só se provam a conduzir o browser a sério:

   · QUE O QR É MESMO UM QR. Uma caixa branca, uma caixa preta ou um `<svg>`
     vazio passam por «existe um código». Aqui não: conta-se os módulos
     escuros e verifica-se os três olhos do QR módulo a módulo. Se o desenho
     não tiver a forma de um código, ninguém o lê ao balcão.

   · QUE O CÓDIGO RODA SOZINHO. Compara-se o desenho antes e depois da
     fronteira dos 15 segundos. Um código que não roda é um código que se
     fotografa.

   · QUE O RELÓGIO PÁRA AO FECHAR. Esta é a mais importante e a mais
     invisível: um `setTimeout` esquecido continua a assinar códigos e a
     acordar o telemóvel a toda a hora, sem nada no ecrã que o denuncie.
     Espiam-se `setTimeout`/`setInterval` ANTES de abrir e conta-se quantos
     ficaram por limpar depois de fechar.
   ========================================================================= */

export const nome = '03 · O ecrã do código QR';
export const ecra = { largura: 390, altura: 844 };

const JANELA = 15;          /* segundos de vida de cada código, como na api.js */
const ANEL = 81.7;          /* perímetro do anel, como no app.js */

const dorme = (ms) => new Promise((r) => setTimeout(r, ms));

/** Passa as boas-vindas, se lá estiverem. */
async function passarBoasVindas(palco) {
  if (!(await palco.ver('#boas-vindas'))) return;
  for (let i = 0; i < 8 && await palco.visivel('#boas-vindas'); i++) {
    await palco.clicar('#bv-seguinte');
  }
}

/* -------------------------------------------------------------------------
   Espião dos temporizadores

   Embrulha `setTimeout`/`setInterval` e guarda os que estão pendentes. O
   embrulho tira o registo ANTES de correr o tratador, por isso o que sobra
   na lista é mesmo o que está agendado e ninguém limpou.
   ------------------------------------------------------------------------- */

const INSTALAR_ESPIA = `
  if (!window.__espiaTempo) {
    const espia = { seq: 0, vivos: new Map() };
    const st = window.setTimeout, ct = window.clearTimeout;
    const si = window.setInterval, ci = window.clearInterval;
    window.setTimeout = function (fn, atraso, ...resto) {
      const n = ++espia.seq;
      let id;
      id = st.call(window, function () {
        espia.vivos.delete(id);
        return typeof fn === 'function' ? fn.apply(this, arguments) : undefined;
      }, atraso, ...resto);
      espia.vivos.set(id, { n, tipo: 'setTimeout', atraso: Number(atraso) || 0 });
      return id;
    };
    window.clearTimeout = function (id) { espia.vivos.delete(id); return ct.call(window, id); };
    window.setInterval = function (fn, atraso, ...resto) {
      const n = ++espia.seq;
      const id = si.call(window, fn, atraso, ...resto);
      espia.vivos.set(id, { n, tipo: 'setInterval', atraso: Number(atraso) || 0 });
      return id;
    };
    window.clearInterval = function (id) { espia.vivos.delete(id); return ci.call(window, id); };
    window.__espiaTempo = espia;
  }
  return window.__espiaTempo.seq;
`;

/** Os temporizadores ainda agendados que nasceram depois da marca. */
function pendentesDesde(palco, marca) {
  return palco.js(`
    const e = window.__espiaTempo;
    return [...e.vivos.values()].filter((v) => v.n > ${marca})
      .map((v) => v.tipo + '(' + v.atraso + ' ms)');
  `);
}

/* -------------------------------------------------------------------------
   Ler o desenho do QR

   O `qrParaSVG` desenha um `<path>` com um quadradinho por módulo escuro
   («M<c> <l>h1v1h-1z»), por isso o caminho é legível: dá para reconstruir a
   matriz e verificar a forma sem descodificar nada.
   ------------------------------------------------------------------------- */

const LER_QR = `
  const svg = document.querySelector('#codigo-qr svg');
  if (!svg) return { erro: 'não há svg dentro de #codigo-qr' };
  const caminho = svg.querySelector('path');
  const d = caminho ? caminho.getAttribute('d') || '' : '';
  const vb = (svg.getAttribute('viewBox') || '').split(/\\s+/).map(Number);
  const lado = vb[2] || 0;

  const escuros = new Set();
  for (const m of d.matchAll(/M(\\d+) (\\d+)h1v1h-1z/g)) escuros.add(m[1] + ',' + m[2]);

  /* A margem sai da diferença entre o viewBox e a maior coordenada usada. */
  let maior = -1, menor = Infinity;
  for (const p of escuros) {
    const [c, l] = p.split(',').map(Number);
    maior = Math.max(maior, c, l); menor = Math.min(menor, c, l);
  }
  const margem = menor;
  const tamanho = lado - margem * 2;

  /* Os três «olhos»: anel escuro de 7×7, um vazio de 1, um miolo de 3×3.
     É a forma que o leitor procura primeiro — se falhar, não há leitura. */
  function olho(c0, l0) {
    let erros = 0;
    for (let l = 0; l < 7; l++) {
      for (let c = 0; c < 7; c++) {
        const deveSerEscuro = l === 0 || l === 6 || c === 0 || c === 6
          || (l >= 2 && l <= 4 && c >= 2 && c <= 4);
        const e = escuros.has((c0 + c + margem) + ',' + (l0 + l + margem));
        if (e !== deveSerEscuro) erros++;
      }
    }
    return erros;
  }

  return {
    d, comprimento: d.length, lado, margem, tamanho,
    escuros: escuros.size,
    olhoCimaEsq: olho(0, 0),
    olhoCimaDir: olho(tamanho - 7, 0),
    olhoBaixoEsq: olho(0, tamanho - 7),
    rotulo: svg.getAttribute('aria-label'),
  };
`;

/** O quanto do anel já foi comido — cresce de 0 até 81.7 ao longo da janela. */
function lerAnel(palco) {
  return palco.js(`
    const arco = document.querySelector('.codigo-anel .frente');
    if (!arco) return null;
    return parseFloat(getComputedStyle(arco).strokeDashoffset);
  `);
}

export async function correr(palco, certo) {
  await palco.ir('/app/?demo=1');
  await passarBoasVindas(palco);
  await palco.esperar('#barra');

  /* Um separador escondido não pinta nem corre `requestAnimationFrame`, e
     este módulo vive de comparar desenhos ao longo do tempo: se a página
     estivesse escondida as medições mentiam todas. */
  const visibilidade = await palco.js('return document.visibilityState');
  certo(visibilidade === 'visible',
    'a página está à vista (senão o relógio e o anel não correm)', String(visibilidade));

  /* --- o espião, antes de haver ecrã nenhum ------------------------------ */
  const marca = await palco.js(INSTALAR_ESPIA);

  /* --- abrir pelo separador «Código» ------------------------------------- */
  const terceiro = await palco.texto('#barra .barra-item:nth-child(3)');
  certo(terceiro === 'Código',
    'o 3.º separador da barra é o «Código»', String(terceiro));

  await palco.clicar('#barra .barra-item:nth-child(3)');
  certo(await palco.visivel('#folha-codigo'),
    'o separador «Código» abre o ecrã do código');

  certo(await palco.atributo('#folha-codigo', 'role') === 'dialog'
    && await palco.atributo('#folha-codigo', 'aria-modal') === 'true',
    'o ecrã do código anuncia-se como diálogo modal',
    `role=${await palco.atributo('#folha-codigo', 'role')} `
    + `aria-modal=${await palco.atributo('#folha-codigo', 'aria-modal')}`);

  /* Modal a sério tapa a barra: se a barra continuasse a apanhar cliques, a
     pessoa saía do código sem querer enquanto o mostra ao balcão. */
  const porCimaDaBarra = await palco.js(`
    const barra = document.querySelector('#barra .barra-item:nth-child(3)');
    const r = barra.getBoundingClientRect();
    const em = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
    const folha = document.querySelector('#folha-codigo');
    if (!em || !folha) return 'nada';
    return folha.contains(em) || em === folha ? 'folha' : em.tagName.toLowerCase();
  `);
  certo(porCimaDaBarra === 'folha',
    'o ecrã do código tapa mesmo a barra de navegação', String(porCimaDaBarra));

  /* --- o QR está desenhado ----------------------------------------------- */


  /* PROBE2 */
  await palco.js(`
    window.__ev = [];
    for (const t of ['transitionrun','transitionstart','transitionend','transitioncancel']) {
      document.addEventListener(t, (ev) => {
        if (ev.target && ev.target.classList && ev.target.classList.contains('frente')) {
          window.__ev.push(t + '@' + Math.round(performance.now()) + ' ' + ev.propertyName);
        }
      }, true);
    }
    window.__rot = [];
    window.__ultimo = null;
    window.__vigia = setInterval(() => {
      const p = document.querySelector('#codigo-qr path');
      const d = p ? p.getAttribute('d') : null;
      if (d && d !== window.__ultimo) { window.__rot.push(Math.round(performance.now())); window.__ultimo = d; }
    }, 100);
    return true;
  `);
  console.log('--- a observar 34 s sem tocar em estilos ---');
  await dorme(34000);
  console.log('EVENTOS', JSON.stringify(await palco.js('clearInterval(window.__vigia); return window.__ev')));
  console.log('ROTACOES', JSON.stringify(await palco.js('return window.__rot')));
  console.log('ANEL FINAL', await lerAnel(palco));
  /* FIM PROBE2 */
  const qr = await palco.js(LER_QR);
  certo(!qr.erro, 'o QR é desenhado como SVG dentro de #codigo-qr', qr.erro || '');

  certo(qr.tamanho >= 21 && (qr.tamanho - 21) % 4 === 0,
    'o QR tem um tamanho de versão válida (21, 25, 29…)', `tamanho=${qr.tamanho}`);

  /* Uma caixa vazia dá zero módulos e uma caixa cheia dá-os todos: um código
     verdadeiro anda perto de metade. */
  const fatia = qr.escuros / (qr.tamanho * qr.tamanho);
  certo(fatia > 0.3 && fatia < 0.6,
    'o QR tem módulos escuros a mais de zero e a menos que tudo',
    `${qr.escuros} de ${qr.tamanho * qr.tamanho} (${(fatia * 100).toFixed(1)} %)`);

  certo(qr.olhoCimaEsq === 0 && qr.olhoCimaDir === 0 && qr.olhoBaixoEsq === 0,
    'os três olhos do QR estão desenhados como manda a norma',
    `erros: cima-esq=${qr.olhoCimaEsq} cima-dir=${qr.olhoCimaDir} baixo-esq=${qr.olhoBaixoEsq}`);

  const caixaQr = await palco.medir('#codigo-qr svg');
  certo(caixaQr && caixaQr.largura > 250 && Math.abs(caixaQr.largura - caixaQr.altura) < 2,
    'o QR é grande e quadrado no ecrã',
    caixaQr ? `${Math.round(caixaQr.largura)}×${Math.round(caixaQr.altura)}` : 'sem caixa');

  /* --- o número por baixo, para quando a câmara não colabora ------------- */
  const guardado = await palco.armazenamento();
  /* Em `?demo=1` as chaves vivem noutro espaço — `carimbo-demo:` — para
     experimentar a demonstração não mexer na conta a sério. Ler
     `carimbo:cliente` dava sempre undefined e o teste acusava a app de não
     mostrar o número que ela estava a mostrar. */
  const publico = JSON.parse(
    guardado['carimbo-demo:cliente'] || guardado['carimbo:cliente'] || '{}').publico;
  const numero = await palco.texto('.codigo-id');
  certo(!!publico && numero === publico,
    'o número por baixo do QR é o código público do cliente',
    `ecrã=«${numero}» guardado=«${publico}»`);

  await palco.captura('03-codigo-aberto');

  /* --- o código roda sozinho --------------------------------------------- */
  const dInicial = qr.d;
  const arranque = Date.now();
  let dNovo = dInicial;
  /* Uma janela inteira mais folga: o ecrã pode ter aberto a meio de uma. */
  while (Date.now() - arranque < (JANELA + 2) * 1000 && dNovo === dInicial) {
    await dorme(250);
    dNovo = await palco.js(`
      const p = document.querySelector('#codigo-qr path');
      return p ? p.getAttribute('d') : null;
    `);
  }
  const demorou = (Date.now() - arranque) / 1000;
  certo(dNovo !== dInicial && !!dNovo,
    `o código roda sozinho ao fim da janela de ${JANELA} s`,
    `esperei ${demorou.toFixed(1)} s e o desenho não mudou`);
  certo(demorou <= JANELA + 1.5,
    'a rodagem acontece dentro da janela, não mais tarde',
    `${demorou.toFixed(1)} s`);

  /* O código muda; a pessoa não. O número tem de ficar igual. */
  certo(await palco.texto('.codigo-id') === publico,
    'ao rodar, o número do cliente mantém-se',
    `${await palco.texto('.codigo-id')} (era ${publico})`);

  const qrDepois = await palco.js(LER_QR);
  certo(qrDepois.olhoCimaEsq === 0 && qrDepois.olhoCimaDir === 0 && qrDepois.olhoBaixoEsq === 0,
    'o código novo continua a ser um QR bem formado',
    `erros: ${qrDepois.olhoCimaEsq}/${qrDepois.olhoCimaDir}/${qrDepois.olhoBaixoEsq}`);

  /* --- o cronómetro desce ------------------------------------------------ */
  /* O anel mede-se por amostragem, e não com duas leituras a três segundos
     uma da outra. Entre o fim de uma janela e o desenho da seguinte há uns
     sessenta milissegundos em que o arco está parado no fim — e duas
     leituras que caiam as duas nessa fresta dão o mesmo número e parecem um
     anel avariado. Sete amostras ao longo de seis segundos atravessam
     qualquer fronteira. */
  const amostras = [];
  for (let i = 0; i < 20; i++) { amostras.push(await lerAnel(palco)); await dorme(500); }
  const lidas = amostras.filter((x) => x !== null && Number.isFinite(x));
  certo(lidas.length === amostras.length,
    'o anel do cronómetro existe no ecrã em todas as amostras',
    `${lidas.length}/${amostras.length}`);

  /* Pergunta-se se o anel MEXE, e não quanto mexeu num intervalo fixo. Duas
     leituras a três segundos uma da outra podiam cair as duas na fresta em
     que o arco está parado no fim de uma janela, e acusar de avariado um
     anel que estava a andar. Dez segundos de amostras atravessam sempre
     pelo menos uma janela inteira. */
  const distintas = new Set(lidas.map((x) => x.toFixed(1))).size;
  const amplitude = Math.max(...lidas) - Math.min(...lidas);
  certo(distintas >= 5 && amplitude > 20,
    'o cronómetro desce com o tempo (o anel esvazia-se)',
    `${distintas} valores distintos, amplitude ${amplitude.toFixed(1)} de ${ANEL}`);

  /* E que os valores ficam todos dentro do perímetro: um arco com offset
     acima do comprimento total desapareceria. */
  certo(Math.max(...lidas) <= ANEL + 0.5 && Math.min(...lidas) >= -0.5,
    'e nunca sai do perímetro do círculo',
    `${Math.min(...lidas).toFixed(1)}..${Math.max(...lidas).toFixed(1)}`);

  /* --- fechar pelo × ------------------------------------------------------ */
  await palco.clicar('.codigo-fechar');
  await palco.sumir('#folha-codigo', 3000);
  certo(!(await palco.ver('#folha-codigo')),
    'o × fecha o ecrã do código');
  certo(await palco.visivel('#barra .barra-item:nth-child(3)'),
    'depois de fechar volta-se à carteira, com a barra à vista');

  /* --- e o relógio pára mesmo -------------------------------------------- */
  await dorme(1500);
  const logoDepois = await pendentesDesde(palco, marca);
  certo(logoDepois.length === 0,
    'fechar não deixa nenhum temporizador agendado',
    logoDepois.join(', '));

  /* Uma janela inteira de silêncio: um relógio esquecido tem de reaparecer
     aqui, porque volta a marcar-se a cada 15 segundos. */
  const seqAntesDoSilencio = await palco.js('return window.__espiaTempo.seq');
  await dorme((JANELA + 2) * 1000);
  const aindaPendentes = await pendentesDesde(palco, marca);
  const seqDepoisDoSilencio = await palco.js('return window.__espiaTempo.seq');
  certo(aindaPendentes.length === 0,
    `passada uma janela de ${JANELA} s com o ecrã fechado, continua sem temporizadores`,
    aindaPendentes.join(', '));
  certo(seqDepoisDoSilencio === seqAntesDoSilencio,
    'com o ecrã fechado a app não volta a marcar nada',
    `marcou mais ${seqDepoisDoSilencio - seqAntesDoSilencio}`);
  certo(!(await palco.ver('#folha-codigo')),
    'o ecrã do código não volta sozinho depois de fechado');

  /* --- reabrir e fechar pelo botão «Fechar» ------------------------------- */
  const marcaDois = await palco.js('return window.__espiaTempo.seq');
  await palco.clicar('#barra .barra-item:nth-child(3)');
  certo(await palco.visivel('#folha-codigo'),
    'o ecrã do código volta a abrir depois de fechado');
  certo(await palco.contar('#codigo-qr svg') === 1,
    'à segunda abertura há um (e um só) QR desenhado',
    String(await palco.contar('#codigo-qr svg')));

  await palco.clicar('#folha-codigo .btn');
  await palco.sumir('#folha-codigo', 3000);
  certo(!(await palco.ver('#folha-codigo')),
    'o botão «Fechar» também fecha o ecrã do código');

  await dorme(1500);
  const depoisDaSegunda = await pendentesDesde(palco, marcaDois);
  certo(depoisDaSegunda.length === 0,
    'abrir e fechar uma segunda vez também não deixa relógios atrás',
    depoisDaSegunda.join(', '));

  await palco.captura('03-codigo-fechado');
}
