/* =========================================================================
   Carimbo Digital Balcão — a aplicação de quem carimba

   A regra que manda em tudo o resto: ao balcão há fila. Cada ecrã tem de
   funcionar com um polegar, à primeira, com o telemóvel numa mão e o café na
   outra. Nada de confirmações a mais, nada de menus escondidos.
   ========================================================================= */

import {
  $, el, icone, avisar, guardar, ler, apagar, vibrar, confetes,
  guardarNoSeparador, lerDoSeparador, foiRecarregamento,
  pintarCartao, haQuanto, dataCurta, horas, NOMES_SELOS, seguro,
  prenderFoco, colunas, prepararCampoDeCodigo,
} from '../js/nucleo.js';
import { api, MODO, DEMO_FORCADO, definirChaveSessao } from '../js/api.js';

/* O balcão guarda a sessão numa chave própria — ver o comentário em
   api.js. Tem de ser dito antes do primeiro pedido. */
definirChaveSessao('sessao-balcao');
import { lerQR } from '../js/qr-leitor.js';
import { carregarPortugal, criarMapa, emPortugal } from '../js/mapa.js';

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
    /* A CÂMARA JÁ ABERTA REAPROVEITA-SE, e é isto que tira do caminho a
       pergunta da autorização.

       O `parar()` desligava as tracks sempre que se saía do ecrã de carimbar,
       e voltar chamava `getUserMedia` outra vez. No Safari do iPhone — que é
       onde isto vive, ao balcão — cada chamada nova volta a perguntar «quer
       autorizar a câmara?». Quem carimba passa o dia entre o «Carimbar» e o
       «Hoje», e apanhava a pergunta em cada ida e volta, com o cliente à
       espera. Foi o dono do produto a apanhá-la.

       Guardar o fluxo resolve a pergunta e traz de volta o problema que o
       `parar()` existia para resolver: a luz da câmara acesa sem razão. Por
       isso o fluxo fica GUARDADO POR UM TEMPO — ver `arrumarCamara` — e
       desliga-se de vez se ninguém voltar, ou assim que a app for para trás. */
    const fluxo = camaraReutilizavel() || await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1280 }, height: { ideal: 720 } },
      audio: false,
    });
    cancelarArrumacaoDaCamara();
    for (const faixa of fluxo.getTracks()) faixa.enabled = true;

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

  /* `manter` quer dizer «vou-me embora mas se calhar já volto»: a leitura pára
     já, o vídeo solta-se, mas o fluxo fica de parte com as faixas desligadas.
     Sem ele — ao fechar a sessão, ao sair — desliga-se tudo agora. */
  parar({ manter = false } = {}) {
    this.correr = false;
    this.desistiu = true;
    if (this.video) this.video.srcObject = null;
    if (!this.fluxo) return;
    if (manter) guardarCamara(this.fluxo);
    else { try { this.fluxo.getTracks().forEach((t) => t.stop()); } catch { /* nada */ } }
    this.fluxo = null;
  }
}

let leitor = null;

/* =========================================================================
   A câmara entre dois ecrãs

   Noventa segundos. É a medida de «fui ver os clientes e já volto» — e não é
   a medida de «pousei o telemóvel». Quem volta dentro desse tempo encontra a
   câmara aberta, sem pergunta nenhuma; quem não volta deixa a luz apagar-se.

   E o relógio não é a única coisa que a desliga: assim que o separador deixa
   de estar à vista, desliga-se já. Um telemóvel pousado no balcão com a luz
   da câmara acesa é pior do que qualquer pergunta.
   ========================================================================= */

const CAMARA_GUARDADA_MS = 90000;
let fluxoGuardado = null;
let relogioDaCamara = null;

function camaraViva(fluxo) {
  try {
    return Boolean(fluxo) && fluxo.getVideoTracks().some((f) => f.readyState === 'live');
  } catch { return false; }
}

function camaraReutilizavel() {
  if (camaraViva(fluxoGuardado)) { const f = fluxoGuardado; fluxoGuardado = null; return f; }
  fluxoGuardado = null;
  return null;
}

function cancelarArrumacaoDaCamara() {
  if (relogioDaCamara) { clearTimeout(relogioDaCamara); relogioDaCamara = null; }
}

function desligarCamaraJa() {
  cancelarArrumacaoDaCamara();
  try { fluxoGuardado?.getTracks().forEach((f) => f.stop()); } catch { /* nada */ }
  fluxoGuardado = null;
}

function guardarCamara(fluxo) {
  desligarCamaraJa();
  if (!camaraViva(fluxo)) return;
  /* Desligadas, não paradas: `enabled = false` corta os fotogramas — e portanto
     o trabalho e a bateria — sem fechar o dispositivo, que é o que faria o
     Safari voltar a perguntar. */
  try { fluxo.getTracks().forEach((f) => { f.enabled = false; }); } catch { /* nada */ }
  fluxoGuardado = fluxo;
  relogioDaCamara = setTimeout(desligarCamaraJa, CAMARA_GUARDADA_MS);
}

/* E O LEITOR QUE ESTÁ A TRABALHAR TAMBÉM, e este era o buraco maior.

   A primeira versão disto só desligava o fluxo GUARDADO — o que está de parte
   entre dois ecrãs. Mas o caso que interessa é o outro: o telemóvel pousado no
   balcão, no ecrã de carimbar, que é onde a app abre. Aí o fluxo está vivo
   dentro do leitor, `fluxoGuardado` é nulo, e não se desligava nada.

   Ou seja: a correcção que veio tirar a pergunta da autorização teria deixado
   a câmara acesa exactamente na situação em que ela mais se nota. Foi a
   afirmação da bateria a apanhá-lo, não a leitura do código.

   Ao voltar, repinta-se o ecrã — é ele que volta a pedir a câmara. */
addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'hidden') {
    if (leitor) { leitor.parar(); leitor = null; }
    desligarCamaraJa();
  } else if (estado.ecra === 'carimbar' && !leitor && $('#barra')) {
    irPara('carimbar');
  }
});
addEventListener('pagehide', () => {
  if (leitor) { leitor.parar(); leitor = null; }
  desligarCamaraJa();
});

/* =========================================================================
   Ecrã: carimbar
   ========================================================================= */

async function ecraCarimbar(principal) {
  const p = estado.programa;

  /* O NOME DO NEGÓCIO VEM PRIMEIRO, e é a resposta a uma pergunta que foi
     feita em voz alta: «não sei se estou com o balcão errado».

     Este ecrã dizia «Carimbar» no topo e o nome do PROGRAMA na etiqueta —
     «Cartão do café» — e mais nada. Quem tem dois negócios, ou quem deixou o
     telemóvel do sócio aberto, não tinha em lado nenhum do ecrã onde carimba
     a indicação de em que loja é que estava a carimbar. E carimbar no balcão
     errado não dá erro: dá um carimbo, no cartão errado. */
  principal.append(el('div', { class: 'programa-atual' },
    el('span', { class: 'programa-selo', html: icone(p.selo, { tipo: 'cheio', tamanho: 20 }) }),
    el('span', { class: 'programa-texto' },
      el('b', { texto: estado.negocio.nome }),
      el('span', { texto: p.nome + ' · ' + (p.tipo === 'pontos'
        ? `prémios a partir de ${(p.marcos || [{ pontos: p.objetivo }])[0].pontos} pontos`
        : `${p.objetivo} carimbos · ${p.premio}`) }))));

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

  /* VEIO POR UM AMIGO. Quem está ao balcão tem de perceber porque é que o
     cartão saltou dois carimbos em vez de um — senão parece um erro da app, e
     a primeira coisa que alguém faz com um número que não percebe é
     desconfiar dele. */
  if (r.amigo && (r.amigo.convidado || r.amigo.convidador)) {
    const pecas = [];
    if (r.amigo.convidado) {
      pecas.push(`+${r.amigo.convidado} para quem chegou`);
    }
    if (r.amigo.convidador) {
      pecas.push(`+${r.amigo.convidador} para quem o trouxe`);
    } else if (r.amigo.tectoCheio) {
      pecas.push('quem o trouxe já chegou ao limite de convites premiados');
    }
    caixa.append(el('div', { class: 'resultado-amigo' },
      el('span', { html: icone('pessoas', { tamanho: 18 }) }),
      el('span', { texto: `Veio por um convite — ${pecas.join(', ')}.` })));
  }

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

  /* QUEM É ESTE? É aqui, e em mais lado nenhum, que a pergunta tem resposta: a
     pessoa está à frente, o código acabou de ser lido, e o balcão sabe com
     certeza a quem corresponde. Esse instante era deitado fora, e era por isso
     que a lista de clientes era uma coluna de códigos sem dono.

     Escreve o CAFÉ, e nunca se pede nada ao cliente. É a diferença entre isto
     caber no produto e obrigar a consentimento, a acordo de responsabilidade
     conjunta com cada café, e a deitar fora a frase «não pedimos nome,
     telefone nem morada» que está publicada em dois sítios. O cliente vê a
     alcunha na app dele e pode tirá-la. */
  caixa.append(linhaDaAlcunha(cartao));

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

/**
 * A linha da alcunha, no painel do carimbo.
 *
 * Fechada por omissão: quem está a carimbar às oito da manhã não quer um campo
 * de texto entre ele e o cliente seguinte. Mostra o que lá está, ou um convite
 * pequeno; abre quando se toca.
 */
function linhaDaAlcunha(cartao) {
  const caixa = el('div', { class: 'alcunha-linha' });

  const pintar = () => {
    caixa.innerHTML = '';
    caixa.append(el('button', {
      class: 'alcunha-botao', type: 'button',
      'aria-label': cartao.alcunha ? `Mudar o nome: ${cartao.alcunha}` : 'Dar um nome a este cliente',
      aoClick: () => abrirCampo(),
    },
      el('span', { class: 'linha-icone', html: icone('pessoas', { tamanho: 16 }) }),
      el('span', { class: cartao.alcunha ? 'alcunha-valor' : 'alcunha-vazia',
                   texto: cartao.alcunha || 'Quem é? Dá-lhe um nome' })));
  };

  const abrirCampo = () => {
    caixa.innerHTML = '';
    const campo = el('input', {
      class: 'campo-alcunha', type: 'text', maxlength: '60',
      placeholder: 'a Joana da manhã', value: cartao.alcunha || '',
      'aria-label': 'Como tratas este cliente',
    });
    const gravar = async () => {
      const texto = campo.value.trim().slice(0, 60);
      if (texto === (cartao.alcunha || '')) { pintar(); return; }
      campo.disabled = true;
      try {
        const r = await api.alcunhaDoCartao(cartao.id, texto);
        cartao.alcunha = (r && r.alcunha) || null;
        avisar(cartao.alcunha ? 'Guardado.' : 'Nome apagado.', 'bom');
      } catch (e) {
        avisar(e.message || 'Não deu para guardar.', 'mau');
      } finally {
        pintar();
      }
    };
    campo.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') { ev.preventDefault(); gravar(); }
      if (ev.key === 'Escape') pintar();
    });
    /* Grava ao sair do campo TAMBÉM, e não só no Enter: num telemóvel quase
       ninguém carrega em Enter — toca noutro sítio e espera que fique. */
    campo.addEventListener('blur', gravar);
    caixa.append(campo);
    setTimeout(() => campo.focus(), 40);
  };

  pintar();
  return caixa;
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
    /* OS DOIS LADOS DA MESMA CONFUSÃO. Sem estas duas linhas, um código de
       demonstração lido num balcão a sério caía em «formato» — «este código é
       de outra coisa qualquer» — e mandava procurar o defeito no leitor, na
       câmara ou no cartão, quando o que estava errado era o telemóvel do outro
       lado estar em demonstração. */
    demonstracao: ['Esse cartão é de uma demonstração', e.message],
    'a-serio': ['Este balcão é uma demonstração', e.message],
    'sem-cartao': ['Esse cartão não é deste balcão', 'O cartão é de outro negócio. Confirma que entraste no balcão certo.'],
    /* «Código inválido» sozinho não diz a ninguém o que fazer a seguir. A
       assinatura não bate por duas razões, e as duas se resolvem da mesma
       maneira: o código foi lido a meio de mudar, ou o cliente trocou de
       telemóvel e o segredo do aparelho é outro. */
    assinatura: ['Esse código não bate certo',
      'Pede ao cliente para fechar e abrir a app, e mostrar outra vez.'],
    'maximo-diario': ['Já chegou ao máximo de hoje', e.message],
    concorrencia: ['Já foi carimbado noutro aparelho', e.message],
  };
  /* ESTA TABELA TEM DE COBRIR TUDO o que o carimbar pode devolver, e há uma
     guarda no auditor que o exige. Sem ela, um código novo cai no «Não deu»
     genérico — foi o que aconteceu ao `demonstracao`, que durante meses se
     apresentou ao balcão como «este código é de outra coisa qualquer». */
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

/* =========================================================================
   Instalar no ecrã principal

   Não é conveniência nem vaidade de PWA: é o que impede o balcão de se
   desligar sozinho.

   O Safari do iPhone apaga TODO o armazenamento escrito por JavaScript de um
   site ao fim de 7 DIAS sem alguém lá ir — `localStorage`, `IndexedDB` e, o
   que dói mais, o registo do service worker. Traduzido para este balcão: a
   sessão desaparece e o modo sem rede desaparece com ela. Um café fechado à
   segunda, uma semana de férias, e o dono volta a encontrar o ecrã de entrada
   e um balcão que já não abre sem Wi-Fi.

   Uma app no ECRÃ PRINCIPAL não é parte do Safari e tem o seu próprio
   contador: aquilo não lhe toca. É a diferença entre «entra uma vez» e «entra
   outra vez cada vez que fecha uma semana».

   Do lado do Android o browser oferece-se para instalar e há um evento para o
   pedir. Do lado do iPhone não há evento nenhum: só se pode dizer à pessoa
   onde é que o botão está, e por isso os passos estão escritos à letra.
   ========================================================================= */

/** Já está instalado no ecrã principal? */
function noEcraPrincipal() {
  return window.matchMedia?.('(display-mode: standalone)').matches
    || navigator.standalone === true;
}

/* O Android dá um evento que se pode guardar e disparar mais tarde; o iPhone
   não dá nada. Apanha-se cedo, antes de qualquer ecrã existir. */
let convidarAInstalar = null;
addEventListener('beforeinstallprompt', (ev) => {
  ev.preventDefault();
  convidarAInstalar = ev;
});

const ADIADO = 'instalar-adiado';

/**
 * O aviso, e a razão por que ele volta.
 *
 * Dá para adiar — um aviso que não se pode calar é um aviso que se aprende a
 * ignorar — mas volta ao fim de três dias, porque o prazo do outro lado são
 * sete e a consequência é perder a sessão a meio de um turno. E o adiamento
 * mora no mesmo `localStorage` que o Safari apaga: se ele o apagar, o aviso
 * volta, o que nesse caso é exactamente o que tem de acontecer.
 */
function avisoDeInstalar() {
  if (noEcraPrincipal()) return null;
  const adiado = ler(ADIADO);
  if (adiado && Date.now() - adiado < 3 * 86400000) return null;

  /* O ANDROID TEM DE SAIR PRIMEIRO, e isto foi apanhado a conduzir e não a
     ler. A segunda metade — `MacIntel` com mais de um toque — é a forma
     conhecida de reconhecer um iPad, que desde o iPadOS 13 se apresenta como
     um Mac. Mas qualquer ambiente que emule um telemóvel em cima de um Mac
     satisfaz as duas condições: foi medido um `userAgent` de Pixel 8 com
     `platform: MacIntel` e cinco toques, e o aviso mandava um utilizador de
     Android procurar o botão Partilhar do Safari.

     Instruções erradas são piores do que nenhumas: quem as segue não encontra
     o que lá está escrito e conclui que a app é que está estragada. */
  const ua = navigator.userAgent;
  const iOS = !/Android/i.test(ua)
    && (/iPad|iPhone|iPod/.test(ua)
      || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1));

  const caixa = el('div', { class: 'folha caixa-texto', style: 'margin-bottom:16px' },
    el('p', { html: '<b>Põe o balcão no ecrã principal.</b> Assim ficas ligado '
      + 'sem ter de pedir o código outra vez, e o balcão continua a carimbar '
      + 'mesmo quando o Wi-Fi vai abaixo.' }));

  if (iOS) {
    /* Os passos à letra. Não há forma de o fazer por ela, e «adiciona ao ecrã
       principal» sem dizer onde é o botão é uma instrução que não se cumpre. */
    caixa.append(el('p', { class: 'miudo', style: 'margin-top:10px', html:
      'No iPhone: toca em <b>Partilhar</b> (o quadrado com a seta para cima, '
      + 'em baixo no Safari) e depois em <b>Adicionar ao ecrã principal</b>.' }));
    caixa.append(el('p', { class: 'miudo', style: 'margin-top:10px', html:
      'Enquanto isto estiver só no Safari, o iPhone apaga a tua sessão ao fim '
      + 'de <b>sete dias</b> sem abrires o balcão.' }));
  } else if (convidarAInstalar) {
    caixa.append(el('button', {
      class: 'btn btn-cheio btn-pequeno', style: 'margin-top:12px',
      texto: 'Instalar no ecrã principal',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        botao.setAttribute('aria-disabled', 'true');
        try {
          convidarAInstalar.prompt();
          const { outcome } = await convidarAInstalar.userChoice;
          if (outcome === 'accepted') { convidarAInstalar = null; irPara('hoje'); }
          else botao.removeAttribute('aria-disabled');
        } catch { botao.removeAttribute('aria-disabled'); }
      },
    }));
  } else {
    caixa.append(el('p', { class: 'miudo', style: 'margin-top:10px', texto:
      'No menu do browser, procura «Instalar aplicação» ou «Adicionar ao ecrã '
      + 'principal».' }));
  }

  caixa.append(el('button', {
    class: 'btn btn-fantasma btn-pequeno', style: 'margin-top:8px',
    texto: 'Agora não',
    aoClick: () => { guardar(ADIADO, Date.now()); irPara('hoje'); },
  }));
  return caixa;
}

async function ecraHoje(principal) {
  principal.append(el('h1', { class: 'titulo-grande', texto: 'Hoje' }));
  /* Antes dos números: é o que decide se este balcão ainda cá está para os
     mostrar daqui a duas semanas. */
  const aviso = avisoDeInstalar();
  if (aviso) principal.append(aviso);
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
          /* «a dois» era mentira a metade deles: o servidor conta os cartões a
             UM OU DOIS carimbos do fim (`BETWEEN 1 AND 2` no resumo), e quem
             está a um ouvia do balcão que lhe faltavam dois. Numa loja isso é
             a diferença entre o cliente voltar hoje ou não voltar. */
          el('b', { texto: `${r.quaseLa} cliente(s) a um ou dois carimbos do prémio` }),
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
    'Não pedimos nomes nem telefones aos teus clientes. Podes escrever uma alcunha '
    + 'em cada cartão — «a Joana da manhã» — para saberes quem é quem; eles vêem-na '
    + 'na app deles e podem apagá-la.' }));

  const lista = el('div', { class: 'lista' });
  for (const c of clientes) {
    /* QUEM TEM PRÉMIO É UM BOTÃO, e quem não tem é uma linha parada.

       A lista dizia «prémio» e não fazia nada. O único caminho para o painel
       de entrega era carimbar outra vez — e quem tinha acabado de fechar o
       cartão esbarrava no arrefecimento de uma hora. O cliente que dissesse
       «levo noutro dia» ficava sem café, e o balcão sem forma de lho dar. */
    const premios = c.premios || [];
    const dentro = [
      el('span', { class: 'linha-icone', html: icone(premios.length ? 'presente' : 'cartoes', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { class: 'mono', texto: c.publico }),
        /* A ALCUNHA LOGO A SEGUIR AO NÚMERO, e na ordem do DOM e não por um
           `order` do CSS: quem lê com um leitor de ecrã ouve pela ordem do
           documento, e pôr o nome a seguir ao detalhe fazia-o ouvir «8 de 10,
           última visita há dois dias» antes de saber de quem se trata.

           Tentei primeiro deixá-la no fim e subi-la com `order: -1`, para não
           mexer no que a bateria mede. Não funcionava: o `.linha-texto` não é
           um contentor flex — é um FILHO flex, com `flex: 1` — e os filhos
           dele são blocos. O `order` não tinha sobre o que agir. */
        c.alcunha ? el('span', { class: 'alcunha-na-lista', texto: c.alcunha }) : null,
        el('span', { class: 'linha-detalhe', texto: c.tipo === 'pontos'
          ? `${c.pontos} pontos · última visita ${c.ultimoEm ? haQuanto(c.ultimoEm) : '—'}`
          : `${c.carimbos}/${c.objetivo} · última visita ${c.ultimoEm ? haQuanto(c.ultimoEm) : '—'}` })),
      c.porResgatar
        ? el('span', { class: 'etiqueta etiqueta-bom', texto: 'prémio' })
        : el('span', { class: 'linha-fim', texto: '' }),
    ];
    lista.append(premios.length
      ? el('button', {
          class: 'linha', type: 'button',
          'aria-label': `Entregar o prémio de ${c.publico}`,
          aoClick: () => painelEntrega(c),
        }, ...dentro)
      : el('div', { class: 'linha' }, ...dentro));
  }
  principal.append(lista);
}

/**
 * Entregar um prémio sem carimbar.
 *
 * O painel do carimbo já sabia mostrar os prémios por entregar — mas só se
 * chegava lá carimbando, e o arrefecimento fecha essa porta durante uma hora.
 * Este abre-se a partir da lista de clientes, a qualquer hora, e não mexe no
 * cartão: entrega o que já estava ganho.
 */
function painelEntrega(cliente) {
  const folha = abrirPainel(`Cartão ${cliente.publico}`);
  const premios = cliente.premios || [];
  folha.append(el('p', { class: 'subtexto', texto: premios.length === 1
    ? 'Tem um prémio por levantar.'
    : `Tem ${premios.length} prémios por levantar.` }));

  for (const g of premios) {
    folha.append(el('button', {
      class: 'btn btn-cheio btn-grande btn-bloco',
      style: 'margin-top:10px',
      html: icone('presente', { tamanho: 18 }) + `<span>Entreguei: ${seguro(g.descricao)}</span>`,
      /* O `ev.currentTarget` vale null depois do primeiro await — guarda-se
         antes, senão o catch rebenta a si próprio e o botão fica morto. */
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        botao.disabled = true;
        try {
          await api.resgatar({ premioId: g.id, operador: estado.operador?.nome || 'Balcão' });
          avisar('Prémio entregue.', 'bom');
          fecharPainel();
          irPara('clientes');
        } catch (e) {
          botao.disabled = false;
          avisar(e.message || 'Não deu para registar a entrega.', 'mau');
        }
      },
    }));
  }

  folha.append(el('p', { class: 'miudo', style: 'margin-top:14px', texto:
    'Isto não carimba o cartão — entrega o que já estava ganho.' }));
}

/* =========================================================================
   Ecrã: o cartão (editor do programa)
   ========================================================================= */

/* =========================================================================
   O logótipo do negócio

   Serve duas coisas: o cartão na Wallet do telemóvel, onde a Google EXIGE um
   logótipo por programa — sem ele não há passe nenhum —, e a lista pública da
   app, onde hoje só há uma letra dentro de um quadrado colorido.

   A REDUÇÃO ACONTECE AQUI, no browser, e não no servidor. Uma fotografia
   tirada com o telemóvel são quatro megapixéis e uns bons megabytes; mandá-la
   para o Worker seria gastar o tecto do pedido, os dados móveis de quem está
   ao balcão, e o tempo de CPU que o plano gratuito conta. Sai daqui um
   quadrado de 512 px em PNG, que são umas dezenas de kilobytes.

   Quadrado e não ao alto: é o formato que a Google quer para o `programLogo`,
   e é o único que não fica esmagado quando o telemóvel o encaixa num círculo.
   ========================================================================= */

const LOGOTIPO_LADO = 512;

/** Lê o ficheiro, corta ao centro, reduz, e devolve um PNG em base64. */
/**
 * O fundo em que um logótipo transparente se lê.
 *
 * UM LOGÓTIPO ESCURO ASSENTA EM BRANCO, sempre. Branco contrasta com o que é
 * escuro, e é o que a Google já desenha à volta — o círculo dela é branco, e
 * assim o fundo não se vê.
 *
 * UM LOGÓTIPO CLARO precisa de fundo escuro, e é aí que estava o defeito: a
 * cor da marca era usada sem se lhe perguntar nada. Não é suposição que se
 * possa fazer — há um selector de cor livre no ecrã ao lado e o Worker aceita
 * qualquer `#RRGGBB`. Uma pastelaria em creme com um logótipo branco ficava
 * com branco sobre creme: 1,2:1, o mesmo que não estar lá. Agora a cor da
 * marca só entra se PASSAR; se não passar, o fundo é quase-preto, que passa
 * sempre.
 *
 * O mínimo é 3:1, que é o que a WCAG pede a um elemento gráfico — isto não é
 * texto corrido, é uma marca dentro de um círculo de 38 pt.
 */
/* A curva do sRGB para luz linear. É esta que a WCAG usa, e é a razão de a
   luminância não se poder calcular sobre a média das componentes: a curva é
   convexa, e a média de curvas não é a curva da média. */
const linear = (v) => { const u = v / 255; return u <= 0.03928 ? u / 12.92 : ((u + 0.055) / 1.055) ** 2.4; };
const luminancia = (r, g, b) => 0.2126 * linear(r) + 0.7152 * linear(g) + 0.0722 * linear(b);
const razaoDeContraste = (a, b) => (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);

/* O fundo tanto pode sair em `#RRGGBB` como em `rgb(r,g,b)`. Guarda-se sempre
   na primeira forma, que é a que o resto do sistema usa para cores. */
function hexDe(cor) {
  const t = String(cor || '').trim();
  if (/^#[0-9a-fA-F]{6}$/.test(t)) return t.toUpperCase();
  const n = t.match(/\d+/g);
  if (!n || n.length < 3) return null;
  return `#${n.slice(0, 3).map((v) => Number(v).toString(16).padStart(2, '0')).join('').toUpperCase()}`;
}

const rgbDe = (hex) => {
  const m = /^#([0-9a-fA-F]{6})$/.exec(String(hex || ''));
  if (!m) return null;
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
};

/**
 * O fundo em que um logótipo transparente se lê.
 *
 * UM LOGÓTIPO ESCURO ASSENTA EM BRANCO, sempre. Branco contrasta com o que é
 * escuro, e é o que a Google já desenha à volta — o círculo dela é branco, e
 * assim o fundo não se vê.
 *
 * UM LOGÓTIPO CLARO precisa de fundo escuro, e é aí que estava o defeito: a
 * cor da marca era usada sem se lhe perguntar nada. Não é suposição que se
 * possa fazer — há um selector de cor livre no ecrã ao lado e o Worker aceita
 * qualquer `#RRGGBB`. Uma pastelaria em creme com um logótipo branco ficava
 * com branco sobre creme: 1,2:1, o mesmo que não estar lá.
 *
 * O mínimo é 3:1, que é o que a WCAG pede a um elemento gráfico — isto não é
 * texto corrido, é uma marca dentro de um círculo de 38 pt.
 *
 * Devolve TAMBÉM de onde veio a cor, e isso não é enfeite: só a cor da marca
 * envelhece quando o dono muda o cartão. Decidir pela cor — comparar o
 * resultado com `estado.negocio.cor` — dava falsos positivos sempre que o
 * recurso ou a moldura do ficheiro calhassem de ser a mesma cor.
 */
function fundoQueContrasta(luzDoDesenho, claro, corDaMarca) {
  if (!claro) return { cor: '#FFFFFF', daMarca: false };
  const rgb = rgbDe(corDaMarca);
  if (!rgb) return { cor: '#17161C', daMarca: false };
  const passa = razaoDeContraste(luminancia(...rgb), luzDoDesenho) >= 3;
  return passa
    ? { cor: hexDe(corDaMarca), daMarca: true }
    : { cor: '#17161C', daMarca: false };
}

function reduzirLogotipo(ficheiro) {
  return new Promise((resolve, recusar) => {
    const leitor = new FileReader();
    leitor.onerror = () => recusar(new Error('Não deu para ler a imagem.'));
    leitor.onload = () => {
      const img = new Image();
      img.onerror = () => recusar(new Error('Isso não parece uma imagem.'));
      img.onload = () => {
        /* Mede-se numa cópia pequena. A imagem inteira espremida num quadrado
           deforma-a, mas aqui ninguém olha para a forma — olha-se para as
           cores, e essas não mudam por a imagem estar esticada. */
        const M = 128;
        const medida = document.createElement('canvas');
        medida.width = M; medida.height = M;
        const mctx = medida.getContext('2d', { willReadFrequently: true });
        mctx.drawImage(img, 0, 0, M, M);
        const px = mctx.getImageData(0, 0, M, M).data;
        const pixel = (x, y) => { const i = (y * M + x) * 4; return [px[i], px[i + 1], px[i + 2], px[i + 3]]; };

        /* UM SÓ PREDICADO para detectar a moldura E para a aparar.
           Estiveram dois, com tolerâncias diferentes — 12 para detectar, 3
           para aparar — e entre eles caía uma família inteira de ficheiros:
           os exportados sobre um fundo quase-liso (branco a #FAFAFA, que o
           Figma e o Illustrator produzem aos molhos). Os cantos concordavam
           dentro de 12, portanto havia moldura; nenhuma linha concordava
           dentro de 3, portanto não se aparava nada. O logótipo ficava com a
           margem toda e encolhido dentro do círculo.

           Três valores em 255 é o limiar abaixo do qual nem um ecrã bom mostra
           diferença; a transparência fica nos 32, que é onde um halo deixa de
           contar. São duas perguntas e cada uma tem o seu número, mas são as
           MESMAS duas em toda a função. */
        const daMesmaCor = (a, b) => (a[3] < 32 && b[3] < 32)
          || (Math.abs(a[0] - b[0]) < 3 && Math.abs(a[1] - b[1]) < 3
            && Math.abs(a[2] - b[2]) < 3 && Math.abs(a[3] - b[3]) < 3);

        const cantos = [pixel(0, 0), pixel(M - 1, 0), pixel(0, M - 1), pixel(M - 1, M - 1)];
        const moldura = cantos.every((c) => daMesmaCor(c, cantos[0])) ? cantos[0] : null;

        /* APARA-SE A MOLDURA antes de encolher. Quase todos os ficheiros de
           logótipo trazem margem a mais — e sem a tirar, o desenho fica ainda
           mais pequeno dentro do círculo do que precisava de ficar. */
        let x0 = 0; let y0 = 0; let x1 = M - 1; let y1 = M - 1;
        if (moldura) {
          const daMoldura = (x, y) => daMesmaCor(pixel(x, y), moldura);
          const linhaSo = (y) => { for (let x = 0; x < M; x += 1) if (!daMoldura(x, y)) return false; return true; };
          const colunaSo = (x) => { for (let y = 0; y < M; y += 1) if (!daMoldura(x, y)) return false; return true; };
          while (y0 < y1 && linhaSo(y0)) y0 += 1;
          while (y1 > y0 && linhaSo(y1)) y1 -= 1;
          while (x0 < x1 && colunaSo(x0)) x0 += 1;
          while (x1 > x0 && colunaSo(x1)) x1 -= 1;
          /* SE TUDO ERA MOLDURA repõe-se a tela; se só um dos eixos ficou
             estreito, NÃO se mexe no outro. A versão anterior repunha os
             quatro limites assim que um dos lados ficasse com menos de três
             células — e num banner de 4000×500 com uma marca vertical estreita
             isso deitava fora a aparagem do eixo longo, que era justamente a
             que valia a pena. */
          const nada = linhaSo(y0) && colunaSo(x0);
          if (nada) { x0 = 0; y0 = 0; x1 = M - 1; y1 = M - 1; }
        }

        /* DESENHA-SE PRIMEIRO, E MEDE-SE O QUE FOI DESENHADO.

           Havia aqui dois limiares de transparência a responder a perguntas
           diferentes, e entre eles cabia um logótipo inteiro: num ficheiro de
           2048 px com traços de 1 px, cada célula da grelha de 128 fica com
           alfa ≈ 16, a aparagem encontrava a caixa certa e a contagem dizia
           que não havia desenho nenhum.

           A saída não é escolher melhor o número: é parar de perguntar à
           grelha. Desenha-se em cima de transparente, no tamanho final, e
           mede-se ISSO — que é a imagem que vai ser guardada. */
        const desenho = document.createElement('canvas');
        desenho.width = LOGOTIPO_LADO;
        desenho.height = LOGOTIPO_LADO;
        const dctx = desenho.getContext('2d', { willReadFrequently: true });
        dctx.imageSmoothingQuality = 'high';

        const fx = (x0 / M) * img.width;
        const fy = (y0 / M) * img.height;
        const fl = ((x1 - x0 + 1) / M) * img.width;
        const fa = ((y1 - y0 + 1) / M) * img.height;
        /* CABE INTEIRO, E DENTRO DO CÍRCULO. Antes cortava-se um quadrado ao
           centro, e um logótipo em palavra larga — que é o que quase toda a
           gente tem: o nome do café escrito — perdia as pontas. «TITI
           BARBERSHOP» ficava «I BARBER».

           E não basta caber no quadrado: a Google desenha isto dentro de um
           CÍRCULO, e os cantos do quadrado ficam de fora. Um rectângulo cabe
           num círculo quando a sua DIAGONAL não passa o diâmetro — por isso é
           pela diagonal que se encolhe, e não pelo lado maior. Os 0,92 são
           folga para o desenho não encostar à borda. */
        const escala = (LOGOTIPO_LADO * 0.92) / Math.hypot(fl, fa);
        const largura = Math.max(1, Math.round(fl * escala));
        const altura = Math.max(1, Math.round(fa * escala));
        dctx.drawImage(img, fx, fy, fl, fa,
          Math.round((LOGOTIPO_LADO - largura) / 2),
          Math.round((LOGOTIPO_LADO - altura) / 2),
          largura, altura);

        /* A luminância do desenho, pesada pelo alfa — que é a forma certa de
           dar a cor média de um desenho com transparência: um traço fino e
           esbatido conta pouco, mas conta. E cada píxel é linearizado ANTES de
           entrar na média: a curva do sRGB é convexa, e linearizar a média dá
           sempre menos do que a média das linearizadas. O erro é zero num
           cinzento e cresce com a saturação — num verde puro dava 3,01:1 onde
           a verdade era 2,10:1, e deixava passar um fundo que não contrasta. */
        const dados = dctx.getImageData(0, 0, LOGOTIPO_LADO, LOGOTIPO_LADO).data;
        let soma = 0; let peso = 0;
        for (let k = 0; k < dados.length; k += 4) {
          const a = dados[k + 3];
          if (a === 0) continue;
          soma += a * luminancia(dados[k], dados[k + 1], dados[k + 2]);
          peso += a;
        }
        const luzDoDesenho = peso > 0 ? soma / peso : 0;
        /* O mesmo limiar de sempre (140 em 255), dito em luz linear. */
        const claro = luzDoDesenho > linear(140);

        /* O FUNDO. Se o ficheiro já traz fundo próprio e opaco, é esse que se
           usa: quem desenhou o logótipo já escolheu o fundo em que ele se lê.
           Se é transparente, mede-se. */
        const escolha = (moldura && moldura[3] >= 32)
          ? { cor: hexDe(`rgb(${moldura[0]},${moldura[1]},${moldura[2]})`), daMarca: false }
          : fundoQueContrasta(luzDoDesenho, claro, estado.negocio.cor);

        const tela = document.createElement('canvas');
        tela.width = LOGOTIPO_LADO;
        tela.height = LOGOTIPO_LADO;
        const ctx = tela.getContext('2d', { willReadFrequently: true });
        ctx.fillStyle = escolha.cor;
        ctx.fillRect(0, 0, LOGOTIPO_LADO, LOGOTIPO_LADO);
        ctx.drawImage(desenho, 0, 0);

        /* UMA IMAGEM SEM NADA VISÍVEL NÃO É UM LOGÓTIPO — e a pergunta faz-se
           ao RESULTADO, não à origem.
        
           A guarda anterior era «não há píxeis opacos», o que só apanhava
           ficheiros transparentes: um JPEG tem alfa 255 em todo o lado, por
           isso para metade dos formatos que a rota aceita era código morto. Um
           ficheiro exportado todo branco — a camada errada escondida, uma
           folha digitalizada — passava e ficava guardado como um quadrado de
           cor. O dono lia «Logótipo guardado», o botão da Wallet aparecia, e
           os clientes ficavam com um círculo vazio no cartão.
        
           Agora olha-se para a imagem composta e pergunta-se se há ali alguma
           coisa DIFERENTE do fundo. Se não há, não há logótipo. */
        const composta = ctx.getImageData(0, 0, LOGOTIPO_LADO, LOGOTIPO_LADO).data;
        const doFundo = rgbDe(escolha.cor) || [255, 255, 255];
        let diferentes = 0;
        for (let k = 0; k < composta.length; k += 4) {
          if (Math.abs(composta[k] - doFundo[0]) > 8
            || Math.abs(composta[k + 1] - doFundo[1]) > 8
            || Math.abs(composta[k + 2] - doFundo[2]) > 8) diferentes += 1;
        }
        if (diferentes === 0) {
          recusar(new Error('Essa imagem está vazia — é só uma cor, sem nada desenhado.'));
          return;
        }

        /* Devolve-se a cor cozida SÓ quando ela é a COR DA MARCA, e isso sabe-
           se pelo RAMO e não por comparação de cores. A partir daqui a cor está
           dentro dos bytes, e refazer a imagem depois não dá — o original não
           fica em lado nenhum. Mas só a cor da marca envelhece: um fundo que
           veio do próprio ficheiro é escolha de quem desenhou o logótipo, e o
           quase-preto e o branco de recurso também não envelhecem. Decidir por
           igualdade de cor punha um aviso impossível de limpar sempre que
           calhassem de ser a mesma cor. */
        resolve({ imagem: tela.toDataURL('image/png'), fundo: escolha.daMarca ? escolha.cor : null });
      };
      img.src = leitor.result;
    };
    leitor.readAsDataURL(ficheiro);
  });
}

function campoLogotipo() {
  const temImagem = Boolean(estado.negocio.logotipo);
  const alvo = el('div', { class: 'logo-previa', id: 'logo-previa' });
  const pintar = (fonte) => {
    alvo.innerHTML = '';
    if (fonte) alvo.append(el('img', { src: fonte, alt: 'O logótipo do negócio' }));
    else alvo.append(el('span', { class: 'logo-vazio', texto: 'sem imagem' }));
  };
  /* De onde vem a imagem a mostrar: em demonstração o próprio valor é um data
     URI; a sério é um endereço do Worker, com a data por sufixo para a cache
     não servir a anterior depois de uma troca. */
  const fonteDoLogotipo = () => {
    const v = estado.negocio.logotipo;
    if (!v) return null;
    if (typeof v === 'string' && v.startsWith('data:')) return v;
    return `${api.base()}/v1/negocio/${estado.negocio.slug}/logotipo`
      + `?v=${encodeURIComponent(estado.negocio.logotipo_em || '')}`;
  };
  pintar(fonteDoLogotipo());

  const entrada = el('input', {
    id: 'f-logotipo', type: 'file', accept: 'image/png,image/jpeg', class: 'escondido',
  });
  entrada.addEventListener('change', async () => {
    const ficheiro = entrada.files && entrada.files[0];
    if (!ficheiro) return;
    try {
      const { imagem: reduzido, fundo } = await reduzirLogotipo(ficheiro);
      pintar(reduzido);
      await api.guardarLogotipo(reduzido, fundo);
      estado.negocio.logotipo = reduzido;
      estado.negocio.logotipo_em = new Date().toISOString();
      estado.negocio.logotipo_fundo = fundo;
      avisar('Logótipo guardado.', 'bom');
    } catch (e) {
      avisar(e.message || 'Não deu para guardar a imagem.', 'mau');
      pintar(fonteDoLogotipo());
    }
    entrada.value = '';
  });

  return el('div', { class: 'campo campo-logotipo' },
    el('span', { texto: 'Logótipo' }),
    el('div', { class: 'logo-linha' },
      alvo,
      el('div', { class: 'logo-accoes' },
        el('button', {
          class: 'btn btn-contorno btn-pequeno', type: 'button',
          texto: temImagem ? 'Trocar a imagem' : 'Escolher uma imagem',
          aoClick: () => entrada.click(),
        }),
        el('p', { class: 'miudo', texto:
          'Quadrada fica melhor. É esta que vai no cartão da Wallet do telemóvel.' }))),
    entrada);
}

async function ecraPrograma(principal) {
  const p = estado.programa;
  principal.append(el('h1', { class: 'titulo-grande', texto: 'O meu cartão' }));
  principal.append(el('p', { class: 'subtexto', texto: 'É assim que os clientes o vêem.' }));

  /* Um negócio de demonstração não aparece na lista pública. Sem esta linha,
     o dono via o cartão certo e o seu café em lado nenhum, e não tinha por
     onde perceber porquê. */
  /* A COR COZIDA DEIXOU DE CONDIZER. O fundo do logótipo é pintado no momento
     do envio e fica dentro dos bytes do PNG; mudar a cor do cartão depois não
     o refaz, e não há como o refazer — o ficheiro original não fica guardado.
     Sem esta linha, o cartão ficava com a cor nova à volta e um quadrado da
     cor velha no meio, e não havia nada no ecrã que explicasse porquê. */
  const cozida = estado.negocio.logotipo_fundo;
  if (cozida && estado.negocio.cor
      && cozida.toUpperCase() !== String(estado.negocio.cor).toUpperCase()) {
    principal.append(el('div', { class: 'aviso-demo' },
      el('b', { texto: 'O logótipo ainda tem a cor antiga por trás.' }),
      el('span', { texto: `Foi gravado sobre ${cozida} e o cartão agora é `
        + `${estado.negocio.cor}. Carrega a imagem outra vez para ela apanhar a cor nova.` })));
  }

  if (estado.negocio.demonstracao) {
    principal.append(el('div', { class: 'aviso-demo' },
      el('b', { texto: 'Este negócio está marcado como demonstração.' }),
      el('span', { texto: 'Não aparece no «Descobrir» da app. O cartaz e o '
        + 'endereço próprio continuam a funcionar.' })));
  }

  const previa = el('div', { class: 'cartao', id: 'previa' });
  principal.append(previa);
  desenharPrevia(previa);

  const form = el('div', { class: 'seccao' },
    campoLogotipo(),
    el('label', { class: 'campo' },
      el('span', { texto: 'Nome do negócio' }),
      el('input', { id: 'f-nome', value: estado.negocio.nome, maxlength: '40' })),
    /* A MORADA NÃO SE PODIA CORRIGIR, e isso foi uma falta e não uma decisão:
       ela era escrita uma vez, ao fundar o negócio, e depois ficava assim para
       sempre. Um café que muda de porta não tinha por onde o dizer — e é a
       morada que aparece na página pública dele. */
    el('label', { class: 'campo' },
      el('span', { texto: 'Morada' }),
      el('input', { id: 'f-morada', value: estado.negocio.morada || '',
                    maxlength: '120', autocomplete: 'off',
                    placeholder: 'Rua e número' })),
    el('label', { class: 'campo' },
      el('span', { texto: 'Localidade' }),
      el('input', { id: 'f-localidade', value: estado.negocio.localidade || '',
                    maxlength: '60', autocomplete: 'off' })),
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

  /* --- traz um amigo ----------------------------------------------------
     O CAFÉ É QUE PAGA, e por isso é o café que decide — e nasce a zero, que é
     desligado. Carimbos, e não prémios: um prémio dado de repente a quem tem
     o cartão a meio é uma conversa difícil ao balcão; carimbos somam-se à
     regra que já existe e, se calhar, fecham o cartão.

     O tecto de três por lado não é gosto: é o que impede que um engano de
     teclado — «30» em vez de «3» — ofereça um cartão inteiro a cada pessoa
     que entra pela porta. */
  const amigo = (p.amigo || { convidador: 0, convidado: 0, max: 5 });
  principal.append(el('section', { class: 'seccao', id: 'seccao-traz-amigo' },
    el('h2', { class: 'seccao-titulo', texto: 'Traz um amigo' }),
    el('div', { class: 'folha caixa-texto' },
      el('p', { class: 'miudo', texto:
        'Cada cliente pode convidar quem conhece com um link. Quando a pessoa '
        + 'convidada for carimbada pela primeira vez aqui, os dois ganham os '
        + 'carimbos que escolheres. A zero, isto fica desligado.' }),
      el('label', { class: 'campo', style: 'margin-top:12px' },
        el('span', { texto: 'Carimbos para quem convida' }),
        el('input', { id: 'f-amigo-convidador', type: 'number', min: '0', max: '3',
                      step: '1', value: String(amigo.convidador || 0) })),
      el('label', { class: 'campo' },
        el('span', { texto: 'Carimbos para quem chega' }),
        el('input', { id: 'f-amigo-convidado', type: 'number', min: '0', max: '3',
                      step: '1', value: String(amigo.convidado || 0) })),
      el('label', { class: 'campo' },
        el('span', { texto: 'Convites premiados por cliente' }),
        el('input', { id: 'f-amigo-max', type: 'number', min: '1', max: '50',
                      step: '1', value: String(amigo.max ?? 5) })),
      el('p', { class: 'miudo', texto:
        'A recompensa só acontece no primeiro carimbo a sério, ao balcão — '
        + 'juntar o cartão não dá nada a ninguém.' }))));

  /* --- Cor -------------------------------------------------------------

     DOZE CORES NÃO CHEGAM, e a falta não era visível até um negócio a sério
     chegar. A barbearia tem `#EE9125`, medido na folha de estilo do site
     deles, e esse laranja não está na paleta. O que acontecia a quem abria
     este ecrã: nenhuma cor aparecia escolhida — porque nenhuma correspondia —
     e o gesto natural é carregar numa. Nesse instante a cor de marca era
     substituída por uma das doze, sem aviso, e **sem forma nenhuma de a
     recompor pela interface**. Foi exactamente o que se passou: o cartão da
     barbearia foi parar a um verde.

     A correcção tem duas metades, e ambas são precisas:

     · a cor ACTUAL entra sempre na paleta, mesmo não sendo uma das doze,
       marcada como escolhida. Quem chega vê o que tem, e não um vazio que
       convida a carregar;
     · e há um selector de cor a sério ao lado, para se poder pôr a cor exacta
       da marca em vez da mais parecida. `input type=color` é o control que
       todos os telemóveis sabem abrir.
     --------------------------------------------------------------------- */
  const SUGESTOES = ['#17161C', '#3B2417', '#12232E', '#B0446A', '#C9821F', '#1E7A6B',
                     '#5AAEE0', '#5A31E8', '#B03A2E', '#2E5E3A', '#6B4E9B', '#A8632B'];
  const corActual = String(estado.negocio.cor || '#17161C').toUpperCase();
  const cores = SUGESTOES.some((c) => c.toUpperCase() === corActual)
    ? SUGESTOES : [corActual, ...SUGESTOES];

  const paleta = el('div', { class: 'paleta' });
  const escolher = (c) => {
    estado.negocio.cor = c;
    for (const o of paleta.querySelectorAll('.paleta-cor')) {
      o.dataset.ativo = o.dataset.cor.toLowerCase() === c.toLowerCase() ? 'sim' : 'nao';
    }
    if (afinador.value.toLowerCase() !== c.toLowerCase()) afinador.value = c;
    desenharPrevia(previa);
  };

  /* O selector fino. Declarado antes do ciclo porque o `escolher` lhe toca. */
  const afinador = el('input', {
    id: 'f-cor', type: 'color', value: corActual,
    'aria-label': 'Escolher a cor exacta da marca',
  });
  afinador.addEventListener('input', () => {
    const c = afinador.value.toUpperCase();
    /* Se a cor afinada não estiver na paleta, entra nela — senão o ecrã
       mostrava uma coisa e o cartão outra. */
    if (!paleta.querySelector(`[data-cor="${c}"]`)) paleta.prepend(botaoDeCor(c));
    escolher(c);
  });

  function botaoDeCor(c) {
    const b = el('button', { class: 'paleta-cor', estilo: { background: c },
                             'aria-label': `Cor ${c}`, type: 'button' });
    b.dataset.cor = c;
    b.dataset.ativo = c.toLowerCase() === corActual.toLowerCase() ? 'sim' : 'nao';
    b.addEventListener('click', () => escolher(c));
    return b;
  }
  for (const c of cores) paleta.append(botaoDeCor(c));

  form.append(el('div', { class: 'campo' },
    el('span', { texto: 'Cor' }),
    el('div', { class: 'cor-linha' }, paleta, afinador)));

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
        morada: $('#f-morada').value.trim(),
        localidade: $('#f-localidade').value.trim(),
        cor: estado.negocio.cor,
      });
      await api.guardarPrograma(estado.negocio.id, {
        ...p,
        nome: $('#f-programa').value.trim() || p.nome,
        premio: $('#f-premio').value.trim() || p.premio,
        objetivo, selo: p.selo,
        regras: $('#f-regras').value.trim(),
        amigoConvidador: $('#f-amigo-convidador').value,
        amigoConvidado: $('#f-amigo-convidado').value,
        amigoMax: $('#f-amigo-max').value,
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

  /* ONDE FICA. É o que põe o estabelecimento no mapa do «Descobrir». */
  const onde = el('section', { class: 'seccao', id: 'seccao-onde-fica' },
    el('h2', { class: 'seccao-titulo', texto: 'Onde fica' }),
    el('div', { class: 'lista', id: 'linha-onde-fica' },
      el('div', { class: 'linha' },
        el('span', { class: 'linha-texto' }, el('b', { texto: 'A ver…' })))));
  principal.append(onde);
  pintarOndeFica(onde);

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

  /* QUEM CARIMBA. Um café com três turnos tem três pessoas a atender, e o
     histórico de cada cartão já guardava o nome de quem carimbou desde o
     primeiro dia — só que o nome era sempre o mesmo, porque só havia um
     operador possível. */
  const quem = el('section', { class: 'seccao', id: 'seccao-quem-carimba' },
    el('h2', { class: 'seccao-titulo', texto: 'Quem carimba' }),
    el('div', { class: 'lista', id: 'lista-operadores' },
      el('div', { class: 'linha' },
        el('span', { class: 'linha-texto' }, el('b', { texto: 'A ver…' })))));
  principal.append(quem);
  /* A LISTA VEM DEPOIS, e o ecrã não espera por ela. Este ecrã é o das
     definições do cartão: fazê-lo esperar por um pedido que nada tem que ver
     com o cartão era pôr o dono a olhar para um ecrã branco por causa de uma
     secção que está no fim. */
  pintarOperadores(quem).catch((e) => {
    const caixa = quem.querySelector('#lista-operadores');
    if (caixa) {
      caixa.innerHTML = '';
      caixa.append(el('div', { class: 'linha' },
        el('span', { class: 'linha-texto' },
          el('b', { texto: 'Não deu para carregar quem carimba' }),
          el('span', { texto: e.message || 'Tenta outra vez daqui a pouco.' }))));
    }
  });

  /* UM BALCÃO PERDIDO NÃO SE PODIA EXPULSAR, e o cenário é banal: o telemóvel
     fica no táxi, ou alguém sai zangado com a app instalada. A sessão dura 180
     dias E desliza a cada utilização — o que resolve «ficar sempre ligado» e
     fazia com que um balcão activo nunca expirasse. Não havia saída nenhuma
     sem apagar o negócio.

     Com a alcunha na lista, o que um telemóvel perdido mostra deixou de ser
     uma coluna de códigos sem dono: é o nome por que o café trata cada pessoa
     e o histórico de visitas de cada uma. */
  principal.append(el('section', { class: 'seccao' },
    el('h2', { class: 'seccao-titulo', texto: 'Segurança' }),
    el('div', { class: 'lista' },
      el('button', { class: 'linha', aoClick: expulsarBalcoes },
        el('span', { class: 'linha-icone', html: icone('cadeado', { tamanho: 20 }) }),
        el('span', { class: 'linha-texto' },
          el('b', { texto: 'Terminar sessão nos outros aparelhos' }),
          el('span', { texto: 'Se perdeste um telemóvel com o balcão aberto' })),
        el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })))));

  /* O BALCÃO NÃO TINHA UMA ÚNICA LIGAÇÃO AOS TERMOS NEM À PRIVACIDADE, e os
     Termos §5 dizem «ao usar o Carimbo Digital, aceita as condições de
     subcontratação descritas na política de privacidade». Aceitar uma coisa
     que não se tem por onde ler não é aceitar nada — e quem tem o balcão é o
     RESPONSÁVEL pelo tratamento dos dados dos clientes dele, com a nossa
     casa como subcontratante. É o lado que mais precisa de as ler, e era o
     único que não tinha por onde.

     `target="_blank"` NAS DUAS, e não por hábito: o manifesto do balcão
     declara um `scope` de `/balcao/`, e `/termos/` está fora dele. Numa app
     posta no ecrã principal, um link para fora do âmbito abre o Safari e o
     balcão fica para trás — no meio de um turno, com a câmara a meio de um
     carimbo. O `rel="noopener"` vai junto porque `_blank` sem ele dá à página
     nova acesso ao `window.opener`. */
  principal.append(el('p', { class: 'rodape-app', html:
    'Carimbo Digital · '
    + `<a class="ligacao" href="${base()}/termos/" target="_blank" rel="noopener">Termos</a> · `
    + `<a class="ligacao" href="${base()}/privacidade/" target="_blank" rel="noopener">Privacidade</a>` }));
}

/**
 * Fechar os outros balcões.
 *
 * Este aparelho fica. Vale para todos os operadores do negócio, e não só para
 * quem carrega: o telemóvel perdido pode ter entrado com outra morada, e quem
 * o perde quer fechar a porta e não auditar por onde alguém entrou.
 */
function expulsarBalcoes() {
  const painel = abrirPainel('Terminar nos outros aparelhos');
  painel.append(
    el('p', { class: 'subtexto', texto:
      'Todos os outros telemóveis e computadores onde este balcão esteja aberto '
      + 'deixam de lá entrar. Este continua.' }),
    el('div', { class: 'folha caixa-texto', style: 'margin-bottom:16px' },
      el('p', { class: 'miudo', html:
        'Quem estiver noutro aparelho tem de <b>pedir o código por email outra '
        + 'vez</b> para voltar a entrar. Os códigos que estejam por usar também '
        + 'deixam de valer — eram uma segunda chave deixada para trás.' })),
    el('button', {
      class: 'btn btn-cheio btn-bloco btn-grande', texto: 'Terminar nos outros',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        botao.setAttribute('aria-disabled', 'true');
        try {
          await api.sairDosOutrosBalcoes();
          fecharPainel();
          avisar('Feito. Os outros aparelhos deixaram de ter acesso.', 'bom');
        } catch (e) {
          botao.removeAttribute('aria-disabled');
          avisar(e.message || 'Não deu para terminar.', 'mau');
        }
      } }),
    el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: 'Cancelar',
      aoClick: fecharPainel }));
}

/* =========================================================================
   Onde fica o estabelecimento

   É o que o põe no mapa do «Descobrir». O ponto vem do telemóvel de quem está
   ao balcão — que é onde este balcão é usado, e é por isso que dá precisão ao
   nível da porta — ou do mapa arrastado à mão, para quem estiver a inscrever o
   negócio de casa.

   NÃO HÁ GEOCODIFICADOR, e é uma decisão e não uma falta: perguntar a morada a
   um serviço de terceiros dava o centro da rua, a oitenta metros, porque o
   número de porta não está no OpenStreetMap. Daria pior do que o telemóvel que
   está na mão de quem preenche isto, e acrescentava um domínio à política de
   privacidade para dar pior.
   ========================================================================= */

/** Um ponto escrito como uma pessoa o lê. */
const emGraus = (n) => Number(n).toFixed(5);

async function pintarOndeFica(seccao) {
  const caixa = seccao.querySelector('#linha-onde-fica');
  if (!caixa) return;
  const n = estado.negocio;
  const tem = typeof n.latitude === 'number' && typeof n.longitude === 'number';
  caixa.innerHTML = '';

  caixa.append(el('button', { class: 'linha', aoClick: () => painelDoPonto(seccao) },
    el('span', { class: 'linha-icone', html: icone('mapa', { tamanho: 20 }) }),
    el('span', { class: 'linha-texto' },
      el('b', { texto: tem ? 'Está no mapa' : 'Ainda não está no mapa' }),
      el('span', { texto: tem
        ? `${emGraus(n.latitude)}, ${emGraus(n.longitude)}`
        : 'Sem isto, o teu negócio aparece na lista mas não no mapa.' })),
    el('span', { class: 'linha-fim', html: icone('seta', { tamanho: 18 }) })));

  /* A MORADA MUDOU E O PONTO NÃO. Não se apaga o ponto — pode ter sido uma
     gralha corrigida com o alfinete já certo. Diz-se, e quem sabe decide. */
  if (n.moradaMudou) {
    caixa.append(el('div', { class: 'linha' },
      el('span', { class: 'linha-icone', html: icone('alerta', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { texto: 'A morada mudou desde que marcaste o ponto' }),
        el('span', { texto: 'O ponto no mapa continua onde estava. Se mudaste '
          + 'de sítio, marca-o outra vez.' }))));
  }
}

/**
 * Marcar o ponto.
 *
 * O ALFINETE NÃO SE ARRASTA: fica quieto no meio do ecrã e move-se o mapa por
 * baixo dele. É o gesto de qualquer app de mapas, e evita a briga entre
 * «arrastar o alfinete» e «arrastar o mapa» num ecrã onde o dedo tapa os dois.
 */
async function painelDoPonto(seccao) {
  const painel = abrirPainel('Onde fica o estabelecimento');
  painel.append(el('p', { class: 'subtexto', texto:
    'Move o mapa até o alfinete ficar em cima da porta. Ou, se estiveres lá '
    + 'agora, deixa o telemóvel dizer onde é.' }));

  const zona = el('div', { class: 'ponto-mapa' });
  painel.append(zona);
  const leitura = el('p', { class: 'miudo', style: 'margin-top:8px' });
  painel.append(leitura);

  /* O AVISO DE QUE O PONTO É PÚBLICO, e não é opcional. Há donos de
     micronegócio que registam a morada de casa; um botão que diz «usar a minha
     posição» convida a publicá-la sem pensar. Por isso o botão diz «Estou no
     estabelecimento», e isto está escrito ao lado do mapa e não escondido. */
  painel.append(el('div', { class: 'folha caixa-texto', style: 'margin:12px 0 16px' },
    el('p', { class: 'miudo', html:
      '<b>Este ponto é público.</b> Aparece no mapa da app, como o nome e a '
      + 'localidade. Marca a porta do estabelecimento — não a tua casa.' })));

  let dados;
  try {
    dados = await carregarPortugal(base());
  } catch {
    zona.replaceWith(el('p', { class: 'aviso-mau', texto:
      'Não deu para carregar o mapa. Tenta outra vez daqui a pouco.' }));
    return;
  }
  if (!painel.isConnected) return;

  const n = estado.negocio;
  const tem = typeof n.latitude === 'number' && typeof n.longitude === 'number';
  const mapa = criarMapa({
    dados, pontos: [], atribuicao: false, folhasSempre: true,
    rotulo: 'Mapa para marcar onde fica o estabelecimento',
  });
  zona.innerHTML = '';
  zona.append(mapa.elemento, el('div', { class: 'ponto-alvo', 'aria-hidden': 'true' }));

  const mostrar = () => {
    const c = mapa.centro();
    leitura.textContent = `${emGraus(c.lat)}, ${emGraus(c.lon)}`;
  };
  /* O mapa move-se com o dedo, com a roda e com as setas; a leitura tem de
     acompanhar os três. Um ouvinte em cada um é uma linha que se esquece de se
     pôr — olha-se para o mapa e pronto.

     E O RELÓGIO PÁRA SOZINHO quando o painel sai da página. Um painel fecha-se
     de quatro maneiras — o botão, o Escape, o véu, o gesto de voltar — e um
     `clearInterval` escrito em cada uma delas é um que fica esquecido numa.
     Perguntar ao próprio elemento se ainda lá está não se esquece de nenhuma. */
  const relogio = setInterval(() => {
    if (!painel.isConnected) { clearInterval(relogio); return; }
    mostrar();
  }, 200);

  if (tem) mapa.centrarEm(n.latitude, n.longitude, 10);
  mostrar();

  /* DE ONDE VEIO ESTE PONTO. O `geo_fonte` não é auditoria: é o que faz o mapa
     desenhar diferente um ponto medido ao metro e um ponto posto à mão. Gravar
     tudo como «mao» era deitar fora a única coisa que o telemóvel dá de melhor
     do que o dedo. Guarda-se a última leitura do GPS e compara-se com o centro
     na hora de gravar — se o dono arrastou o mapa depois, já não é do GPS. */
  let ultimoGPS = null;
  const fonteDoCentro = () => {
    if (!ultimoGPS) return 'mao';
    const c = mapa.centro();
    return (emGraus(c.lat) === emGraus(ultimoGPS.lat)
      && emGraus(c.lon) === emGraus(ultimoGPS.lon)) ? 'gps' : 'mao';
  };

  /* E NÃO SE GRAVA O QUE NINGUÉM ESCOLHEU. Num negócio ainda sem ponto, o mapa
     abre no país inteiro; carregar em «Guardar» sem tocar em nada punha o café
     no meio de Portugal, com ar de coisa decidida. O botão só acorda depois de
     alguém mexer no mapa ou de o telemóvel dizer onde está. Quem já tem ponto
     não precisa: o mapa abriu nele, e gravar sem mexer não muda nada. */
  let mexeu = tem;
  for (const evento of ['pointerdown', 'wheel', 'keydown']) {
    zona.addEventListener(evento, () => {
      mexeu = true;
      const b = painel.querySelector('#guardar-ponto');
      if (b) { b.removeAttribute('aria-disabled'); }
    }, { passive: true });
  }

  /* --- o telemóvel diz onde é ------------------------------------------- */
  painel.append(el('button', {
    class: 'btn btn-suave btn-bloco', style: 'margin-bottom:8px',
    html: icone('bussola', { tamanho: 18 }) + '<span>Estou no estabelecimento</span>',
    aoClick: async (ev) => {
      const botao = ev.currentTarget;
      if (!navigator.geolocation) {
        avisar('Este telemóvel não sabe dizer onde está.', 'mau'); return;
      }
      botao.setAttribute('aria-disabled', 'true');
      try {
        const posicao = await new Promise((resolve, rejeitar) => {
          navigator.geolocation.getCurrentPosition(resolve, rejeitar,
            { enableHighAccuracy: true, timeout: 12000, maximumAge: 0 });
        });
        const { latitude, longitude } = posicao.coords;
        /* A POSIÇÃO NÃO SAI DAQUI ENQUANTO NINGUÉM GRAVAR. Só mexe o mapa; é
           o botão de gravar que decide se ela chega ao servidor. */
        if (!mapa.centrarEm(latitude, longitude, 6)) {
          avisar('Esse ponto não fica em Portugal.', 'mau');
        } else {
          ultimoGPS = { lat: latitude, lon: longitude };
          mexeu = true;
          painel.querySelector('#guardar-ponto')?.removeAttribute('aria-disabled');
        }
        mostrar();
      } catch (e) {
        avisar(e && e.code === 1
          ? 'Não deixaste a app saber onde está. Podes marcar o ponto à mão.'
          : 'Não deu para saber onde estás. Marca o ponto à mão.', 'neutro');
      } finally {
        botao.removeAttribute('aria-disabled');
      }
    } }));

  painel.append(el('button', {
    class: 'btn btn-cheio btn-bloco btn-grande', id: 'guardar-ponto',
    texto: 'Guardar este ponto',
    'aria-disabled': mexeu ? null : 'true',
    aoClick: async (ev) => {
      const botao = ev.currentTarget;
      if (botao.getAttribute('aria-disabled') === 'true') {
        avisar('Move o mapa até o alfinete ficar em cima da porta, ou carrega '
          + 'em «Estou no estabelecimento».', 'neutro');
        return;
      }
      botao.setAttribute('aria-disabled', 'true');
      const c = mapa.centro();
      /* CONTRA AS FORMAS, e não contra a caixa da folha: a janela do continente
         inclui uma faixa de Espanha e muito Atlântico, e um alfinete no mar
         passava. */
      if (!emPortugal(dados, c.lat, c.lon)) {
        botao.removeAttribute('aria-disabled');
        avisar('O alfinete não está em cima do país. Move-o para o sítio certo.', 'mau');
        return;
      }
      try {
        const r = await api.guardarNegocio(estado.negocio.id, {
          latitude: c.lat, longitude: c.lon, geoFonte: fonteDoCentro(),
        });
        estado.negocio = { ...estado.negocio, ...r };
        clearInterval(relogio);
        fecharPainel();
        await pintarOndeFica(seccao);
        avisar('Ficou no mapa.', 'bom');
      } catch (e) {
        botao.removeAttribute('aria-disabled');
        avisar(e.message || 'Não deu para guardar o ponto.', 'mau');
      }
    } }));

  /* TIRAR DO MAPA. Está prometido na página de privacidade — «podes mudá-lo ou
     apagá-lo» — e uma promessa escrita obriga o código. Só aparece a quem tem
     ponto: um botão para apagar o que não existe é ruído. */
  if (tem) {
    painel.append(el('button', {
      class: 'btn btn-perigo btn-bloco btn-pequeno', style: 'margin-top:8px',
      texto: 'Tirar do mapa',
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        botao.setAttribute('aria-disabled', 'true');
        try {
          const r = await api.guardarNegocio(estado.negocio.id, { apagarPonto: true });
          estado.negocio = { ...estado.negocio, ...r,
                             latitude: null, longitude: null, geoFonte: null };
          clearInterval(relogio);
          fecharPainel();
          await pintarOndeFica(seccao);
          avisar('Saiu do mapa. Continua na lista do «Descobrir».', 'bom');
        } catch (e) {
          botao.removeAttribute('aria-disabled');
          avisar(e.message || 'Não deu para tirar do mapa.', 'mau');
        }
      } }));
  }

  painel.append(el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno',
    texto: 'Cancelar', aoClick: () => { clearInterval(relogio); fecharPainel(); } }));
}

/* =========================================================================
   Quem carimba

   O histórico de cada cartão guarda o NOME de quem carimbou, e não o número
   de ninguém — de propósito, para o histórico sobreviver a quem sai do café.
   É essa decisão que manda em tudo o que está aqui: dois nomes iguais são
   recusados, quem sai não se apaga (desactiva-se), e o ecrã explica porquê
   quando recusa, em vez de dizer só que não.
   ========================================================================= */

/** Há quanto tempo, em português de balcão. */
function desdeQuando(quando) {
  if (!quando) return 'ainda não entrou';
  const dias = Math.floor((Date.now() - new Date(quando).getTime()) / 86400000);
  if (dias <= 0) return 'esteve cá hoje';
  if (dias === 1) return 'esteve cá ontem';
  if (dias < 30) return `há ${dias} dias`;
  const meses = Math.floor(dias / 30);
  return meses === 1 ? 'há um mês' : `há ${meses} meses`;
}

async function pintarOperadores(seccao) {
  const r = await api.operadores();
  const caixa = seccao.querySelector('#lista-operadores');
  if (!caixa) return;
  const souDono = r.sou === 'dono';
  caixa.innerHTML = '';

  for (const o of r.operadores) {
    const souEu = o.id === r.eu;
    /* O DONO NÃO SE TIRA A SI, e o botão não aparece — em vez de aparecer e
       dar um erro depois de tocado. A regra está no servidor na mesma; isto é
       só não oferecer o que não se pode fazer. */
    const podeMexer = souDono && !souEu;
    caixa.append(el('div', { class: 'linha' },
      el('span', { class: 'linha-icone', html: icone(o.papel === 'dono' ? 'cadeado' : 'pessoas', { tamanho: 20 }) }),
      el('span', { class: 'linha-texto' },
        el('b', { texto: o.nome + (souEu ? ' (tu)' : '') }),
        el('span', { texto: [
          o.papel === 'dono' ? 'Dono' : 'Balcão',
          desdeQuando(o.visto),
          /* A morada só chega cá quando quem está a ver é o dono — é ele que
             precisa dela para tirar quem saiu. Aos outros nem vem da API. */
          o.email || null,
        ].filter(Boolean).join(' · ') })),
      podeMexer
        ? el('span', { class: 'linha-fim' },
          el('button', { class: 'btn btn-fantasma btn-pequeno', texto: 'Mudar',
            'aria-label': `Mudar ${o.nome}`,
            aoClick: () => painelDeOperador(o, seccao, r) }))
        : el('span', { class: 'linha-fim' })));
  }

  if (!souDono) {
    caixa.append(el('div', { class: 'linha' },
      el('span', { class: 'linha-texto' },
        el('span', { texto: 'Juntar ou tirar quem carimba é do dono do balcão.' }))));
    return;
  }

  const cheio = r.operadores.length >= r.tecto;
  seccao.append(el('button', {
    class: 'btn btn-suave btn-bloco', id: 'juntar-operador', style: 'margin-top:12px',
    'aria-disabled': cheio ? 'true' : null,
    html: icone('mais', { tamanho: 18 }) + '<span>Juntar quem carimba</span>',
    aoClick: () => { if (!cheio) painelDeOperador(null, seccao, r); },
  }));
  seccao.append(el('p', { class: 'miudo', style: 'margin-top:8px', texto: cheio
    ? `Já são ${r.tecto}, que é o máximo. Tira alguém antes de juntar outro.`
    : 'Cada pessoa entra com o email dela e o nome dela fica no histórico de '
      + 'cada cartão — é assim que se sabe quem atendeu.' }));
}

/** Volta a pintar a secção depois de uma mudança, sem recarregar o ecrã. */
async function recarregarOperadores(seccao) {
  for (const velho of [...seccao.querySelectorAll('button, p.miudo')]) velho.remove();
  const caixa = seccao.querySelector('#lista-operadores');
  if (caixa) caixa.innerHTML = '';
  await pintarOperadores(seccao);
}

/**
 * Juntar alguém, ou mexer em quem já cá está.
 *
 * O MESMO PAINEL PARA AS DUAS COISAS, porque são a mesma coisa vista de dois
 * lados — e porque um painel de «juntar» e outro de «editar» divergem sempre,
 * e a divergência aparece no campo do nome, que é o que tem a regra difícil.
 */
function painelDeOperador(o, seccao, estadoLista) {
  const novo = !o;
  const painel = abrirPainel(novo ? 'Juntar quem carimba' : o.nome);

  painel.append(el('p', { class: 'subtexto', texto: novo
    ? 'Ele entra no balcão com o email dele — não há palavra-passe nenhuma '
      + 'para combinar, nem PIN para escrever à frente dos clientes.'
    : 'O nome é o que fica no histórico de cada cartão que esta pessoa '
      + 'carimbar.' }));

  const campoNome = el('input', { id: 'op-nome', type: 'text',
    maxlength: '40', autocomplete: 'off', value: novo ? '' : o.nome,
    placeholder: 'Marta da tarde' });
  painel.append(el('label', { class: 'campo' },
    el('span', { texto: 'Nome' }), campoNome));

  let campoEmail = null;
  if (novo) {
    campoEmail = el('input', { id: 'op-email', type: 'email',
      inputmode: 'email', autocomplete: 'off', placeholder: 'marta@exemplo.pt' });
    painel.append(el('label', { class: 'campo' },
      el('span', { texto: 'Email' }), campoEmail));
    painel.append(el('p', { class: 'miudo', style: 'margin-bottom:16px', texto:
      'Mandamos-lhe um email a dizer como entrar. Não vai lá código nenhum: o '
      + 'código chega quando ele o pedir, e vale quinze minutos.' }));
  }

  const aviso = el('p', { class: 'aviso-mau', hidden: true, role: 'alert' });
  painel.append(aviso);
  const dizer = (m) => { aviso.textContent = m; aviso.hidden = false; };

  painel.append(el('button', {
    class: 'btn btn-cheio btn-bloco btn-grande',
    texto: novo ? 'Juntar' : 'Guardar',
    aoClick: async (ev) => {
      const botao = ev.currentTarget;
      if (botao.getAttribute('aria-disabled') === 'true') return;
      botao.setAttribute('aria-disabled', 'true');
      aviso.hidden = true;
      try {
        if (novo) {
          const r = await api.juntarOperador({
            nome: campoNome.value, email: campoEmail.value });
          fecharPainel();
          await recarregarOperadores(seccao);
          /* SE O EMAIL NÃO SAIU, DIZ-SE. A pessoa existe na mesma e o dono
             pode avisá-la de viva voz — que é o que acontece num café. Calar
             isto era deixar o dono à espera de um email que não vem. */
          avisar(r.avisado
            ? 'Juntámos. Foi-lhe um email a dizer como entrar.'
            : 'Juntámos, mas o email não saiu. Diz-lhe para abrir o balcão e '
              + 'entrar com a morada dele.', r.avisado ? 'bom' : 'neutro');
        } else {
          await api.mudarOperador(o.id, { nome: campoNome.value });
          fecharPainel();
          await recarregarOperadores(seccao);
          avisar('Nome mudado.', 'bom');
        }
      } catch (e) {
        botao.removeAttribute('aria-disabled');
        dizer(e.message || 'Não deu para gravar.');
      }
    } }));

  if (!novo) {
    /* PROMOVER A DONO. Dois sócios existem, e um café onde só uma pessoa
       consegue arrumar o balcão fica preso no dia em que ela falta. */
    if (o.papel !== 'dono') {
      painel.append(el('button', {
        class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: 'Fazer dono também',
        aoClick: async (ev) => {
          const botao = ev.currentTarget;
          botao.setAttribute('aria-disabled', 'true');
          try {
            await api.mudarOperador(o.id, { papel: 'dono' });
            fecharPainel();
            await recarregarOperadores(seccao);
            avisar(`${o.nome} passa a poder arrumar o balcão.`, 'bom');
          } catch (e) {
            botao.removeAttribute('aria-disabled');
            dizer(e.message || 'Não deu para mudar.');
          }
        } }));
    }
    painel.append(el('button', {
      class: 'btn btn-perigo btn-bloco', style: 'margin-top:8px',
      texto: 'Tirar do balcão',
      aoClick: () => confirmarTirarOperador(o, seccao, estadoLista) }));
  }

  painel.append(el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno',
    texto: 'Cancelar', aoClick: fecharPainel }));
  campoNome.focus();
}

function confirmarTirarOperador(o, seccao) {
  const painel = abrirPainel(`Tirar ${o.nome}?`);
  painel.append(
    el('p', { class: 'subtexto', texto:
      'Deixa de poder entrar neste balcão, e a sessão dele fecha-se já — mesmo '
      + 'que tenha o telemóvel aberto neste momento.' }),
    el('div', { class: 'folha caixa-texto', style: 'margin-bottom:16px' },
      el('p', { class: 'miudo', html:
        'Os carimbos que ele deu <b>ficam no histórico</b>, com o nome dele. É '
        + 'o que permite saber quem atendeu, e não se apaga por alguém ter '
        + 'saído do café.' })),
    el('button', {
      class: 'btn btn-perigo btn-bloco btn-grande', texto: `Tirar ${o.nome}`,
      aoClick: async (ev) => {
        const botao = ev.currentTarget;
        botao.setAttribute('aria-disabled', 'true');
        try {
          await api.tirarOperador(o.id);
          fecharPainel();
          await recarregarOperadores(seccao);
          avisar(`${o.nome} já não carimba neste balcão.`, 'bom');
        } catch (e) {
          botao.removeAttribute('aria-disabled');
          avisar(e.message || 'Não deu para tirar.', 'mau');
        }
      } }),
    el('button', { class: 'btn btn-fantasma btn-bloco btn-pequeno', texto: 'Cancelar',
      aoClick: fecharPainel }));
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

/* O ecrã do último F5, guardado por separador. O `-balcao` no nome é o que
   impede a app do cliente e o balcão — que partilham a origem — de mandarem um
   no ecrã do outro. */
const CHAVE_ECRA = 'ecra-balcao';

async function irPara(nome) {
  /* A leitura pára sempre que se sai do ecrã de carimbar — mas a câmara fica
     de parte durante noventa segundos, com as faixas desligadas, para quem
     volte não voltar a apanhar a pergunta da autorização. Ver `guardarCamara`. */
  if (leitor) { leitor.parar({ manter: true }); leitor = null; }
  /* O `#principal` está no HTML e existe quase sempre — mas não sempre: o
     apanhador de erros do arranque substitui o `body` inteiro por uma
     mensagem, e a partir daí não há `#principal` nenhum. Um `popstate` que
     chegue depois disso não pode rebentar por cima do erro que já aconteceu. */
  const principal = $('#principal');
  if (!principal || !$('#barra')) return;

  estado.ecra = nome;
  /* Onde a pessoa está, guardado no SEPARADOR — ver o comentário igual na app
     do cliente. Ao balcão isto vale ainda mais: recarregar com o telemóvel na
     mão acontece, e voltar sempre ao «Carimbar» é aceitável; voltar ao
     «Carimbar» quando se estava a ver os clientes é perder o sítio. */
  guardarNoSeparador(CHAVE_ECRA, nome);
  principal.innerHTML = '';
  const titulo = $('#topo-titulo');
  if (titulo) titulo.textContent = ECRAS[nome].titulo;
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

  /* NO ECRÃ ONDE FICOU, e não sempre no primeiro. */
  const guardado = foiRecarregamento() ? lerDoSeparador(CHAVE_ECRA) : null;
  await irPara(guardado && ECRAS[guardado] ? guardado : 'carimbar');
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

  /* DUAS PORTAS COM O MESMO PESO, e uma pergunta a desempatar.

     Antes havia um `btn-cheio` e um `btn-contorno`, e o olho não escolhe entre
     duas portas: vai à porta iluminada. A iluminada era «Entrar», que só serve
     a quem JÁ tem balcão — ou seja, à minoria. Quem chega pela primeira vez ia
     lá parar, escrevia o email, e ficava à espera de um código que não podia
     chegar. Aconteceu ao próprio dono do produto.

     A pergunta não usa a palavra «balcão»: é a única palavra deste ecrã que
     quem chega pela primeira vez não conhece, e era justamente a que teria de
     desempatar. E a segunda porta diz «código», que é a palavra que se diz em
     voz alta dentro do café, e não «convite», que é vocabulário nosso. */
  acoes.append(
    el('p', { class: 'entrada-pergunta', texto: 'Já criou aqui o cartão do seu negócio?' }),
    el('button', {
      id: 'porta-entrar',
      class: 'btn btn-cheio btn-grande btn-bloco', texto: 'Já criei — quero entrar',
      aoClick: entrarPorEmail,
    }),
    el('button', {
      id: 'porta-convite',
      class: 'btn btn-cheio btn-grande btn-bloco', texto: 'Deram-me um código',
      aoClick: fundarNegocio,
    }),
    /* AQUI ESTAVA A PORTA DA DEMONSTRAÇÃO, e saiu. Não foi por a demonstração
       ser má: foi por ela ser fácil de entrar sem se dar por isso, e difícil
       de sair.

       A bandeira do modo vivia no `localStorage`, numa origem partilhada pelas
       duas aplicações. Um toque neste botão punha TAMBÉM a app do cliente em
       demonstração, para sempre. E um cartão de demonstração é assinado com
       outro segredo: um balcão a sério não o carimba. O dono do café ficava com
       uma app que parecia a certa e um carimbo que não dava.

       A demonstração continua a existir para as baterias, e alcança-se
       escrevendo `?demo=1` à mão. O que deixou de existir é a maneira de lá
       cair sem querer. */
    el('p', { class: 'entrada-nota', texto:
      'Sem instalar nada, sem cartão de crédito, sem mensalidade.' }),
    /* E A TERCEIRA HIPÓTESE, que é a de quem chega aqui pela primeira vez.
 
       As duas portas acima servem quem já tem balcão e quem já tem código.
       Quem não tem nenhum dos dois — que é toda a gente que chega pelo site —
       ficava a olhar para um ecrã que lhe pedia uma coisa que ele não sabia
       onde arranjar, e sem uma terceira linha para onde ir. Um beco sem saída
       no fim do único caminho que o site tem.
 
       Vai em `btn-fantasma` de propósito: é uma saída, não uma porta. Quem tem
       código não pode ter dúvidas sobre onde carregar. */
    el('a', {
      class: 'btn btn-fantasma btn-bloco btn-pequeno', id: 'porta-pedir',
      href: 'mailto:geral@carimbodigital.pt?subject='
        + encodeURIComponent('Quero um convite para o Carimbo Digital'),
      texto: 'Ainda não tenho código — quero pedir um',
    }));
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
        try {
          const r = await api.entrarBalcao(email);
          /* O `enviado` diz a verdade do ENVIO, e não se o email tem negócio
             — essa parte continua escondida de propósito, senão este ecrã
             servia para descobrir que moradas estão registadas. Portanto um
             `false` aqui é o correio em baixo, e não «não te conheço».

             Isto faltava. O ecrã seguinte dizia «enviámos-lhe um código»
             acontecesse o que acontecesse, e quem ficasse à espera não tinha
             como saber que não vinha nada — que é exactamente o que se passa
             quando o Worker está publicado sem chave de correio. A app do
             cliente já lia este campo; o balcão ficou para trás. */
          if (r && r.enviado === false) {
            botao.disabled = false;
            avisar('Não foi possível enviar o email agora. Tenta daqui a pouco.', 'mau');
            return;
          }
          pedirCodigoBalcao(email);
        }
        catch (e) { botao.disabled = false; avisar(e.message, 'mau'); }
      },
    }));
  setTimeout(() => $('#e-email')?.focus(), 120);
}

function pedirCodigoBalcao(email) {
  const painel = abrirPainel('Escreve o código');
  painel.append(
    /* As DUAS hipóteses, à mesma altura e nesta ordem.

       A resposta do servidor é de propósito a mesma exista ou não a conta —
       senão este ecrã servia para descobrir que moradas estão registadas. Mas
       a frase antiga («Se este email tiver um negócio, enviámos-lhe um
       código») enterrava o «se»: lia-se a segunda metade, e quem não tinha
       balcão ficava a olhar para um campo à espera de um código que não podia
       chegar. Foi o que aconteceu a sério, e não havia nada no ecrã que o
       dissesse nem por onde sair.

       Dizer as duas hipóteses não revela nada: a página diz exactamente o
       mesmo a toda a gente, tal como o servidor. O que muda é que agora a
       pessoa sabe quanto tempo esperar e o que fazer a seguir. */
    el('p', { class: 'subtexto', texto:
      'Se este email já tiver um balcão, o código chega em segundos e vale 15 minutos.' }),
    el('p', { class: 'subtexto', texto:
      'Se não chegar nada em dois minutos, é porque este email ainda não tem '
      + 'balcão nenhum. Nesse caso é preciso criá-lo com um convite.' }),
    el('label', { class: 'campo' },
      el('span', { texto: 'Código' }),
      el('input', { id: 'e-codigo', type: 'text', inputmode: 'numeric',
                    autocomplete: 'one-time-code', maxlength: '6',
                    placeholder: '000000', class: 'campo-codigo' })),
      /* O `maxlength` acima é só a rede para browsers sem JavaScript a correr;
         quem manda é o `prepararCampoDeCodigo`, lá em baixo, que o tira. */
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
    }),
    /* A saída. Sem isto, quem cá chegou por engano tem de adivinhar que o
       caminho é fechar o painel e carregar noutro botão. Sobe de fantasma a
       contorno pela mesma razão das portas da entrada: um botão fantasma, em
       terceira linha, num ecrã de poupança de bateria, não existe. */
    el('button', {
      class: 'btn btn-contorno btn-bloco',
      texto: 'Este email ainda não tem balcão',
      aoClick: fundarNegocio,
    }));
  const campo = $('#e-codigo');
  /* O mesmo do lado do cliente: a colagem é limpa antes de ser cortada, a
     sugestão do teclado passa, e ao sexto algarismo entra sozinho. Ao balcão
     isto vale ainda mais — quem está a abrir a loja tem uma mão no telemóvel
     e a outra na máquina do café. */
  prepararCampoDeCodigo(campo, () => painel.querySelector('.btn-cheio')?.click());
  setTimeout(() => campo.focus(), 120);
}

function fundarNegocio(codigoDaLigacao) {
  const painel = abrirPainel('Criar o meu cartão');
  painel.append(
    el('p', { class: 'subtexto', texto: 'Enquanto o Carimbo Digital estiver por '
      + 'convite, é preciso um código para criar um negócio.' }),
    el('label', { class: 'campo' },
      el('span', { texto: 'Código de convite' }),
      el('input', { id: 'f-convite', type: 'text', autocomplete: 'off',
                    autocapitalize: 'characters', spellcheck: 'false',
                    inputmode: 'text', maxlength: '20',
                    placeholder: 'o código que te deram' })),
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
  /* O campo do código trata-se como o do número do cartão na app: maiúsculas
     à medida que se escreve, e fora tudo o que não é do alfabeto. Sem isto
     ele escreve `k3wm-7rpd` em minúsculas, vê no ecrã uma coisa diferente do
     papel que tem na mão, apaga tudo e recomeça. O servidor normaliza na
     mesma — mas o ecrã tem de concordar com o papel. O hífen entra sozinho
     ao quarto caracter, que é como o código é escrito e lido em voz alta. */
  const campoConvite = $('#f-convite');
  campoConvite.addEventListener('input', () => {
    const limpo = campoConvite.value.toUpperCase().replace(/[^A-Z0-9]/g, '').slice(0, 12);
    campoConvite.value = limpo.replace(/(.{4})(?=.)/g, '$1-');
  });

  /* Chegou pela ligação: põe-se lá e passa-se o foco ao campo seguinte, que é
     o primeiro que a pessoa tem mesmo de preencher. */
  if (codigoDaLigacao) {
    campoConvite.value = String(codigoDaLigacao).toUpperCase()
      .replace(/[^A-Z0-9]/g, '').replace(/(.{4})(?=.)/g, '$1-');
    setTimeout(() => $('#f-negocio')?.focus(), 120);
    return;
  }
  setTimeout(() => campoConvite.focus(), 120);
}

/**
 * O convite que vem na ligação, lido e tirado da barra de endereço.
 *
 * Lê-se no PRINCÍPIO do arranque, antes de qualquer `return`. A primeira
 * versão lia-o no fim, a seguir a desenhar a entrada — e quem tivesse uma
 * sessão guardada que já não valesse saía pelo `return` do `catch` e nunca lá
 * chegava: caía no ecrã de entrada com o código deitado fora em silêncio.
 * Apanhou-se a conduzir o balcão a sério, num browser que tinha uma sessão de
 * outro dia.
 *
 * Vai no fragmento e não na query string de propósito: o que está depois do
 * `#` não sai do browser — não entra no cabeçalho `Referer` quando a página
 * pede um tipo de letra, nem nos registos de servidor nenhum. E limpa-se já:
 * uma captura de ecrã do balcão aberto não pode levar o código na barra.
 */
function convitePelaLigacao() {
  const c = location.hash.match(/^#c=([A-Za-z0-9-]{4,40})$/);
  if (!c) return null;
  history.replaceState(null, '', location.pathname + location.search);
  return c[1];
}


/**
 * A barra da demonstração.
 *
 * Fixa, no topo, em todos os ecrãs, e não se fecha. Não é um enfeite: é a
 * resposta a um defeito que custou caro — a demonstração colava-se ao
 * telemóvel, contaminava a outra aplicação, e ficava-se com uma app que
 * parecia a certa e um carimbo que não dava. Um aviso discreto num canto do
 * perfil não chegou; este ocupa uma faixa e leva um botão para sair.
 */
function barraDaDemonstracao() {
  if (MODO !== 'demo' || document.querySelector('#barra-demo')) return;
  const barra = el('div', { class: 'barra-demo', id: 'barra-demo' },
    el('span', { class: 'barra-demo-texto' },
      el('b', { texto: 'Demonstração.' }),
      el('span', { texto: ' Nada disto é real — nenhum destes cartões serve num café.' })),
    el('button', {
      class: 'barra-demo-sair', type: 'button', texto: 'Sair',
      /* SAIR É SAIR: apaga-se a bandeira do separador, deitam-se fora os dados
         da demonstração, e recarrega-se em produção. Deixar os dados lá era
         deixar a demonstração à espera da próxima vez. */
      aoClick: () => {
        try {
          sessionStorage.removeItem('carimbo:modo-demo');
          localStorage.removeItem('carimbo:modo-demo');
          for (const k of Object.keys(localStorage)) {
            if (k.startsWith('carimbo-demo:')) localStorage.removeItem(k);
          }
        } catch { /* armazenamento fechado: o recarregar chega */ }
        location.href = `${location.pathname}?demo=0`;
      },
    }));
  /* A SEGUIR À LIGAÇÃO DE SALTAR, e não antes dela.

     `prepend` punha a barra em primeiro no documento, e portanto em primeiro
     na tabulação: quem anda de Tab batia no «Sair» da demonstração antes de
     chegar ao «Saltar para o conteúdo», que é a primeira paragem de todas as
     páginas e a única que quem não vê o ecrã espera encontrar ali. A barra é o
     que está mais acima NO ECRÃ; a ligação de saltar está acima de tudo por
     convenção, e as duas cabem por esta ordem. */
  const saltar = document.querySelector('a.saltar');
  if (saltar) saltar.after(barra); else document.body.prepend(barra);
  document.documentElement.dataset.demo = 'sim';

  /* E A ALTURA MEDE-SE, não se adivinha. O texto quebra em duas linhas num
     ecrã estreito, e o número escrito à mão no CSS tinha de ter uma media
     query a adivinhar onde é que isso acontecia — que é adivinhar duas vezes.
     A barra diz quanto ocupa, e a página desce isso. */
  const medir = () => document.documentElement.style.setProperty(
    '--barra-demo', `${Math.ceil(barra.getBoundingClientRect().height)}px`);
  medir();
  new ResizeObserver(medir).observe(barra);
}

async function arrancar() {
  barraDaDemonstracao();

  /* Escuro sempre — ver o comentário no topo de balcao.css. O atributo já vem
     escrito no `index.html`, antes do primeiro pixel; isto fica como rede para
     quem chegue aqui por outro caminho, e é uma atribuição idempotente. */
  document.documentElement.dataset.tema = 'escuro';
  const convite = convitePelaLigacao();

  /* E também quando a ligação é carregada com a página JÁ ABERTA. Ir de
     `/balcao/` para `/balcao/#c=CODIGO` é navegação dentro do mesmo
     documento: o browser não recarrega nada e o arranque não volta a correr.
     Sem isto, quem tivesse o balcão aberto e tocasse na ligação que lhe
     mandaram via a barra de endereço mudar e mais nada acontecer. */
  addEventListener('hashchange', () => {
    const c = convitePelaLigacao();
    if (c) fundarNegocio(c);
  });
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
      /* Também aqui. É JUSTAMENTE este o caminho de quem tem uma sessão velha
         no telemóvel e recebe uma ligação de convite — e era o que deitava o
         código fora sem dizer nada. Sem rede não se funda, mas o formulário
         abre com o código lá dentro e o aviso por cima: mais vale ver onde se
         ia parar do que voltar à estaca zero. */
      if (convite) fundarNegocio(convite);
      return;
    }
  }
  $('#entrada').hidden = false;
  desenharEntrada();
  if (convite) fundarNegocio(convite);
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
