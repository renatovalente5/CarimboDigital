#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — a bateria de browser

   O Worker já tem 66 testes. O QR está provado contra 320 matrizes. Mas
   ninguém tinha ainda conduzido a interface: abrir a app, carregar nos
   botões, escrever nos campos e ver o que aparece. É o que isto faz.

   Três decisões que valem a pena explicar:

   · CONDUZ-SE COM O RATO, não com `elemento.click()`. Um clique de JavaScript
     dispara mesmo em cima de um elemento tapado por outro, invisível, ou de
     zero píxeis — e depois o teste passa e a pessoa não consegue carregar no
     botão. Aqui mede-se o elemento, aponta-se ao centro, verifica-se quem
     está lá com `elementFromPoint`, e só então se carrega.

   · QUALQUER EXCEPÇÃO POR APANHAR REPROVA O MÓDULO. É a rede de segurança
     que apanha a classe de defeito mais cara desta app: a promessa que
     rebenta dentro de um tratador de clique, ninguém vê, e o botão fica
     morto. Erros de consola também contam, salvo os que o módulo desculpar.

   · CADA MÓDULO CORRE NUM SEPARADOR NOVO E COM O ARMAZENAMENTO LIMPO. Sem
     isto, o segundo teste herda a conta que o primeiro criou e passa por
     razões erradas — ou reprova por razões que não são dele.

   Os módulos vivem em scripts/bateria/. Cada um exporta:
     export const nome = 'Carteira do cliente';
     export const ecra = { largura: 390, altura: 844 };   // opcional
     export const desculpar = [/favicon/];                // opcional
     export async function correr(palco, certo) { ... }

   Uso:
     node scripts/bateria.mjs                 — corre tudo
     node scripts/bateria.mjs carteira perfil — corre só os que casarem
     BATERIA_CAPTURAS=1 node scripts/bateria.mjs — guarda as fotografias
   ========================================================================= */

import { spawn } from 'node:child_process';
import { readdirSync, existsSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { abrirChrome, novoSeparador, esperar } from './chrome.mjs';

const AQUI = dirname(fileURLToPath(import.meta.url));
const RAIZ = join(AQUI, '..');
const MODULOS = join(AQUI, 'bateria');
const CAPTURAS = join(RAIZ, '_dev', 'bateria');
const BASE = existsSync(join(RAIZ, 'CNAME')) ? '' : '/CarimboDigital';
const GUARDAR_CAPTURAS = process.env.BATERIA_CAPTURAS === '1';

/* =========================================================================
   O servidor
   Sobe um servidor próprio numa porta sorteada em vez de assumir que já há
   um a andar. Assim isto corre no CI sem preparação nenhuma, e não vai
   buscar a versão que outra pessoa tem aberta no browser.
   ========================================================================= */

async function subirServidor() {
  const porta = 4400 + Math.floor(Math.random() * 500);
  const processo = spawn(process.execPath, [join(AQUI, 'servir.mjs')], {
    env: { ...process.env, PORTA: String(porta) },
    stdio: 'ignore',
  });
  const matar = () => { try { processo.kill(); } catch { /* já morreu */ } };
  process.once('exit', matar);

  const limite = Date.now() + 10000;
  for (;;) {
    try {
      const r = await fetch(`http://127.0.0.1:${porta}${BASE}/`);
      if (r.ok) break;
    } catch { /* ainda a subir */ }
    if (Date.now() > limite) { matar(); throw new Error('O servidor não subiu.'); }
    await esperar(120);
  }
  return { url: `http://127.0.0.1:${porta}`, matar };
}

/* =========================================================================
   O palco — o que cada módulo recebe para conduzir a página
   ========================================================================= */

class Palco {
  constructor(enviar, sessionId, servidor, desculpar) {
    this.enviar = enviar;
    this.sessao = sessionId;
    this.servidor = servidor;
    this.desculpar = desculpar || [];
    this.excepcoes = [];
    this.consola = [];
    this.lixo = [];
    this.capturas = [];
  }

  /* --- avaliar ---------------------------------------------------------- */

  /** Corre uma expressão na página e devolve o valor. Await incluído. */
  async js(expressao) {
    const r = await this.enviar('Runtime.evaluate', {
      expression: `(async () => { ${expressao} })()`,
      awaitPromise: true, returnByValue: true,
    }, this.sessao);
    if (r.exceptionDetails) {
      throw new Error(`na página: ${r.exceptionDetails.exception?.description
        || r.exceptionDetails.text}`);
    }
    return r.result.value;
  }

  /* --- navegação -------------------------------------------------------- */

  /** Vai para um caminho da app (já com o prefixo do GitHub Pages). */
  async ir(caminho, { esperarPor = 'body', tecto = 10000 } = {}) {
    const url = this.servidor + BASE + caminho;
    await this.enviar('Page.navigate', { url }, this.sessao);
    await this.pronta(tecto);
    if (esperarPor) await this.esperar(esperarPor, tecto);
    /* Uma volta de pintura, para o que é desenhado por JavaScript assentar. */
    await esperar(120);
  }

  async pronta(tecto = 10000) {
    const limite = Date.now() + tecto;
    for (;;) {
      const r = await this.js('return document.readyState').catch(() => null);
      if (r === 'complete') return true;
      if (Date.now() > limite) return false;
      await esperar(100);
    }
  }

  async recarregar() {
    await this.enviar('Page.reload', { ignoreCache: false }, this.sessao);
    await this.pronta();
    await esperar(200);
  }

  async voltarAtras() {
    await this.js('history.back()');
    await esperar(300);
  }

  /* --- ler a página ----------------------------------------------------- */

  async ver(seletor) {
    return this.js(`return !!document.querySelector(${JSON.stringify(seletor)})`);
  }

  async contar(seletor) {
    return this.js(`return document.querySelectorAll(${JSON.stringify(seletor)}).length`);
  }

  async texto(seletor) {
    return this.js(`const n = document.querySelector(${JSON.stringify(seletor)});
      return n ? n.textContent.replace(/\\s+/g, ' ').trim() : null`);
  }

  async textos(seletor) {
    return this.js(`return [...document.querySelectorAll(${JSON.stringify(seletor)})]
      .map(n => n.textContent.replace(/\\s+/g, ' ').trim())`);
  }

  /** Todo o texto visível da página — para procurar uma frase sem saber onde está. */
  async textoTodo() {
    return this.js('return document.body.innerText.replace(/\\s+/g, " ").trim()');
  }

  async atributo(seletor, nome) {
    return this.js(`const n = document.querySelector(${JSON.stringify(seletor)});
      return n ? n.getAttribute(${JSON.stringify(nome)}) : null`);
  }

  async valor(seletor) {
    return this.js(`const n = document.querySelector(${JSON.stringify(seletor)});
      return n ? n.value : null`);
  }

  async estilo(seletor, propriedade) {
    return this.js(`const n = document.querySelector(${JSON.stringify(seletor)});
      return n ? getComputedStyle(n).getPropertyValue(${JSON.stringify(propriedade)}) : null`);
  }

  /**
   * Está mesmo à vista?
   *
   * Não se pergunta por `offsetParent`: num elemento `position: fixed` vale
   * sempre `null`, e os painéis desta app são todos fixos — a resposta seria
   * «invisível» para tudo o que está à frente dos olhos da pessoa.
   *
   * Pergunta-se pelo que se vê: tem tamanho, não está `display:none` nem
   * `visibility:hidden`, não está a zero de opacidade, e não foi empurrado
   * para fora do ecrã.
   */
  async visivel(seletor) {
    return this.js(`const n = document.querySelector(${JSON.stringify(seletor)});
      if (!n) return false;
      const e = getComputedStyle(n);
      if (e.display === 'none' || e.visibility === 'hidden' || Number(e.opacity) === 0) return false;
      const r = n.getBoundingClientRect();
      if (r.width < 1 || r.height < 1) return false;
      if (r.bottom < 0 || r.right < 0) return false;
      if (r.top > innerHeight || r.left > innerWidth) return false;
      return true;`);
  }

  /** Caixa do elemento em píxeis de CSS. `null` se não existir ou for invisível. */
  async medir(seletor) {
    return this.js(`const n = document.querySelector(${JSON.stringify(seletor)});
      if (!n) return null;
      const r = n.getBoundingClientRect();
      if (!r.width || !r.height) return null;
      return { x: r.x, y: r.y, largura: r.width, altura: r.height,
               centroX: r.x + r.width / 2, centroY: r.y + r.height / 2 };`);
  }

  /* --- esperar ---------------------------------------------------------- */

  async esperar(seletor, tecto = 6000) {
    const limite = Date.now() + tecto;
    for (;;) {
      if (await this.ver(seletor)) return true;
      if (Date.now() > limite) {
        throw new Error(`esperei ${tecto} ms por «${seletor}» e não apareceu`);
      }
      await esperar(80);
    }
  }

  async sumir(seletor, tecto = 6000) {
    const limite = Date.now() + tecto;
    for (;;) {
      if (!(await this.ver(seletor))) return true;
      if (Date.now() > limite) {
        throw new Error(`«${seletor}» ainda lá está passados ${tecto} ms`);
      }
      await esperar(80);
    }
  }

  async esperarTexto(pedaco, tecto = 6000) {
    const limite = Date.now() + tecto;
    for (;;) {
      const t = await this.textoTodo();
      if (t && t.includes(pedaco)) return true;
      if (Date.now() > limite) {
        throw new Error(`esperei ${tecto} ms pelo texto «${pedaco}» e não apareceu`);
      }
      await esperar(100);
    }
  }

  /* --- conduzir --------------------------------------------------------- */

  /**
   * Carrega com o rato, a sério. Recusa-se a carregar num elemento que não
   * esteja lá, não tenha tamanho, ou esteja tapado por outro — que é
   * exactamente o que um `.click()` de JavaScript esconderia.
   */
  async clicar(seletor, { tecto = 6000 } = {}) {
    await this.esperar(seletor, tecto);
    await this.js(`const n = document.querySelector(${JSON.stringify(seletor)});
      n.scrollIntoView({ block: 'center', behavior: 'instant' }); return true`);
    await esperar(60);

    const caixa = await this.medir(seletor);
    if (!caixa) throw new Error(`«${seletor}» não tem tamanho — ninguém lhe consegue tocar`);

    const quem = await this.js(`
      const alvo = document.querySelector(${JSON.stringify(seletor)});
      const r = alvo.getBoundingClientRect();
      const em = document.elementFromPoint(r.x + r.width / 2, r.y + r.height / 2);
      if (!em) return 'fora do ecrã';
      if (em === alvo || alvo.contains(em) || em.contains(alvo)) return null;
      return em.tagName.toLowerCase() + (em.className && typeof em.className === 'string'
        ? '.' + em.className.split(' ').filter(Boolean).join('.') : '');`);
    if (quem) throw new Error(`«${seletor}» está tapado por ${quem} — o clique não lhe chega`);

    for (const tipo of ['mousePressed', 'mouseReleased']) {
      await this.enviar('Input.dispatchMouseEvent', {
        type: tipo, x: Math.round(caixa.centroX), y: Math.round(caixa.centroY),
        button: 'left', clickCount: 1,
      }, this.sessao);
    }
    await esperar(150);
  }

  /**
   * Arrasta a partir do centro de um elemento.
   *
   * COM `pointerType: 'mouse'`, e isto não é um enfeite: o que o mapa ouve são
   * eventos de PONTEIRO — um caminho só para o rato, o dedo e a caneta —, e o
   * Chrome só os emite a partir de um `dispatchMouseEvent` que diga de que
   * tipo de ponteiro se trata. Sem esta linha, o arrasto não acontece e o
   * teste reprova a dizer que o mapa não se mexe, quando o que não se mexeu
   * foi o ponteiro.
   *
   * E EM VÁRIOS PASSOS, e não de um salto: um `mouseMoved` sozinho é um salto
   * que nenhum dedo faz, e mascara um mapa que só reage ao primeiro
   * movimento.
   */
  async arrastar(seletor, dx, dy, { passos = 8 } = {}) {
    const caixa = await this.medir(seletor);
    if (!caixa) throw new Error(`«${seletor}» não tem tamanho — não há por onde o arrastar`);
    const x0 = Math.round(caixa.centroX), y0 = Math.round(caixa.centroY);
    const rato = (type, x, y, buttons) => this.enviar('Input.dispatchMouseEvent',
      { type, x, y, button: 'left', buttons, clickCount: 1, pointerType: 'mouse' }, this.sessao);
    await rato('mousePressed', x0, y0, 1);
    for (let i = 1; i <= passos; i++) {
      await rato('mouseMoved',
        Math.round(x0 + (dx * i) / passos), Math.round(y0 + (dy * i) / passos), 1);
    }
    await rato('mouseReleased', Math.round(x0 + dx), Math.round(y0 + dy), 0);
    await esperar(160);
  }

  /**
   * Roda a roda do rato por cima do centro de um elemento.
   *
   * O `ctrl` existe porque um mapa que come a roda simples é uma armadilha
   * numa página que rola — a ampliação pede `ctrl`/`⌘` mais roda, que é
   * também o que uma pinça de trackpad envia. Sem isto, um teste que quisesse
   * ampliar rolava a página e depois acusava o mapa de não ampliar.
   */
  async roda(seletor, deltaY, { ctrl = false } = {}) {
    const caixa = await this.medir(seletor);
    if (!caixa) throw new Error(`«${seletor}» não tem tamanho — a roda não lhe chega`);
    await this.enviar('Input.dispatchMouseEvent', {
      type: 'mouseWheel', x: Math.round(caixa.centroX), y: Math.round(caixa.centroY),
      deltaX: 0, deltaY, pointerType: 'mouse', modifiers: ctrl ? 2 : 0,
    }, this.sessao);
    await esperar(200);
  }

  /** Escreve num campo como uma pessoa escreve: foco, teclas, eventos. */
  async escrever(seletor, texto) {
    await this.esperar(seletor);
    await this.js(`const n = document.querySelector(${JSON.stringify(seletor)});
      n.focus(); n.value = ''; return true`);
    for (const c of String(texto)) {
      await this.enviar('Input.dispatchKeyEvent', { type: 'keyDown', text: c }, this.sessao);
      await this.enviar('Input.dispatchKeyEvent', { type: 'keyUp' }, this.sessao);
    }
    await esperar(80);
  }

  /** Atalho: mete o valor de uma vez e dispara os eventos. Para campos longos. */
  async preencher(seletor, texto) {
    await this.esperar(seletor);
    await this.js(`const n = document.querySelector(${JSON.stringify(seletor)});
      n.focus();
      n.value = ${JSON.stringify(String(texto))};
      n.dispatchEvent(new Event('input', { bubbles: true }));
      n.dispatchEvent(new Event('change', { bubbles: true }));
      return true`);
    await esperar(80);
  }

  async tecla(chave, { seletor } = {}) {
    if (seletor) {
      await this.js(`document.querySelector(${JSON.stringify(seletor)}).focus(); return true`);
    }
    /* UM `text` SÓ EXISTE PARA TECLAS QUE ESCREVEM. O ramo por omissão mandava
       `text: chave` para tudo — e para uma tecla com nome, como a `ArrowRight`,
       isso é um `text` de dez caracteres, que o Chrome recusa com «Invalid
       'text' parameter». O teste rebentava a dizer uma coisa que não tinha nada
       que ver com o que estava a provar.

       Aqui: as teclas com nome vão pelo nome e sem `text`; um caractere vai
       como caractere. */
    const codigos = {
      Enter: { windowsVirtualKeyCode: 13, code: 'Enter', key: 'Enter', text: '\r' },
      Escape: { windowsVirtualKeyCode: 27, code: 'Escape', key: 'Escape' },
      Tab: { windowsVirtualKeyCode: 9, code: 'Tab', key: 'Tab' },
      Backspace: { windowsVirtualKeyCode: 8, code: 'Backspace', key: 'Backspace' },
      Delete: { windowsVirtualKeyCode: 46, code: 'Delete', key: 'Delete' },
      ArrowLeft: { windowsVirtualKeyCode: 37, code: 'ArrowLeft', key: 'ArrowLeft' },
      ArrowUp: { windowsVirtualKeyCode: 38, code: 'ArrowUp', key: 'ArrowUp' },
      ArrowRight: { windowsVirtualKeyCode: 39, code: 'ArrowRight', key: 'ArrowRight' },
      ArrowDown: { windowsVirtualKeyCode: 40, code: 'ArrowDown', key: 'ArrowDown' },
      Home: { windowsVirtualKeyCode: 36, code: 'Home', key: 'Home' },
      End: { windowsVirtualKeyCode: 35, code: 'End', key: 'End' },
      PageUp: { windowsVirtualKeyCode: 33, code: 'PageUp', key: 'PageUp' },
      PageDown: { windowsVirtualKeyCode: 34, code: 'PageDown', key: 'PageDown' },
      ' ': { windowsVirtualKeyCode: 32, code: 'Space', key: ' ', text: ' ' },
    };
    if (!codigos[chave] && String(chave).length > 1) {
      throw new Error(`o palco não sabe a tecla «${chave}» — acrescenta-a ao mapa `
        + 'das teclas em vez de a mandar como texto');
    }
    const k = codigos[chave] || {
      key: chave, text: chave, windowsVirtualKeyCode: chave.toUpperCase().charCodeAt(0),
    };
    await this.enviar('Input.dispatchKeyEvent', { type: 'keyDown', ...k }, this.sessao);
    await this.enviar('Input.dispatchKeyEvent', { type: 'keyUp', ...k }, this.sessao);
    await esperar(120);
  }

  /** Quem tem o foco agora — para provar a ordem de tabulação. */
  async focado() {
    return this.js(`const a = document.activeElement;
      if (!a || a === document.body) return null;
      return { etiqueta: a.tagName.toLowerCase(),
               classe: typeof a.className === 'string' ? a.className : '',
               texto: (a.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 40),
               rotulo: a.getAttribute('aria-label') || null };`);
  }

  /**
   * Rola, e espera que a página ASSENTE.
   *
   * O `html` da app tem `scroll-behavior: smooth`, por isso um `scrollBy` é
   * uma animação e não um salto. Medir 150 ms depois apanha-a a meio — e um
   * teste que rola e mede a seguir acusava a app de deixar o ecrã novo onze
   * píxeis fora do sítio quando o que estava fora do sítio era a medição.
   */
  async rolar(quanto = 400) {
    await this.js(`window.scrollBy(0, ${quanto}); return true`);
    let anterior = null;
    for (let i = 0; i < 25; i++) {
      const agora = await this.js('return Math.round(window.scrollY)');
      if (agora === anterior) return agora;
      anterior = agora;
      await esperar(80);
    }
    return anterior;
  }

  /* --- ambiente --------------------------------------------------------- */

  async tamanho(largura, altura) {
    await this.enviar('Emulation.setDeviceMetricsOverride', {
      width: largura, height: altura, deviceScaleFactor: 2,
      mobile: largura < 768,
    }, this.sessao);
    await esperar(150);
  }

  /**
   * Finge que o telemóvel está num sítio.
   *
   * Dá a permissão E a posição: sem a permissão, o `getCurrentPosition` chama
   * o ramo do erro e o teste acusava a app de não ordenar a lista quando o que
   * faltava era alguém dizer que sim.
   */
  async posicao(lat, lon, { precisao = 30 } = {}) {
    const origem = await this.js('return location.origin');
    await this.enviar('Browser.grantPermissions',
      { origin: origem, permissions: ['geolocation'] }).catch(() => {});
    await this.enviar('Emulation.setGeolocationOverride',
      { latitude: lat, longitude: lon, accuracy: precisao }, this.sessao);
    await esperar(120);
  }

  /**
   * Passa a contar os pedidos que a página faz daqui para a frente.
   *
   * Remenda o `fetch` e guarda o endereço E o corpo: uma coordenada tanto pode
   * escapar num `?lat=` como dentro de um JSON, e uma afirmação que só olhe
   * para o endereço deixa passar a segunda.
   */
  async espiarPedidos() {
    await this.js(`
      window.__pedidos = [];
      if (!window.__fetchEspiado) {
        window.__fetchEspiado = window.fetch.bind(window);
        window.fetch = (...a) => {
          const url = String(a[0] && a[0].url ? a[0].url : a[0]);
          const corpo = a[1] && a[1].body ? String(a[1].body) : '';
          window.__pedidos.push(url + (corpo ? ' :: ' + corpo : ''));
          return window.__fetchEspiado(...a);
        };
      }
      return true`);
  }

  async pedidos() {
    return this.js('return window.__pedidos || []');
  }

  async tema(qual) {
    await this.enviar('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-color-scheme', value: qual }],
    }, this.sessao);
    await esperar(150);
  }

  async movimento(qual) {
    await this.enviar('Emulation.setEmulatedMedia', {
      features: [{ name: 'prefers-reduced-motion', value: qual }],
    }, this.sessao);
    await esperar(100);
  }

  /** Corta a rede, para ver o que a app faz sem ela. */
  async semRede(sim = true) {
    await this.enviar('Network.enable', {}, this.sessao).catch(() => {});
    await this.enviar('Network.emulateNetworkConditions', {
      offline: sim, latency: 0, downloadThroughput: -1, uploadThroughput: -1,
    }, this.sessao);
  }

  async armazenamento() {
    return this.js(`const o = {};
      for (let i = 0; i < localStorage.length; i++) {
        const k = localStorage.key(i);
        o[k] = localStorage.getItem(k);
      }
      return o;`);
  }

  async limparArmazenamento() {
    await this.js('try { localStorage.clear(); sessionStorage.clear(); } catch {} return true')
      .catch(() => {});
  }

  /* --- provas ----------------------------------------------------------- */

  async captura(nome) {
    if (!GUARDAR_CAPTURAS) return null;
    const { data } = await this.enviar('Page.captureScreenshot',
      { format: 'png', captureBeyondViewport: true }, this.sessao);
    const ficheiro = join(CAPTURAS, `${nome}.png`);
    writeFileSync(ficheiro, Buffer.from(data, 'base64'));
    this.capturas.push(ficheiro);
    return ficheiro;
  }

  /** Excepções por apanhar e erros de consola que ninguém desculpou. */
  problemas() {
    const perdoado = (t) => this.desculpar.some((r) => r.test(t));
    return [
      ...this.excepcoes.filter((t) => !perdoado(t)).map((t) => `excepção: ${t}`),
      ...this.consola.filter((t) => !perdoado(t)).map((t) => `consola: ${t}`),
    ];
  }
}

/* =========================================================================
   O vigia do lixo visível

   Um `null` não rebenta nada. Um template literal transforma-o em texto, o
   browser desenha-o, e ninguém se queixa — nem uma excepção, nem um erro de
   consola, nem uma afirmação da bateria. Só se vê a olhar para o ecrã certo
   no momento certo. Aconteceu: um negócio sem categoria mostrava «null ·
   Ovar» a quem estava a descobrir sítios, e a bateria inteira passou por lá
   sem lhe tocar.

   Isto instala-se em TODOS os documentos que a aba abrir, antes de o código
   da página correr, e olha para o texto que aparece — o que já lá está e o
   que for sendo acrescentado. Grita pela consola porque é o único canal que
   sobrevive a uma navegação: o que apanhar num ecrã que a pessoa já deixou
   para trás chega ao corredor na mesma.

   As fronteiras de palavra não são enfeite: sem elas, «anulado» — que está
   em todos os históricos — casava com «null».
   ========================================================================= */
const MARCA_LIXO = 'LIXO-VISIVEL:';

/* `String.raw` e não uma barra invertida por acidente: dentro de um template
   normal o `\b` da expressão regular vira o caractere de retrocesso, o `\s`
   vira um `s` e o `\[` vira `[`. A guarda ficou instalada, calada e inútil —
   passou uma bateria inteira a dizer que estava tudo bem. */
const VIGIA_LIXO = String.raw`(() => {
  const MARCA = ${JSON.stringify('LIXO-VISIVEL:')};
  const PADRAO = /\b(null|undefined|NaN)\b|\[object [A-Z]\w*\]/;
  /* O que não conta: o que ninguém lê. Um campo escondido, o conteúdo de um
     <script>, ou texto dentro de um elemento com \`hidden\`. */
  const invisivel = (no) => {
    for (let e = no.parentElement; e; e = e.parentElement) {
      const t = e.tagName;
      if (t === 'SCRIPT' || t === 'STYLE' || t === 'TEMPLATE' || t === 'NOSCRIPT') return true;
      if (e.hidden || e.getAttribute('aria-hidden') === 'true') return true;
    }
    return false;
  };
  const onde = (no) => {
    const e = no.parentElement;
    if (!e) return 'sem pai';
    const classe = e.className && typeof e.className === 'string'
      ? '.' + e.className.trim().split(/\s+/).join('.') : '';
    return e.tagName.toLowerCase() + classe;
  };
  const visto = new Set();
  const olhar = (no) => {
    if (!no || no.nodeType !== 3) return;
    const t = String(no.nodeValue || '');
    if (!PADRAO.test(t)) return;
    if (invisivel(no)) return;
    const queixa = onde(no) + ' → ' + t.replace(/\s+/g, ' ').trim().slice(0, 80);
    if (visto.has(queixa)) return;
    visto.add(queixa);
    console.error(MARCA + ' ' + queixa);
  };
  const varrer = (raiz) => {
    if (!raiz) return;
    if (raiz.nodeType === 3) return olhar(raiz);
    if (raiz.nodeType !== 1 && raiz.nodeType !== 9 && raiz.nodeType !== 11) return;
    const caminhante = document.createTreeWalker(raiz, NodeFilter.SHOW_TEXT);
    for (let n = caminhante.nextNode(); n; n = caminhante.nextNode()) olhar(n);
  };
  const arrancar = () => {
    varrer(document.body);
    new MutationObserver((mudancas) => {
      for (const m of mudancas) {
        if (m.type === 'characterData') olhar(m.target);
        else for (const n of m.addedNodes) varrer(n);
      }
    }).observe(document.documentElement, {
      childList: true, subtree: true, characterData: true,
    });
  };
  if (document.body) arrancar();
  else document.addEventListener('DOMContentLoaded', arrancar, { once: true });
})();`;

/* =========================================================================
   O corredor
   ========================================================================= */

let passou = 0, falhou = 0;
const falhas = [];

async function correrModulo(enviar, servidor, mod, ficheiro) {
  const { targetId, sessionId } = await novoSeparador(enviar);
  const palco = new Palco(enviar, sessionId, servidor, mod.desculpar);

  /* Nada de erros silenciosos: o que rebentar aparece. */
  const ouvir = (m) => {
    if (m.sessionId !== sessionId) return;
    if (m.method === 'Runtime.exceptionThrown') {
      const d = m.params.exceptionDetails;
      palco.excepcoes.push(d.exception?.description || d.text || 'sem descrição');
    }
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
      const texto = m.params.args.map((a) => a.description || String(a.value)).join(' ');
      /* O vigia do lixo visível grita pela consola, que é o único canal que
         sobrevive a uma navegação: o que ele apanhar num ecrã que a pessoa já
         deixou para trás chega cá na mesma. */
      if (texto.startsWith(MARCA_LIXO)) palco.lixo.push(texto.slice(MARCA_LIXO.length).trim());
      else palco.consola.push(texto);
    }
  };
  enviar.ouvintes.add(ouvir);

  try {
    await enviar('Page.addScriptToEvaluateOnNewDocument',
      { source: VIGIA_LIXO }, sessionId);
    await enviar('Emulation.setDeviceMetricsOverride', {
      width: mod.ecra?.largura || 390, height: mod.ecra?.altura || 844,
      deviceScaleFactor: 2, mobile: true,
    }, sessionId);
    /* Um separador novo NÃO é armazenamento novo: o localStorage é do
       domínio, não da aba. Sem isto, o módulo que abre `?demo=1` deixa a
       marca do modo de demonstração ligada e o módulo seguinte encontra a
       app noutro modo — que foi exactamente o que aconteceu, e levou meia
       hora a perceber porque o balcão só mostrava duas portas em vez de
       três. Limpa-se tudo: chaves, base de dados e service workers. */
    await enviar('Storage.clearDataForOrigin', {
      origin: servidor,
      storageTypes: 'local_storage,indexeddb,service_workers,cache_storage,websql,cookies',
    }, sessionId).catch(() => {});

    /* O service worker fica de fora salvo se o módulo o quiser testar — de
       outra forma serve versões guardadas a meio da bateria e o teste
       seguinte vê a app anterior. */
    if (!mod.comServiceWorker) {
      await enviar('Network.enable', {}, sessionId).catch(() => {});
      await enviar('Network.setBypassServiceWorker', { bypass: true }, sessionId)
        .catch(() => {});
    }

    console.log(`\n${mod.nome}`);
    const certo = (condicao, descricao, detalhe = '') => {
      if (condicao) { passou++; console.log(`  ✓ ${descricao}`); }
      else {
        falhou++;
        falhas.push(`${mod.nome} — ${descricao}${detalhe ? ` (${detalhe})` : ''}`);
        console.log(`  ✗ ${descricao}${detalhe ? ` — ${detalhe}` : ''}`);
      }
    };

    await mod.correr(palco, certo);

    const problemas = palco.problemas();
    certo(problemas.length === 0,
      'nada rebentou por baixo',
      problemas.slice(0, 3).join(' · '));

    /* E nada de lixo de programador à vista. Um `null` chega ao ecrã sem
       rebentar nada: um template literal transforma-o em texto e ninguém se
       queixa. Aconteceu a sério — um negócio sem categoria mostrava «null ·
       Ovar» a quem estava a descobrir sítios, e passou por toda a bateria
       sem uma afirmação sequer lhe tocar. */
    const lixo = [...new Set(palco.lixo)];
    certo(lixo.length === 0,
      'nenhum ecrã mostrou «null», «undefined», «NaN» ou «[object Object]» a quem lá estava',
      lixo.slice(0, 3).join(' · '));
  } catch (erro) {
    falhou++;
    falhas.push(`${mod.nome} — o módulo rebentou: ${erro.message}`);
    console.log(`  ✗ o módulo rebentou: ${erro.message}`);
    /* Uma fotografia do momento em que rebentou vale a leitura do erro. */
    try {
      const { data } = await enviar('Page.captureScreenshot', { format: 'png' }, sessionId);
      const f = join(CAPTURAS, `rebentou-${ficheiro.replace(/\W+/g, '-')}.png`);
      writeFileSync(f, Buffer.from(data, 'base64'));
      console.log(`    (fotografia em ${f.slice(RAIZ.length + 1)})`);
    } catch { /* nem isso deu */ }
  } finally {
    enviar.ouvintes.delete(ouvir);
    await enviar('Target.closeTarget', { targetId }).catch(() => {});
  }
}

/* --- arranque ------------------------------------------------------------ */

if (!existsSync(join(RAIZ, '_site', 'app', 'index.html'))) {
  console.error('Falta o _site. Corre `node scripts/gerar.mjs` primeiro.');
  process.exit(1);
}

/* Só se limpa quando se vai fotografar. De outra forma duas corridas ao
   mesmo tempo — e há-as, quando se escreve um módulo enquanto outro corre —
   apagam as provas uma da outra a meio. */
if (GUARDAR_CAPTURAS) rmSync(CAPTURAS, { recursive: true, force: true });
mkdirSync(CAPTURAS, { recursive: true });

const filtros = process.argv.slice(2);
const ficheiros = existsSync(MODULOS)
  ? readdirSync(MODULOS).filter((f) => f.endsWith('.mjs')).sort()
  : [];
const escolhidos = filtros.length
  ? ficheiros.filter((f) => filtros.some((t) => f.includes(t)))
  : ficheiros;

if (!escolhidos.length) {
  console.error(ficheiros.length
    ? `Nenhum módulo casa com ${filtros.join(', ')}.`
    : 'Não há módulos em scripts/bateria/.');
  process.exit(1);
}

const servidor = await subirServidor();
const { enviar, fechar } = await abrirChrome({ tecto: 45000 });

console.log(`\nBateria de browser — ${escolhidos.length} módulos`);
console.log(`servidor em ${servidor.url}${BASE}\n${'─'.repeat(56)}`);

for (const f of escolhidos) {
  const mod = await import(join(MODULOS, f));
  if (typeof mod.correr !== 'function') {
    console.log(`\n${f}: não exporta correr() — saltado`);
    continue;
  }
  await correrModulo(enviar, servidor.url, mod, f);
}

console.log(`\n${'─'.repeat(56)}`);
console.log(`${passou} passaram, ${falhou} falharam.`);
if (falhas.length) {
  console.log('\nFalhas:');
  for (const f of falhas) console.log(`  · ${f}`);
}
if (GUARDAR_CAPTURAS) console.log(`\nFotografias em ${CAPTURAS.slice(RAIZ.length + 1)}/`);

await fechar();
servidor.matar();
process.exit(falhou ? 1 : 0);
