/* =========================================================================
   Carimbo Digital Balcão — a aplicação de quem carimba

   A regra que manda em tudo o resto: ao balcão há fila. Cada ecrã tem de
   funcionar com um polegar, à primeira, com o telemóvel numa mão e o café na
   outra. Nada de confirmações a mais, nada de menus escondidos.
   ========================================================================= */

import {
  $, el, icone, avisar, guardar, ler, apagar, vibrar, confetes,
  pintarCartao, haQuanto, dataCurta, horas, NOMES_SELOS, seguro,
  prenderFoco, colunas,
} from '../js/nucleo.js';
import { api, MODO, DEMO_FORCADO, definirChaveSessao } from '../js/api.js';

/* O balcão guarda a sessão numa chave própria — ver o comentário em
   api.js. Tem de ser dito antes do primeiro pedido. */
definirChaveSessao('sessao-balcao');
import { lerQR } from '../js/qr-leitor.js';

const estado = {
  negocio: null,
  operador: null,
  programa: null,
  ecra: 'carimbar',
  ultimoMovimento: null,
};

function base() {
  return (globalThis.CARIMBO_CONFIG && globalThis.CARIMBO_CONFIG.base) || '';
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
    this.desistiu = false;
  }

  async comecar() {
    const fluxo = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });

    /* A autorização da câmara pode demorar segundos — e nesses segundos a
       pessoa muda de separador. O `parar()` corria antes de o fluxo chegar,
       não encontrava nada para desligar, e a câmara ficava acesa até se
       fechar a app: a luz do telemóvel ligada em cima do balcão, a gastar
       bateria, sem nada no ecrã que o explicasse. Se já nos mandaram parar,
       desliga-se o que acabou de chegar e sai-se. */
    if (this.desistiu) {
      try { fluxo.getTracks().forEach((t) => t.stop()); } catch { /* nada */ }
      return { nativo: false, parado: true };
    }
    this.fluxo = fluxo;
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
    this.desistiu = true;
    try { this.fluxo?.getTracks().forEach((t) => t.stop()); } catch { /* nada */ }
    if (this.video) this.video.srcObject = null;
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
  const meu = leitor = new Leitor(video, (valor) => carimbar(valor));

  /* Escreve-se no `visor` que esta função criou, e não no que estiver no
     documento. A câmara pode demorar segundos a responder — e nesses
     segundos a pessoa muda de separador. Quando a resposta chegava,
     `$('#visor-estado')` já não existia, o `.textContent` rebentava com um
     TypeError, e a excepção subia até ao `catch` do arrancar(), que a lia
     como «a sessão não presta» e mandava o operador de volta ao ecrã de
     entrada — com o email a pedir outra vez, a meio de um serviço.
     Se já não somos o leitor em curso, não se toca em nada. */
  const estadoDoVisor = visor.querySelector('#visor-estado');
  const botaoManual = manual.querySelector('#botao-manual');
  try {
    await meu.comecar();
    if (leitor !== meu) return;
    estadoDoVisor.textContent = 'Aponta ao código do cliente';
    visor.dataset.ativo = 'sim';
  } catch {
    if (leitor !== meu) return;
    visor.dataset.ativo = 'nao';
    estadoDoVisor.innerHTML =
      'Sem acesso à câmara.<br>Autoriza nas definições do browser, ou escreve o número.';
    botaoManual.classList.replace('btn-suave', 'btn-cheio');
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
        maxlength: '6', placeholder: 'AE4KFM', class: 'campo-numero',
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

let soltarResultado = null;

function mostrarResultado(r) {
  const cartao = r.cartao;
  const p = cartao.programa;

  /* Todos os prémios por entregar, e não só os que acabaram de sair.
     Estava aqui o defeito mais caro do balcão: quem dissesse «levo noutro
     dia» ficava sem forma nenhuma de o levantar — o botão de entregar só
     existia no painel do carimbo que o tinha dado, e não havia outro
     caminho na app inteira. O prémio ficava preso na base de dados para
     sempre, e o cliente com um cartão cheio que não valia nada. */
  const porEntregar = cartao.premios && cartao.premios.length
    ? cartao.premios
    : r.ganhos;
  const ganhou = r.ganhos.length > 0;
  const temPremio = porEntregar.length > 0;

  const folha = el('div', { class: 'resultado', id: 'resultado', role: 'dialog', 'aria-modal': 'true' });
  const caixa = el('div', { class: 'resultado-caixa' });

  caixa.append(el('div', { class: `resultado-marca ${temPremio ? 'resultado-marca-premio' : ''}`,
    html: icone(temPremio ? 'presente' : 'visto', { tamanho: 34 }) }));

  caixa.append(el('h2', { class: 'resultado-titulo', texto: ganhou
    ? 'Cartão completo!'
    : temPremio ? 'Tem um prémio à espera'
    : r.novo ? 'Cartão criado e carimbado' : 'Carimbado' }));

  caixa.append(el('p', { class: 'resultado-sub', texto: temPremio
    ? `Entregar: ${porEntregar.map((g) => g.descricao).join(', ')}`
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
  if (temPremio) {
    for (const g of porEntregar) {
      acoes.append(el('button', {
        class: 'btn btn-cheio btn-grande btn-bloco',
        html: icone('presente', { tamanho: 18 }) + `<span>Entreguei: ${seguro(g.descricao)}</span>`,
        /* `ev.currentTarget` vale null depois do primeiro await — guarda-se
           antes. Sem isto o catch rebentava a si próprio, o botão ficava
           desactivado para sempre e o balcão pensava que tinha entregado. */
        aoClick: async (ev) => {
          const botao = ev.currentTarget;
          botao.disabled = true;
          try {
            await api.resgatar({ premioId: g.id, operador: estado.operador?.nome || 'Balcão' });
            avisar('Prémio entregue.', 'bom');
            fecharResultado();
          } catch (e) {
            botao.disabled = false;
            avisar(e.message || 'Não deu para registar a entrega.', 'mau');
          }
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
     no cliente» que acontece uma vez por semana em qualquer balcão.

     Isto ia buscar o cartão a `/v1/cliente/cartoes/:id` para descobrir o
     movimento — uma rota de CLIENTE, pedida com a sessão do OPERADOR. Em
     demonstração passava, porque lá ninguém confere sessões; em produção
     respondia 401 e o botão nunca funcionou. O carimbo já devolve o
     `movimentoId`: não é preciso ir perguntar a ninguém. */
  if (r.movimentoId) {
    /* Meio segundo de carência, e só nesta.

       O painel nasce no mesmo sítio do ecrã onde estava o botão em que a
       pessoa acabou de carregar, e esta é a única acção destrutiva que o
       balcão tem. Um toque duplo — ou um dedo que insiste porque a app
       pareceu lenta — anulava o carimbo que o primeiro toque tinha dado, em
       silêncio: o cliente ia-se embora com o cartão na mesma.

       A carência é só neste botão, e não no painel inteiro: um painel que
       não aceita toques deixa de ser visível ao teste de «isto está tapado?»
       — e passar a ser transparente para se proteger é trocar um problema
       por outro. */
    const anular = el('button', {
      class: 'btn btn-fantasma btn-bloco btn-pequeno',
      disabled: true,
      html: icone('menos', { tamanho: 16 }) + '<span>Enganei-me — anular</span>',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        botao.disabled = true;
        try {
          await api.anular({ movimentoId: r.movimentoId });
          avisar('Carimbo anulado.', 'bom');
          fecharResultado();
        } catch (e) {
          botao.disabled = false;
          avisar(e.message || 'Não deu para anular.', 'mau');
        }
      },
    });
    acoes.append(anular);
    setTimeout(() => { anular.disabled = false; }, 500);
  }

  caixa.append(acoes);
  folha.append(caixa);
  folha.setAttribute('aria-label', temPremio ? 'Prémio a entregar' : 'Cartão carimbado');

  document.body.append(folha);
  soltarResultado = prenderFoco(folha, { aoEscapar: fecharResultado });

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
  if (soltarResultado) { soltarResultado(); soltarResultado = null; }
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
  let [titulo, corpo] = explicacoes[e.codigo] || ['Não deu', e.message];
  /* O corpo de alguns erros começa pelo próprio título — a mensagem do
     servidor traz a frase inteira e a tabela acima só lhe põe um chapéu.
     Lido em voz alta ao balcão fica «Já foi carimbado há pouco. Já foi
     carimbado há pouco. Volte a tentar daqui a 60 min.» */
  if (corpo && titulo && corpo.startsWith(titulo)) {
    corpo = corpo.slice(titulo.length).replace(/^[.\s—-]+/, '') || corpo;
  }
  const folha = el('div', { class: 'resultado', id: 'resultado', role: 'alertdialog',
                            'aria-modal': 'true', 'aria-label': titulo },
    el('div', { class: 'resultado-caixa' },
      el('div', { class: 'resultado-marca resultado-marca-mau', html: icone('alerta', { tamanho: 34 }) }),
      el('h2', { class: 'resultado-titulo', texto: titulo }),
      el('p', { class: 'resultado-sub', texto: corpo }),
      el('div', { class: 'resultado-acoes' },
        el('button', { class: 'btn btn-cheio btn-grande btn-bloco', texto: 'Tentar outra vez', aoClick: fecharResultado }))));
  document.body.append(folha);
  soltarResultado = prenderFoco(folha, { aoEscapar: fecharResultado });
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

  /* Um ouvinte, não quatro. O laço percorria os nomes dos campos e nunca
     usava o nome: registava o mesmo ouvinte no mesmo formulário quatro
     vezes, e a pré-visualização redesenhava-se quatro vezes por tecla.
     O `input` borbulha — no formulário chega uma vez. */
  form.addEventListener('input', () => desenharPrevia(previa));

  form.append(el('button', {
    class: 'btn btn-cheio btn-grande btn-bloco', style: 'margin-top:8px',
    texto: 'Guardar',
    aoClick: async (ev) => {
      const botao = ev.currentTarget;
      const escrito = Math.round(Number($('#f-objetivo').value));
      if (!Number.isFinite(escrito) || escrito < 2 || escrito > 30) {
        avisar('Os carimbos até ao prémio têm de estar entre 2 e 30.', 'mau');
        $('#f-objetivo')?.focus();
        return;
      }
      const objetivo = escrito;
      /* São dois pedidos e o primeiro pode passar e o segundo falhar. Sem
         tratamento, o botão ficava desactivado para sempre, metade ficava
         gravada, e o ecrã não dizia nada — o dono do café saía convencido
         de que tinha guardado. */
      botao.disabled = true;
      try {
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
      } catch (e) {
        botao.disabled = false;
        avisar(e.message || 'Não deu para guardar. Tenta outra vez.', 'mau');
      }
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
  /* Um cartão a MEIO, e nunca cheio: com o objectivo no mínimo (2), o
     `Math.ceil(2 * 0.6)` dava 2 e a pré-visualização mostrava um cartão
     completo a dizer «faltam 0 carimbos» — o exemplo mais confuso que se
     podia dar a quem está a montar o cartão. Deixa-se sempre pelo menos um
     por fazer. */
  const feitos = Math.max(1, Math.min(objetivo - 1, Math.ceil(objetivo * 0.6)));
  const faltam = objetivo - feitos;
  /* A MESMA grelha da app do cliente, vinda do núcleo. Havia aqui uma regra
     própria — `objetivo <= 6 ? 3 : 5` — e o editor, que promete «é assim
     que os clientes o vêem», mostrava um cartão de nove em cinco colunas
     quando o cliente o via em três. */
  const cols = colunas(objetivo);

  previa.innerHTML = '';
  previa.append(el('div', { class: 'cartao-corpo' },
    el('div', { class: 'cartao-topo' },
      el('div', { class: 'cartao-marca' },
        el('div', { class: 'cartao-nome', texto: nome }),
        el('div', { class: 'cartao-tipo', texto: prog })),
      el('div', { class: 'cartao-id' },
        el('span', { texto: 'cartão' }), el('b', { texto: 'AE4KFM' }))),
    el('div', { class: 'carimbos', estilo: { '--colunas': String(cols) },
      html: Array.from({ length: objetivo }, (_, k) =>
        `<div class="carimbo" data-estado="${k < feitos ? 'cheio' : 'vazio'}" `
        + `style="--inclina:${((k * 37) % 9) - 4}deg">`
        + icone(selo, { tipo: 'cheio', tamanho: 24 }) + '</div>').join('') }),
    el('div', { class: 'cartao-rodape' },
      el('div', {},
        /* Singular à parte, como na app do cliente: «faltam 1 carimbos» era
           a pré-visualização a escrever pior português do que o produto. */
        el('div', { class: 'cartao-rotulo',
                    texto: faltam === 1 ? 'falta 1 carimbo' : `faltam ${faltam} carimbos` }),
        el('div', { class: 'cartao-premio', texto: premio })))));
  pintarCartao(previa, estado.negocio.cor);
}

/* =========================================================================
   Painel
   ========================================================================= */

/* =========================================================================
   O botão de voltar

   O balcão não tratava disto de todo: abrir o painel do número do cartão e
   carregar em voltar levava o separador para fora de /balcao/ — e numa app
   instalada isso é a app a fechar-se, com o cliente à espera. O modelo é o
   mesmo da app do cliente: cada coisa que se abre por cima é uma entrada, e
   voltar desfaz a última.
   ========================================================================= */

try { history.scrollRestoration = 'manual'; } catch { /* nem sempre existe */ }

let recuosNossos = 0;

function empurrarHistorico(marca) {
  try { history.pushState({ carimbo: marca }, ''); } catch { /* sem histórico */ }
}

function recuar() {
  recuosNossos++;
  try { history.back(); } catch { recuosNossos--; }
}

addEventListener('popstate', () => {
  if (recuosNossos > 0) { recuosNossos--; return; }
  if ($('#resultado')) { fecharResultado(); empurrarHistorico('ecra'); return; }
  if ($('#painel')) { fecharPainel({ historico: false }); return; }
  /* Fora dos painéis, voltar leva ao ecrã de carimbar, que é a casa do
     balcão. Já lá estando, deixa-se sair — quem carrega duas vezes quer
     mesmo ir-se embora. */
  if (estado.ecra && estado.ecra !== 'carimbar') {
    empurrarHistorico('ecra');
    irPara('carimbar');
  }
});

let soltarPainel = null;

function abrirPainel(titulo) {
  const jaHavia = Boolean($('#painel'));
  fecharPainel({ historico: false });
  if (!jaHavia) empurrarHistorico('painel');
  const folha = el('div', { class: 'painel-folha', role: 'dialog', 'aria-modal': 'true', 'aria-label': titulo },
    el('div', { class: 'painel-pega' }),
    el('h2', { style: 'margin-bottom:12px', texto: titulo }));
  document.body.append(el('div', { class: 'painel', id: 'painel' },
    el('div', { class: 'painel-veu', aoClick: fecharPainel }), folha));
  /* Foco para dentro, Tab preso lá, e devolvido ao fechar — as três coisas
     que o `aria-modal="true"` promete e que nenhuma acontecia sozinha. */
  soltarPainel = prenderFoco(folha, { aoEscapar: () => fecharPainel() });
  return folha;
}
function fecharPainel({ historico = true } = {}) {
  const havia = Boolean($('#painel'));
  if (soltarPainel) { soltarPainel(); soltarPainel = null; }
  $('#painel')?.remove();
  if (havia && historico) recuar();
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
  try {
    await ECRAS[nome].render(principal);
  } catch (erro) {
    /* Um ecrã que não deu para pintar tem de o dizer. Sem isto, tocar em
       «Hoje» com a API em baixo deixava o título e mais nada — e o erro
       morria dentro do clique, sem consola aberta para o ver. */
    principal.innerHTML = '';
    principal.append(el('div', { class: 'vazio' },
      el('div', { class: 'vazio-desenho', html: icone('ligacao', { tamanho: 64 }) }),
      el('h2', { texto: 'Não deu para carregar' }),
      el('p', { class: 'subtexto', texto: 'Verifica a ligação e tenta outra vez.' }),
      el('button', { class: 'btn btn-cheio', texto: 'Tentar outra vez',
                     aoClick: () => irPara(nome) }),
      el('p', { class: 'miudo', style: 'margin-top:12px', texto: erro?.message || '' })));
  }
  /* Ao topo só depois de o conteúdo existir: a rolar antes, a página
     voltava a descer sozinha um fotograma depois e o ecrã novo abria a
     meio. */
  window.scrollTo({ top: 0, behavior: 'instant' });
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

/* =========================================================================
   Entrar
   Duas portas: quem já tem negócio entra pelo email, e quem tem convite
   funda o negócio na hora. Em modo de demonstração há uma terceira, que é
   experimentar sem nada — e é a que fica em destaque.
   ========================================================================= */

function desenharEntrada() {
  const acoes = $('#entrada-acoes');
  acoes.innerHTML = '';

  if (MODO === 'demo') {
    acoes.append(
      el('button', {
        class: 'btn btn-cheio btn-grande btn-bloco', texto: 'Experimentar agora',
        aoClick: entrar,
      }),
      el('p', { class: 'entrada-nota', texto:
        'Nesta demonstração os dados ficam só neste telemóvel — não há '
        + 'servidor nenhum a receber nada.' }));
    if (DEMO_FORCADO) {
      acoes.append(el('button', {
        class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: 'Sair da demonstração',
        aoClick: () => { location.href = '?demo=0'; },
      }));
    }
    return;
  }

  acoes.append(
    el('button', {
      class: 'btn btn-cheio btn-grande btn-bloco', texto: 'Entrar',
      aoClick: entrarPorEmail,
    }),
    el('button', {
      class: 'btn btn-contorno btn-bloco', texto: 'Tenho um convite',
      aoClick: fundarNegocio,
    }),
    /* A porta para quem só quer ver. Um dono de café não vai pedir um convite
       antes de saber o que isto faz — e a demonstração corre no espaço de
       chaves dela, por isso não estraga nada. */
    el('button', {
      class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: 'Só quero ver como funciona',
      aoClick: () => { location.href = '?demo=1'; },
    }),
    el('p', { class: 'entrada-nota', texto:
      'Sem instalar nada, sem cartão de crédito, sem mensalidade.' }));
}

function entrarPorEmail() {
  const painel = abrirPainel('Entrar no balcão');
  painel.append(
    el('p', { class: 'subtexto', texto: 'Escreve o email com que o negócio foi criado. '
      + 'Enviamos um código de seis algarismos.' }),
    el('label', { class: 'campo' },
      el('span', { texto: 'Email' }),
      el('input', { id: 'e-email', type: 'email', inputmode: 'email',
                    autocomplete: 'email', placeholder: 'o.teu@email.pt' })),
    el('button', {
      class: 'btn btn-cheio btn-bloco btn-grande', texto: 'Enviar o código',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        const email = $('#e-email').value.trim().toLowerCase();
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          avisar('Esse email não parece válido.', 'mau'); return;
        }
        botao.disabled = true;
        try { await api.entrarBalcao(email); pedirCodigoBalcao(email); }
        catch (e) { botao.disabled = false; avisar(e.message, 'mau'); }
      },
    }));
  setTimeout(() => $('#e-email')?.focus(), 120);
}

function pedirCodigoBalcao(email) {
  const painel = abrirPainel('Escreve o código');
  painel.append(
    el('p', { class: 'subtexto', html:
      `Se este email tiver um negócio, enviámos-lhe um código. Vale 15 minutos.` }),
    el('label', { class: 'campo' },
      el('span', { texto: 'Código' }),
      el('input', { id: 'e-codigo', type: 'text', inputmode: 'numeric',
                    autocomplete: 'one-time-code', maxlength: '6',
                    placeholder: '000000', class: 'campo-codigo' })),
    el('button', {
      class: 'btn btn-cheio btn-bloco btn-grande', texto: 'Entrar',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        const codigo = $('#e-codigo').value.replace(/\D/g, '');
        if (codigo.length !== 6) { avisar('O código tem seis algarismos.', 'mau'); return; }
        botao.disabled = true;
        try {
          const r = await api.sessaoBalcao(email, codigo);
          guardar('sessao-balcao', r.sessao);
          fecharPainel();
          await entrar();
        } catch (e) { botao.disabled = false; avisar(e.message, 'mau'); }
      },
    }));
  const campo = $('#e-codigo');
  campo.addEventListener('input', () => { campo.value = campo.value.replace(/\D/g, ''); });
  setTimeout(() => campo.focus(), 120);
}

function fundarNegocio() {
  const painel = abrirPainel('Criar o meu cartão');
  painel.append(
    el('p', { class: 'subtexto', texto: 'Enquanto o Carimbo Digital estiver por '
      + 'convite, é preciso um código para criar um negócio.' }),
    el('label', { class: 'campo' },
      el('span', { texto: 'Código de convite' }),
      el('input', { id: 'f-convite', type: 'text', autocomplete: 'off',
                    spellcheck: 'false', placeholder: 'o código que te deram' })),
    el('label', { class: 'campo' },
      el('span', { texto: 'Nome do negócio' }),
      el('input', { id: 'f-negocio', maxlength: '60', placeholder: 'Café Torrado' })),
    el('label', { class: 'campo' },
      el('span', { texto: 'Localidade' }),
      el('input', { id: 'f-localidade', maxlength: '40', placeholder: 'Ovar' })),
    el('label', { class: 'campo' },
      el('span', { texto: 'Email de quem manda' }),
      el('input', { id: 'f-email', type: 'email', inputmode: 'email',
                    autocomplete: 'email', placeholder: 'o.teu@email.pt' })),
    el('label', { class: 'campo' },
      el('span', { texto: 'O prémio' }),
      el('input', { id: 'f-premio', maxlength: '60',
                    placeholder: 'Um café por conta da casa' })),
    el('label', { class: 'campo' },
      el('span', { texto: 'Carimbos até ao prémio' }),
      el('input', { id: 'f-objetivo', type: 'number', min: '2', max: '30',
                    step: '1', value: '10' })),
    el('button', {
      class: 'btn btn-cheio btn-bloco btn-grande', texto: 'Criar',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        const nome = $('#f-negocio').value.trim();
        const email = $('#f-email').value.trim().toLowerCase();
        if (nome.length < 2) { avisar('Falta o nome do negócio.', 'mau'); return; }
        if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
          avisar('Esse email não parece válido.', 'mau'); return;
        }
        /* O `min`/`max` do campo só valem se o formulário for submetido, e
           este não é: é um botão com um tratador. Sem esta verificação, quem
           escrevesse 99 via o pedido partir, o servidor cortar em silêncio
           para 30, e o cartão nascer diferente do que pediu — sem uma
           palavra a explicar porquê. */
        const objetivo = Math.round(Number($('#f-objetivo').value));
        if (!Number.isFinite(objetivo) || objetivo < 2 || objetivo > 30) {
          avisar('Os carimbos até ao prémio têm de estar entre 2 e 30.', 'mau');
          $('#f-objetivo')?.focus();
          return;
        }
        botao.disabled = true;
        try {
          const r = await api.fundar({
            codigo: $('#f-convite').value.trim(),
            nome, email,
            localidade: $('#f-localidade').value.trim() || null,
            premio: $('#f-premio').value.trim() || undefined,
            objetivo,
          });
          if (r.sessao) guardar('sessao-balcao', r.sessao);
          if (r.operadorId) guardar('operador', r.operadorId);
          fecharPainel();
          avisar('Negócio criado. O cartão já pode ser carimbado.', 'bom');
          await entrar();
        } catch (e) { botao.disabled = false; avisar(e.message, 'mau'); }
      },
    }),
    el('p', { class: 'miudo', style: 'margin-top:12px', texto:
      'Podes mudar tudo isto depois, no separador «O cartão».' }));
  setTimeout(() => $('#f-convite')?.focus(), 120);
}

async function arrancar() {
  /* Escuro sempre — ver o comentário no topo de balcao.css. */
  document.documentElement.dataset.tema = 'escuro';
  const topo = $('#topo');
  addEventListener('scroll', () => { topo.dataset.rolado = window.scrollY > 4 ? 'sim' : 'nao'; }, { passive: true });

  /* Uma sessão guardada não é garantia de nada: pode ter expirado ou o
     operador ter sido desactivado. Se falhar, volta-se ao ecrã de entrada em
     vez de mostrar um erro no meio de nada. */
  /* O registo do service worker foi para cima do `return`. Estava no fim da
     função, a seguir a um `return` que dispara sempre que há sessão — ou
     seja, o balcão de quem já entrou NUNCA o registava, que é precisamente
     o balcão que precisa de funcionar sem rede. */
  await registarServiceWorker();

  if (ler('balcao-entrou') && (MODO === 'demo' || ler('sessao-balcao'))) {
    try { await entrar(); return; }
    catch (erro) {
      /* Só se deita fora a sessão quando o servidor DIZ que ela não vale.
         Um erro de rede não é isso: apagar a marca por o Wi-Fi ter falhado
         punha o operador a pedir o email outra vez por nada. */
      if (!erro.rede) apagar('balcao-entrou');
      $('#entrada').hidden = false;
      desenharEntrada();
      if (erro.rede) avisar('Sem ligação. Verifica a Internet e tenta entrar de novo.', 'mau');
      return;
    }
  }
  $('#entrada').hidden = false;
  desenharEntrada();
}

async function registarServiceWorker() {
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
