#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — capturas de ecrã

   Abre o Chrome sem interface, conduz a app até ao ecrã que se quer e tira a
   fotografia. Fala com o Chrome pelo protocolo de depuração (CDP), que é só
   WebSocket e JSON — o Node 22 já traz as duas coisas, por isso continua a
   não haver dependências.

   Um alvo só, navegado de ecrã em ecrã. Criar um alvo por ecrã parece mais
   limpo, mas em modo headless o `Page.captureScreenshot` fotografa a
   superfície composta: com vários alvos abertos saem capturas byte a byte
   iguais entre ecrãs do mesmo tamanho, e parece que as páginas estão erradas.

   Uso:  node scripts/capturar.mjs [endereço-base]
   ========================================================================= */

import { mkdirSync, writeFileSync, rmSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirChrome, novoSeparador, esperarCarregada, encontrarChrome, esperar } from './chrome.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const DESTINO = join(AQUI, '..', '_dev', 'capturas');
/* O prefixo sai do mesmo sítio que o do gerador: com domínio próprio o site
   vive na raiz, sem ele vive em /CarimboDigital/. Estava escrito à mão aqui,
   e no dia em que o domínio entrou as treze capturas passaram a ser de 404. */
const PREFIXO = existsSync(join(AQUI, '..', 'CNAME')) ? '' : '/CarimboDigital';
const BASE = process.argv[2] || `http://localhost:4321${PREFIXO}`;

/* TUDO EM `?demo=1`, e isso foi uma correcção e não uma preferência.

   Fora da demonstração, a app regista uma conta NOVA a cada captura — e uma
   conta nova tem a carteira vazia. As fotografias da app do cliente eram, há
   vários meses, o ecrã «Ainda não tens cartões» com o nome dos ecrãs de
   dentro: a conferência só olhava para o `location.pathname`, e esse estava
   sempre certo. De caminho, cada corrida deixava meia dúzia de contas vazias
   na base de produção. A demonstração tem os três cartões semeados e não sai
   do browser. */



/* --- os ecrãs a fotografar ----------------------------------------------- */

const LIMPAR = `
  localStorage.clear();
  await new Promise(res => { const d = indexedDB.deleteDatabase('carimbo');
    d.onsuccess = d.onerror = d.onblocked = res; });
  for (const r of await navigator.serviceWorker.getRegistrations()) await r.unregister();
  for (const k of await caches.keys()) await caches.delete(k);
`;

/* ESPERAR POR UM ELEMENTO, e não por um número de milissegundos.

   Um `setTimeout(1100)` é uma aposta: passa na máquina de quem o escreveu e
   falha no CI, ou passa nove vezes em dez e sai uma captura do ecrã anterior
   com o nome do ecrã seguinte. E uma captura da página errada é pior do que
   captura nenhuma — parece que o produto está avariado. */
const ATE = (seletor, tecto = 8000) => `
  for (let i = 0; i < ${Math.ceil(tecto / 100)}; i++) {
    if (document.querySelector(${JSON.stringify(seletor)})) break;
    await new Promise((r) => setTimeout(r, 100));
  }
  await new Promise((r) => setTimeout(r, 250));
`;

const ABRIR_APP = `
  const b = document.querySelector('#bv-seguinte');
  if (b) { for (let i = 0; i < 3; i++) { b.click(); await new Promise(r=>setTimeout(r,260)); } }
  await new Promise(r=>setTimeout(r,1500));
`;

const ECRAS = [
  { nome: '1-site', espera: '.site-capa, main', url: '/', largura: 1280, altura: 900 },
  { nome: '2-site-telemovel', espera: '.site-capa, main', url: '/', largura: 402, altura: 874 },
  { nome: '3-negocios', espera: 'main', url: '/negocios/', largura: 1280, altura: 900 },

  { nome: '4-abertura', espera: '#boas-vindas', url: '/app/?demo=1', largura: 402, altura: 874, limpar: true },
  { nome: '5-carteira', espera: '#principal .pilha > .cartao', url: '/app/?demo=1', largura: 402, altura: 874, limpar: true, guiao: ABRIR_APP },
  {
    nome: '6-codigo', espera: '#principal .identidade-numero, #principal canvas, #principal svg', url: '/app/?demo=1', largura: 402, altura: 874,
    guiao: `${ABRIR_APP}
            document.querySelectorAll('.barra-item')[2].click();
            await new Promise(r=>setTimeout(r,900));`,
  },
  {
    nome: '7-cartao', espera: '#principal .cartao-grande', url: '/app/?demo=1', largura: 402, altura: 1180,
    guiao: `${ABRIR_APP}
            const c = [...document.querySelectorAll('#principal .pilha > .cartao')]
                        .find(x => x.textContent.includes('Café Torrado'));
            c.click();
            ${ATE('#principal .cartao-grande')}`,
  },
  {
    nome: '8-descobrir', espera: '#principal .lista .linha, #principal .cartao', url: '/app/?demo=1', largura: 402, altura: 874,
    guiao: `${ABRIR_APP}
            document.querySelectorAll('.barra-item')[1].click();
            await new Promise(r=>setTimeout(r,900));`,
  },
  {
    nome: '9-premios', espera: '#principal .pilha, #principal .lista, #principal .vazio', url: '/app/?demo=1', largura: 402, altura: 874,
    guiao: `${ABRIR_APP}
            document.querySelectorAll('.barra-item')[3].click();
            await new Promise(r=>setTimeout(r,900));`,
  },

  { nome: '10-balcao-entrada', espera: '#porta-espreitar', url: '/balcao/', largura: 402, altura: 874, limpar: true },
  /* O BALCÃO ABRE-SE EM `?demo=1`, e não com um clique no botão de espreitar:
     esse botão faz `location.href = '?demo=1'`, ou seja NAVEGA — e o guião
     morria a meio com «Inspected target navigated or closed». Era o que
     estava escrito aqui antes com outro nome: um `#entrar-demo` que nunca
     existiu, e um `?.click()` que não se queixa de nada. */
  {
    nome: '11-balcao-carimbado', espera: '#principal .visor, #principal .resultado',
    url: '/balcao/?demo=1', largura: 402, altura: 874, limpar: true,
    /* O balcão sozinho não tem clientes — quem os cria é a app do cliente.
       Para a captura, cria-se um pela mesma camada de dados. */
    guiao: `const { api } = await import('../js/api.js');
            const r = await api.registarCliente();
            await api.semear(r.cliente.id);
            document.querySelector('#entrada-acoes .btn-cheio').click();
            await new Promise(res=>setTimeout(res,1700));
            document.querySelector('#botao-manual').click();
            await new Promise(res=>setTimeout(res,340));
            document.querySelector('#campo-numero').value = r.cliente.publico;
            document.querySelector('.painel-folha .btn-cheio').click();
            await new Promise(res=>setTimeout(res,1600));`,
  },
  {
    nome: '12-balcao-hoje', espera: '#principal .numeros',
    url: '/balcao/?demo=1', largura: 402, altura: 1000,
    guiao: `document.querySelector('#entrada-acoes .btn-cheio')?.click();
            await new Promise(res=>setTimeout(res,1600));
            document.querySelectorAll('.barra-item')[1].click();
            ${ATE('#principal .numeros')}`,
  },
  {
    nome: '13-balcao-cartao', espera: '#previa',
    url: '/balcao/?demo=1', largura: 402, altura: 1240,
    guiao: `document.querySelector('#entrada-acoes .btn-cheio')?.click();
            await new Promise(res=>setTimeout(res,1600));
            document.querySelectorAll('.barra-item')[3].click();
            ${ATE('#previa')}`,
  },

  /* Quem carimba. A secção é a última do ecrã do cartão, por isso a captura
     tem de lá ir ter — e esperar pela lista, que chega depois do resto. */
  {
    /* SEM `limpar`, como a 12 e a 13: a sessão do balcão vem da captura 11, e
       limpá-la aqui devolvia o ecrã de entrada com o nome deste ecrã. */
    nome: '14-quem-carimba', espera: '#lista-operadores .linha',
    /* A secção é a última de um ecrã de dois mil píxeis: recorta-se. */
    recorte: '#seccao-quem-carimba', folga: 20,
    url: '/balcao/?demo=1', largura: 402, altura: 2200,
    guiao: `document.querySelector('#entrada-acoes .btn-cheio')?.click();
            await new Promise((r)=>setTimeout(r,1600));
            document.querySelectorAll('.barra-item')[3].click();
            /* ESPERA-SE PELA LISTA, e não por um número de milissegundos: ela
               vem de um pedido próprio, DEPOIS de o ecrã estar pintado, e o
               \`scrollIntoView\` chegava primeiro — a captura saía no topo do
               ecrã, com a secção lá em baixo fora do enquadramento. */
            for (let i = 0; i < 60; i++) {
              if (document.querySelector('#lista-operadores .linha b')) break;
              await new Promise((r)=>setTimeout(r,100));
            }
            /* A BARRA DE BAIXO É FIXA, e a captura para lá do enquadramento
               desenha-a por cima do recorte, a meio da secção. Esconde-se para
               esta fotografia: o que ela documenta é a secção, e a barra está
               nas outras todas. (Sem crases neste comentário: ele vive dentro
               de um template literal, e uma crase fecha-o.) */
            document.querySelector('#barra').style.visibility = 'hidden';
            await new Promise((r)=>setTimeout(r,400));`,
  },

  /* O ecrã de quem mudou de telemóvel. Não estava aqui porque, até agora, o
     botão das boas-vindas não abria nada em demonstração. */
  {
    nome: '15-mudei-de-telemovel', espera: '#painel', url: '/app/?demo=1', largura: 402, altura: 1000, limpar: true,
    guiao: `document.querySelector('#bv-saltar').click();
            ${ATE('#painel .btn-google, #painel #campo-email')}`,
  },
  /* O mapa do «Descobrir», que é a razão de este ecrã ter mudado. */
  {
    nome: '17-mapa-descobrir', espera: '#mapa-descobrir .mapa-pino',
    url: '/app/?demo=1', largura: 402, altura: 1100, limpar: true,
    guiao: `${ABRIR_APP}
            document.querySelectorAll('.barra-item')[1].click();
            ${ATE('#mapa-descobrir .mapa-pino')}
            await new Promise((r)=>setTimeout(r,700));`,
  },
  /* E o ecrã onde o dono marca onde fica o estabelecimento. */
  {
    nome: '18-onde-fica', espera: '.ponto-alvo',
    url: '/balcao/?demo=1', largura: 402, altura: 1100, limpar: true,
    guiao: `document.querySelector('#entrada-acoes .btn-cheio')?.click();
            await new Promise((r)=>setTimeout(r,1600));
            document.querySelectorAll('.barra-item')[3].click();
            ${ATE('#linha-onde-fica .linha b')}
            document.querySelector('#linha-onde-fica .linha').click();
            ${ATE('.ponto-alvo')}
            await new Promise((r)=>setTimeout(r,1000));`,
  },

  /* E o mesmo painel pelo outro lado: guardar em vez de recuperar. NÃO se
     carrega em porta nenhuma aqui — fora da demonstração, tocar na Google sai
     do site e a captura acaba noutro ecrã com o nome deste. */
  {
    nome: '16-guardar-a-conta', espera: '#painel', url: '/app/?demo=1', largura: 402, altura: 1100, limpar: true,
    guiao: `${ABRIR_APP}
            document.querySelectorAll('.barra-item')[4].click();
            ${ATE('#principal .lista .linha')}
            document.querySelector('#principal .lista .linha').click();
            ${ATE('#painel .btn-google, #painel #campo-email')}`,
  },
];

/* --- a correr ------------------------------------------------------------ */

if (!encontrarChrome()) { console.error('Não encontrei o Chrome.'); process.exit(1); }

/* A pasta é limpa de propósito: se um ecrã for renomeado, o ficheiro antigo
   fica lá e passa a parecer uma captura desta volta. */
rmSync(DESTINO, { recursive: true, force: true });
mkdirSync(DESTINO, { recursive: true });

const { enviar, fechar } = await abrirChrome();
const { targetId, sessionId } = await novoSeparador(enviar);

let maus = 0;
for (const ecra of ECRAS) {
  await enviar('Emulation.setDeviceMetricsOverride', {
    width: ecra.largura, height: ecra.altura,
    deviceScaleFactor: 2, mobile: ecra.largura < 700,
  }, sessionId);

  /* Limpa-se ANTES de navegar para a página que interessa: limpar depois
     obriga a um `location.reload()`, e a partir daí não se sabe em que
     estado a página está quando se dispara. */
  if (ecra.limpar) {
    await enviar('Page.navigate', { url: BASE + ecra.url }, sessionId);
    await esperarCarregada(enviar, sessionId);
    await enviar('Runtime.evaluate', {
      expression: `(async () => { ${LIMPAR} })()`, awaitPromise: true,
    }, sessionId).catch(() => {});
  }

  await enviar('Page.navigate', { url: BASE + ecra.url }, sessionId);
  await esperarCarregada(enviar, sessionId);
  await esperar(1100);

  if (ecra.guiao) {
    await enviar('Runtime.evaluate', {
      expression: `(async () => { ${ecra.guiao} })()`, awaitPromise: true,
    }, sessionId).catch((e) => console.warn(`  (guião de ${ecra.nome}: ${e.message})`));
    await esperar(450);
  }

  /* Confirma-se onde é que se está antes de disparar. Uma captura da página
     errada é pior do que nenhuma — parece que o produto está avariado.

     E NÃO CHEGA O ENDEREÇO. O guião do balcão carregava em `#entrar-demo`, que
     nunca existiu — o botão chama-se `#porta-espreitar` —, e o `?.click()` de
     uma coisa que não existe não se queixa. Três capturas do balcão eram o
     ECRÃ DE ENTRADA com o nome do ecrã de dentro, e ninguém notou porque o
     endereço estava certo: `/balcao/` é o mesmo antes e depois de entrar.
     Por isso o `espera` de cada ecrã diz TAMBÉM o que tem de estar lá. */
  const onde = await enviar('Runtime.evaluate', {
    expression: 'location.pathname', returnByValue: true,
  }, sessionId).catch(() => null);
  const caminho = onde?.result?.value || '';
  const esperado = new URL(BASE + ecra.url).pathname;
  let certo = caminho === esperado;
  let porque = certo ? '' : `está em ${caminho}, esperava ${esperado}`;

  if (certo && ecra.espera) {
    const viu = await enviar('Runtime.evaluate', {
      expression: `Boolean(document.querySelector(${JSON.stringify(ecra.espera)}))`,
      returnByValue: true,
    }, sessionId).catch(() => null);
    if (!viu?.result?.value) { certo = false; porque = `não há «${ecra.espera}» no ecrã`; }
  }
  if (!certo) maus++;

  /* RECORTAR, em vez de rolar. Este script fotografa sempre a partir do topo
     do documento — é por isso que os ecrãs compridos usam uma `altura` maior em
     vez de um `scrollIntoView`, que não faz diferença nenhuma à captura. Para
     documentar uma SECÇÃO que vive no fim de um ecrã comprido, nenhuma das
     duas serve: ou sai o topo, ou sai uma tira de 2000 píxeis com a secção
     escondida lá em baixo. Mede-se a secção e pede-se só aquele rectângulo. */
  let clip;
  if (ecra.recorte) {
    const caixa = await enviar('Runtime.evaluate', {
      expression: `(() => {
        const n = document.querySelector(${JSON.stringify(ecra.recorte)});
        if (!n) return null;
        const r = n.getBoundingClientRect();
        const folga = ${ecra.folga ?? 16};
        return { x: Math.max(0, r.x - folga), y: Math.max(0, r.y + scrollY - folga),
                 width: Math.min(innerWidth, r.width + folga * 2),
                 height: r.height + folga * 2 };
      })()`, returnByValue: true,
    }, sessionId).catch(() => null);
    const c = caixa?.result?.value;
    /* O `maus++` fica para a linha de baixo, que é quem o conta uma vez só.
       Estava aqui também, e uma captura que falhasse o recorte contava duas —
       o resumo chegou a dizer «-1/16 capturas na página certa», que é um
       número que não quer dizer nada. */
    if (c) clip = { ...c, scale: 2 };
    else { certo = false; porque = `não há «${ecra.recorte}» para recortar`; }
  }

  const { data } = await enviar('Page.captureScreenshot',
    clip ? { format: 'png', clip, captureBeyondViewport: true } : { format: 'png' },
    sessionId);
  writeFileSync(join(DESTINO, `${ecra.nome}.png`), Buffer.from(data, 'base64'));
  console.log(`  ${certo ? ' ' : '✗'} ${ecra.nome}.png  ${ecra.largura}x${ecra.altura}`
    + (certo ? '' : `  (${porque})`));
}

await enviar('Target.closeTarget', { targetId }).catch(() => {});
fechar();

console.log(`\n${ECRAS.length - maus}/${ECRAS.length} capturas na página certa, em _dev/capturas/.`);
process.exit(maus ? 1 : 0);
