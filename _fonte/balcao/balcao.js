/* =========================================================================
   Carimbo Digital Balcão — a aplicação de quem carimba

   A regra que manda em tudo o resto: ao balcão há fila. Cada ecrã tem de
   funcionar com um polegar, à primeira, com o telemóvel numa mão e o café na
   outra. Nada de confirmações a mais, nada de menus escondidos.
   ========================================================================= */

import {
  $, el, icone, avisar, guardar, ler, apagar, vibrar, confetes,
  pintarCartao, haQuanto, dataCurta, horas, NOMES_SELOS, seguro,
} from '../js/nucleo.js';
import { api, MODO } from '../js/api.js';
import { lerQR } from '../js/qr-leitor.js';

const estado = {
  negocio: null,
  operador: null,
  programa: null,
  ecra: 'carimbar',
  ultimoMovimento: null,
};

function base() {
  return (globalThis.SINETE_CONFIG && globalThis.SINETE_CONFIG.base) || '';
}

/* =========================================================================
   O leitor
   Usa o descodificador do próprio browser quando existe (é nativo, rápido e
   não traz um megabyte de JavaScript atrás). Onde não existe — o Safari até
   há pouco — fica a entrada manual pelo número do cartão, que é o que os
   balcões já fazem quando o código não lê.
   ========================================================================= */

class Leitor {
  constructor(video, aoLer) {
    this.video = video;
    this.aoLer = aoLer;
    this.correr = false;
    this.nativo = null;
    this.tela = null;
    this.pincel = null;
    this.ultimo = null;
    this.ultimoEm = 0;
    this.aTrabalhar = false;
  }

  async comecar() {
    this.fluxo = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    this.video.srcObject = this.fluxo;
    this.video.setAttribute('playsinline', '');   // sem isto o iOS abre em ecrã inteiro
    this.video.muted = true;
    await this.video.play();

    if ('BarcodeDetector' in window) {
      try { this.nativo = new BarcodeDetector({ formats: ['qr_code'] }); }
      catch { this.nativo = null; }
    }
    /* Sem descodificador nativo — o caso do Safari, e portanto de todos os
       iPhones — usa-se o nosso (js/qr-leitor.js). É por isso que ele existe. */
    if (!this.nativo) {
      this.tela = document.createElement('canvas');
      this.pincel = this.tela.getContext('2d', { willReadFrequently: true });
    }
    this.correr = true;
    this.ciclo();
    return { nativo: Boolean(this.nativo) };
  }

  /* O quadrado do meio da imagem, reduzido a 480 px no lado maior. Não se lê
     o fotograma inteiro: é quatro vezes mais trabalho e o código está sempre
     ao centro, que é onde a mira o põe. */
  recortar() {
    const vw = this.video.videoWidth, vh = this.video.videoHeight;
    if (!vw || !vh) return null;
    const lado = Math.min(vw, vh);
    const destino = Math.min(480, lado);
    if (this.tela.width !== destino) { this.tela.width = destino; this.tela.height = destino; }
    this.pincel.drawImage(this.video, (vw - lado) / 2, (vh - lado) / 2, lado, lado,
                          0, 0, destino, destino);
    return this.pincel.getImageData(0, 0, destino, destino);
  }

  async ciclo() {
    if (!this.correr) return;
    if (!this.aTrabalhar) {
      this.aTrabalhar = true;
      try {
        let valor = null;
        if (this.nativo) {
          const codigos = await this.nativo.detect(this.video);
          if (codigos.length) valor = codigos[0].rawValue;
        } else {
          const imagem = this.recortar();
          if (imagem) {
            const { data, width, height } = imagem;
            const cinza = new Uint8Array(width * height);
            for (let k = 0, q = 0; k < data.length; k += 4, q++) {
              cinza[q] = (data[k] * 306 + data[k + 1] * 601 + data[k + 2] * 117) >> 10;
            }
            valor = lerQR(cinza, width, height);
          }
        }
        if (valor) {
          /* O mesmo código lido dez vezes por segundo não são dez carimbos. */
          const agora = Date.now();
          if (valor !== this.ultimo || agora - this.ultimoEm > 4000) {
            this.ultimo = valor; this.ultimoEm = agora;
            this.aoLer(valor);
          }
        }
      } catch { /* um fotograma que falha não é motivo para parar */ }
      this.aTrabalhar = false;
    }
    if (this.correr) requestAnimationFrame(() => this.ciclo());
  }

  parar() {
    this.correr = false;
    try { this.fluxo?.getTracks().forEach((t) => t.stop()); } catch { /* nada */ }
    this.video.srcObject = null;
  }
}

let leitor = null;

/* =========================================================================
   Ecrã: carimbar
   ========================================================================= */

async function ecraCarimbar(principal) {
  const p = estado.programa;

  principal.append(el('div', { class: 'programa-atual' },
    el('span', { class: 'programa-selo', html: icone(p.selo, { tipo: 'cheio', tamanho: 20 }) }),
    el('span', { class: 'programa-texto' },
      el('b', { texto: p.nome }),
      el('span', { texto: p.tipo === 'pontos'
        ? `Pontos · prémios a partir de ${(p.marcos || [{ pontos: p.objetivo }])[0].pontos}`
        : `${p.objetivo} carimbos · ${p.premio}` }))));

  const visor = el('div', { class: 'visor' },
    el('video', { class: 'visor-video', id: 'video', playsinline: true, muted: true }),
    el('div', { class: 'visor-mira', 'aria-hidden': 'true' },
      el('span'), el('span'), el('span'), el('span')),
    el('div', { class: 'visor-estado', id: 'visor-estado', texto: 'A ligar a câmara…' }));
  principal.append(visor);

  const manual = el('div', { class: 'manual' },
    el('button', {
      class: 'btn btn-suave btn-bloco', id: 'botao-manual',
      html: icone('lapis', { tamanho: 18 }) + '<span>Escrever o número do cartão</span>',
      aoClick: abrirManual,
    }));
  principal.append(manual);

  if (p.tipo === 'pontos') {
    principal.append(el('div', { class: 'quantia' },
      el('span', { class: 'quantia-rotulo', texto: 'Pontos a dar' }),
      el('div', { class: 'quantia-botoes' },
        ...[5, 10, 20, 50].map((n) => el('button', {
          class: 'quantia-botao', texto: String(n),
          'data-ativo': n === (estado.quantidade || 10) ? 'sim' : 'nao',
          aoClick: (ev) => {
            estado.quantidade = n;
            for (const b of principal.querySelectorAll('.quantia-botao')) b.dataset.ativo = 'nao';
            ev.currentTarget.dataset.ativo = 'sim';
          },
        })))));
    estado.quantidade = estado.quantidade || 10;
  }

  const video = $('#video');
  leitor = new Leitor(video, (valor) => carimbar(valor));
  try {
    await leitor.comecar();
    $('#visor-estado').textContent = 'Aponta ao código do cliente';
    visor.dataset.ativo = 'sim';
  } catch {
    visor.dataset.ativo = 'nao';
    $('#visor-estado').innerHTML =
      'Sem acesso à câmara.<br>Autoriza nas definições do browser, ou escreve o número.';
    $('#botao-manual').classList.replace('btn-suave', 'btn-cheio');
  }
}

function abrirManual() {
  const folha = abrirPainel('Número do cartão');
  folha.append(
    el('p', { class: 'subtexto', texto: 'São os seis caracteres que o cliente tem por baixo do código.' }),
    el('label', { class: 'campo' },
      el('span', { texto: 'Número' }),
      el('input', {
        id: 'campo-numero', type: 'text', inputmode: 'text',
        autocapitalize: 'characters', autocomplete: 'off', spellcheck: 'false',
        maxlength: '6', placeholder: 'EA4BFM', class: 'campo-numero',
      })),
    el('button', {
      class: 'btn btn-cheio btn-bloco btn-grande', texto: 'Carimbar',
      aoClick: () => {
        const v = $('#campo-numero').value.trim().toUpperCase();
        if (v.length !== 6) { avisar('O número tem seis caracteres.', 'mau'); return; }
        fecharPainel();
        carimbar(`M1.${v}`, { manual: true });
      },
    }));
  const campo = $('#campo-numero');
  campo.addEventListener('input', () => { campo.value = campo.value.toUpperCase(); });
  setTimeout(() => campo.focus(), 120);
}

/* =========================================================================
   O carimbo
   ========================================================================= */

let aCarimbar = false;

async function carimbar(codigo, { manual = false } = {}) {
  if (aCarimbar) return;
  aCarimbar = true;
  try {
    const r = await api.carimbar({
      codigo, programaId: estado.programa.id,
      quantidade: estado.programa.tipo === 'pontos' ? (estado.quantidade || 10) : 1,
      operador: estado.operador?.nome || 'Balcão',
      manual,
    });
    vibrar([12, 40, 18]);
    mostrarResultado(r);
  } catch (e) {
    vibrar([60, 60, 60]);
    mostrarErro(e);
  } finally {
    setTimeout(() => { aCarimbar = false; }, 900);
  }
}

function mostrarResultado(r) {
  const cartao = r.cartao;
  const p = cartao.programa;
  const ganhou = r.ganhos.length > 0;

  const folha = el('div', { class: 'resultado', id: 'resultado', role: 'dialog', 'aria-modal': 'true' });
  const caixa = el('div', { class: 'resultado-caixa' });

  caixa.append(el('div', { class: `resultado-marca ${ganhou ? 'resultado-marca-premio' : ''}`,
    html: icone(ganhou ? 'presente' : 'visto', { tamanho: 34 }) }));

  caixa.append(el('h2', { class: 'resultado-titulo', texto: ganhou
    ? 'Cartão completo!'
    : r.novo ? 'Cartão criado e carimbado' : 'Carimbado' }));

  caixa.append(el('p', { class: 'resultado-sub', texto: ganhou
    ? `Entregar: ${r.ganhos.map((g) => g.descricao).join(', ')}`
    : p.tipo === 'pontos'
      ? `+${r.quantidade} pontos · ${cartao.pontos} no total`
      : `${cartao.carimbos} de ${p.objetivo} · faltam ${p.objetivo - cartao.carimbos}` }));

  /* O cartão do cliente, com o carimbo novo a assentar. */
  const mini = el('div', { class: 'cartao resultado-cartao' },
    el('div', { class: 'cartao-corpo' },
      el('div', { class: 'cartao-topo' },
        el('div', { class: 'cartao-marca' },
          el('div', { class: 'cartao-nome', texto: cartao.negocio.nome })),
        el('div', { class: 'cartao-id' },
          el('span', { texto: 'cartão' }),
          el('b', { texto: r.cliente.publico }))),
      p.tipo === 'pontos' ? null : grelhaResultado(cartao, r.quantidade)));
  pintarCartao(mini, cartao.negocio.cor);
  caixa.append(mini);

  const acoes = el('div', { class: 'resultado-acoes' });
  if (ganhou) {
    for (const g of r.ganhos) {
      acoes.append(el('button', {
        class: 'btn btn-cheio btn-grande btn-bloco',
        html: icone('presente', { tamanho: 18 }) + `<span>Entreguei: ${seguro(g.descricao)}</span>`,
        aoClick: async (ev) => {
          ev.currentTarget.disabled = true;
          await api.resgatar({ premioId: g.id, operador: estado.operador?.nome || 'Balcão' });
          avisar('Prémio entregue.', 'bom');
          fecharResultado();
        },
      }));
    }
    acoes.append(el('button', {
      class: 'btn btn-fantasma btn-bloco', texto: 'O cliente leva noutro dia',
      aoClick: fecharResultado,
    }));
  } else {
    acoes.append(el('button', {
      class: 'btn btn-cheio btn-grande btn-bloco', texto: 'Seguinte',
      aoClick: fecharResultado,
    }));
  }

  /* Anular: dois minutos, e só ao carimbo que se acabou de dar. É o «enganei-me
     no cliente» que acontece uma vez por semana em qualquer balcão. */
  const movimento = null;
  acoes.append(el('button', {
    class: 'btn btn-fantasma btn-bloco btn-pequeno',
    html: icone('menos', { tamanho: 16 }) + '<span>Enganei-me — anular</span>',
    aoClick: async () => {
      try {
        const detalhe = await api.cartao(cartao.clienteId, cartao.id);
        const ultimo = detalhe.movimentos.find((m) => m.tipo === 'carimbo' || m.tipo === 'pontos');
        if (!ultimo) throw new Error('Nada para anular');
        await api.anular({ movimentoId: ultimo.id });
        avisar('Carimbo anulado.', 'bom');
        fecharResultado();
      } catch (e) { avisar(e.message, 'mau'); }
    },
  }));

  caixa.append(acoes);
  folha.append(caixa);
  document.body.append(folha);

  if (ganhou) confetes();
  /* Fecha-se sozinho: ao balcão ninguém carrega em «ok». */
  estado.fecho = setTimeout(fecharResultado, ganhou ? 20000 : 6000);
}

function grelhaResultado(cartao, quantidade) {
  const p = cartao.programa;
  const cheios = cartao.porResgatar && cartao.carimbos === 0 ? p.objetivo : cartao.carimbos;
  const grelha = el('div', { class: 'carimbos', estilo: { '--colunas': String(Math.min(p.objetivo, 5)), '--peca': '44px' } });
  for (let i = 0; i < p.objetivo; i++) {
    const peca = el('div', { class: 'carimbo', estilo: { '--inclina': `${((i * 37) % 9) - 4}deg` },
      html: icone(p.selo, { tipo: 'cheio', tamanho: 22 }) });
    peca.dataset.estado = i < cheios ? 'cheio' : 'vazio';
    if (i >= cheios - quantidade && i < cheios) peca.dataset.novo = 'sim';
    grelha.append(peca);
  }
  return grelha;
}

function fecharResultado() {
  clearTimeout(estado.fecho);
  $('#resultado')?.remove();
}

function mostrarErro(e) {
  const explicacoes = {
    formato: ['Não é um código Carimbo Digital', 'Este código é de outra coisa qualquer.'],
    'sem-cliente': ['Cartão desconhecido', 'Pede ao cliente para abrir a app outra vez.'],
    expirado: ['Código expirado', 'O código muda a cada 15 segundos. Pede para mostrar de novo.'],
    repetido: ['Código já usado', 'Este código já foi carimbado. Pede o seguinte.'],
    arrefecimento: ['Já foi carimbado há pouco', e.message],
  };
  const [titulo, corpo] = explicacoes[e.codigo] || ['Não deu', e.message];
  const folha = el('div', { class: 'resultado', id: 'resultado', role: 'alertdialog' },
    el('div', { class: 'resultado-caixa' },
      el('div', { class: 'resultado-marca resultado-marca-mau', html: icone('alerta', { tamanho: 34 }) }),
      el('h2', { class: 'resultado-titulo', texto: titulo }),
      el('p', { class: 'resultado-sub', texto: corpo }),
      el('div', { class: 'resultado-acoes' },
        el('button', { class: 'btn btn-cheio btn-grande btn-bloco', texto: 'Tentar outra vez', aoClick: fecharResultado }))));
  document.body.append(folha);
  estado.fecho = setTimeout(fecharResultado, 6000);
}

/* =========================================================================
   Ecrã: hoje
   ========================================================================= */

async function ecraHoje(principal) {
  principal.append(el('h1', { class: 'titulo-grande', texto: 'Hoje' }));
  const r = await api.resumo(estado.negocio.id);

  principal.append(el('div', { class: 'numeros' },
    numero('Carimbos hoje', r.carimbosHoje, 'raio'),
    numero('Clientes', r.clientes, 'pessoas'),
    numero('Novos (30 dias)', r.novos30, 'mais'),
    numero('Prémios por levantar', r.porResgatar, 'presente')));

  /* Os dois números que mudam alguma coisa. Tudo o resto é vaidade. */
  principal.append(el('section', { class: 'seccao' },
    el('h2', { class: 'seccao-titulo', texto: 'O que fazer com isto' }),
    el('div', { class: 'lista' },
      el('div', { class: 'linha' },
        el('span', { class: 'linha-icone linha-icone-marca', html: icone('lampada', { tamanho: 20 }) }),
        el('span', { class: 'linha-texto' },
          el('b', { texto: `${r.quaseLa} cliente(s) a dois carimbos do prémio` }),
          el('span', { texto: 'São os que voltam se lhes disseres. Diz-lhes ao balcão.' }))),
      el('div', { class: 'linha' },
        el('span', { class: 'linha-icone', html: icone('relogio', { tamanho: 20 }) }),
        el('span', { class: 'linha-texto' },
          el('b', { texto: `${r.aFugir} cliente(s) sem aparecer há 2 meses` }),
          el('span', { texto: 'Um dia de desconto trá-los de volta mais barato do que um anúncio.' }))))));

  principal.append(el('section', { class: 'seccao' },
    el('h2', { class: 'seccao-titulo', texto: 'Prémios' }),
    el('div', { class: 'lista' },
      el('div', { class: 'linha' },
        el('span', { class: 'linha-icone', html: icone('presente', { tamanho: 20 }) }),
        el('span', { class: 'linha-texto' },
          el('b', { texto: `${r.premiosGanhos} ganhos, ${r.premiosResgatados} levantados` }),
          el('span', { texto: r.premiosGanhos
            ? `${Math.round((r.premiosResgatados / r.premiosGanhos) * 100)}% levantados`
            : 'Ainda não há prémios' }))))));
}

function numero(rotulo, valor, ic) {
  return el('div', { class: 'numero folha' },
    el('span', { class: 'numero-icone', html: icone(ic, { tamanho: 18 }) }),
    el('b', { texto: String(valor) }),
    el('span', { class: 'numero-rotulo', texto: rotulo }));
}

/* =========================================================================
   Ecrã: clientes
   ========================================================================= */

async function ecraClientes(principal) {
  principal.append(el('h1', { class: 'titulo-grande', texto: 'Clientes' }));
  const clientes = await api.clientesDoNegocio(estado.negocio.id);

  if (!clientes.length) {
    principal.append(el('div', { class: 'vazio' },
      el('div', { class: 'vazio-desenho', html: icone('pessoas', { tamanho: 96 }) }),
      el('h3', { texto: 'Ainda ninguém' }),
      el('p', { texto: 'Assim que carimbares o primeiro cartão, o cliente aparece aqui.' })));
    return;
  }

  principal.append(el('p', { class: 'subtexto', texto:
    'Não guardamos nomes nem telefones — só o número do cartão. É quanto basta para carimbar.' }));

  const lista = el('div', { class: 'lista' });
  for (const c of clientes) {
    lista.append(el('div', { class: 'linha' },
      el('span', { class: 'linha-icone', html: icone('cartoes', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { class: 'mono', texto: c.publico }),
        el('span', { texto: c.tipo === 'pontos'
          ? `${c.pontos} pontos · última visita ${c.ultimoEm ? haQuanto(c.ultimoEm) : '—'}`
          : `${c.carimbos}/${c.objetivo} · última visita ${c.ultimoEm ? haQuanto(c.ultimoEm) : '—'}` })),
      c.porResgatar
        ? el('span', { class: 'etiqueta etiqueta-bom', texto: 'prémio' })
        : el('span', { class: 'linha-fim', texto: '' })));
  }
  principal.append(lista);
}

/* =========================================================================
   Ecrã: o cartão (editor do programa)
   ========================================================================= */

async function ecraPrograma(principal) {
  const p = estado.programa;
  principal.append(el('h1', { class: 'titulo-grande', texto: 'O meu cartão' }));
  principal.append(el('p', { class: 'subtexto', texto: 'É assim que os clientes o vêem.' }));

  const previa = el('div', { class: 'cartao', id: 'previa' });
  principal.append(previa);
  desenharPrevia(previa);

  const form = el('div', { class: 'seccao' },
    el('label', { class: 'campo' },
      el('span', { texto: 'Nome do negócio' }),
      el('input', { id: 'f-nome', value: estado.negocio.nome, maxlength: '40' })),
    el('label', { class: 'campo' },
      el('span', { texto: 'Nome do cartão' }),
      el('input', { id: 'f-programa', value: p.nome, maxlength: '40' })),
    el('label', { class: 'campo' },
      el('span', { texto: 'O prémio' }),
      el('input', { id: 'f-premio', value: p.premio, maxlength: '60' })),
    el('label', { class: 'campo' },
      el('span', { texto: 'Carimbos até ao prémio' }),
      el('input', { id: 'f-objetivo', type: 'number', min: '2', max: '30', step: '1', value: String(p.objetivo) })),
    el('label', { class: 'campo' },
      el('span', { texto: 'Regras (a letra pequena)' }),
      el('textarea', { id: 'f-regras', maxlength: '240' }, p.regras || '')));

  /* Cor */
  const cores = ['#17161C', '#3B2417', '#12232E', '#B0446A', '#C9821F', '#1E7A6B',
                 '#5AAEE0', '#5A31E8', '#B03A2E', '#2E5E3A', '#6B4E9B', '#A8632B'];
  const paleta = el('div', { class: 'paleta' });
  for (const c of cores) {
    const b = el('button', { class: 'paleta-cor', estilo: { background: c },
                             'aria-label': `Cor ${c}`, type: 'button' });
    b.dataset.ativo = c.toLowerCase() === String(estado.negocio.cor).toLowerCase() ? 'sim' : 'nao';
    b.addEventListener('click', () => {
      estado.negocio.cor = c;
      for (const o of paleta.querySelectorAll('.paleta-cor')) o.dataset.ativo = 'nao';
      b.dataset.ativo = 'sim';
      desenharPrevia(previa);
    });
    paleta.append(b);
  }
  form.append(el('div', { class: 'campo' }, el('span', { texto: 'Cor' }), paleta));

  /* Selo */
  const selos = el('div', { class: 'selos' });
  for (const nome of NOMES_SELOS) {
    const b = el('button', { class: 'selo-opcao', type: 'button', 'aria-label': nome,
                             html: icone(nome, { tipo: 'cheio', tamanho: 22 }) });
    b.dataset.ativo = nome === p.selo ? 'sim' : 'nao';
    b.addEventListener('click', () => {
      p.selo = nome;
      for (const o of selos.querySelectorAll('.selo-opcao')) o.dataset.ativo = 'nao';
      b.dataset.ativo = 'sim';
      desenharPrevia(previa);
    });
    selos.append(b);
  }
  form.append(el('div', { class: 'campo' }, el('span', { texto: 'Desenho do carimbo' }), selos));

  for (const campo of ['f-nome', 'f-programa', 'f-premio', 'f-objetivo']) {
    form.addEventListener('input', () => desenharPrevia(previa));
  }

  form.append(el('button', {
    class: 'btn btn-cheio btn-grande btn-bloco', style: 'margin-top:8px',
    texto: 'Guardar',
    aoClick: async () => {
      const objetivo = Math.max(2, Math.min(30, Number($('#f-objetivo').value) || p.objetivo));
      await api.guardarNegocio(estado.negocio.id, {
        nome: $('#f-nome').value.trim() || estado.negocio.nome,
        cor: estado.negocio.cor,
      });
      await api.guardarPrograma(estado.negocio.id, {
        ...p,
        nome: $('#f-programa').value.trim() || p.nome,
        premio: $('#f-premio').value.trim() || p.premio,
        objetivo, selo: p.selo,
        regras: $('#f-regras').value.trim(),
      });
      const r = await api.negocioDoOperador(estado.operador.id);
      estado.negocio = r.negocio;
      estado.programa = r.negocio.programas[0];
      avisar('Guardado. Os clientes vão ver já a mudança.', 'bom');
      irPara('programa');
    },
  }));

  principal.append(form);

  /* Como pôr isto ao balcão. */
  principal.append(el('section', { class: 'seccao' },
    el('h2', { class: 'seccao-titulo', texto: 'Pôr no balcão' }),
    el('div', { class: 'folha caixa-texto' },
      el('p', { html: '<b>Um cartaz com o teu código.</b> Os clientes apontam a câmara, '
        + 'a app abre e o cartão fica logo na carteira deles.' }),
      el('button', {
        class: 'btn btn-suave btn-bloco', style: 'margin-top:12px',
        html: icone('descarregar', { tamanho: 18 }) + '<span>Imprimir o cartaz</span>',
        aoClick: () => window.open(`${base()}/balcao/cartaz.html?n=`
          + encodeURIComponent(estado.negocio.nome) + '&c=' + encodeURIComponent(estado.negocio.cor)
          + '&p=' + encodeURIComponent(estado.programa.premio)
          + '&s=' + encodeURIComponent(estado.negocio.slug || ''), '_blank'),
      }))));
}

function desenharPrevia(previa) {
  const nome = $('#f-nome')?.value || estado.negocio.nome;
  const prog = $('#f-programa')?.value || estado.programa.nome;
  const premio = $('#f-premio')?.value || estado.programa.premio;
  const objetivo = Math.max(2, Math.min(30, Number($('#f-objetivo')?.value) || estado.programa.objetivo));
  const selo = estado.programa.selo;
  const feitos = Math.min(objetivo, Math.ceil(objetivo * 0.6));
  const cols = Math.min(objetivo, objetivo <= 6 ? 3 : 5);

  previa.innerHTML = '';
  previa.append(el('div', { class: 'cartao-corpo' },
    el('div', { class: 'cartao-topo' },
      el('div', { class: 'cartao-marca' },
        el('div', { class: 'cartao-nome', texto: nome }),
        el('div', { class: 'cartao-tipo', texto: prog })),
      el('div', { class: 'cartao-id' },
        el('span', { texto: 'cartão' }), el('b', { texto: 'EA4BFM' }))),
    el('div', { class: 'carimbos', estilo: { '--colunas': String(cols) },
      html: Array.from({ length: objetivo }, (_, k) =>
        `<div class="carimbo" data-estado="${k < feitos ? 'cheio' : 'vazio'}" `
        + `style="--inclina:${((k * 37) % 9) - 4}deg">`
        + icone(selo, { tipo: 'cheio', tamanho: 24 }) + '</div>').join('') }),
    el('div', { class: 'cartao-rodape' },
      el('div', {},
        el('div', { class: 'cartao-rotulo', texto: `faltam ${objetivo - feitos} carimbos` }),
        el('div', { class: 'cartao-premio', texto: premio })))));
  pintarCartao(previa, estado.negocio.cor);
}

/* =========================================================================
   Painel
   ========================================================================= */

function abrirPainel(titulo) {
  fecharPainel();
  const folha = el('div', { class: 'painel-folha', role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo },
    el('div', { class: 'painel-pega' }),
    el('h2', { style: 'margin-bottom:12px', texto: titulo }));
  document.body.append(el('div', { class: 'painel', id: 'painel' },
    el('div', { class: 'painel-veu', aoClick: fecharPainel }), folha));
  document.addEventListener('keydown', escapaPainel);
  return folha;
}
function escapaPainel(ev) { if (ev.key === 'Escape') fecharPainel(); }
function fecharPainel() {
  document.removeEventListener('keydown', escapaPainel);
  $('#painel')?.remove();
}

/* =========================================================================
   Navegação
   ========================================================================= */

const ECRAS = {
  carimbar: { titulo: 'Carimbar', icone: 'camara',  rotulo: 'Carimbar', render: ecraCarimbar },
  hoje:     { titulo: 'Hoje',     icone: 'grafico', rotulo: 'Hoje',     render: ecraHoje },
  clientes: { titulo: 'Clientes', icone: 'pessoas', rotulo: 'Clientes', render: ecraClientes },
  programa: { titulo: 'O cartão', icone: 'cartoes', rotulo: 'O cartão', render: ecraPrograma },
};

async function irPara(nome) {
  /* A câmara desliga-se sempre que se sai do ecrã de carimbar: deixá-la a
     trabalhar em segundo plano gasta bateria e acende a luz do telemóvel sem
     razão nenhuma. */
  if (leitor) { leitor.parar(); leitor = null; }
  estado.ecra = nome;
  const principal = $('#principal');
  principal.innerHTML = '';
  $('#topo-titulo').textContent = ECRAS[nome].titulo;
  desenharBarra();
  window.scrollTo({ top: 0, behavior: 'instant' });
  await ECRAS[nome].render(principal);
  principal.focus({ preventScroll: true });
}

function desenharBarra() {
  const barra = $('#barra');
  barra.innerHTML = '';
  for (const [nome, e] of Object.entries(ECRAS)) {
    barra.append(el('button', {
      class: 'barra-item', 'aria-current': nome === estado.ecra ? 'page' : null,
      aoClick: () => irPara(nome),
    },
      el('span', { html: icone(e.icone, { tamanho: 24 }) }),
      el('span', { texto: e.rotulo })));
  }
}

/* =========================================================================
   Arranque
   ========================================================================= */

async function entrar() {
  $('#entrada').hidden = true;
  $('#aplicacao').hidden = false;
  const r = await api.negocioDoOperador(ler('operador', 'o-demo'));
  estado.operador = r.operador;
  estado.negocio = r.negocio;
  estado.programa = r.negocio.programas[0];
  guardar('operador', r.operador.id);
  guardar('balcao-entrou', true);

  $('#botao-negocio').innerHTML = icone('engrenagem', { tamanho: 20 });
  $('#botao-negocio').addEventListener('click', () => irPara('programa'));

  await irPara('carimbar');
}

async function arrancar() {
  /* Escuro sempre — ver o comentário no topo de balcao.css. */
  document.documentElement.dataset.tema = 'escuro';
  const topo = $('#topo');
  addEventListener('scroll', () => { topo.dataset.rolado = window.scrollY > 4 ? 'sim' : 'nao'; }, { passive: true });

  if (ler('balcao-entrou')) { await entrar(); }
  else {
    $('#entrada').hidden = false;
    $('#entrar-demo').addEventListener('click', entrar);
  }

  if ('serviceWorker' in navigator) {
    try {
      /* Ver o comentário igual em app.js: o GitHub Pages não deixa mexer nos
         cabeçalhos e serve tudo com dez minutos de cache. */
      await navigator.serviceWorker.register(`${base()}/balcao/sw.js`, {
        scope: `${base()}/balcao/`, updateViaCache: 'none',
      });
    }
    catch { /* nada */ }
  }
}

arrancar().catch((e) => {
  console.error(e);
  document.body.innerHTML = '<div class="coluna" style="padding-block:56px">'
    + '<h1>Alguma coisa correu mal</h1><p style="margin-top:12px;color:var(--tinta-2)">'
    + seguro(e.message) + '</p></div>';
});
