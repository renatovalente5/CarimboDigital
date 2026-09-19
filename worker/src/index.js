/* =========================================================================
   Carimbo Digital — Worker da Cloudflare

   É o único servidor que este projecto tem. Faz três coisas:
     · guarda os cartões (D1, que é SQLite)
     · verifica os códigos que o balcão lê
     · aplica as regras — arrefecimento, tectos, prémios

   Corre no plano gratuito: 100 000 pedidos por dia, e nada de criptografia
   pesada. Por isso não há palavras-passe nem derivação de chaves lenta em
   lado nenhum — só HMAC-SHA256, que é nativo e custa microssegundos.

   Segredos a pôr com `wrangler secret put`:
     CHAVE_MESTRA        — 32 bytes em base64url; deriva os segredos dos
                           dispositivos. Se mudar, todos os códigos deixam de
                           valer (por isso há `chave_versao` na tabela).
     MAIL_TOKEN          — opcional; o token da API de correio da Hostinger
                           (hPanel › Emails › o domínio › Agentic mail › API,
                           e não o de hpanel.hostinger.com/api, que é de outra
                           API e leva 401). Sem ele não se enviam emails e a
                           app continua a funcionar, só sem recuperação de
                           conta por email. Anda a par do MAIL_CAIXA, que não
                           é segredo e está no wrangler.toml.
   ========================================================================= */

import { emailCodigoCliente, emailCodigoBalcao, emailContaAApagar,
         emailConviteOperador } from './emails.js';
import {
  assinarRS256, classeDePrograma, objetoDeCartao, ligacaoDeGravacao, actualizacaoDeSaldo,
  actualizacaoDeClasse,
} from './wallet.js';
import {
  construirPasse, passeDeCartao, certificadosDoPEM, emissorESerie, doPEM,
  validadeDoCertificado,
} from './pkpass.js';
import { faixaDeCartao, APPLE_STRIP, GOOGLE_HERO } from './faixa.js';
import { apnsLigada, avisarAparelhos } from './apns.js';
import * as SELOS from './selos-mapa.js';
import { enviarPush, pushPronto } from './push.js';

const JANELA = 15;                 // segundos de vida de um código
const TOLERANCIA = 2;              // janelas de folga para relógios desencontrados
const SESSAO_DIAS = 180;
const ENTRADA_MINUTOS = 15;
const ENTRADA_TENTATIVAS = 5;
const USADOS_HORAS = 24;           // quanto tempo se guarda um código já gasto
const ENVIOS_HORA = 5;             // códigos por morada, por hora
const ENVIOS_INTERVALO = 45;       // segundos entre dois pedidos para a mesma morada
const REGISTOS_HORA = 60;          // contas novas por origem, por hora (ver `travarRegistos`)

/* Tectos do que um negócio pode escrever. Não é desconfiança do dono do café:
   é que tudo isto é pintado na lista pública, a toda a gente, e uma conta
   legítima chega para encher o ecrã dos outros — de propósito ou por engano.
   O `descobrir` percorre negócio a negócio e programa a programa, e as
   «linhas lidas» do D1 gratuito acabam aos cinco milhões por dia. */
const PROGRAMAS_MAX = 12;          // cartões diferentes por negócio
const DESCOBRIR_MAX = 200;         // negócios devolvidos na lista pública
const TIPOS = ['carimbos', 'pontos'];

/* Contas paradas. O RGPD (art. 5.º, n.º 1, alínea e) não deixa guardar dados
   pessoais mais tempo do que o preciso, e uma conta que ninguém abre há dois
   anos é exactamente isso — sobretudo quando tem uma morada de email colada.
   Estes dois números são a fonte da verdade: a política de privacidade
   lê-os daqui na construção do site, e se desaparecerem a construção morre. */
const INACTIVA_MESES = 24;         // sem dar sinal este tempo, a conta é apagada
const AVISO_DIAS = 30;             // com aviso por email, este tempo antes

/* =========================================================================
   Respostas
   ========================================================================= */

function origensPermitidas(env) {
  return String(env.ORIGENS || '')
    .split(',').map((s) => s.trim()).filter(Boolean);
}

function cabecalhosCORS(pedido, env) {
  const origem = pedido.headers.get('origin') || '';
  const lista = origensPermitidas(env);
  /* Sem lista configurada aceita-se tudo — é o que serve para desenvolver.
     Em produção põe-se ORIGENS=https://carimbodigital.pt e fecha-se a porta. */
  const permitida = lista.length === 0 || lista.includes(origem);
  return {
    'access-control-allow-origin': permitida ? (origem || '*') : lista[0],
    'access-control-allow-methods': 'GET,POST,PUT,DELETE,OPTIONS',
    'access-control-allow-headers': 'content-type,authorization',
    'access-control-max-age': '86400',
    vary: 'origin',
  };
}

function json(dados, { estado = 200, pedido, env } = {}) {
  return new Response(JSON.stringify(dados), {
    status: estado,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store',
      ...(pedido ? cabecalhosCORS(pedido, env) : {}),
    },
  });
}

class Falha extends Error {
  constructor(mensagem, { estado = 400, codigo = null, extra = {} } = {}) {
    super(mensagem);
    this.estado = estado;
    this.codigo = codigo;
    this.extra = extra;
  }
}

/* =========================================================================
   Miudezas
   ========================================================================= */

const agora = () => new Date().toISOString();

function bytesParaHex(b) {
  return Array.from(new Uint8Array(b), (x) => x.toString(16).padStart(2, '0')).join('');
}

function base64url(bytes) {
  let s = '';
  for (const b of new Uint8Array(bytes)) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function deBase64url(texto) {
  const s = texto.replace(/-/g, '+').replace(/_/g, '/');
  return Uint8Array.from(atob(s + '='.repeat((4 - (s.length % 4)) % 4)), (c) => c.charCodeAt(0));
}

function id() {
  return bytesParaHex(crypto.getRandomValues(new Uint8Array(16)));
}

/* Alfabeto sem 0/O, 1/I, 5/S, 8/B: ao balcão estes números são ditos em voz
   alta e escritos à mão, e cada confusão dessas é um cliente irritado.

   O `L` ESTÁ CÁ, e o comentário dizia que não. Um agente foi ler a regra ao
   comentário em vez da constante e escreveu-a errada numa página do site.
   Um comentário que mente sobre a linha seguinte engana toda a gente. */
const ALFABETO = '234679ACDEFGHJKLMNPQRTUVWXYZ';
function publicoNovo(n = 6) {
  const b = crypto.getRandomValues(new Uint8Array(n));
  return Array.from(b, (x) => ALFABETO[x % ALFABETO.length]).join('');
}

/* Seis dígitos, sorteados sem viés (rejeita os valores que não cabem num
   múltiplo de um milhão — o resto de 2^32 % 1e6 tornaria os primeiros
   códigos ligeiramente mais prováveis). */
function codigoEntrada() {
  const b = new Uint32Array(1);
  const limite = Math.floor(0xffffffff / 1000000) * 1000000;
  do { crypto.getRandomValues(b); } while (b[0] >= limite);
  return String(b[0] % 1000000).padStart(6, '0');
}

async function resumo(texto) {
  return bytesParaHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(texto)));
}

async function hmac(chaveBytes, mensagem) {
  const chave = await crypto.subtle.importKey(
    'raw', chaveBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return crypto.subtle.sign('HMAC', chave, new TextEncoder().encode(mensagem));
}

/**
 * O segredo de uma CONTA não se guarda: deriva-se.
 *
 * segredo = HMAC(CHAVE_MESTRA, "c1:<cliente_id>")           (versão 1)
 * segredo = HMAC(CHAVE_MESTRA, "c1:<cliente_id>:<versão>")  (a partir da 2)
 *
 * A app guarda-o; o servidor volta a calculá-lo sempre que precisa. A tabela
 * `clientes` fica sem nada que sirva para forjar um código, e não há nenhuma
 * coluna de segredos para alguém deixar escapar num backup.
 *
 * E CHAMA-SE SEGREDO DA CONTA, não do aparelho — o nome anterior mentia. Não
 * leva nada do telemóvel lá dentro: é o mesmo em todos os aparelhos que entrem
 * na conta, e o próprio teste diz isso à letra («o QR de B vale tanto como o
 * de A»). Enquanto só havia uma porta de entrada isso era um pormenor. Com
 * várias portas e várias sessões, um aparelho perdido passa a ser um problema
 * sem solução — e a coluna que existia para lhe dar solução, `chave_versao`,
 * estava no esquema, tinha um comentário a explicar que servia para revogar, e
 * NUNCA era lida nem escrita em lado nenhum. Uma coluna que só se escreve é um
 * protocolo com metade; esta nem isso era.
 *
 * A VERSÃO 1 MANTÉM A FÓRMULA ANTIGA, sem sufixo, e isso não é elegância: é a
 * única forma de não partir o código QR de todas as apps já instaladas. A
 * cópia no telemóvel de alguém pode ser de há semanas e tem o segredo guardado
 * de quando o gerou. Só a partir da 2 é que o sufixo entra — ou seja, só para
 * quem tiver mandado expulsar os outros aparelhos.
 */
async function derivarSegredo(env, clienteId, versao = 1) {
  const mestra = deBase64url(env.CHAVE_MESTRA);
  const n = Number(versao) || 1;
  return base64url(await hmac(mestra, n > 1 ? `c1:${clienteId}:${n}` : `c1:${clienteId}`));
}

/* Comparação em tempo constante — a diferença é irrelevante para um HMAC de
   16 dígitos, mas é o hábito certo e não custa nada. */
function iguais(a, b) {
  if (a.length !== b.length) return false;
  let d = 0;
  for (let i = 0; i < a.length; i++) d |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return d === 0;
}

/* =========================================================================
   Sessões
   ========================================================================= */

/**
 * Já passou o prazo? E o que fazer quando o prazo é ilegível.
 *
 * FALHAVA ABERTO, nos três sítios onde se pergunta isto — a sessão, o código
 * de entrada do cliente e o do balcão. `new Date('')` e `new Date('lixo')` dão
 * `Invalid Date`, e QUALQUER comparação com `Invalid Date` é falsa: o
 * `expira_em < agora` dava `false` e a linha passava por válida. Um prazo que
 * não se consegue ler tornava a credencial ETERNA, que é exactamente o
 * contrário do que ele existe para fazer.
 *
 * Descobriu-se por acidente, a preparar um teste contra a produção: uma
 * inserção minha escreveu o prazo vazio e a sessão de balcão foi aceite na
 * mesma. O produto escreve sempre um ISO bem formado, por isso não havia nada
 * partido no ar — mas uma guarda que só funciona enquanto os dados estão bons
 * não é uma guarda.
 *
 * Agora, na dúvida, está expirado. É a direcção certa para falhar: o pior que
 * acontece a quem tenha uma linha estragada é ter de pedir outro código.
 */
function expirado(quando) {
  const t = Date.parse(String(quando ?? ''));
  return !Number.isFinite(t) || t < Date.now();
}

async function criarSessao(env, sujeito) {
  const testemunho = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const expira = new Date(Date.now() + SESSAO_DIAS * 86400000).toISOString();
  await env.DB.prepare(
    'INSERT INTO sessoes (resumo, sujeito, criada_em, expira_em) VALUES (?, ?, ?, ?)'
  ).bind(await resumo(testemunho), sujeito, agora(), expira).run();
  return testemunho;
}

async function lerSessao(env, pedido) {
  const cabecalho = pedido.headers.get('authorization') || '';
  const testemunho = cabecalho.startsWith('Bearer ') ? cabecalho.slice(7) : null;
  if (!testemunho) return null;
  /* Calcula-se UMA vez: é um SHA-256 e usa-se em três sítios desta função. */
  const digerido = await resumo(testemunho);
  const linha = await env.DB.prepare(
    'SELECT sujeito, expira_em FROM sessoes WHERE resumo = ?'
  ).bind(digerido).first();
  if (!linha) return null;
  if (expirado(linha.expira_em)) return null;

  /* A SESSÃO DESLIZA. Contava 180 dias a partir do dia em que nasceu, e usá-la
     não a esticava — um balcão aberto todos os dias sem falhar um era posto
     fora ao fim de seis meses, sem aviso, a meio de um turno. Não é o que
     alguém espera de um aparelho que vive em cima de um balcão: espera entrar
     uma vez e nunca mais pensar nisso.

     ESCREVE-SE NO MÁXIMO UMA VEZ POR DIA, e isso é o que a torna barata. A
     condição está dentro do próprio UPDATE — só mexe se faltar menos de
     `SESSAO_DIAS - 1`, ou seja, só uma vez em cada 24 horas por sessão. Sem
     ela, cada pedido do balcão era uma escrita no D1, que tem tecto diário e é
     partilhado com tudo o resto. É a mesma manha do `marcarVisto`.

     Falhar aqui não pode derrubar o pedido: quem está a carimbar um café não
     tem nada que ver com o prazo da sessão dele. */
  try {
    const novoPrazo = new Date(Date.now() + SESSAO_DIAS * 86400000).toISOString();
    const limite = new Date(Date.now() + (SESSAO_DIAS - 1) * 86400000).toISOString();
    await env.DB.prepare(
      'UPDATE sessoes SET expira_em = ? WHERE resumo = ? AND expira_em < ?'
    ).bind(novoPrazo, digerido, limite).run();
  } catch (erro) {
    console.error('sessao: não deu para renovar o prazo', String(erro));
  }

  const [tipo, valor] = linha.sujeito.split(':');
  /* O `resumo` vai junto para quem precise de distinguir ESTA sessão das
     outras da mesma conta — é o que permite expulsar os outros aparelhos sem
     se expulsar a si próprio. Acrescenta-se um campo; não se muda nenhum. */
  return { tipo, id: valor, resumo: digerido };
}

async function exigirCliente(env, pedido) {
  const s = await lerSessao(env, pedido);
  if (!s || s.tipo !== 'cliente') throw new Falha('Sessão inválida', { estado: 401 });
  /* UMA SESSÃO NUMA SOMBRA NÃO ABRE NADA, e NÃO se segue o ponteiro — seguir
     era o erro fácil. Há dois modos de fusão e confundi-los é um ataque: numa
     fusão PROVADA as duas contas autenticaram-se no acto e as sessões são
     reapontadas ali mesmo; numa ABSORÇÃO de conta anónima as sessões dela
     morrem. Logo, uma sessão que ainda aponte para uma sombra só pode ser uma
     que devia ter morrido — e seguir o ponteiro dava a essa sessão a conta
     inteira de outra pessoa. Fecha-se. */
  const sombra = await env.DB.prepare(
    'SELECT 1 AS e FROM clientes WHERE id = ? AND fundida_em IS NOT NULL'
  ).bind(s.id).first();
  if (sombra) {
    await env.DB.prepare('DELETE FROM sessoes WHERE resumo = ?').bind(s.resumo).run();
    throw new Falha('Sessão inválida', { estado: 401 });
  }
  await marcarVisto(env, s.id);
  return s.id;
}

/**
 * Guarda que a conta deu sinal de vida.
 *
 * Existia uma coluna `visto_em` desde o primeiro dia e nada lhe tocava depois
 * do registo — ficava presa à data em que a conta nasceu. Quem quisesse apagar
 * contas paradas por essa coluna apagava toda a gente ao fim de dois anos,
 * incluindo quem usasse a app todas as semanas.
 *
 * Escreve-se no máximo uma vez por dia. Sem essa condição, abrir a app passava
 * a custar uma escrita por pedido, e o plano gratuito do D1 dá 100 000 por dia
 * — que é o mesmo tecto do Workers, mas gasto muito mais depressa. Com ela, a
 * linha só é escrita quando o dia mudou; nos outros casos o UPDATE não
 * encontra nada e não escreve.
 */
async function marcarVisto(env, clienteId) {
  const ontem = new Date(Date.now() - 86400000).toISOString();
  /* O `avisada_em` cai aqui de propósito: quem voltou deixou de estar parado,
     e se um dia voltar a parar tem direito a um aviso novo em vez de ser
     apagado em silêncio por causa de um aviso de há dois anos. */
  await env.DB.prepare(
    'UPDATE clientes SET visto_em = ?, avisada_em = NULL WHERE id = ? AND (visto_em IS NULL OR visto_em < ?)'
  ).bind(agora(), clienteId, ontem).run();
}

async function exigirOperador(env, pedido) {
  const s = await lerSessao(env, pedido);
  if (!s || s.tipo !== 'operador') throw new Falha('Sessão inválida', { estado: 401 });
  const op = await env.DB.prepare(
    'SELECT * FROM operadores WHERE id = ? AND ativo = 1'
  ).bind(s.id).first();
  if (!op) throw new Falha('Operador desativado', { estado: 403 });
  return op;
}

/* =========================================================================
   Traz um amigo

   «Cada cliente traz outro, e ganham os dois.» O convite é um endereço que a
   app partilha; quem o abre adere ao cartão e fica ligado a quem o mandou.

   TRÊS COISAS SEGURAM ISTO, e cada uma fecha uma porta diferente:

   · O CONVITE VAI ASSINADO. Leva o número público de quem convida mais uma
     assinatura da chave-mestra. Sem ela, bastava saber um número público — que
     é dito em voz alta ao balcão todos os dias — para atribuir convites a quem
     nunca convidou ninguém.
   · A RECOMPENSA SÓ ACONTECE NO PRIMEIRO CARIMBO A SÉRIO. Não na adesão. É a
     defesa que segura tudo o resto: criar contas vazias não dá nada, porque é
     preciso alguém ir ao balcão, mostrar o código e ser carimbado por uma
     pessoa.
   · E HÁ UM TECTO POR PROGRAMA. Cinco convites premiados por cliente é muito
     para quem convida a família e pouco para quem faz disto um negócio.
   ========================================================================= */

/** A assinatura de um convite. Curta: é para caber num endereço partilhado. */
async function assinaturaDeAmigo(env, publico, programaId) {
  const mestra = deBase64url(env.CHAVE_MESTRA);
  const bytes = await hmac(mestra, `amigo:${publico}:${programaId}`);
  return base64url(bytes).slice(0, 16);
}

/** O código que a app partilha: `<publico>.<assinatura>`. */
async function codigoDeAmigo(env, publico, programaId) {
  return `${publico}.${await assinaturaDeAmigo(env, publico, programaId)}`;
}

/**
 * Quem é que mandou este convite — ou `null`, se ele não prestar.
 *
 * DEVOLVE `null` PARA TUDO O QUE CORRE MAL, e de propósito: um convite que não
 * presta não é um erro de quem o abriu. Quem chega por um link partilhado quer
 * juntar o cartão de um café, e é isso que acontece — só não fica ligado a
 * ninguém. Mandar-lhe um ecrã de erro por causa de um código que outra pessoa
 * lhe deu seria castigá-lo por uma coisa que não fez.
 */
async function lerConviteDeAmigo(env, codigo, programaId) {
  if (typeof codigo !== 'string' || !codigo.includes('.')) return null;
  const [publico, assinatura] = codigo.split('.');
  if (!publico || !assinatura) return null;
  const esperada = await assinaturaDeAmigo(env, publico, programaId);
  /* Comparação de comprimento constante, como em todo o resto desta casa. */
  if (assinatura.length !== esperada.length) return null;
  let diferenca = 0;
  for (let i = 0; i < esperada.length; i++) {
    diferenca |= assinatura.charCodeAt(i) ^ esperada.charCodeAt(i);
  }
  if (diferenca !== 0) return null;
  return env.DB.prepare(
    'SELECT id, publico FROM clientes WHERE publico = ? AND fundida_em IS NULL'
  ).bind(publico).first();
}

/**
 * Paga o convite, se houver um por pagar.
 *
 * Corre DEPOIS de o carimbo estar gravado, dentro do `carimbar`. Não atira: um
 * convite que não se consegue pagar não pode fazer um carimbo falhar — o
 * carimbo é o que a pessoa foi ali fazer, e o convite é um extra.
 *
 * Devolve o que houver para dizer, para o balcão e a app o mostrarem.
 */
async function pagarConviteDeAmigo(env, { cartao, programa, clienteId }) {
  const oferta = {
    convidador: programa.amigo_convidador || 0,
    convidado: programa.amigo_convidado || 0,
  };
  if (!oferta.convidador && !oferta.convidado) return null;

  let convite;
  try {
    convite = await env.DB.prepare(
      `SELECT id, convidador FROM amigos
        WHERE convidado = ? AND programa_id = ? AND premiado_em IS NULL`
    ).bind(clienteId, programa.id).first();
  } catch (erro) {
    console.error('amigos: não deu para ler o convite', String(erro));
    return null;
  }
  if (!convite) return null;

  /* O TECTO CONTA-SE NA HORA DE PAGAR, e não na hora de convidar. Quem convida
     não controla quando os amigos aparecem, e travar o convite à sexta pessoa
     quando as cinco primeiras ainda não foram ao café seria travar o que
     interessa. Aqui já se sabe. */
  const premiados = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM amigos
      WHERE convidador = ? AND programa_id = ? AND premiado_em IS NOT NULL`
  ).bind(convite.convidador, programa.id).first()).n;
  const tecto = programa.amigo_max === undefined || programa.amigo_max === null
    ? 5 : programa.amigo_max;

  const quando = agora();
  const instrucoes = [
    env.DB.prepare('UPDATE amigos SET premiado_em = ? WHERE id = ?')
      .bind(quando, convite.id),
  ];
  const saida = { convidador: 0, convidado: 0, tectoCheio: premiados >= tecto };

  /* Quem chegou ganha sempre — não é ele que tem tecto nenhum. */
  if (oferta.convidado) {
    saida.convidado = oferta.convidado;
    instrucoes.push(...instrucoesDeBonus(env, cartao.id, oferta.convidado,
      programa, 'Traz um amigo: bem-vindo', quando));
  }

  /* E quem convidou, se ainda tiver lugar e se tiver cartão deste programa —
     pode tê-lo apagado entretanto, e um bónus num cartão que já não existe é
     um `UPDATE` que não muda nada e um movimento órfão. */
  let cartaoDele = null;
  if (oferta.convidador && !saida.tectoCheio) {
    cartaoDele = await env.DB.prepare(
      'SELECT * FROM cartoes WHERE cliente_id = ? AND programa_id = ?'
    ).bind(convite.convidador, programa.id).first();
    if (cartaoDele) {
      saida.convidador = oferta.convidador;
      instrucoes.push(...instrucoesDeBonus(env, cartaoDele.id, oferta.convidador,
        programa, 'Traz um amigo: obrigado', quando));
    }
  }

  try {
    await env.DB.batch(instrucoes);
  } catch (erro) {
    console.error('amigos: não deu para pagar o convite', String(erro));
    return null;
  }
  return { ...saida, cartaoDoConvidador: cartaoDele ? cartaoDele.id : null };
}

/**
 * Os `UPDATE`/`INSERT` de um bónus de carimbos num cartão.
 *
 * NÃO FECHA CARTÕES AQUI. Somar carimbos e ver se o cartão ficou cheio é a
 * conta do `carimbar`, com o arrefecimento, o tecto diário e o prémio — e
 * duplicá-la era garantir que as duas cópias se afastavam. O bónus soma, e o
 * carimbo seguinte fecha o cartão como fecharia de qualquer maneira.
 *
 * O que isto quer dizer, e está escrito no ecrã: um bónus pode deixar o cartão
 * com mais carimbos do que o objectivo, e o prémio sai no carimbo a seguir.
 */
function instrucoesDeBonus(env, cartaoId, quantos, programa, nota, quando) {
  const coluna = programa.tipo === 'pontos' ? 'pontos' : 'carimbos';
  return [
    env.DB.prepare(
      `UPDATE cartoes SET ${coluna} = ${coluna} + ?,
              total_carimbos = total_carimbos + ? WHERE id = ?`
    ).bind(quantos, programa.tipo === 'pontos' ? 0 : quantos, cartaoId),
    env.DB.prepare(
      `INSERT INTO movimentos (id, cartao_id, tipo, quantidade, nota, em)
       VALUES (?, ?, ?, ?, ?, ?)`
    ).bind(id(), cartaoId, programa.tipo === 'pontos' ? 'pontos' : 'carimbo',
           quantos, nota, quando),
  ];
}

/* =========================================================================
   Leitura de programas e cartões
   ========================================================================= */

async function programaCompleto(env, programaId) {
  const p = await env.DB.prepare(
    `SELECT p.*, n.nome AS negocio_nome, n.slug AS negocio_slug, n.cor AS negocio_cor,
            n.categoria AS negocio_categoria, n.localidade AS negocio_localidade,
            n.morada AS negocio_morada, n.telefone AS negocio_telefone,
            (n.logotipo IS NOT NULL) AS negocio_tem_logotipo,
            (substr(n.logotipo, 1, 10) = 'image/png;') AS negocio_logotipo_png
       FROM programas p JOIN negocios n ON n.id = p.negocio_id
      WHERE p.id = ?`
  ).bind(programaId).first();
  if (!p) return null;
  const marcos = p.tipo === 'pontos'
    ? (await env.DB.prepare(
        'SELECT pontos, premio FROM marcos WHERE programa_id = ? ORDER BY pontos'
      ).bind(programaId).all()).results
    : null;
  return { ...p, marcos };
}

function moldarPrograma(p) {
  return {
    id: p.id, nome: p.nome, tipo: p.tipo, selo: p.selo,
    objetivo: p.objetivo, premio: p.premio, regras: p.regras,
    arrefecimento: p.arrefecimento, marcos: p.marcos || null,
    /* «Traz um amigo». Vai sempre, mesmo a zero: é assim que a app sabe se há
       alguma coisa para oferecer, sem um pedido a mais. */
    amigo: {
      convidador: p.amigo_convidador || 0,
      convidado: p.amigo_convidado || 0,
      max: p.amigo_max === undefined || p.amigo_max === null ? 5 : p.amigo_max,
    },
  };
}

function moldarNegocio(p) {
  return {
    id: p.negocio_id, nome: p.negocio_nome, slug: p.negocio_slug,
    cor: p.negocio_cor, categoria: p.negocio_categoria,
    localidade: p.negocio_localidade, morada: p.negocio_morada,
    telefone: p.negocio_telefone,
  };
}

async function moldarCartao(env, cartao) {
  const p = await programaCompleto(env, cartao.programa_id);
  if (!p) return null;
  const premios = (await env.DB.prepare(
    'SELECT id, descricao, ganho_em FROM premios WHERE cartao_id = ? AND resgatado_em IS NULL ORDER BY ganho_em'
  ).bind(cartao.id).all()).results;
  return moldeDeCartao(env, cartao, p, premios);
}

/**
 * A FORMA de um cartão, sem ir à base buscar nada.
 *
 * Existe para haver UM sítio que a define. O `moldarCartao` lê o que precisa e
 * chama isto; o `moldarCartoes` lê tudo de uma vez, para muitos cartões, e
 * chama isto também. Duas cópias desta forma divergiam ao primeiro campo novo
 * — e a app que está nos telemóveis lê-a por nome.
 */
function moldeDeCartao(env, cartao, p, premios) {
  return {
    id: cartao.id,
    clienteId: cartao.cliente_id,
    programaId: cartao.programa_id,
    carimbos: cartao.carimbos,
    pontos: cartao.pontos,
    totalCarimbos: cartao.total_carimbos,
    premiosGanhos: cartao.premios_ganhos,
    aderiuEm: cartao.aderiu_em,
    ultimoEm: cartao.ultimo_em,
    /* SE O PASSE DA APPLE JÁ FOI GUARDADO, e quando. A app precisa de saber
       porque o passe da Apple não se actualiza sozinho — não temos servidor
       de web service — e por isso o botão tem de passar a dizer «Actualizar»
       em vez de «Adicionar» a quem já o tem. Sem isto, a pessoa lia
       «Adicionar à Apple Wallet» num cartão que já lá estava e não tinha
       razão nenhuma para lhe tocar; e o passe ficava a mostrar os carimbos do
       dia em que foi guardado, para sempre.

       CAMPO NOVO, nome novo: esta API acrescenta e não renomeia. Uma app em
       cache que não o conheça continua a ver «Adicionar», que é o que via
       antes — perde a melhoria, não perde o botão.

       Só a Apple. O cartão da Google actualiza-se por PATCH, e desde que a
       faixa passou a ir no mesmo pedido, o desenho vai com o saldo. */
    naApple: Boolean(cartao.apple_em),
    /* SE O PASSE QUE ESTÁ NO TELEMÓVEL SE ACTUALIZA SOZINHO.

       O endereço do serviço vai ASSINADO dentro do ficheiro .pkpass. Um passe
       emitido antes de o serviço existir não o tem, e nada do que se faça no
       servidor lhe toca: fica congelado no telemóvel para sempre.

       Sem este campo, a app dizia a toda a gente «actualiza-se sozinho» — e
       para quem guardou o cartão na semana passada isso era mentira. Com ele,
       diz a essa pessoa que guarde o passe outra vez, uma vez só. */
    appleAutomatico: Boolean(cartao.apple_servico),
    /* Quando a pessoa o guardou, para se lhe poder dizer o que mudou desde
       então em vez de um aviso permanente que ninguém lê ao fim da terceira
       vez. */
    appleEm: cartao.apple_em || null,
    /* A ALCUNHA VAI PARA OS DOIS LADOS, e é isso que a torna aceitável: é o
       café que a escreve, mas é o cliente que a lê. Uma nota sobre uma pessoa
       que ela não pode ver é o contrário do que este produto diz ser — e o
       direito de acesso do art. 15.º não é opcional. */
    alcunha: cartao.alcunha || null,
    negocio: moldarNegocio(p),
    programa: moldarPrograma(p),
    porResgatar: premios.length,
    premios: premios.map((x) => ({ id: x.id, descricao: x.descricao, ganhoEm: x.ganho_em })),
    /* Que botões de carteira vale a pena mostrar neste cartão. Nenhuma das
       condições é adivinhável do lado do telemóvel: é preciso o Worker ter
       conta na Google ou certificado da Apple, e o negócio ter logótipo — sem
       ele as duas recusam o passe. Vai aqui em vez de a app tentar e apanhar
       o erro, porque um botão que só falha ao ser tocado é pior do que um
       botão que não está lá. A coluna do logótipo NÃO viaja: o que viaja é a
       resposta a «existe?».

       São duas e não uma: a Google já está no ar e a Apple espera pelo
       certificado, e o telemóvel de quem usa a app não tem de saber disso —
       vê os botões que servem. */
    carteiras: {
      google: Boolean(walletLigada(env) && p.negocio_tem_logotipo),
      /* A APPLE EXIGE PNG, e a promessa tem de saber disso. O `pecasDoPasse`
         recusa um logótipo JPEG com 409 — e este campo existe justamente para
         que um botão não falhe só quando é tocado. Prometer a Apple a um
         negócio com logótipo JPEG era pôr aqui o defeito que o campo veio
         resolver. */
      apple: Boolean(applePronta(env) && p.negocio_tem_logotipo && p.negocio_logotipo_png),
      /* PORQUE É QUE NÃO HÁ BOTÃO, quando não há.

         A app limitava-se a não desenhar nada — e «nada» não se distingue de
         «esta app não faz isso». Uma pessoa com dois cartões, um com botão e
         outro sem, não conclui «falta o logótipo daquele café»: conclui que a
         app está avariada. E o perfil dela promete a carteira a toda a gente.

         O motivo é a coisa que o cliente NÃO PODE RESOLVER — quem tem de
         carregar o logótipo é o dono — e por isso a frase que ele vê não pede
         nada nem culpa ninguém. Quem tem de agir é avisado no balcão.

         Campo novo, nome novo: esta API acrescenta. */
      motivo: (walletLigada(env) || applePronta(env)) && !p.negocio_tem_logotipo
        ? 'sem-logotipo' : null,
    },
    /* O NOME ANTIGO FICA. Isto chamava-se `wallet` e era um booleano, e mudar
       o nome apagou o botão da Wallet da aplicação que estava no ar — o
       Worker publica-se num minuto e o site demora dez, e nesse intervalo a
       app pedia um campo que já não vinha.

       E o intervalo é o menor dos problemas: isto é uma app instalada no ecrã
       inicial de gente, com o JavaScript em cache de um service worker. A
       cópia que uma pessoa tem pode ser de há semanas. Uma API que muda nomes
       parte essas cópias em silêncio — ninguém vê um erro, só um botão que
       deixou de lá estar.

       A regra, daqui em diante: esta API ACRESCENTA. Não renomeia nem tira. */
    wallet: Boolean(walletLigada(env) && p.negocio_tem_logotipo),
  };
}

/**
 * Vários cartões de uma vez, com um número FIXO de consultas.
 *
 * O `moldarCartao` custa duas a três consultas por cartão, e uma invocação de
 * Worker tem tecto de cinquenta subpedidos. Chamado em ciclo — o que a
 * carteira e a exportação de dados faziam — bastavam uns dez cartões para a
 * resposta rebentar com «Too many subrequests» e sair um 500.
 *
 * Aqui são quatro consultas, quantos cartões forem: os programas, os marcos,
 * os prémios por resgatar, e nada mais. A lista de `IN (...)` é montada com
 * tantos `?` quantos os valores — nunca com os valores lá dentro.
 */
async function moldarCartoes(env, cartoes) {
  if (!cartoes.length) return [];

  /* O D1 ACEITA CEM PARÂMETROS POR CONSULTA, e nem um a mais. Um `IN (?, ?,
     …)` com a lista toda resolvia o N+1 e punha o mesmo problema cem cartões
     mais à frente — que é o género de tecto que ninguém encontra a testar e
     alguém encontra a usar. Parte-se em lotes de noventa, que deixa folga
     para os parâmetros que a consulta já leva. */
  const POR_LOTE = 90;
  const emLotes = async (valores, consulta) => {
    const saida = [];
    for (let i = 0; i < valores.length; i += POR_LOTE) {
      const lote = valores.slice(i, i + POR_LOTE);
      const marcas = lote.map(() => '?').join(',');
      saida.push(...(await env.DB.prepare(consulta(marcas)).bind(...lote).all()).results);
    }
    return saida;
  };

  const idsProgramas = [...new Set(cartoes.map((c) => c.programa_id))];
  const programas = await emLotes(idsProgramas, (marcas) =>
    `SELECT p.*, n.nome AS negocio_nome, n.slug AS negocio_slug, n.cor AS negocio_cor,
            n.categoria AS negocio_categoria, n.localidade AS negocio_localidade,
            n.morada AS negocio_morada, n.telefone AS negocio_telefone,
            (n.logotipo IS NOT NULL) AS negocio_tem_logotipo,
            (substr(n.logotipo, 1, 10) = 'image/png;') AS negocio_logotipo_png
       FROM programas p JOIN negocios n ON n.id = p.negocio_id
      WHERE p.id IN (${marcas})`);
  const porPrograma = new Map(programas.map((p) => [p.id, p]));

  /* Os marcos só existem nos programas de pontos. Se não houver nenhum, não
     se gasta a consulta. */
  const dePontos = programas.filter((p) => p.tipo === 'pontos').map((p) => p.id);
  if (dePontos.length) {
    const marcos = await emLotes(dePontos, (marcas) =>
      `SELECT programa_id, pontos, premio FROM marcos
        WHERE programa_id IN (${marcas}) ORDER BY pontos`);
    for (const p of programas) if (p.tipo === 'pontos') p.marcos = [];
    for (const m of marcos) {
      const p = porPrograma.get(m.programa_id);
      if (p) p.marcos.push({ pontos: m.pontos, premio: m.premio });
    }
  }

  const idsCartoes = cartoes.map((c) => c.id);
  const premios = await emLotes(idsCartoes, (marcas) =>
    `SELECT id, cartao_id, descricao, ganho_em FROM premios
      WHERE cartao_id IN (${marcas}) AND resgatado_em IS NULL
      ORDER BY ganho_em`);
  const porCartao = new Map();
  for (const pr of premios) {
    const lista = porCartao.get(pr.cartao_id) || [];
    lista.push(pr);
    porCartao.set(pr.cartao_id, lista);
  }

  return cartoes.map((cartao) => {
    const p = porPrograma.get(cartao.programa_id);
    if (!p) return null;
    const meus = porCartao.get(cartao.id) || [];
    return moldeDeCartao(env, cartao, p, meus);
  });
}

/* =========================================================================
   O carimbo — o coração de tudo
   ========================================================================= */

async function carimbar(env, pedido, operador) {
  const corpo = await corpoJSON(pedido);
  const { codigo, programaId } = corpo;
  /* Arredondado, e não só limitado: sem o `Math.round` um pedido com
     `quantidade: 3.7` gravava 3,7 pontos no cartão, e a partir daí todos os
     totais daquele cliente ficavam com casas decimais. Um carimbo é uma
     coisa inteira. */
  let quantidade = Math.max(1, Math.min(500, Math.round(Number(corpo.quantidade)) || 1));
  let manual = Boolean(corpo.manual);

  /* Sem isto, um pedido sem `programaId` chegava ao D1 com um valor por
     ligar, e o D1 atira — o que saía era um 500 «Erro interno» em vez de
     dizer o que falta. Quem está do outro lado é um balcão a tentar
     perceber porque é que não carimba. */
  exigirTexto(programaId, 'programaId');
  const p = await programaCompleto(env, programaId);
  if (!p) throw new Falha('Programa não encontrado', { estado: 404 });
  if (p.negocio_id !== operador.negocio_id) {
    throw new Falha('Este programa não é deste negócio', { estado: 403 });
  }
  if (p.tipo !== 'pontos') quantidade = 1;

  /* --- quem é o cliente --- */
  const partes = String(codigo || '').split('.');
  let publico, janela = null;
  let porPasse = null;
  if (partes[0] === 'M1' && partes.length === 2) {
    publico = partes[1].toUpperCase();
    manual = true;
  } else if (partes[0] === 'C1' && partes.length === 4) {
    publico = partes[1];
    janela = Number(partes[2]);
  } else if (partes[0] === 'W1' && partes.length === 2) {
    /* O CÓDIGO DO PASSE NA CARTEIRA DO TELEMÓVEL, e isto faltava por inteiro.
       O `wallet.js` e o `pkpass.js` escrevem `W1.<codigo>` no código de
       barras do passe desde sempre, com um comentário a dizer que «é por ele
       que o balcão sabe que está a ler um passe» — e ninguém do lado de cá o
       sabia. O prefixo caía neste `else` e o que saía era «Este código não é
       de um cartão Carimbo Digital». Provado contra a produção: um passe
       criado pela app, lido pelo balcão, recusado.

       O `wallet_codigo` era escrito e nunca lido: as únicas ocorrências dele
       em todo o Worker eram dois UPDATE. O índice único que o acompanha
       existia para uma pesquisa que nunca foi escrita. É esta.

       Não é `manual`: quem lê isto é a câmara, não um dedo a escrever seis
       letras. E é um token PRÓPRIO do passe, e não o número do cliente — é
       isso que permite revogar um passe fotografado sem mexer no cartão da
       pessoa. */
    porPasse = partes[1].toUpperCase();
  } else if (partes[0] === 'D1') {
    /* UM CÓDIGO DE DEMONSTRAÇÃO. Ele nunca poderia ser carimbado aqui — é
       assinado com outro segredo, e o cliente dele não existe nesta base —,
       mas até haver este prefixo dizia-se-lhe a mesma coisa que a um código
       forjado: «não é de um cartão Carimbo Digital». Quem estava do outro lado
       do balcão ficava sem saber o que tinha feito de errado, e a resposta é
       simples: a app dele está em demonstração. */
    throw new Falha('Este código é de uma DEMONSTRAÇÃO, e não de um cartão a '
      + 'sério. Na app do cliente, sai da demonstração no aviso lá de cima.',
    { codigo: 'demonstracao' });
  } else {
    throw new Falha('Este código não é de um cartão Carimbo Digital.', { codigo: 'formato' });
  }

  /* A `chave_versao` vem junto: é ela que decide qual é o segredo que vale
     agora, e sem ela um QR revogado continuava a carimbar. */
  const encontrado = porPasse
    ? await env.DB.prepare(
        `SELECT cl.id, cl.publico, cl.chave_versao, cl.fundida_em FROM cartoes c
           JOIN clientes cl ON cl.id = c.cliente_id
          WHERE c.wallet_codigo = ?`
      ).bind(porPasse).first()
    : await env.DB.prepare(
        'SELECT id, publico, chave_versao, fundida_em FROM clientes WHERE publico = ?'
      ).bind(publico).first();

  /* ATRAVESSA-SE A SOMBRA, e é aqui que a promessa se cumpre: o número que
     alguém tem apontado num guardanapo continua a carimbar depois de as contas
     se juntarem.

     E o código do ECRÃ não sobrevive à mesma travessia, o que também está
     certo. A partir daqui o segredo que se deriva é o da conta que ficou, e a
     assinatura de um `C1.` antigo foi feita com o da sombra sobre o número
     antigo: nunca bate. Ou seja, um telemóvel que tenha ficado de fora da
     fusão deixa de poder carimbar, sem que se tenha escrito uma linha para
     isso — cai do próprio desenho. Quem entra à mão (`M1.`) passa, porque esse
     nunca teve assinatura nenhuma: é o número dito em voz alta. */
  const cliente = await resolverSombra(env, encontrado);
  if (!cliente) {
    throw new Falha(porPasse
      ? 'Este passe já não vale. O cliente pode mostrar o código na app.'
      : 'Cartão desconhecido.',
    { estado: 404, codigo: porPasse ? 'sem-passe' : 'sem-cliente' });
  }

  /* --- o código é válido? --- */
  let chaveUso = null;
  if (janela !== null) {
    const atual = Math.floor(Date.now() / 1000 / JANELA);
    if (!Number.isFinite(janela) || Math.abs(atual - janela) > TOLERANCIA) {
      throw new Falha('Código expirado. Peça para atualizar o ecrã.', { codigo: 'expirado' });
    }
    const segredo = await derivarSegredo(env, cliente.id, cliente.chave_versao);
    const esperado = bytesParaHex(await hmac(deBase64url(segredo), `${publico}.${janela}`)).slice(0, 16);
    if (!iguais(esperado, partes[3])) {
      throw new Falha('Código inválido.', { estado: 403, codigo: 'assinatura' });
    }
    chaveUso = `${publico}:${janela}`;
  }

  /* --- o cartão --- */
  let cartao = await env.DB.prepare(
    'SELECT * FROM cartoes WHERE cliente_id = ? AND programa_id = ?'
  ).bind(cliente.id, programaId).first();

  const novo = !cartao;
  const instrucoes = [];
  if (!cartao) {
    const cartaoId = id();
    await env.DB.prepare(
      `INSERT INTO cartoes (id, cliente_id, programa_id, negocio_id, aderiu_em)
       VALUES (?, ?, ?, ?, ?)`
    ).bind(cartaoId, cliente.id, programaId, p.negocio_id, agora()).run();
    await env.DB.prepare(
      'INSERT INTO movimentos (id, cartao_id, tipo, em) VALUES (?, ?, ?, ?)'
    ).bind(id(), cartaoId, 'adesao', agora()).run();
    cartao = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartaoId).first();
  }

  /* É ESTE O PRIMEIRO CARIMBO DESTE CARTÃO? Lê-se aqui, antes de o `ultimo_em`
     ser escrito, porque é ele que responde.

     E NÃO SERVE O `novo`, que quer dizer outra coisa: «o balcão criou o cartão
     agora», que é o caminho de quem chega sem app. Quem vem por um convite JÁ
     tem o cartão quando chega ao balcão — aderiu ao abrir o link —, e com o
     `novo` o convite nunca seria pago a ninguém. */
  const primeiroCarimbo = !cartao.ultimo_em;

  /* --- arrefecimento --- */
  if (cartao.ultimo_em && p.arrefecimento > 0) {
    const passou = (Date.now() - new Date(cartao.ultimo_em).getTime()) / 1000;
    if (passou < p.arrefecimento) {
      const faltam = Math.ceil((p.arrefecimento - passou) / 60);
      throw new Falha(
        `Já foi carimbado há pouco. Volte a tentar daqui a ${faltam} min.`,
        { estado: 429, codigo: 'arrefecimento', extra: { faltam } });
    }
  }

  /* --- tecto diário --- */
  const inicioDia = new Date(); inicioDia.setHours(0, 0, 0, 0);
  const hoje = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM movimentos
      WHERE cartao_id = ? AND tipo IN ('carimbo','pontos') AND em >= ?`
  ).bind(cartao.id, inicioDia.toISOString()).first();
  if (p.maximo_diario > 0 && hoje.n >= p.maximo_diario) {
    throw new Falha('Este cartão já chegou ao máximo de hoje.',
      { estado: 429, codigo: 'maximo-diario' });
  }

  /* --- só agora se queima o código ---
     Queimá-lo antes das regras gastava-o à toa: quem chegasse dentro do
     arrefecimento ficava sem carimbo E sem código, e tinha de esperar pelos
     quinze segundos seguintes sem perceber porquê. A chave primária é que
     garante a unicidade — não um SELECT antes do INSERT, que numa fila com
     dois telemóveis a ler ao mesmo tempo deixava passar os dois. */
  if (chaveUso) {
    try {
      await env.DB.prepare(
        'INSERT INTO codigos_usados (chave, usado_em) VALUES (?, ?)'
      ).bind(chaveUso, agora()).run();
    } catch {
      throw new Falha('Este código já foi usado.', { estado: 409, codigo: 'repetido' });
    }
  }

  /* --- somar --- */
  const ganhos = [];
  let carimbos = cartao.carimbos;
  let pontos = cartao.pontos;
  let totalCarimbos = cartao.total_carimbos;
  let premiosGanhos = cartao.premios_ganhos;

  if (p.tipo === 'pontos') {
    const antes = pontos;
    pontos += quantidade;
    for (const m of (p.marcos || [])) {
      if (antes < m.pontos && pontos >= m.pontos) {
        ganhos.push({ id: id(), descricao: m.premio });
        premiosGanhos++;
      }
    }
  } else {
    carimbos += quantidade;
    totalCarimbos += quantidade;
    while (carimbos >= p.objetivo) {
      carimbos -= p.objetivo;
      ganhos.push({ id: id(), descricao: p.premio });
      premiosGanhos++;
    }
  }

  const quando = agora();
  const movimentoId = id();

  /* O UPDATE traz a condição de que `ultimo_em` não mudou entretanto. Se dois
     telemóveis lerem códigos diferentes do mesmo cliente no mesmo instante,
     ambos passam pela verificação do arrefecimento — mas só um consegue
     escrever, e o outro fica a saber que chegou tarde. Sem isto era possível
     carimbar duas vezes com dois telemóveis ao balcão. */
  const escrita = await env.DB.prepare(
    `UPDATE cartoes SET carimbos = ?, pontos = ?, total_carimbos = ?,
            premios_ganhos = ?, ultimo_em = ?
      WHERE id = ? AND (ultimo_em IS ? OR ultimo_em = ?)`
  ).bind(carimbos, pontos, totalCarimbos, premiosGanhos, quando,
         cartao.id, cartao.ultimo_em, cartao.ultimo_em).run();
  if (escrita.meta && escrita.meta.changes === 0) {
    throw new Falha('Este cartão acabou de ser carimbado noutro aparelho.',
      { estado: 409, codigo: 'concorrencia' });
  }

  instrucoes.push(
    env.DB.prepare(
      `INSERT INTO movimentos (id, cartao_id, tipo, quantidade, operador, manual, em)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(movimentoId, cartao.id, p.tipo === 'pontos' ? 'pontos' : 'carimbo',
           quantidade, operador.nome, manual ? 1 : 0, quando),
  );
  for (const g of ganhos) {
    instrucoes.push(
      env.DB.prepare(
        'INSERT INTO premios (id, cartao_id, descricao, ganho_em) VALUES (?, ?, ?, ?)'
      ).bind(g.id, cartao.id, g.descricao, quando),
      env.DB.prepare(
        'INSERT INTO movimentos (id, cartao_id, tipo, nota, em) VALUES (?, ?, ?, ?, ?)'
      ).bind(id(), cartao.id, 'premio', g.descricao, quando),
    );
  }
  await env.DB.batch(instrucoes);

  /* --- e o convite, se houver um por pagar -------------------------------
     DEPOIS de o carimbo estar gravado, e nunca antes. É esta a regra que faz o
     «traz um amigo» não ser uma máquina de carimbos: só quem foi mesmo ao
     balcão e foi carimbado por uma pessoa é que o desbloqueia.

     E só no PRIMEIRO carimbo — a linha do convite fica marcada como paga, e o
     índice único impede uma segunda. */
  const amigo = primeiroCarimbo
    ? await pagarConviteDeAmigo(env, { cartao, programa: p, clienteId: cliente.id })
    : null;

  const atualizado = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartao.id).first();
  return {
    cartao: await moldarCartao(env, atualizado),
    cliente: { publico: cliente.publico },
    ganhos: ganhos.map((g) => ({ id: g.id, descricao: g.descricao })),
    novo, quantidade, manual, movimentoId,
    /* Vai `null` quando não houve convite nenhum — que é quase sempre. */
    amigo,
  };
}

/* =========================================================================
   Email (opcional)
   ========================================================================= */

/**
 * Manda o email pela API de correio da Hostinger.
 *
 * Era a Resend. Trocou-se por três razões, e a primeira é a que pesa:
 *
 * · NÃO SAI DA UNIÃO EUROPEIA. A caixa está na Hostinger, em servidores
 *   europeus, e o correio é enviado de lá. Com a Resend a morada, a data e o
 *   estado de entrega ficavam guardados nos Estados Unidos — uma
 *   transferência que a política de privacidade tinha de declarar, e um
 *   subcontratante a mais para um serviço que manda seis algarismos.
 * · JÁ ESTÁ PAGO, e a API vem incluída em todos os planos de email.
 * · O TECTO É OUTRO: mil a três mil por dia contra três mil por MÊS.
 *
 * O que se perdeu, e convém saber: a Resend tinha chave de idempotência —
 * um pedido repetido não mandava um segundo email. Aqui não há. Quem segura
 * isso agora é o `podeEnviar()`, que recusa dois pedidos para a mesma morada
 * a menos de 45 segundos um do outro.
 *
 * E uma nota de segurança que não se deve esquecer: este token abre a caixa
 * toda — lê, procura, apaga. Não há âmbito só-de-envio nesta API. É por isso
 * que ele vive num segredo do Worker e nunca no repositório.
 */
async function enviarEmail(env, { para, assunto, texto, html }) {
  if (!env.MAIL_TOKEN || !env.MAIL_CAIXA) return { enviado: false, motivo: 'sem-chave' };
  try {
    const r = await fetch(
      `https://api.mail.hostinger.com/api/v1/mailboxes/${env.MAIL_CAIXA}/send`, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${env.MAIL_TOKEN}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          to: [para],
          /* Não há campo `from`: quem envia é a própria caixa. O que se
             escolhe é o nome que aparece ao lado da morada. */
          displayName: env.EMAIL_NOME || 'Carimbo Digital',
          subject: assunto,
          /* As duas versões, sempre. A de texto não é um resto do passado: há
             clientes que só mostram texto, os leitores de ecrã dão-se melhor
             com ela, e um email só-HTML pontua pior nos filtros de spam. */
          text: texto,
          ...(html ? { html } : {}),
        }),
      });
    /* 204 e não 200: a API responde sem corpo nenhum quando o email sai. */
    if (r.status === 204 || r.ok) return { enviado: true };

    /* Um envio recusado tem quase sempre uma razão concreta. Registá-la é o
       que evita meia hora à procura: vê-se com `npx wrangler tail`. O motivo
       NÃO volta ao cliente: diria a um estranho como está montada a casa.

       Os três estados que esta API usa querem dizer coisas diferentes, e a
       diferença é a diferença entre ir ao sítio certo e andar às voltas:
       401 é a credencial (e o engano do costume é ter-se criado o token da
       API de alojamento em vez do de Agentic mail); 403 é um token bom para
       outra caixa; 422 é o corpo do pedido, ou seja, culpa nossa. */
    const porque = {
      401: 'credencial recusada — o MAIL_TOKEN é da API de correio '
         + '(hPanel › Emails › o domínio › Agentic mail › API) e não da de alojamento?',
      403: 'o token não manda nesta caixa — o MAIL_CAIXA é de outra, '
         + 'ou o token foi criado só para algumas',
      422: 'o pedido não passou na validação — isto é defeito nosso, não da conta',
      429: 'depressa de mais para o que a Hostinger aceita',
    }[r.status];
    const detalhe = await r.text().catch(() => '');
    console.error('Hostinger recusou', r.status, porque || '', detalhe.slice(0, 400));
    return { enviado: false, motivo: 'recusado', estado: r.status };
  } catch (e) {
    console.error('Correio inacessível:', e.message);
    return { enviado: false, motivo: 'rede' };
  }
}

/**
 * Valida um código de entrada e gasta-o.
 *
 * O código é curto de propósito — tem de ser escrito à mão — por isso a
 * segurança vem do prazo (15 min), do uso único e do contador de tentativas.
 * Cinco enganos e o código morre; sem isso, um milhão de hipóteses tentava-se
 * em minutos.
 */
/**
 * A forma canónica de uma morada de email.
 *
 * Isto é uma função e não um `.toLowerCase()` espalhado pelo código porque
 * já custou um defeito: a morada era guardada como a pessoa a escreveu e
 * procurada em minúsculas. Quem escrevesse `Renato@Exemplo.pt` recebia o
 * código e nunca conseguia entrar — o resumo nunca batia certo.
 */
/**
 * O corpo do pedido, em JSON, sem rebentar.
 *
 * `pedido.json()` atira quando o corpo está vazio ou não é JSON, e essa
 * excepção sai pelo apanhador geral como 500 «Erro interno» — o que diz a
 * quem chamou que o servidor se avariou, quando quem se enganou foi ele.
 * Um corpo em branco é um objecto vazio; um corpo estragado é um 400.
 */
/**
 * Um identificador que tem mesmo de vir no pedido.
 *
 * Sem isto, um campo em falta chegava ao `.bind(undefined)` do D1, que atira
 * — e a excepção saía pelo apanhador geral como 500 «Erro interno». Dizia a
 * quem chamou que o servidor se avariou quando quem se enganou foi ele, e
 * enchia os registos de erros que não eram erros nossos.
 */
function exigirTexto(valor, nome) {
  if (typeof valor !== 'string' || !valor.trim()) {
    throw new Falha(`Falta ${nome}.`, { estado: 400, codigo: 'em-falta' });
  }
  return valor;
}

/* Um corpo de pedido tinha tamanho livre. Trinta e dois kilobytes chegam e
   sobram para tudo o que estas rotas recebem — o maior é o formulário de
   fundar, com seis campos curtos. O logótipo, que é o único que precisa de
   mais, entra por rota própria e tem o tecto dele. */
const CORPO_MAX = 32 * 1024;
const LOGOTIPO_MAX = 256 * 1024;   // o PNG já reduzido no browser, em base64

async function corpoJSON(pedido, tecto = CORPO_MAX) {
  const texto = await pedido.text();
  if (texto.length > tecto) {
    throw new Falha('O pedido é demasiado grande.', { estado: 413, codigo: 'grande' });
  }
  if (!texto.trim()) return {};
  try {
    const d = JSON.parse(texto);
    return d && typeof d === 'object' ? d : {};
  } catch {
    throw new Falha('O corpo do pedido não é JSON válido.', { estado: 400, codigo: 'json' });
  }
}

function normalizarEmail(valor) {
  return String(valor || '').trim().toLowerCase();
}

const EMAIL_VALIDO = /^[^@\s]{1,64}@[^@\s]{1,190}\.[a-z]{2,}$/i;

/**
 * Quantos códigos podem sair para a mesma morada.
 *
 * Devolve `null` se pode sair, ou uma mensagem se não pode. Duas travas: um
 * intervalo mínimo entre pedidos, para o dedo nervoso não gastar a quota, e
 * um tecto por hora, para ninguém usar isto como relé de email.
 */
async function podeEnviar(env, email) {
  const agoraMs = Date.now();
  const ultimo = await env.DB.prepare(
    'SELECT em FROM envios WHERE email = ? ORDER BY em DESC LIMIT 1'
  ).bind(email).first();
  if (ultimo && agoraMs - new Date(ultimo.em).getTime() < ENVIOS_INTERVALO * 1000) {
    return 'Já enviámos um código há pouco. Espera um minuto.';
  }
  const desde = new Date(agoraMs - 3600000).toISOString();
  const { n } = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM envios WHERE email = ? AND em >= ?'
  ).bind(email, desde).first();
  if (n >= ENVIOS_HORA) {
    return 'Demasiados pedidos para esta morada. Tenta daqui a uma hora.';
  }
  return null;
}

/**
 * O endereço reduzido ao que é, de facto, UMA origem.
 *
 * EM IPv6 CONTA-SE O /64, e não o endereço inteiro. Qualquer linha doméstica
 * recebe um /64 completo — dezoito triliões de endereços — e o telemóvel muda
 * de um para o outro quando lhe apetece, por causa das extensões de
 * privacidade. Contar o /128 era escrever uma trava que não trava: cada pedido
 * chegava de uma «origem» nova. Em IPv4 conta-se o endereço, que é o que a
 * casa tem.
 *
 * Isto vale para as duas travas, a dos registos incluída — que estava com o
 * mesmo buraco desde que nasceu.
 */
function enderecoDeOrigem(ip) {
  /* IPv4, ou um IPv4 embrulhado em IPv6 (`::ffff:1.2.3.4`). O ponto é o que os
     distingue, e tratar o segundo como IPv6 punha o mundo inteiro dentro da
     mesma origem — o contrário do defeito, e pior. */
  if (ip.includes('.')) return ip;
  if (!ip.includes(':')) return ip;
  const [esquerda, direita = ''] = ip.split('::');
  const a = esquerda ? esquerda.split(':').filter(Boolean) : [];
  const b = direita ? direita.split(':').filter(Boolean) : [];
  const faltam = Math.max(0, 8 - a.length - b.length);
  const grupos = [...a, ...Array(faltam).fill('0'), ...b];
  return grupos.slice(0, 4).map((g) => g.padStart(4, '0')).join(':');
}

/**
 * Trava quem cria contas em série.
 *
 * `/v1/cliente/registar` é a ÚNICA rota aberta a quem nunca se identificou —
 * não pede email, não pede sessão, não pede nada: devolve uma conta, um
 * segredo e uma sessão a quem bater à porta. É de propósito, e é isso que faz
 * a app funcionar «a partir do primeiro segundo». Mas sem contador nenhum, um
 * ciclo de três linhas escrevia até as 100 000 escritas diárias do D1 se
 * esgotarem — e esse tecto é POR CONTA da Cloudflare, por isso levava atrás
 * todos os outros projectos que lá vivem.
 *
 * Conta-se por origem e **guarda-se um HMAC dela, nunca a própria origem**. Um
 * resumo simples não chegava: os endereços IPv4 são quatro mil milhões, que se
 * percorrem todos numa tarde — com a chave-mestra pelo meio, não. A linha vive
 * uma hora e a limpeza da madrugada leva o resto.
 *
 * SEM CABEÇALHO NÃO HÁ TRAVA, e isso não é um buraco: o `CF-Connecting-IP` é
 * posto pela Cloudflare em todos os pedidos que lhe passam pela frente, e um
 * valor que o cliente mande é substituído lá — não se pode forjar nem apagar.
 * Faltar só acontece fora da borda, ou seja, em desenvolvimento local.
 */
async function travarRegistos(env, pedido) {
  return travarPorOrigem(env, pedido, {
    marca: 'ip', tecto: REGISTOS_HORA, codigo: 'demasiados-registos',
    mensagem: 'Demasiados cartões criados daqui. Tenta daqui a uma hora.',
    aviso: 'registar',
  });
}

/**
 * A trava, para qualquer rota aberta que escreva.
 *
 * A `marca` é o que separa os contadores: `ip:` para as contas novas, `liga:`
 * para as idas a um provedor de identidade. Vão na mesma tabela e no mesmo
 * HMAC, mas em espaços diferentes — senão quem entrasse pela Google gastava a
 * quota de quem cria cartões, e a pessoa via «não consigo criar o cartão» sem
 * nada que o explicasse. A marca antiga NÃO muda: era `ip:` e continua a ser.
 */
async function travarPorOrigem(env, pedido, { marca, tecto, codigo, mensagem, aviso = marca }) {
  const ip = pedido.headers.get('cf-connecting-ip');
  if (!ip) return;
  const origem = base64url(await hmac(deBase64url(env.CHAVE_MESTRA), `${marca}:${enderecoDeOrigem(ip)}`));
  const desde = new Date(Date.now() - 3600000).toISOString();
  const { n } = await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM registos WHERE origem = ? AND em >= ?'
  ).bind(origem, desde).first();
  if (n >= tecto) {
    /* FICA ESCRITO NO LOG, e não é zelo: os operadores móveis portugueses põem
       muitos clientes atrás do mesmo IPv4 (CGNAT). Com um negócio a sério o
       tecto nunca se alcança; com centenas de cafés, sessenta contas novas por
       hora vindas do mesmo operador deixa de ser impossível — e o que a pessoa
       vê é «não consigo criar o cartão», sem nada que o explique deste lado.
       Se isto aparecer no `wrangler tail`, é sinal de que chegou a hora de
       trocar a trava por um tecto global diário. */
    console.warn(`${aviso}: origem travada`, { tentativas: n });
    throw new Falha(mensagem, { estado: 429, codigo });
  }
  await env.DB.prepare('INSERT INTO registos (origem, em) VALUES (?, ?)')
    .bind(origem, agora()).run();
}

/** Emite um código, guarda-o, e conta o envio para efeitos de tecto. */
async function emitirCodigo(env, { email, alvo }) {
  await env.DB.prepare('DELETE FROM entradas WHERE alvo = ?').bind(alvo).run();
  const codigo = codigoEntrada();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em) VALUES (?, ?, ?, ?, ?)'
    ).bind(await resumo(`${email}|${codigo}`), alvo, email, agora(),
           new Date(Date.now() + ENTRADA_MINUTOS * 60000).toISOString()),
    env.DB.prepare('INSERT INTO envios (id, email, em) VALUES (?, ?, ?)')
      .bind(id(), email, agora()),
  ]);
  return codigo;
}

async function consumirEntrada(env, email, codigo) {
  const limpo = String(codigo || '').replace(/\D/g, '');
  if (limpo.length !== 6) throw new Falha('O código tem seis algarismos.', { estado: 400 });
  const correio = normalizarEmail(email);

  const linha = await env.DB.prepare(
    'SELECT * FROM entradas WHERE resumo = ?'
  ).bind(await resumo(`${correio}|${limpo}`)).first();

  if (!linha || linha.usada_em || expirado(linha.expira_em)) {
    /* Conta-se a tentativa falhada contra o código que existe para este
       email, não contra o resumo que falhou — senão bastava mudar o palpite
       para nunca gastar tentativas. */
    await env.DB.prepare(
      `UPDATE entradas SET tentativas = tentativas + 1
        WHERE email = ? AND usada_em IS NULL`
    ).bind(correio).run();
    await env.DB.prepare(
      'DELETE FROM entradas WHERE email = ? AND tentativas >= ?'
    ).bind(correio, ENTRADA_TENTATIVAS).run();
    throw new Falha('Código errado ou expirado.', { estado: 401, codigo: 'codigo-invalido' });
  }

  await env.DB.prepare('UPDATE entradas SET usada_em = ? WHERE resumo = ?')
    .bind(agora(), linha.resumo).run();
  return linha;
}

/* =========================================================================
   Rotas
   ========================================================================= */

const rotas = [];
const rota = (metodo, padrao, mao) => rotas.push({ metodo, padrao, mao });

/* --- cliente ------------------------------------------------------------ */

rota('POST', '/v1/cliente/registar', async (env, pedido) => {
  /* Sem nome, sem email, sem nada. A conta nasce anónima e só ganha um email
     se a pessoa quiser poder recuperá-la noutro telemóvel. */
  await travarRegistos(env, pedido);
  const clienteId = id();
  let publico, tentativas = 0;
  for (;;) {
    publico = publicoNovo();
    const existe = await env.DB.prepare('SELECT 1 FROM clientes WHERE publico = ?').bind(publico).first();
    if (!existe) break;
    if (++tentativas > 12) throw new Falha('Não foi possível criar o cartão', { estado: 503 });
  }
  await env.DB.prepare(
    'INSERT INTO clientes (id, publico, criado_em, visto_em) VALUES (?, ?, ?, ?)'
  ).bind(clienteId, publico, agora(), agora()).run();

  return {
    cliente: { id: clienteId, publico, criadoEm: agora(), email: null },
    segredo: await derivarSegredo(env, clienteId),
    sessao: await criarSessao(env, `cliente:${clienteId}`),
    horaDoServidor: agora(),
  };
});

/* =========================================================================
   Contas-sombra

   Uma conta que sai de uma fusão não se apaga: fica com o `publico` de sempre
   e um ponteiro para quem a absorveu. Ver `migracoes/010`.
   ========================================================================= */

/* Quantos saltos se seguem antes de desistir. Em condições normais é UM: a
   fusão achata as cadeias, reapontando para o destino final tudo o que
   apontava para a conta absorvida. Este tecto existe para o caso de alguma vez
   não achatar — e sobretudo para um CICLO, que sem tecto nenhum era uma
   invocação a rodar até o Worker a matar, disparada por um número de cartão
   que qualquer pessoa pode escrever ao balcão. */
const SALTOS_MAX = 8;

/**
 * Segue o ponteiro da fusão até à conta que está mesmo viva.
 *
 * Recebe a linha já lida e devolve a linha final — a mesma, se não for sombra.
 * Devolve `null` se a cadeia se perder (o destino foi apagado) ou se der
 * voltas: nos dois casos a resposta certa é «cartão desconhecido» e não um
 * carimbo em sítio nenhum.
 */
async function resolverSombra(env, linha) {
  if (!linha || !linha.fundida_em) return linha;
  const vistos = new Set([linha.id]);
  let actual = linha;
  for (let i = 0; i < SALTOS_MAX && actual.fundida_em; i++) {
    if (vistos.has(actual.fundida_em)) {
      console.error('sombra: ciclo na cadeia de fusão', actual.id);
      return null;
    }
    vistos.add(actual.fundida_em);
    actual = await env.DB.prepare(
      'SELECT id, publico, chave_versao, fundida_em FROM clientes WHERE id = ?'
    ).bind(actual.fundida_em).first();
    if (!actual) return null;
  }
  /* Ainda com ponteiro ao fim dos saltos é cadeia longa de mais para ser
     verdade. Fica escrito, porque quer dizer que a fusão deixou de achatar. */
  if (actual.fundida_em) {
    console.error('sombra: cadeia longa de mais', linha.id);
    return null;
  }
  return actual;
}

/**
 * Juntar duas contas numa só.
 *
 * É a operação mais perigosa do produto inteiro, e o perigo não é técnico: é
 * que quase tudo o que corre mal aqui corre mal em SILÊNCIO. Ninguém repara
 * que perdeu um cartão que tinha há dois anos; repara daí a meio ano, ao
 * balcão, e já não há como saber o que aconteceu.
 *
 * SÃO DOIS MODOS, e confundi-los é um ataque:
 *
 *   'provada'  — as duas contas autenticaram-se no acto. As sessões da que sai
 *                reapontam-se para a que fica: a pessoa continua a andar em
 *                todos os aparelhos onde estava.
 *   'absorcao' — a que sai é anónima e ninguém provou ser dela. As sessões
 *                MORREM. Tratar isto como o outro caso era entregar a conta
 *                inteira a quem estivesse com o telemóvel na mão.
 *
 * O QUE NÃO SE FAZ, e é tão importante como o que se faz:
 *
 *   - não se RECRIAM cartões, reparenteiam-se. O objecto da Google é
 *     `<emissor>.<cartao.id>` e o `serialNumber` do `.pkpass` é o `cartao.id`:
 *     um cartão recriado é um passe morto na carteira de alguém.
 *   - não se SOMAM ciclos. Dois cartões do mesmo programa ficam pelo MAIOR. O
 *     arrefecimento e o tecto diário são por CARTÃO, não por pessoa, por isso
 *     somar era pagar a quem andasse com dois números no mesmo café. O total
 *     histórico soma-se, porque esse não dá prémio nenhum: é memória.
 *   - não se apaga a conta que sai. Fica sombra (ver `migracoes/010`).
 */
async function fundirContas(env, { origem, destino, modo }) {
  if (origem === destino) throw new Falha('É a mesma conta.', { estado: 400, codigo: 'fusao-mesma' });
  if (modo !== 'provada' && modo !== 'absorcao') {
    throw new Falha('Modo de fusão desconhecido.', { estado: 400, codigo: 'fusao-modo' });
  }

  const daOrigem = await env.DB.prepare(
    'SELECT id, publico, fundida_em FROM clientes WHERE id = ?').bind(origem).first();
  const doDestino = await env.DB.prepare(
    'SELECT id, publico, fundida_em FROM clientes WHERE id = ?').bind(destino).first();
  if (!daOrigem || !doDestino) throw new Falha('Conta não encontrada', { estado: 404 });
  if (daOrigem.fundida_em || doDestino.fundida_em) {
    /* Fundir uma sombra era escrever cadeias de propósito, e o destino tem de
       estar vivo por razões óbvias. Quem chama resolve primeiro. */
    throw new Falha('Essa conta já foi fundida.', { estado: 409, codigo: 'fusao-sombra' });
  }

  /* --- OS PRÉMIOS PASSAM TODOS ---------------------------------------
     Esteve aqui uma trava: a fusão era recusada se houvesse um prémio por
     levantar de qualquer dos lados. Era a regra conservadora, e estava escrita
     como decisão por confirmar. Foi confirmada ao contrário, pelo dono: os
     prémios juntam-se.

     E é defensável. Um prémio por levantar é uma dívida do café a alguém que
     JÁ fez as visitas — os carimbos que o geraram foram dados ao balcão, um a
     um. Recusar a fusão não apagava a dívida: só obrigava a pessoa a ir ao
     café levantar o prémio antes de poder juntar as contas, e ficava com o
     mesmo número de cafés grátis no fim. A trava incomodava quem tinha razão e
     não impedia nada a quem não tivesse.

     Não é preciso código para os mover: um prémio pende de um CARTÃO, e os
     cartões reparenteiam-se logo abaixo. Os do cartão que morre numa colisão
     mudam de cartão antes de a linha desaparecer — sem isso, o ON DELETE
     CASCADE levava-os à frente e a pessoa perdia um prémio ganho sem que nada
     o dissesse. É a mesma instrução que já salva o histórico.

     O que fica por resolver não é da fusão: o arrefecimento e o tecto diário
     são por CARTÃO, portanto quem ande com dois números no mesmo café leva o
     dobro dos carimbos por visita, com ou sem fusão. Resolve-se ao carimbar. */

  const cartoesOrigem = (await env.DB.prepare(
    'SELECT * FROM cartoes WHERE cliente_id = ?').bind(origem).all()).results;
  const cartoesDestino = (await env.DB.prepare(
    'SELECT * FROM cartoes WHERE cliente_id = ?').bind(destino).all()).results;
  const porPrograma = new Map(cartoesDestino.map((c) => [c.programa_id, c]));

  const instrucoes = [];
  let mudados = 0, juntados = 0;

  for (const c of cartoesOrigem) {
    const gemeo = porPrograma.get(c.programa_id);
    if (!gemeo) {
      /* Sem colisão: muda de dono e mais nada. O `id` não se toca, senão o
         passe na carteira de alguém morre. */
      instrucoes.push(env.DB.prepare(
        'UPDATE cartoes SET cliente_id = ? WHERE id = ?').bind(destino, c.id));
      mudados++;
      continue;
    }
    /* Colisão: o cartão do destino fica, o da origem despeja-se lá dentro.
       O histórico vai junto — movimentos e prémios mudam de cartão ANTES de a
       linha morrer, senão o ON DELETE CASCADE leva-os à frente e a pessoa
       perde anos de visitas sem que nada o diga. */
    instrucoes.push(
      env.DB.prepare('UPDATE movimentos SET cartao_id = ? WHERE cartao_id = ?').bind(gemeo.id, c.id),
      env.DB.prepare('UPDATE premios SET cartao_id = ? WHERE cartao_id = ?').bind(gemeo.id, c.id),
      env.DB.prepare(
        `UPDATE cartoes
            SET carimbos = MAX(carimbos, ?),
                pontos = MAX(pontos, ?),
                total_carimbos = total_carimbos + ?,
                premios_ganhos = premios_ganhos + ?,
                aderiu_em = MIN(aderiu_em, ?),
                ultimo_em = MAX(COALESCE(ultimo_em, ''), COALESCE(?, '')),
                -- A ALCUNHA DO CARTÃO QUE MORRE NÃO SE PERDE EM SILÊNCIO. É o
                -- café que a escreveu, e é o mesmo café dos dois lados (os
                -- dois cartões são do mesmo programa). Fica a que o cartão que
                -- sobrevive já tinha; se não tinha nenhuma, herda a do outro.
                -- Sem isto, juntar duas contas apagava ao balcão o nome por
                -- que ele conhecia aquela pessoa, sem nada que o dissesse.
                alcunha = COALESCE(alcunha, ?)
          WHERE id = ?`
      ).bind(c.carimbos, c.pontos, c.total_carimbos, c.premios_ganhos,
             c.aderiu_em, c.ultimo_em, c.alcunha, gemeo.id),
      env.DB.prepare('DELETE FROM cartoes WHERE id = ?').bind(c.id),
    );
    juntados++;
  }

  /* --- OS PASSES DAS DUAS CONTAS SÃO REVOGADOS --------------------------
     Esta é a dívida 3.2 a ser paga onde ela existe mesmo. O `wallet_codigo` é
     um PORTADOR: o código de barras do passe carimba sem assinatura nenhuma.
     Um cartão que muda de dono e leva o código atrás punha o passe que está na
     carteira do telemóvel A a abrir o cartão que agora é da conta B — e é
     exactamente o mesmo código que estava lá antes, por isso ninguém veria
     nada de estranho.

     Revogam-se os dois lados e não só os que mudaram: o cartão do destino que
     absorveu um gémeo tem agora carimbos que não tinha, e o passe antigo
     continuaria a mostrar o saldo velho. Voltar a juntar à carteira cunha um
     código novo. */
  /* DUAS CONTAS DIFERENTES, e o `LIMIT` só se aplica a uma delas. Quantos
     passes caem é o que se diz a quem chamou, e tem de ser o número todo; o
     tecto existe só para a ida à Google, que gasta subpedidos — uma invocação
     tem cinquenta e esta rota já gastou uma dezena antes de chegar aqui. Ter
     os dois no mesmo `SELECT` fazia a contagem parar nos 20 e a resposta
     mentir a quem tivesse mais. */
  const comPasse = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM cartoes
      WHERE cliente_id IN (?, ?) AND wallet_codigo IS NOT NULL`
  ).bind(origem, destino).first()).n;
  if (walletLigada(env)) {
    const naGoogle = (await env.DB.prepare(
      `SELECT id FROM cartoes
        WHERE cliente_id IN (?, ?) AND wallet_em IS NOT NULL LIMIT 20`
    ).bind(origem, destino).all()).results;
    for (const c of naGoogle) {
      try {
        await googlePedir(env, `/loyaltyObject/${env.GOOGLE_EMISSOR}.${c.id}`, {
          metodo: 'PATCH', corpo: { state: 'EXPIRED' },
        });
      } catch (erro) {
        console.error('wallet: não deu para expirar o passe ao fundir', c.id, String(erro));
      }
    }
  }
  instrucoes.push(env.DB.prepare(
    `UPDATE cartoes SET wallet_codigo = NULL, wallet_em = NULL, apple_em = NULL
      WHERE cliente_id IN (?, ?)`).bind(origem, destino));

  /* As formas de entrar mudam de dono. */
  instrucoes.push(env.DB.prepare(
    'UPDATE identidades SET cliente_id = ? WHERE cliente_id = ?').bind(destino, origem));

  /* As sessões: os dois modos, e é aqui que a diferença vive. */
  instrucoes.push(modo === 'provada'
    ? env.DB.prepare('UPDATE sessoes SET sujeito = ? WHERE sujeito = ?')
        .bind(`cliente:${destino}`, `cliente:${origem}`)
    : env.DB.prepare('DELETE FROM sessoes WHERE sujeito = ?').bind(`cliente:${origem}`));

  /* Os códigos por usar da origem não podem ficar a apontar para uma sombra:
     quem escrevesse um deles entrava numa conta que já não é destino de nada. */
  instrucoes.push(env.DB.prepare(
    'UPDATE entradas SET alvo = ? WHERE alvo = ? AND usada_em IS NULL')
    .bind(`cliente:${destino}`, `cliente:${origem}`));

  /* A origem passa a sombra, e o segredo dela deixa de valer. A subida da
     versão é a dívida 3.1 a servir para o que foi feita. */
  instrucoes.push(env.DB.prepare(
    `UPDATE clientes
        SET fundida_em = ?, fundida_quando = ?, chave_versao = chave_versao + 1,
            email = NULL, email_verificado = 0, avisada_em = NULL
      WHERE id = ?`).bind(destino, agora(), origem));

  /* ACHATAR A CADEIA. Tudo o que apontava para a origem passa a apontar para o
     destino, para a travessia ser sempre de um salto só. Sem isto, cada fusão
     acrescentava um elo, e ao oitavo o `resolverSombra` desiste — um número de
     cartão antigo deixava de carimbar sem nada que o explicasse. */
  instrucoes.push(env.DB.prepare(
    'UPDATE clientes SET fundida_em = ? WHERE fundida_em = ?').bind(destino, origem));

  /* O espelho do email do destino refaz-se a partir das identidades, que é
     quem manda. A origem podia trazer a morada e o destino não ter nenhuma. */
  instrucoes.push(env.DB.prepare(
    `UPDATE clientes SET email = (
        SELECT i.email FROM identidades i
         WHERE i.cliente_id = ?1 AND i.provedor = 'email' AND i.relay = 0
         ORDER BY i.verificada_em LIMIT 1),
      email_verificado = CASE WHEN EXISTS (
        SELECT 1 FROM identidades i
         WHERE i.cliente_id = ?1 AND i.provedor = 'email' AND i.relay = 0) THEN 1 ELSE 0 END
      WHERE id = ?1`).bind(destino));

  await env.DB.batch(instrucoes);
  return { cartoesMudados: mudados, cartoesJuntados: juntados, passesRevogados: comPasse };
}

/* =========================================================================
   Identidades — as formas de entrar numa conta

   A chave é `(provedor, sujeito)` e NÃO a morada. Ver `migracoes/009`.
   ========================================================================= */

/**
 * De quem é esta identidade — ou `null` se ainda não é de ninguém.
 *
 * É esta pergunta que decide o dono de uma conta, e é por isso que se faz
 * contra `identidades` e não contra `clientes.email`: a morada é pista. Duas
 * contas podem mostrar a mesma morada sem serem a mesma pessoa (uma delas
 * mostrou-a pela Google e ninguém a provou aqui), e tratá-las como uma é
 * exactamente o pré-registo que o modelo existe para impedir.
 */
async function donoDaIdentidade(env, provedor, sujeito) {
  const l = await env.DB.prepare(
    'SELECT cliente_id FROM identidades WHERE provedor = ? AND sujeito = ?'
  ).bind(provedor, sujeito).first();
  if (!l) return null;
  /* ATRAVESSA A SOMBRA. A fusão muda as identidades de dono, por isso em bom
     estado isto nunca dá um salto. Mas se alguma vez ficar uma para trás, o
     que acontece sem esta linha é a pessoa provar a caixa de correio e ser
     mandada para uma conta vazia que já não é destino de nada — e como a
     conta existe, nem sequer daria erro. */
  const linha = await env.DB.prepare(
    'SELECT id, publico, chave_versao, fundida_em FROM clientes WHERE id = ?'
  ).bind(l.cliente_id).first();
  const viva = await resolverSombra(env, linha);
  return viva ? viva.id : null;
}

/**
 * As instruções que colam uma identidade a uma conta.
 *
 * Devolve instruções em vez de as correr, para poderem ir num `batch` com o
 * resto — se o índice único recusar a identidade, a escrita do espelho também
 * não acontece, e não fica uma conta com o email preenchido e sem identidade
 * nenhuma a sustentá-lo.
 *
 * O ESPELHO EM `clientes.email` CONTINUA A SER ESCRITO, e não é descuido: a
 * PWA no telemóvel de alguém pode ser de há semanas e lê aquela coluna, e o
 * aviso de conta parada também. A API acrescenta, não renomeia. Sai quando já
 * não houver quem o leia.
 */
function instrucoesDeIdentidade(env, { clienteId, provedor, sujeito, email, relay = 0, rotulo = null }) {
  const agoraISO = agora();
  const instrucoes = [
    env.DB.prepare(
      `INSERT INTO identidades
         (id, cliente_id, provedor, sujeito, email, relay, rotulo, criada_em, verificada_em, usada_em)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id(), clienteId, provedor, sujeito, email || null, relay ? 1 : 0, rotulo,
           agoraISO, agoraISO, agoraISO),
  ];
  /* Só o email alimenta o espelho. Um `sub` da Google não é uma morada, e a
     morada que a Google mostra é pista — pô-la aqui era deixá-la decidir de
     quem é a conta pela porta das traseiras. E um relay da Apple nunca, que a
     pessoa o pode desligar. */
  if (provedor === 'email' && email && !relay) {
    instrucoes.push(env.DB.prepare(
      'UPDATE clientes SET email = ?, email_verificado = 1 WHERE id = ?'
    ).bind(email, clienteId));
  }
  return instrucoes;
}

/** Marca que uma identidade acabou de servir para entrar. */
async function marcarIdentidadeUsada(env, provedor, sujeito) {
  await env.DB.prepare(
    'UPDATE identidades SET usada_em = ? WHERE provedor = ? AND sujeito = ?'
  ).bind(agora(), provedor, sujeito).run();
}

/**
 * Quem sou eu, e qual é o meu segredo AGORA.
 *
 * O segredo não se guardava em lado nenhum do lado do servidor — deriva-se —
 * mas também não havia por onde voltar a pedi-lo: saía uma vez no registo e
 * outra na entrada, e quem o perdesse (ou quem o tivesse de uma versão já
 * revogada) ficava com um código QR que o balcão recusa e sem forma de se
 * endireitar a não ser criando outra conta. Uma sessão válida já prova tanto
 * como qualquer das outras duas rotas provam — é a mesma credencial.
 */
rota('GET', '/v1/cliente/eu', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  const c = await env.DB.prepare(
    'SELECT id, publico, email, criado_em, chave_versao FROM clientes WHERE id = ?'
  ).bind(clienteId).first();
  if (!c) throw new Falha('Conta não encontrada', { estado: 404 });

  /* AS FORMAS DE ENTRAR VÊM JUNTAS, e é o que permite à app saber se há aqui
     alguém — em vez de adivinhar pelo `email`, que é só o espelho de UMA
     delas e que fica a NULL para quem entrar pela Google. É esta lista que
     decide se o toque no perfil abre o perfil ou pede para entrar, e é ela que
     desenha «entraste com...». Sem `sujeito`: o `sub` da Google não se mostra
     a ninguém e não serve para nada do lado do ecrã. */
  const identidades = (await env.DB.prepare(
    `SELECT provedor, email, relay, rotulo, criada_em, usada_em
       FROM identidades WHERE cliente_id = ? ORDER BY criada_em`
  ).bind(clienteId).all()).results;

  return {
    cliente: { id: c.id, publico: c.publico, email: c.email, criadoEm: c.criado_em },
    identidades,
    segredo: await derivarSegredo(env, c.id, c.chave_versao),
    horaDoServidor: agora(),
  };
});

/**
 * Expulsar os outros aparelhos.
 *
 * Um telemóvel perdido com a app aberta é uma conta perdida: quem o tiver na
 * mão mostra o código e leva carimbos, e até aqui não havia absolutamente nada
 * a fazer quanto a isso. A coluna `chave_versao` existia para isto desde o
 * primeiro dia, com um comentário a explicá-lo, e NUNCA era lida nem escrita.
 *
 * São TRÊS credenciais e não uma, e é por isso que esta rota faz três coisas.
 * Deixar qualquer uma delas de fora tornava o botão uma mentira:
 *
 *   1. a SESSÃO — apagam-se as outras, fica só esta;
 *   2. o SEGREDO do código QR — sobe a versão, e todos os códigos derivados da
 *      anterior deixam de bater certo;
 *   3. o CÓDIGO DO PASSE na carteira do telemóvel — e este é o que quase
 *      escapou. O `W1.<codigo>` não leva assinatura nenhuma: o próprio código
 *      É a credencial, e o `carimbar()` nem chega a olhar para a versão da
 *      chave nesse caminho. Sem lhe mexer, o passe que ficou no telemóvel
 *      perdido continuava a carimbar para sempre, com o segredo revogado e a
 *      sessão apagada — exactamente o cenário que esta rota diz resolver.
 *
 * O preço do ponto 3 é que o passe TAMBÉM morre no aparelho que ficou, e isso
 * diz-se na resposta (`passesRevogados`) para a app poder avisar em vez de o
 * deixar falhar ao balcão. Voltar a juntar o cartão à carteira cunha um código
 * novo; é um gesto, e é muito menos mau do que a alternativa.
 */
rota('POST', '/v1/cliente/sair-dos-outros', async (env, pedido) => {
  const s = await lerSessao(env, pedido);
  if (!s || s.tipo !== 'cliente') throw new Falha('Sessão inválida', { estado: 401 });
  const clienteId = s.id;

  /* OS AVISOS DOS OUTROS APARELHOS TÊM DE MORRER TAMBÉM, e não morriam.

     Esta rota subia o `chave_versao`, apagava as sessões e matava os passes —
     e não tocava em `subscricoes`. O `avisarDoPremio` procura por `cliente_id`
     e não precisa de sessão nenhuma para mandar: o telemóvel perdido continuava
     a receber «Café Central — um café grátis» no ecrã bloqueado, indefinidamente,
     depois de a pessoa ter carregado no botão que existe precisamente para o
     calar. E o aviso diz o nome do café e o prémio: é a rotina de quem o perdeu,
     escrita num ecrã que não precisa de desbloquear.

     QUAL FICA. Uma subscrição de push não traz sessão, por isso o servidor não
     consegue saber qual delas é a deste aparelho — é a app que a sabe, e manda-a.
     Sem ela caem todas, incluindo a deste telemóvel: é o lado seguro do engano.
     Uma app em cache antiga que não mande nada perde os avisos aqui e volta a
     ligá-los no perfil; perder um aviso é uma chatice, deixar um telemóvel
     roubado a receber a vida de alguém não é. */
  let manter = '';
  try {
    const corpo = await corpoJSON(pedido);
    if (typeof corpo.manterAviso === 'string') manter = corpo.manterAviso;
  } catch { /* sem corpo: caem todas */ }

  const comPasse = (await env.DB.prepare(
    'SELECT id FROM cartoes WHERE cliente_id = ? AND wallet_codigo IS NOT NULL'
  ).bind(clienteId).all()).results;

  /* Os passes da Google morrem na Google, senão ficava um rectângulo com saldo
     velho na carteira de quem quer que fosse. Falhar aqui não trava o resto —
     o código já deixou de valer do lado de cá, que é o que impede o carimbo, e
     o reconciliador da madrugada volta a tentar. O tecto de 50 subpedidos por
     invocação é real, por isso só vão os que têm passe da Google mesmo. */
  if (walletLigada(env)) {
    const naGoogle = (await env.DB.prepare(
      'SELECT id FROM cartoes WHERE cliente_id = ? AND wallet_em IS NOT NULL LIMIT 20'
    ).bind(clienteId).all()).results;
    for (const c of naGoogle) {
      try {
        await googlePedir(env, `/loyaltyObject/${env.GOOGLE_EMISSOR}.${c.id}`, {
          metodo: 'PATCH', corpo: { state: 'EXPIRED' },
        });
      } catch (erro) {
        console.error('wallet: não deu para expirar o passe ao revogar', c.id, String(erro));
      }
    }
  }

  await env.DB.batch([
    env.DB.prepare('UPDATE clientes SET chave_versao = chave_versao + 1 WHERE id = ?')
      .bind(clienteId),
    env.DB.prepare('DELETE FROM sessoes WHERE sujeito = ? AND resumo != ?')
      .bind(`cliente:${clienteId}`, s.resumo),
    /* Os três de uma vez: sem o `wallet_em`/`apple_em` a NULL, o cartão dizia
       à app que já tinha passe e ela não oferecia voltar a juntá-lo.

       E NÃO É A MESMA COISA PARA AS DUAS CARTEIRAS. Do lado da Google o
       objecto é expirado lá fora, umas linhas acima, e o passe morre mesmo.
       Do lado da Apple isto só apaga o que está DESTE lado: o `.pkpass` que
       está no iPhone não tem serviço web nosso, fica lá com o saldo velho, e o
       que o mata é o `wallet_codigo` deixar de existir — o código de barras
       passa a dar «Este passe já não vale» ao balcão. Chega para revogar, não
       chega para limpar o ecrã de ninguém, e é por isso que o painel da app
       avisa que o passe tem de ser apagado à mão. */
    env.DB.prepare(
      `UPDATE cartoes SET wallet_codigo = NULL, wallet_em = NULL, apple_em = NULL
        WHERE cliente_id = ?`
    ).bind(clienteId),
    /* Vai no MESMO batch que as sessões, de propósito: são a mesma decisão. Um
       apagar que corresse à parte podia falhar sozinho e deixar a conta com as
       sessões fechadas e os avisos abertos — que é exactamente o estado que
       esta rota existe para não deixar acontecer. */
    manter
      ? env.DB.prepare('DELETE FROM subscricoes WHERE cliente_id = ? AND endereco != ?')
        .bind(clienteId, manter)
      : env.DB.prepare('DELETE FROM subscricoes WHERE cliente_id = ?').bind(clienteId),
  ]);

  const c = await env.DB.prepare('SELECT chave_versao FROM clientes WHERE id = ?')
    .bind(clienteId).first();

  /* O segredo NOVO vai na resposta: sem ele, o aparelho que mandou expulsar os
     outros expulsava-se a si próprio — ficava com o segredo da versão anterior
     e o seu próprio código deixava de carimbar. */
  return {
    segredo: await derivarSegredo(env, clienteId, c.chave_versao),
    passesRevogados: comPasse.length,
    /* Para a app poder dizer a verdade no aviso: se os avisos deste aparelho
       também caíram, a frase tem de o dizer em vez de prometer que «este
       continua». Campo novo — esta API acrescenta. */
    avisosMantidos: Boolean(manter),
    horaDoServidor: agora(),
  };
});

/**
 * Juntar duas contas.
 *
 * A PROVA SÃO DUAS SESSÕES, e não é preciso inventar credencial nenhuma: uma
 * sessão já é a credencial de uma conta, em todas as outras rotas. Quem
 * consegue apresentar as duas provou as duas.
 *
 *   authorization: Bearer <sessão da conta que FICA>
 *   corpo:         { "sessaoOrigem": "<testemunho da conta que SAI>" }
 *
 * O MODO NÃO SE PEDE, DEDUZ-SE, e isso não é comodidade: deixar quem chama
 * escolher entre 'provada' e 'absorcao' era deixá-lo escolher se as sessões da
 * outra conta sobrevivem. Uma conta com identidades é uma conta em que alguém
 * entrou — as sessões dela reapontam-se. Uma conta anónima, dessas que a app
 * cria ao abrir pela primeira vez, é uma absorção e as sessões morrem.
 *
 * O caminho real: a pessoa anda há meses com a app e tem cartões; toca no
 * perfil, entra com o email, e a conta que a app tinha localmente não é a mesma
 * que a do email. Sem isto, os cartões do telemóvel ficavam para trás.
 */
rota('POST', '/v1/cliente/fundir', async (env, pedido) => {
  const destino = await exigirCliente(env, pedido);
  const { sessaoOrigem } = await corpoJSON(pedido);
  if (!sessaoOrigem || typeof sessaoOrigem !== 'string') {
    throw new Falha('Falta a sessão da conta a juntar.', { estado: 400, codigo: 'fusao-sem-origem' });
  }

  const linha = await env.DB.prepare(
    'SELECT sujeito, expira_em FROM sessoes WHERE resumo = ?'
  ).bind(await resumo(sessaoOrigem)).first();
  if (!linha || expirado(linha.expira_em)) {
    throw new Falha('Essa sessão já não vale.', { estado: 401, codigo: 'fusao-origem-invalida' });
  }
  const [tipo, origem] = linha.sujeito.split(':');
  if (tipo !== 'cliente') {
    throw new Falha('Essa sessão não é de um cliente.', { estado: 400, codigo: 'fusao-origem-tipo' });
  }
  if (origem === destino) {
    throw new Falha('Já é a mesma conta.', { estado: 400, codigo: 'fusao-mesma' });
  }

  const temIdentidade = await env.DB.prepare(
    'SELECT 1 AS e FROM identidades WHERE cliente_id = ? LIMIT 1').bind(origem).first();
  const modo = temIdentidade ? 'provada' : 'absorcao';

  const resultado = await fundirContas(env, { origem, destino, modo });
  return { ...resultado, modo, horaDoServidor: agora() };
});

rota('GET', '/v1/cliente/cartoes', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  const linhas = (await env.DB.prepare(
    'SELECT * FROM cartoes WHERE cliente_id = ?'
  ).bind(clienteId).all()).results;
  const cartoes = (await moldarCartoes(env, linhas)).filter(Boolean);
  cartoes.sort((a, b) => (b.porResgatar - a.porResgatar)
    || (new Date(b.ultimoEm || b.aderiuEm) - new Date(a.ultimoEm || a.aderiuEm)));
  return cartoes;
});

rota('GET', /^\/v1\/cliente\/cartoes\/([\w-]+)$/, async (env, pedido, [cartaoId]) => {
  const clienteId = await exigirCliente(env, pedido);
  const c = await env.DB.prepare(
    'SELECT * FROM cartoes WHERE id = ? AND cliente_id = ?'
  ).bind(cartaoId, clienteId).first();
  if (!c) throw new Falha('Cartão não encontrado', { estado: 404 });
  const movimentos = (await env.DB.prepare(
    'SELECT id, tipo, quantidade, nota, em FROM movimentos WHERE cartao_id = ? ORDER BY em DESC LIMIT 60'
  ).bind(cartaoId).all()).results;
  return { ...(await moldarCartao(env, c)), movimentos };
});

rota('POST', '/v1/cliente/aderir', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  const { programaId, amigo } = await corpoJSON(pedido);
  exigirTexto(programaId, 'programaId');
  const p = await programaCompleto(env, programaId);
  if (!p || !p.ativo) throw new Falha('Programa não encontrado', { estado: 404 });

  const ja = await env.DB.prepare(
    'SELECT * FROM cartoes WHERE cliente_id = ? AND programa_id = ?'
  ).bind(clienteId, programaId).first();
  /* QUEM JÁ TEM O CARTÃO NÃO VEM DE UM CONVITE. Aderir outra vez pelo link de
     um amigo seria a forma mais simples de o vigarizar: mando-lhe o meu link,
     ele abre-o, e eu ganho carimbos por um cliente que o café já tinha. */
  if (ja) return moldarCartao(env, ja);

  /* --- veio por um convite? ---------------------------------------------
     Regista-se ANTES de o cartão existir? Não: o cartão primeiro, porque é ele
     que a pessoa veio buscar, e o convite é um extra que não pode fazer a
     adesão falhar. */
  let convidador = null;
  if (amigo && (p.amigo_convidador || p.amigo_convidado)) {
    const quem = await lerConviteDeAmigo(env, amigo, programaId);
    /* NINGUÉM SE CONVIDA A SI PRÓPRIO. Dois telemóveis e a mesma conta é o
       primeiro sítio onde alguém vai bater. */
    if (quem && quem.id !== clienteId) convidador = quem.id;
  }

  const cartaoId = id();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO cartoes (id, cliente_id, programa_id, negocio_id, aderiu_em) VALUES (?, ?, ?, ?, ?)'
    ).bind(cartaoId, clienteId, programaId, p.negocio_id, agora()),
    env.DB.prepare(
      'INSERT INTO movimentos (id, cartao_id, tipo, em) VALUES (?, ?, ?, ?)'
    ).bind(id(), cartaoId, 'adesao', agora()),
  ]);
  /* O CONVITE FICA A DEVER, e paga-se no primeiro carimbo. O `INSERT` pode
     falhar pelo índice único — este cliente já tinha sido convidado para este
     programa —, e isso não é um erro: é a defesa a funcionar. Apanha-se e
     segue-se, que o cartão é o que interessa. */
  if (convidador) {
    try {
      await env.DB.prepare(
        `INSERT INTO amigos (id, programa_id, convidador, convidado, criado_em)
         VALUES (?, ?, ?, ?, ?)`
      ).bind(id(), programaId, convidador, clienteId, agora()).run();
    } catch (erro) {
      console.error('amigos: convite não registado', String(erro));
    }
  }

  const c = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartaoId).first();
  return moldarCartao(env, c);
});

/**
 * O meu convite para um programa.
 *
 * Só existe se o programa oferecer alguma coisa: um botão «traz um amigo» num
 * café que não dá nada por isso é uma promessa que ninguém fez.
 */
rota('POST', '/v1/cliente/amigo', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  const { programaId } = await corpoJSON(pedido);
  exigirTexto(programaId, 'programaId');
  const p = await programaCompleto(env, programaId);
  if (!p || !p.ativo) throw new Falha('Programa não encontrado', { estado: 404 });
  if (!p.amigo_convidador && !p.amigo_convidado) {
    throw new Falha('Este cartão não tem «traz um amigo».',
      { estado: 404, codigo: 'amigo-desligado' });
  }
  /* E só a quem TEM o cartão: convidar para um sítio onde não se vai é
     publicidade, e não uma recomendação. */
  const cartao = await env.DB.prepare(
    'SELECT id FROM cartoes WHERE cliente_id = ? AND programa_id = ?'
  ).bind(clienteId, programaId).first();
  if (!cartao) {
    throw new Falha('Junta o cartão primeiro.', { estado: 403, codigo: 'sem-cartao' });
  }

  const cliente = await env.DB.prepare(
    'SELECT publico FROM clientes WHERE id = ?').bind(clienteId).first();
  const premiados = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM amigos
      WHERE convidador = ? AND programa_id = ? AND premiado_em IS NOT NULL`
  ).bind(clienteId, programaId).first()).n;
  const aCaminho = (await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM amigos
      WHERE convidador = ? AND programa_id = ? AND premiado_em IS NULL`
  ).bind(clienteId, programaId).first()).n;

  return {
    codigo: await codigoDeAmigo(env, cliente.publico, programaId),
    slug: p.negocio_slug,
    convidador: p.amigo_convidador,
    convidado: p.amigo_convidado,
    max: p.amigo_max,
    premiados,
    aCaminho,
  };
});

rota('GET', '/v1/descobrir', async (env) => {
  /* Com tecto. Isto é uma consulta por negócio e outra por programa, e corre a
     cada abertura da app — sem `LIMIT`, o custo da lista pública cresce com o
     que os negócios lá puserem, e as «linhas lidas» do D1 gratuito acabam aos
     cinco milhões por dia. Quando houver mais de duzentos negócios, isto passa
     a ser procura e mapa, não uma lista; o tecto é o aviso de que chegou essa
     hora. */
  /* Os de DEMONSTRAÇÃO ficam de fora. Existe um café em produção que não
     existe na rua — é o banco de provas, e provar um cartão de fidelidade a
     sério exige uma loja com clientes, carimbos e prémios. Só que ele estava
     aqui, ao lado de uma barbearia que existe, e alguém podia juntar o cartão
     de uma porta que não abre. O endereço próprio (`/v1/p/<slug>`) continua a
     responder: o que se tira é a publicidade a quem não foi convidado. */
  /* As colunas UMA A UMA, e não `SELECT *`. O `logotipo` é um PNG em base64 —
     dezenas de kilobytes por negócio — e esta consulta só precisa de saber se
     ele EXISTE. Com `*`, cada abertura da app puxava os logótipos todos da
     base para os deitar fora à linha seguinte. */
  const negocios = (await env.DB.prepare(
    `SELECT id, slug, nome, cor, categoria, localidade, morada, telefone,
            latitude, longitude, geo_fonte,
            logotipo_em, (logotipo IS NOT NULL) AS tem_logotipo
       FROM negocios
      WHERE estado = 'ativo' AND demonstracao = 0
      ORDER BY nome LIMIT ?`
  ).bind(DESCOBRIR_MAX).all()).results;
  const saida = [];
  for (const n of negocios) {
    const programas = (await env.DB.prepare(
      'SELECT * FROM programas WHERE negocio_id = ? AND ativo = 1'
    ).bind(n.id).all()).results;
    if (!programas.length) continue;
    const comMarcos = [];
    for (const p of programas) {
      const marcos = p.tipo === 'pontos'
        ? (await env.DB.prepare(
            'SELECT pontos, premio FROM marcos WHERE programa_id = ? ORDER BY pontos'
          ).bind(p.id).all()).results
        : null;
      comMarcos.push(moldarPrograma({ ...p, marcos }));
    }
    saida.push({
      id: n.id, slug: n.slug, nome: n.nome, cor: n.cor, categoria: n.categoria,
      localidade: n.localidade, morada: n.morada, telefone: n.telefone,
      /* Onde fica, para o mapa. Vai `null` quando o negócio ainda não tem
         ponto — e nunca (0, 0), que seria pô-lo no Golfo da Guiné. A `fonte`
         vai junto porque o mapa desenha DIFERENTE um ponto ao metro e o
         centróide de um concelho inteiro. */
      latitude: n.latitude ?? null, longitude: n.longitude ?? null,
      geoFonte: n.geo_fonte || null,
      /* Só se HÁ, e a data — nunca a imagem. Esta lista é pedida a cada
         abertura da app por toda a gente, e mandar os logótipos todos lá
         dentro seria mandar megabytes para desenhar uns quadrados. */
      logotipo: Boolean(n.tem_logotipo), logotipoEm: n.logotipo_em || null,
      programas: comMarcos,
    });
  }
  return saida;
});

/**
 * Pedir um código por email.
 *
 * Faz duas coisas que parecem uma só, e é aqui que estava o defeito mais
 * caro do produto: guardar a conta e recuperá-la noutro telemóvel.
 *
 * Antes, o código era emitido sempre contra o cliente da sessão em curso.
 * Num telemóvel novo a app já tinha registado uma conta vazia, por isso o
 * código apontava para essa — e a pessoa confirmava, ouvia «os cartões já
 * não se perdem», e ficava com a carteira vazia. Estava prometido no ecrã
 * de boas-vindas, no perfil e no próprio email; não funcionava em lado
 * nenhum.
 *
 * Agora decide-se pelo que já existe: se a morada pertence a uma conta
 * confirmada que não é esta, o código aponta para ESSA. É uma recuperação.
 * Se não pertence a ninguém, aponta para a conta actual e é uma adesão.
 *
 * O email só passa a constar da conta depois de confirmado. Guardá-lo antes
 * punha na base de dados uma morada que ninguém provou ser sua — e a
 * exportação de dados chamava-lhe «o teu email».
 */
rota('POST', '/v1/cliente/email', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  const { email } = await corpoJSON(pedido);
  const correio = normalizarEmail(email);
  if (!EMAIL_VALIDO.test(correio)) throw new Falha('Email inválido');

  const trava = await podeEnviar(env, correio);
  if (trava) throw new Falha(trava, { estado: 429, codigo: 'demasiados' });

  /* A pergunta é «de quem é esta identidade», e faz-se à tabela que a guarda.
     O `clientes.email` continua a ser escrito, mas já não é ele que decide. */
  const dono = await donoDaIdentidade(env, 'email', correio);
  const recuperar = Boolean(dono) && dono !== clienteId;
  const alvo = `cliente:${recuperar ? dono : clienteId}`;

  const codigo = await emitirCodigo(env, { email: correio, alvo });
  const r = await enviarEmail(env, {
    para: correio,
    ...emailCodigoCliente({ codigo, minutos: ENTRADA_MINUTOS }),
  });
  /* Devolve-se a verdade: é o email do próprio, e mandá-lo esperar por um
     código que nunca vai chegar é a pior coisa que se lhe pode fazer.
     `recuperar` deixa a app avisar que os cartões vêm de outro aparelho. */
  return { enviado: r.enviado, motivo: r.enviado ? null : r.motivo, recuperar };
});

rota('POST', '/v1/cliente/entrar', async (env, pedido) => {
  const { email, codigo } = await corpoJSON(pedido);
  const linha = await consumirEntrada(env, email, codigo);
  const [tipo, valor] = linha.alvo.split(':');
  if (tipo !== 'cliente') throw new Falha('Código inválido', { estado: 400 });
  /* QUEM É O DONO DESTA MORADA, AGORA — e não quando o código foi pedido.
     Entre pedir e escrever passam até quinze minutos, e nesses minutos a
     morada pode ter ganho dono noutro aparelho. Resolver isto só à emissão
     deixava ficar DUAS contas com a mesma morada verificada, e a recuperação
     faz `LIMIT 1`: escolhia uma ao calhas e os cartões da outra deixavam de
     ter por onde ser alcançados. Não é roubo — as duas pessoas provaram a
     mesma caixa — é perda de dados em silêncio.

     O caminho real: pôr o email no telemóvel e não escrever o código; pôr o
     mesmo noutro aparelho e concluir; voltar ao primeiro e usar o código
     antigo, que ainda vale. Está provado na bateria.

     A regra passa a ser uma só, e vale para os dois casos: quem prova a caixa
     de correio entra na conta que já é dela; se não houver nenhuma, a conta
     que pediu fica com ela. */
  let dono = await donoDaIdentidade(env, 'email', linha.email);
  let alvoFinal = dono || valor;

  /* É aqui que a morada passa a ser da conta, e não no pedido do código:
     agora está provado que quem a escreveu a lê. O índice único sobre
     `(provedor, sujeito)` é a rede por baixo disto — se duas verificações se
     cruzarem no mesmo instante, a segunda falha em vez de duplicar.

     E FALHAR AQUI NÃO É UM ERRO INTERNO. Quem perdeu a corrida por
     microssegundos provou a mesma caixa de correio que o outro: a resposta
     certa é entrar na conta que entretanto ficou com ela, não um 500. Antes,
     a rede era o índice parcial sobre `clientes.email` e ninguém a apanhava —
     a pessoa via «Erro interno» e não tinha por onde voltar. */
  if (!dono) {
    try {
      await env.DB.batch(instrucoesDeIdentidade(env, {
        clienteId: alvoFinal, provedor: 'email', sujeito: linha.email, email: linha.email,
      }));
    } catch (erro) {
      if (!/UNIQUE|constraint/i.test(String(erro))) throw erro;
      dono = await donoDaIdentidade(env, 'email', linha.email);
      if (!dono) throw erro;
      alvoFinal = dono;
    }
  }
  await marcarIdentidadeUsada(env, 'email', linha.email);

  const cliente = await env.DB.prepare('SELECT * FROM clientes WHERE id = ?').bind(alvoFinal).first();
  if (!cliente) throw new Falha('Conta não encontrada', { estado: 404 });

  return {
    cliente: { id: cliente.id, publico: cliente.publico, email: linha.email, criadoEm: cliente.criado_em },
    segredo: await derivarSegredo(env, cliente.id, cliente.chave_versao),
    sessao: await criarSessao(env, `cliente:${cliente.id}`),
    horaDoServidor: agora(),
    /* Diz-se a verdade: os cartões que vai ver podem não ser os que tinha
       neste aparelho. A app já sabe avisar. */
    recuperada: Boolean(dono) && dono !== valor,
  };
});

/* =========================================================================
   Entrar com a Google

   POR REDIRECCIONAMENTO PURO, e nunca pelo One Tap. O One Tap escreve um
   cookie `g_state` no nosso domínio e carrega um script de
   `accounts.google.com` antes de qualquer clique — partia à letra as duas
   frases publicadas na página de privacidade («não instala cookies», «não
   carrega scripts de terceiros») e trazia de volta o aviso de cookies que este
   produto não tem. Aqui não se carrega nada de lá: navega-se para lá e volta-se.

   SÃO TRÊS ROTAS, e a terceira é a que faz isto funcionar num iPhone. Numa app
   posta no ecrã principal, tocar num endereço de fora abre o browser DE DENTRO,
   que é outro armazenamento: a app fica de um lado e a volta da Google aterra
   do outro, e nada do que ela escrevesse lá chegava cá. Por isso:

     1. `comecar` — a app pede a ida e fica com um BILHETE;
     2. `volta`   — a app, de volta a `/app/?code=...`, entrega o código. Não
                    recebe credencial nenhuma em troca;
     3. `estado`  — a app apresenta o bilhete. É aqui, e só aqui, que a sessão
                    é cunhada.

   A VOLTA ATERRA DENTRO DE `/app/`, que é o âmbito declarado no manifesto, e
   isso não é gosto: para fora do âmbito, um iPhone abre o Safari e não volta
   mais à app instalada — e é a app que tem o bilhete.

   QUEM DECIDE DE QUEM É A CONTA É O `sub`, e nunca a morada. A morada que a
   Google mostra é pista — e nem sempre: só conta se vier com `email_verified`.
   A regra de ligação é a mesma das outras portas e não se estende nem se
   abranda: uma identidade nova só se cola a uma conta que JÁ provou ser
   daquela pessoa na mesma sessão. Sem prova, nasce conta nova. É a mitigação
   do pré-registo (Sudhodanan e Paverd, USENIX Security 2022).
   ========================================================================= */

const LIGACAO_MINUTOS = 10;        // quanto tempo uma ida à Google vale
const RECOLHA_MINUTOS = 2;         // ... e a app, para levantar o que ficou lá
const RECOLHAS_MAX = 1;            // o bilhete serve uma vez, como tudo por aqui
const LIGACOES_HORA = 30;          // idas por origem, por hora

/* O mesmo par de sempre: enquanto estes dois não existirem, a rota responde
   404 e a app não mostra o botão. É o que permite ter isto publicado e provado
   antes de haver conta na Google — e o que faz um botão nunca falhar só quando
   é tocado. */
const googleEntrarPronta = (env) => Boolean(env.GOOGLE_ENTRAR_ID && env.GOOGLE_ENTRAR_SEGREDO);

/* Duas casas diferentes, e é por isso que são duas variáveis: o ecrã de
   consentimento vive em `accounts.google.com` e a troca do código em
   `oauth2.googleapis.com`. Nos testes as duas apontam para a Google de
   mentira. */
const googleContas = (env) => env.GOOGLE_CONTAS_BASE || 'https://accounts.google.com';

/* O que a Google aceita como emissor do `id_token`. São duas formas da mesma
   coisa e ela usa as duas conforme o caminho — recusar uma delas era recusar
   entradas legítimas sem se perceber porquê. */
const EMISSORES_GOOGLE = ['https://accounts.google.com', 'accounts.google.com'];

/**
 * Para onde a Google devolve o browser.
 *
 * Sai da ORIGEM do pedido e não de uma variável, para a app poder correr em
 * `carimbodigital.pt`, em `www.` e em `localhost` sem três configurações — e
 * é validada contra a mesma lista que o CORS. Quem manda uma origem que não
 * está lá leva 403 aqui, antes de existir linha nenhuma na base de dados.
 *
 * Há uma segunda rede, e é do lado de lá: a Google só aceita redireccionar
 * para os endereços registados na consola. Mesmo que esta guarda falhasse, um
 * endereço estranho morria lá.
 */
function redireccaoDeVolta(env, pedido) {
  const origem = pedido.headers.get('origin') || '';
  if (!origem) throw new Falha('Falta a origem do pedido.', { estado: 400, codigo: 'sem-origem' });
  const lista = origensPermitidas(env);
  let u;
  try { u = new URL(origem); } catch { throw new Falha('Origem inválida.', { estado: 400 }); }
  const local = u.hostname === 'localhost' || u.hostname === '127.0.0.1';

  /* AQUI A LISTA VAZIA RECUSA, e é o contrário do que ela faz no CORS.
     Lá, «vazia = aceita tudo» é uma comodidade de quem desenvolve e a defesa
     verdadeira é outra (os testemunhos vão no cabeçalho, não em cookies). Aqui
     não: a origem vira um endereço para onde a Google devolve o browser, e
     herdar aquela regra era deixar um ambiente mal configurado escrever o
     endereço de quem pedisse. Sem lista, só o localhost. */
  if (lista.length ? !lista.includes(origem) : !local) {
    throw new Falha('Origem não autorizada.', { estado: 403, codigo: 'origem-recusada' });
  }
  if (u.protocol !== 'https:' && !local) {
    throw new Falha('Origem inválida.', { estado: 400, codigo: 'origem-recusada' });
  }
  /* DENTRO DO ÂMBITO DA APP, e não numa página do site. O manifesto declara
     `scope: "/app/"`; num iPhone com a app no ecrã principal, uma volta para
     fora desse âmbito abre o Safari e nunca mais regressa à app — e é a app
     que tem o bilhete. Aterrar em `/app/` é o que faz o iOS devolver o
     controlo a quem começou. */
  return `${u.origin}/app/`;
}

/** Troca o código de autorização por um `id_token`. Server-to-server, com o segredo. */
async function trocarCodigoGoogle(env, { codigo, redireccao, verificador }) {
  const corpo = new URLSearchParams({
    code: codigo,
    client_id: env.GOOGLE_ENTRAR_ID,
    client_secret: env.GOOGLE_ENTRAR_SEGREDO,
    redirect_uri: redireccao,
    grant_type: 'authorization_code',
    code_verifier: verificador,
  });
  let r;
  try {
    r = await fetch(`${googleOAuth(env)}/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: corpo.toString(),
      /* Um pedido sem prazo prende a invocação até o Worker ser morto, e quem
         está do outro lado fica a olhar para uma roda a girar. */
      ...(typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? { signal: AbortSignal.timeout(8000) } : {}),
    });
  } catch (erro) {
    console.error('google entrar: a troca do código nem chegou a sair', String(erro));
    throw new Falha('A Google não respondeu. Tenta outra vez.',
      { estado: 502, codigo: 'porta-falhou' });
  }
  if (!r.ok) {
    /* O ESTADO VAI PARA O REGISTO, o corpo não. Uma mensagem de erro de
       terceiros pode trazer lá dentro o que lhe apetecer, e isto é escrito num
       log que alguém lê. */
    console.error('google entrar: a Google recusou a troca', r.status);
    throw new Falha('A Google não confirmou a entrada.', { estado: 502, codigo: 'porta-falhou' });
  }
  let dados;
  try { dados = await r.json(); } catch { dados = null; }
  if (!dados || !dados.id_token) {
    throw new Falha('A Google não confirmou a entrada.', { estado: 502, codigo: 'porta-falhou' });
  }
  return String(dados.id_token);
}

/**
 * Abre o `id_token` e confere-o.
 *
 * NÃO SE VERIFICA A ASSINATURA, e é uma decisão e não um esquecimento: este
 * token não vem pelo browser — vem por TLS, directamente do endereço de troca
 * da Google, num pedido que leva o nosso segredo de cliente. O OpenID Connect
 * Core §3.1.3.7 diz à letra que nesse caso a validação do servidor de TLS pode
 * substituir a da assinatura. Ir buscar a chave pública era mais um subpedido
 * por entrada (e o tecto é de 50 por invocação) para provar o que o TLS já
 * provou.
 *
 * O que se confere é o que o TLS NÃO prova: que o token é para nós (`aud`),
 * que não caducou (`exp`), e que responde a ESTA ida e não a outra (`nonce`).
 * Sem o `nonce`, um token legítimo obtido noutro sítio servia aqui.
 */
function abrirIdToken(env, provedor, texto, nonce) {
  const apple = provedor === 'apple';
  const emissores = apple ? ['https://appleid.apple.com'] : EMISSORES_GOOGLE;
  const destinatario = apple ? env.APPLE_ENTRAR_SERVICO : env.GOOGLE_ENTRAR_ID;
  const partes = String(texto || '').split('.');
  if (partes.length !== 3) {
    throw new Falha('A Google respondeu de forma estranha.', { estado: 502, codigo: 'porta-falhou' });
  }
  let corpo;
  try {
    corpo = JSON.parse(new TextDecoder().decode(deBase64url(partes[1])));
  } catch {
    throw new Falha('A Google respondeu de forma estranha.', { estado: 502, codigo: 'porta-falhou' });
  }

  const mau = (porque) => {
    console.error(`${provedor} entrar: id_token recusado —`, porque);
    return new Falha('A Google não confirmou a entrada.', { estado: 502, codigo: 'porta-falhou' });
  };
  if (!emissores.includes(String(corpo.iss))) throw mau('emissor');
  if (String(corpo.aud) !== String(destinatario)) throw mau('destinatário');
  if (!corpo.sub || typeof corpo.sub !== 'string') throw mau('sem sujeito');
  /* Na dúvida, caducado — a mesma direcção de `expirado`. */
  const exp = Number(corpo.exp);
  if (!Number.isFinite(exp) || exp * 1000 < Date.now()) throw mau('prazo');
  if (!corpo.nonce || !iguais(String(corpo.nonce), String(nonce))) throw mau('nonce');
  return corpo;
}

/**
 * Uma conta nova, anónima, como a que a app cria ao abrir pela primeira vez —
 * mas em INSTRUÇÕES, para poder ir no mesmo `batch` que a identidade.
 *
 * E isso não é arrumação: se a conta fosse escrita primeiro e a identidade
 * falhasse a seguir no índice único — duas entradas com o mesmo `sub` ao mesmo
 * tempo, que é a mesma pessoa em dois aparelhos — ficava uma conta órfã, sem
 * identidade e sem cartões, para sempre. No mesmo `batch`, o índice único
 * deita as duas fora e não sobra nada.
 */
async function instrucoesDeClienteNovo(env) {
  const clienteId = id();
  let publico, tentativas = 0;
  for (;;) {
    publico = publicoNovo();
    const existe = await env.DB.prepare('SELECT 1 FROM clientes WHERE publico = ?').bind(publico).first();
    if (!existe) break;
    if (++tentativas > 12) throw new Falha('Não foi possível criar o cartão', { estado: 503 });
  }
  return {
    id: clienteId,
    publico,
    instrucao: env.DB.prepare(
      'INSERT INTO clientes (id, publico, criado_em, visto_em) VALUES (?, ?, ?, ?)'
    ).bind(clienteId, publico, agora(), agora()),
  };
}

/**
 * De quem é esta entrada — a regra de ligação, escrita uma vez para as quatro
 * portas.
 *
 * A SESSÃO DE QUEM PEDIU VOLTA A SER PROCURADA AGORA, e não se acredita no que
 * ela era há dez minutos: entre a ida e a volta a pessoa pode ter mandado
 * expulsar os aparelhos, ou a conta pode ter entrado numa fusão e virado
 * sombra. Se já não valer, é como se não houvesse — e sem prova nasce conta
 * nova, que é o lado certo para falhar.
 */
async function resolverEntrada(env, { provedor, sujeito, email, sessaoResumo }) {
  let dono = await donoDaIdentidade(env, provedor, sujeito);

  let pedinte = null;
  if (sessaoResumo) {
    const s = await env.DB.prepare(
      'SELECT sujeito, expira_em FROM sessoes WHERE resumo = ?'
    ).bind(sessaoResumo).first();
    if (s && !expirado(s.expira_em)) {
      const [tipo, valor] = String(s.sujeito).split(':');
      /* Uma sessão de BALCÃO não é uma conta de cliente, e uma identidade de
         cliente nunca se cola a um operador. */
      if (tipo === 'cliente') {
        const sombra = await env.DB.prepare(
          'SELECT 1 AS e FROM clientes WHERE id = ? AND fundida_em IS NOT NULL'
        ).bind(valor).first();
        if (!sombra) pedinte = valor;
      }
    }
  }

  /* Já conhecemos esta identidade: entra-se na conta dela, ponto. Se quem
     pediu estava noutra conta, a app fica a saber — e é ela que oferece juntar
     as duas, com a sessão antiga como prova do outro lado. Aqui não se junta
     nada sozinho: juntar não tem volta. */
  if (dono) {
    await marcarIdentidadeUsada(env, provedor, sujeito);
    return { clienteId: dono, recuperada: Boolean(pedinte) && pedinte !== dono, pista: null };
  }

  /* Identidade nova. Cola-se à conta que pediu, se ela provou ser dela — que é
     o que uma sessão é. Sem prova, nasce conta. */
  const nova = pedinte ? null : await instrucoesDeClienteNovo(env);
  const alvo = pedinte || nova.id;
  const instrucoes = instrucoesDeIdentidade(env, { clienteId: alvo, provedor, sujeito, email });
  try {
    await env.DB.batch(nova ? [nova.instrucao, ...instrucoes] : instrucoes);
  } catch (erro) {
    if (!/UNIQUE|constraint/i.test(String(erro))) throw erro;
    /* Perdeu a corrida por microssegundos contra outra entrada com o mesmo
       `sub` — ou seja, contra a mesma pessoa, noutro aparelho. A resposta
       certa é entrar na conta que ficou com a identidade, e não um 500. É a
       mesma lição do `/v1/cliente/entrar`. O `batch` é uma transacção: a conta
       nova, se a havia, não chegou a existir. */
    dono = await donoDaIdentidade(env, provedor, sujeito);
    if (!dono) throw erro;
    return { clienteId: dono, recuperada: Boolean(pedinte) && pedinte !== dono, pista: null };
  }

  /* UMA PISTA, E NÃO UMA FUSÃO. Quem já tinha conta pelo email e entra pela
     Google com a MESMA morada cai numa conta nova e vazia — e isso está certo,
     porque a morada é pista e não chave (é a mitigação do pré-registo). Mas o
     que a pessoa vê é «perdi os cartões», e nós sabemos o suficiente para lhe
     dizer o que se passa. Diz-se; não se junta. Juntar continua a exigir a
     prova dos dois lados, que é o que a app vai pedir a seguir.

     Não há aqui fuga nenhuma: a morada acabou de ser provada pela Google, a
     quem ela pertence. */
  let pista = null;
  if (email) {
    const outra = await env.DB.prepare(
      `SELECT 1 AS e FROM identidades
        WHERE provedor = 'email' AND sujeito = ? AND cliente_id != ? LIMIT 1`
    ).bind(email, alvo).first();
    if (outra) pista = 'mesma-morada';
  }
  return { clienteId: alvo, recuperada: false, pista };
}

/** Deixa escrito na ligação porque é que não deu, para a app poder dizê-lo. */
async function anotarErroDaLigacao(env, ligacaoId, codigo) {
  try {
    /* NUNCA POR CIMA DE UMA CONCLUÍDA. Sem esta condição, uma segunda volta a
       falhar escrevia «erro» sobre uma entrada que tinha corrido bem, e a
       pessoa via uma falha depois de ter entrado. */
    await env.DB.prepare(
      'UPDATE ligacoes SET erro = ?, concluida_em = ? WHERE id = ? AND concluida_em IS NULL'
    ).bind(codigo, agora(), ligacaoId).run();
  } catch (erro) {
    console.error('ligacoes: não deu para anotar o erro', String(erro));
  }
}

/**
 * Que portas de entrada é que este servidor tem abertas.
 *
 * Existe por causa de uma regra desta casa: um botão que só falha ao ser
 * tocado é pior do que um botão que não está lá. A app pergunta isto quando
 * abre o painel de guardar a conta, e desenha o que existe.
 */
rota('GET', '/v1/portas', async (env) => ({
  email: Boolean(env.MAIL_TOKEN),
  google: googleEntrarPronta(env),
  apple: appleEntrarPronta(env),
  /* A CHAVE PÚBLICA DAS NOTIFICAÇÕES VEM DAQUI, e não da construção do site.
     Ela e a privada são duas metades da mesma chave: se a app subscrevesse com
     uma chave que o Worker não tem, o browser guardava-a e todos os envios
     levavam 403 para sempre — e do lado de cá tudo parecia bem. Uma fonte só,
     e é a que assina. `null` quando não está configurada, e então a app não
     oferece o interruptor. */
  push: env.PUSH_PUBLICA || null,
}));

/**
 * A ida. Devolve o endereço da Google e o bilhete com que a app volta a
 * perguntar.
 */
rota('POST', '/v1/cliente/google/comecar', async (env, pedido) => {
  if (!googleEntrarPronta(env)) {
    throw new Falha('A entrada pela Google não está ligada.', { estado: 404, codigo: 'google-desligada' });
  }
  /* É uma rota ABERTA que ESCREVE — a mesma família de `/registar`, e com o
     mesmo travão: sem ele, um ciclo de três linhas esgotava as escritas
     diárias do D1, que são por conta da Cloudflare e não por projecto. Conta
     à parte dos registos, com outra marca, para uma coisa não castigar a
     outra. */
  await travarPorOrigem(env, pedido, {
    marca: 'liga', tecto: LIGACOES_HORA, codigo: 'demasiadas-ligacoes',
    mensagem: 'Demasiadas tentativas de entrada daqui. Tenta daqui a uma hora.',
  });

  const redireccao = redireccaoDeVolta(env, pedido);

  /* A SESSÃO É OPCIONAL e é ela que decide tudo o que vem a seguir: com ela, a
     identidade nova cola-se a esta conta; sem ela, nasce uma. Guarda-se o
     RESUMO, para a volta poder voltar a perguntar se ainda vale. */
  const s = await lerSessao(env, pedido);
  const sessaoResumo = s && s.tipo === 'cliente' ? s.resumo : null;

  const estado = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const bilhete = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const verificador = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const desafio = base64url(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verificador)));
  const expira = new Date(Date.now() + LIGACAO_MINUTOS * 60000).toISOString();

  await env.DB.prepare(
    `INSERT INTO ligacoes
       (id, provedor, estado_resumo, bilhete_resumo, verificador, nonce,
        redireccao, sessao_resumo, criada_em, expira_em)
     VALUES (?, 'google', ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id(), await resumo(estado), await resumo(bilhete), verificador, nonce,
         redireccao, sessaoResumo, agora(), expira).run();

  const url = new URL(`${googleContas(env)}/o/oauth2/v2/auth`);
  url.searchParams.set('client_id', env.GOOGLE_ENTRAR_ID);
  url.searchParams.set('redirect_uri', redireccao);
  url.searchParams.set('response_type', 'code');
  /* SÓ ISTO. Sem `profile`: o nome e a fotografia não fazem falta a um cartão
     de carimbos, e a página de privacidade promete em seis sítios que não
     pedimos o nome. Pedir um âmbito para não o usar era gastar a promessa por
     nada — e o ecrã de consentimento lê-se em voz alta a quem lá chega.

     (O que obriga a app a passar pela verificação da Google não é isto: é um
     logótipo carregado na consola, ou um âmbito sensível. Estes dois não são
     sensíveis e não há logótipo — de propósito.) */
  url.searchParams.set('scope', 'openid email');
  url.searchParams.set('state', estado);
  url.searchParams.set('nonce', nonce);
  url.searchParams.set('code_challenge', desafio);
  url.searchParams.set('code_challenge_method', 'S256');
  /* Faz a Google perguntar SEMPRE qual é a conta. Num telemóvel com duas
     contas, entrar na errada é uma conta duplicada e uns carimbos perdidos —
     e quem toca neste botão toca nele uma vez na vida. */
  url.searchParams.set('prompt', 'select_account');
  /* Não se pede `access_type=offline`: um `refresh_token` era uma credencial
     de longa duração para uma coisa que se faz uma vez. */

  return { url: url.toString(), bilhete, expiraEm: expira };
});

/* =========================================================================
   Entrar com a Apple

   O MESMO CAMINHO DA GOOGLE, e de propósito: a mesma tabela `ligacoes`, o
   mesmo bilhete a prender a conclusão a quem começou, a mesma regra de
   ligação. O que muda são três coisas, e as três são da Apple.

   1. O «client secret» NÃO É UM SEGREDO GUARDADO: é um JWT que se assina na
      hora, em ES256, com a chave `.p8`. Vale seis meses no máximo; aqui vale
      dez minutos, que é quanto uma troca demora.

   2. NÃO VAI ÂMBITO NENHUM, e isso é uma decisão com preço escrito. A Apple só
      manda a morada de email se a volta for por POST (`response_mode=form_post`),
      e a nossa volta aterra em `/app/`, no GitHub Pages, que só serve GET. Para
      ter o POST era preciso o Worker ter endereço próprio, e isso obrigava a
      mudar a zona do domínio da Hostinger para a Cloudflare. Quem entrar SÓ
      pela Apple não nos deixa morada nenhuma — e a app oferece-lhe juntar um
      email ou a Google no mesmo painel.

   3. NÃO VAI PKCE. A Apple não o documenta para o caminho da web, e mandar-lhe
      parâmetros que ela não conhece é pedir um erro que não se explica. O que
      protege esta troca é o segredo de cliente, que só o Worker sabe assinar.

   A ARMADILHA QUE CUSTA UM DIA, e que aqui não se cai nela: a página
   «Verifying a user» da Apple manda verificar «the JWS E256 signature» do
   `id_token` — e isso está errado. O `openid-configuration` dela declara
   RS256; o ES256 é do NOSSO segredo de cliente, não do token dela. Como aqui
   não se verifica assinatura nenhuma (ver `abrirIdToken`), a confusão não tem
   por onde entrar.
   ========================================================================= */

const appleEntrarPronta = (env) => Boolean(
  env.APPLE_ENTRAR_SERVICO && env.APPLE_ENTRAR_KID && env.APPLE_ENTRAR_CHAVE && env.APPLE_EQUIPA);

/** Está esta porta ligada? Uma pergunta, duas respostas. */
const portaPronta = (env, provedor) =>
  (provedor === 'apple' ? appleEntrarPronta(env) : googleEntrarPronta(env));

const appleContas = (env) => env.APPLE_CONTAS_BASE || 'https://appleid.apple.com';

/**
 * O segredo de cliente da Apple — um JWT assinado com a `.p8`.
 *
 * Assina-se a cada troca e não se guarda: um segredo que vive dez minutos não
 * precisa de casa. O `kid` no cabeçalho é o que diz à Apple com que chave
 * verificar, e esquecê-lo dá um `invalid_client` que não explica nada.
 */
async function segredoDeClienteApple(env) {
  const chave = await crypto.subtle.importKey(
    'pkcs8', doPEM(env.APPLE_ENTRAR_CHAVE),
    { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const agoraSeg = Math.floor(Date.now() / 1000);
  const cabecalho = base64url(new TextEncoder().encode(
    JSON.stringify({ alg: 'ES256', kid: env.APPLE_ENTRAR_KID })));
  const corpo = base64url(new TextEncoder().encode(JSON.stringify({
    iss: env.APPLE_EQUIPA,
    iat: agoraSeg,
    exp: agoraSeg + 600,
    aud: 'https://appleid.apple.com',
    /* O `sub` é o Services ID, e não o Team ID nem o App ID. É o erro mais
       comum deste caminho, e a Apple responde-lhe com `invalid_client`. */
    sub: env.APPLE_ENTRAR_SERVICO,
  })));
  const assinatura = await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, chave,
    new TextEncoder().encode(`${cabecalho}.${corpo}`));
  /* A WebCrypto devolve `r||s` em cru, que é o que um JWS quer. O `node:crypto`
     devolveria DER — é por isso que este código não se copia de exemplos de
     Node sem olhar. */
  return `${cabecalho}.${corpo}.${base64url(assinatura)}`;
}

/** Troca o código por um `id_token`. Servidor a servidor, com o segredo. */
async function trocarCodigoApple(env, { codigo, redireccao }) {
  const corpo = new URLSearchParams({
    code: codigo,
    client_id: env.APPLE_ENTRAR_SERVICO,
    client_secret: await segredoDeClienteApple(env),
    redirect_uri: redireccao,
    grant_type: 'authorization_code',
  });
  let r;
  try {
    r = await fetch(`${appleContas(env)}/auth/token`, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: corpo.toString(),
      ...(typeof AbortSignal !== 'undefined' && AbortSignal.timeout
        ? { signal: AbortSignal.timeout(8000) } : {}),
    });
  } catch (erro) {
    console.error('apple entrar: a troca do código nem chegou a sair', String(erro));
    throw new Falha('A Apple não respondeu. Tenta outra vez.',
      { estado: 502, codigo: 'porta-falhou' });
  }
  if (!r.ok) {
    console.error('apple entrar: a Apple recusou a troca', r.status);
    throw new Falha('A Apple não confirmou a entrada.', { estado: 502, codigo: 'porta-falhou' });
  }
  let dados;
  try { dados = await r.json(); } catch { dados = null; }
  if (!dados || !dados.id_token) {
    throw new Falha('A Apple não confirmou a entrada.', { estado: 502, codigo: 'porta-falhou' });
  }
  return String(dados.id_token);
}

/** A ida à Apple. Gémea da da Google, com as diferenças dela. */
rota('POST', '/v1/cliente/apple/comecar', async (env, pedido) => {
  if (!appleEntrarPronta(env)) {
    throw new Falha('A entrada pela Apple não está ligada.',
      { estado: 404, codigo: 'porta-desligada' });
  }
  await travarPorOrigem(env, pedido, {
    marca: 'liga', tecto: LIGACOES_HORA, codigo: 'demasiadas-ligacoes',
    mensagem: 'Demasiadas tentativas de entrada daqui. Tenta daqui a uma hora.',
  });

  const redireccao = redireccaoDeVolta(env, pedido);
  const s = await lerSessao(env, pedido);
  const sessaoResumo = s && s.tipo === 'cliente' ? s.resumo : null;

  const estado = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const bilhete = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const nonce = base64url(crypto.getRandomValues(new Uint8Array(16)));
  const expira = new Date(Date.now() + LIGACAO_MINUTOS * 60000).toISOString();

  await env.DB.prepare(
    `INSERT INTO ligacoes
       (id, provedor, estado_resumo, bilhete_resumo, verificador, nonce,
        redireccao, sessao_resumo, criada_em, expira_em)
     VALUES (?, 'apple', ?, ?, ?, ?, ?, ?, ?, ?)`
  /* O `verificador` é NOT NULL e a Apple não leva PKCE: fica em branco, dito
     por escrito, em vez de se afrouxar o esquema por causa de uma porta. */
  ).bind(id(), await resumo(estado), await resumo(bilhete), '', nonce,
         redireccao, sessaoResumo, agora(), expira).run();

  const url = new URL(`${appleContas(env)}/auth/authorize`);
  url.searchParams.set('client_id', env.APPLE_ENTRAR_SERVICO);
  url.searchParams.set('redirect_uri', redireccao);
  url.searchParams.set('response_type', 'code');
  /* Sem `scope`, e por isso `response_mode=query` — que é o único que uma
     página do GitHub Pages consegue receber. Ver o cabeçalho deste bloco. */
  url.searchParams.set('response_mode', 'query');
  url.searchParams.set('state', estado);
  url.searchParams.set('nonce', nonce);

  return { url: url.toString(), bilhete, expiraEm: expira, provedor: 'apple' };
});

/**
 * A volta. Chamada pela app, quando o browser regressa a `/app/?code=...`.
 *
 * O BILHETE É OBRIGATÓRIO AQUI, e é ele que fecha o buraco maior que este
 * desenho teve. Sem ele, o ataque era este: eu peço a ida, fico com o bilhete,
 * e mando-te o endereço — que é um endereço verdadeiro da Google, com o nosso
 * `client_id`, indistinguível de um login legítimo. Tu entras, a nossa página
 * conclui a ligação, e eu levanto a TUA sessão com o MEU bilhete. Levava a
 * conta inteira: sessão de 180 dias e o segredo que cunha os códigos do balcão.
 *
 * Nem o `state` nem o PKCE nem o `nonce` defendem disto — são todos do lado de
 * quem COMEÇA, e quem começa é o atacante. O que defende é exigir que quem
 * conclui seja quem começou: o bilhete vive no armazenamento local da origem,
 * e a app só o tem se estiver no mesmo browser que pediu a ida.
 *
 * O preço está escrito e é honesto: se a volta aterrar noutro contexto — um
 * iPhone antigo a abrir a ligação no Safari em vez de dentro da app — não há
 * bilhete, e então NÃO SE CONCLUI. A pessoa vê uma frase que o explica e um
 * caminho para a frente, em vez de uma credencial a ser entregue ao sítio
 * errado.
 *
 * E repare-se no que esta rota não devolve, mesmo assim: sessão nenhuma. Quem
 * a levanta é a rota seguinte, com o mesmo bilhete.
 */
async function tratarVolta(env, pedido) {
  const corpo = await corpoJSON(pedido);
  const estado = typeof corpo.estado === 'string' ? corpo.estado : '';
  const bilhete = typeof corpo.bilhete === 'string' ? corpo.bilhete : '';
  if (!estado) throw new Falha('Falta o estado.', { estado: 400, codigo: 'ligacao-desconhecida' });
  if (!bilhete) {
    throw new Falha('Esta janela não é a que começou a entrada.',
      { estado: 403, codigo: 'bilhete-em-falta' });
  }

  /* A LIGAÇÃO É QUE DIZ QUAL É A PORTA. Antes procurava-se `provedor = 'google'`
     e a rota tinha o nome da Google lá dentro; com duas portas a viverem na
     mesma tabela, quem sabe de quem é aquele estado é a linha, e não o
     endereço por onde o pedido entrou. É o que permite à app ter um caminho de
     volta só. */
  const linha = await env.DB.prepare(
    'SELECT * FROM ligacoes WHERE estado_resumo = ?'
  ).bind(await resumo(estado)).first();
  if (!linha) throw new Falha('Esta entrada já não vale.', { estado: 400, codigo: 'ligacao-desconhecida' });
  if (!portaPronta(env, linha.provedor)) {
    throw new Falha('Essa forma de entrar não está ligada.',
      { estado: 404, codigo: 'porta-desligada' });
  }
  /* O bilhete tem de ser o DESTA ligação. Comparação em tempo constante, como
     em todo o lado aqui. */
  if (!iguais(await resumo(bilhete), String(linha.bilhete_resumo))) {
    throw new Falha('Esta janela não é a que começou a entrada.',
      { estado: 403, codigo: 'bilhete-errado' });
  }
  if (expirado(linha.expira_em)) {
    throw new Falha('Demoraste de mais. Começa outra vez.', { estado: 410, codigo: 'ligacao-expirada' });
  }

  /* O `state` SERVE UMA VEZ, e marca-se ANTES de falar com a Google. Duas
     voltas com o mesmo endereço — um recarregar da página chega — davam duas
     trocas do mesmo código, e a segunda apanhava a Google a recusar um código
     já gasto, sem se perceber porquê. A condição está dentro do UPDATE: quem
     perde a corrida não muda nenhuma linha e fica a saber. */
  const marcada = await env.DB.prepare(
    'UPDATE ligacoes SET usada_em = ? WHERE id = ? AND usada_em IS NULL'
  ).bind(agora(), linha.id).run();
  if (!marcada.meta || marcada.meta.changes !== 1) {
    throw new Falha('Esta entrada já foi usada.', { estado: 409, codigo: 'ligacao-usada' });
  }

  /* A pessoa carregou em «Cancelar» no ecrã da Google. É um caminho normal e
     tem de chegar à app: ficar a sondar para sempre era o pior dos mundos. */
  if (corpo.erro) {
    await anotarErroDaLigacao(env, linha.id, 'porta-recusou');
    return { ok: false, codigo: 'porta-recusou' };
  }

  const codigo = typeof corpo.codigo === 'string' ? corpo.codigo : '';
  if (!codigo) {
    await anotarErroDaLigacao(env, linha.id, 'porta-falhou');
    throw new Falha('Falta o código de autorização.', { estado: 400, codigo: 'porta-falhou' });
  }

  let reivindicacoes;
  try {
    const idToken = linha.provedor === 'apple'
      ? await trocarCodigoApple(env, { codigo, redireccao: linha.redireccao })
      : await trocarCodigoGoogle(env, {
        codigo, redireccao: linha.redireccao, verificador: linha.verificador,
      });
    reivindicacoes = abrirIdToken(env, linha.provedor, idToken, linha.nonce);
  } catch (erro) {
    await anotarErroDaLigacao(env, linha.id, 'porta-falhou');
    throw erro;
  }

  /* A MORADA SÓ CONTA SE O PROVEDOR DISSER QUE A VERIFICOU. Sem isso é uma
     morada que ninguém provou, e este produto não guarda moradas por provar —
     nem sequer como pista, que uma pista falsa é pior do que nenhuma.

     Da APPLE não vem morada nenhuma, e é de propósito: ela só a manda se a
     volta for por POST, e a nossa volta aterra no GitHub Pages, que só serve
     GET. Fica `null`, como ficaria uma que não estivesse verificada. */
  const correio = normalizarEmail(reivindicacoes.email);
  const email = reivindicacoes.email_verified === true && EMAIL_VALIDO.test(correio)
    ? correio : null;

  const { clienteId, recuperada, pista } = await resolverEntrada(env, {
    provedor: linha.provedor,
    sujeito: String(reivindicacoes.sub),
    email,
    sessaoResumo: linha.sessao_resumo,
  });

  await env.DB.prepare(
    `UPDATE ligacoes SET concluida_em = ?, cliente_id = ?, recuperada = ?, pista = ?
      WHERE id = ?`
  ).bind(agora(), clienteId, recuperada ? 1 : 0, pista, linha.id).run();

  return { ok: true, provedor: linha.provedor };
}

/* O endereço GERAL, que serve as duas portas — e o antigo, que continua a
   servir a da Google. A API acrescenta e não renomeia: a PWA no telemóvel de
   alguém pode ser de há semanas e chama o de baixo. */
rota('POST', '/v1/cliente/entrada/volta', tratarVolta);
rota('POST', '/v1/cliente/google/volta', tratarVolta);

/**
 * O bilhete. É aqui que a sessão nasce — e é por isso que a tabela `ligacoes`
 * nunca guarda um testemunho: uma cópia dela não abre conta nenhuma.
 */
async function tratarEstadoDaEntrada(env, pedido) {
  const corpo = await corpoJSON(pedido);
  const bilhete = typeof corpo.bilhete === 'string' ? corpo.bilhete : '';
  if (!bilhete) throw new Falha('Falta o bilhete.', { estado: 400, codigo: 'sem-bilhete' });

  const linha = await env.DB.prepare(
    'SELECT * FROM ligacoes WHERE bilhete_resumo = ?'
  ).bind(await resumo(bilhete)).first();
  /* UM BILHETE DESCONHECIDO É «EXPIRADA», e não um erro. São a mesma coisa do
     ponto de vista de quem espera — a entrada não se concluiu e não se vai
     concluir — e assim não há aqui um oráculo a dizer quais é que existiram. */
  if (!linha) return { situacao: 'expirada' };

  if (linha.erro) return { situacao: 'erro', codigo: linha.erro };
  if (!linha.concluida_em) {
    return expirado(linha.expira_em) ? { situacao: 'expirada' } : { situacao: 'a-espera' };
  }

  /* A JANELA DE RECOLHA É CURTA DE PROPÓSITO. A ligação vive dez minutos
     porque entrar na Google demora; depois de concluída, o que falta é a app
     estender a mão, e isso são segundos.

     E O BILHETE SERVE UMA VEZ. Cada recolha cunha uma sessão de 180 dias;
     deixar três era transformar um login em três credenciais, e a única coisa
     que isso comprava era uma resposta perdida pela rede — que se resolve
     entrando outra vez, em dez segundos.

     `Date.parse` na dúvida dá NaN, e NaN passa aqui por FECHADO — a mesma
     direcção de `expirado`. */
  const fim = Date.parse(String(linha.concluida_em));
  if (!Number.isFinite(fim) || fim + RECOLHA_MINUTOS * 60000 < Date.now()) {
    return { situacao: 'expirada' };
  }

  const contada = await env.DB.prepare(
    'UPDATE ligacoes SET entregues = entregues + 1 WHERE id = ? AND entregues < ?'
  ).bind(linha.id, RECOLHAS_MAX).run();
  if (!contada.meta || contada.meta.changes !== 1) return { situacao: 'expirada' };

  const encontrado = await env.DB.prepare('SELECT * FROM clientes WHERE id = ?')
    .bind(linha.cliente_id).first();
  /* A conta pode ter sido apagada no meio disto — é raro, mas a resposta certa
     não é um erro interno.

     E PODE TER ENTRADO NUMA FUSÃO nos segundos entre a volta e o levantamento:
     nesse caso o que está aqui é uma SOMBRA, e cunhar-lhe uma sessão dava uma
     sessão morta à nascença — o `exigirCliente` apaga-a ao primeiro pedido e a
     app leva um 401 que ninguém consegue explicar. Atravessa-se, como em todo
     o lado por onde uma sombra pode aparecer. */
  const vivo = encontrado ? await resolverSombra(env, encontrado) : null;
  if (!vivo) throw new Falha('Conta não encontrada', { estado: 404 });
  /* O `resolverSombra` só devolve QUATRO colunas quando dá um salto — chega-lhe
     para o que ele faz, e não chega para esta resposta, que precisa da morada e
     da data. Quando saltou, vai-se buscar a linha inteira. */
  const cliente = vivo.id === linha.cliente_id
    ? encontrado
    : await env.DB.prepare('SELECT * FROM clientes WHERE id = ?').bind(vivo.id).first();
  if (!cliente) throw new Falha('Conta não encontrada', { estado: 404 });

  /* A MESMA FORMA QUE `/v1/cliente/entrar`, à letra, para a app poder tratar
     as duas portas com o mesmo caminho — e para a fase da Apple não inventar
     uma terceira. */
  return {
    situacao: 'pronta',
    cliente: {
      id: cliente.id, publico: cliente.publico, email: cliente.email, criadoEm: cliente.criado_em,
    },
    segredo: await derivarSegredo(env, cliente.id, cliente.chave_versao),
    sessao: await criarSessao(env, `cliente:${cliente.id}`),
    horaDoServidor: agora(),
    recuperada: Boolean(linha.recuperada),
    /* 'mesma-morada' quando há outra conta com esta morada, pela porta do
       email. Não se juntou nada; é para a app poder dizê-lo. */
    pista: linha.pista || null,
    provedor: linha.provedor,
  };
}

rota('POST', '/v1/cliente/entrada/estado', tratarEstadoDaEntrada);
rota('POST', '/v1/cliente/google/estado', tratarEstadoDaEntrada);

/* =========================================================================
   Notificações

   UMA SÓ, e é de propósito: quando o cartão fica cheio. É o momento em que a
   pessoa está a guardar o telemóvel e a sair do café, e o carimbo foi dado no
   aparelho do BALCÃO — do lado de cá não há nada que o diga, a não ser que a
   app esteja aberta.

   «Há dois meses que não apareces» fica de fora, e não por falta de vontade:
   é publicidade com outro nome, e a página de privacidade promete em letra
   grande que não a enviamos. Se um dia for para fazer, é outro consentimento e
   outra linha — não um uso a mais deste.

   O TEXTO VAI CIFRADO (ver `push.js`), por uma razão prática além da óbvia: um
   push vazio obrigaria o service worker a ir buscar o texto à API, e um service
   worker NÃO TEM ACESSO ao `localStorage`, que é onde vive a sessão.
   ========================================================================= */

/* Aparelhos por conta. Seis é muito para uma pessoa e pouco para abusar: cada
   um custa um subpedido por prémio, e o tecto de uma invocação é 50. */
const SUBSCRICOES_MAX = 6;
/* Envios seguidos sem sucesso antes de se desistir daquele aparelho. */
const FALHAS_MAX = 3;

/** Uma subscrição tem de se parecer com uma subscrição antes de entrar na base. */
function lerSubscricao(corpo) {
  const endereco = String(corpo.endereco || '');
  const p256dh = String(corpo.p256dh || '');
  const auth = String(corpo.auth || '');
  let u;
  try { u = new URL(endereco); } catch { u = null; }
  /* HTTPS e mais nada: os serviços de push são todos https, e aceitar outra
     coisa era deixar alguém usar-nos para bater a um endereço qualquer. A
     única excepção é o localhost, e é a mesma que o endereço de volta das
     portas já abre — sem ela não há forma de provar este caminho contra um
     serviço de push de mentira. */
  const local = u && (u.hostname === 'localhost' || u.hostname === '127.0.0.1');
  if (!u || (u.protocol !== 'https:' && !local) || endereco.length > 512) {
    throw new Falha('Endereço de notificação inválido.', { estado: 400, codigo: 'push-endereco' });
  }
  /* 65 bytes sem compressão e 16 de segredo — é o que o RFC 8291 manda, e o
     que a cifra precisa. Recusar aqui é recusar antes de gravar.

     E O `atob` ATIRA com base64 mal formado, o que dava um «Erro interno» a
     quem mandasse lixo — 500 para o que é claramente um 400. Uma chave que não
     se consegue ler é uma chave inválida, e diz-se isso. */
  let tamanhos;
  try {
    tamanhos = [deBase64url(p256dh).length, deBase64url(auth).length];
  } catch {
    tamanhos = [0, 0];
  }
  if (tamanhos[0] !== 65 || tamanhos[1] !== 16) {
    throw new Falha('Chaves de notificação inválidas.', { estado: 400, codigo: 'push-chaves' });
  }
  return { endereco, p256dh, auth };
}

/**
 * Manda o aviso do prémio aos aparelhos desta conta, e limpa os que morreram.
 *
 * NÃO ATIRA. Corre num `waitUntil`, depois de o carimbo já estar gravado e a
 * resposta já ter saído: o que acontecer aqui não pode fazer o balcão esperar
 * nem falhar. Um serviço de push em baixo é um aviso que não chega, não um
 * carimbo que se perde.
 */
async function avisarDoPremio(env, cartao, ganhos) {
  if (!pushPronto(env) || !cartao || !ganhos || !ganhos.length) return;
  let subs;
  try {
    subs = (await env.DB.prepare(
      'SELECT id, endereco, p256dh, auth FROM subscricoes WHERE cliente_id = ? LIMIT ?'
    ).bind(cartao.clienteId, SUBSCRICOES_MAX).all()).results;
  } catch (erro) {
    console.error('push: não deu para ler as subscrições', String(erro));
    return;
  }
  if (!subs.length) return;

  const nomes = ganhos.map((g) => g.descricao).filter(Boolean);
  const texto = JSON.stringify({
    titulo: nomes.length > 1 ? 'Ganhaste prémios' : 'Ganhaste um prémio',
    /* O nome do café e o que se ganhou. Quem lê isto no ecrã bloqueado tem de
       saber onde ir buscar, sem abrir nada. */
    corpo: `${cartao.negocio?.nome || 'O teu cartão'} — ${nomes.join(' · ')}`,
  });

  for (const s of subs) {
    const r = await enviarPush(env, s, texto);
    try {
      if (r.ok) {
        await env.DB.prepare(
          'UPDATE subscricoes SET usada_em = ?, falhas = 0 WHERE id = ?'
        ).bind(agora(), s.id).run();
      } else if (r.morta) {
        /* 404 e 410 são a resposta normal a um aparelho que já não existe — a
           app foi desinstalada, os dados do site foram limpos. Guardar aquilo
           é guardar um endereço de alguém que já não nos ouve. */
        await env.DB.prepare('DELETE FROM subscricoes WHERE id = ?').bind(s.id).run();
      } else {
        await env.DB.prepare(
          'UPDATE subscricoes SET falhas = falhas + 1 WHERE id = ?').bind(s.id).run();
        await env.DB.prepare(
          'DELETE FROM subscricoes WHERE id = ? AND falhas >= ?').bind(s.id, FALHAS_MAX).run();
      }
    } catch (erro) {
      console.error('push: não deu para arrumar a subscrição', String(erro));
    }
  }
}

/**
 * Passar a receber avisos neste aparelho.
 *
 * O consentimento verdadeiro é o do SISTEMA — a folha que o telemóvel desenha
 * e que só ele pode desenhar. Quando este pedido chega, a pessoa já disse que
 * sim lá; aqui só se guarda para onde mandar.
 */
rota('POST', '/v1/cliente/push', async (env, pedido) => {
  if (!pushPronto(env)) {
    throw new Falha('As notificações não estão ligadas.', { estado: 404, codigo: 'push-desligado' });
  }
  const clienteId = await exigirCliente(env, pedido);
  const s = lerSubscricao(await corpoJSON(pedido));

  /* UM APARELHO, UMA LINHA. O browser volta a subscrever com o mesmo endereço
     depois de uma actualização, e duas linhas iguais são duas notificações
     iguais no mesmo ecrã. O `cliente_id` também se actualiza: um telemóvel que
     mude de conta tem de passar a receber a da conta nova, e nunca as duas. */
  await env.DB.prepare(
    `INSERT INTO subscricoes (id, cliente_id, endereco, p256dh, auth, criada_em)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(endereco) DO UPDATE SET
       cliente_id = excluded.cliente_id, p256dh = excluded.p256dh,
       auth = excluded.auth, criada_em = excluded.criada_em, falhas = 0`
  ).bind(id(), clienteId, s.endereco, s.p256dh, s.auth, agora()).run();

  /* O tecto guarda-se deitando fora os mais velhos, e não recusando o novo:
     quem está com o telemóvel na mão é quem acabou de dizer que sim. */
  await env.DB.prepare(
    `DELETE FROM subscricoes WHERE cliente_id = ?1 AND id NOT IN (
       SELECT id FROM subscricoes WHERE cliente_id = ?1
        ORDER BY criada_em DESC LIMIT ?2)`
  ).bind(clienteId, SUBSCRICOES_MAX).run();

  return { ok: true };
});

/**
 * Deixar de receber.
 *
 * Com endereço, é este aparelho; sem ele, são todos — que é o que se quer
 * quando alguém desliga o interruptor numa app que tem sessão em três sítios.
 */
rota('DELETE', '/v1/cliente/push', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  let endereco = '';
  try {
    const corpo = await corpoJSON(pedido);
    endereco = typeof corpo.endereco === 'string' ? corpo.endereco : '';
  } catch { /* sem corpo: são todos */ }

  if (endereco) {
    await env.DB.prepare('DELETE FROM subscricoes WHERE cliente_id = ? AND endereco = ?')
      .bind(clienteId, endereco).run();
  } else {
    await env.DB.prepare('DELETE FROM subscricoes WHERE cliente_id = ?').bind(clienteId).run();
  }
  return { ok: true };
});

rota('GET', '/v1/cliente/dados', async (env, pedido) => {
  /* CINCO CONSULTAS, e não cinco POR CARTÃO.

     Isto fazia um `moldarCartao` (duas a três consultas), um SELECT de
     movimentos e um de prémios por cada cartão. Uma invocação de Worker tem
     tecto de CINQUENTA subpedidos: a partir de uns dez cartões, o «Descarregar
     os meus dados» — que é o direito de portabilidade do artigo 20.º do RGPD —
     rebentava com «Too many subrequests» e a pessoa via «Erro interno». O
     direito de levar os dados consigo não pode depender de se ter poucos
     cartões. */
  const clienteId = await exigirCliente(env, pedido);
  const cliente = await env.DB.prepare('SELECT * FROM clientes WHERE id = ?').bind(clienteId).first();
  const cartoes = (await env.DB.prepare('SELECT * FROM cartoes WHERE cliente_id = ?').bind(clienteId).all()).results;

  const movimentos = cartoes.length ? (await env.DB.prepare(
    `SELECT m.* FROM movimentos m
       JOIN cartoes c ON c.id = m.cartao_id
      WHERE c.cliente_id = ? ORDER BY m.em DESC`
  ).bind(clienteId).all()).results : [];
  const premios = cartoes.length ? (await env.DB.prepare(
    `SELECT pr.* FROM premios pr
       JOIN cartoes c ON c.id = pr.cartao_id
      WHERE c.cliente_id = ? ORDER BY pr.ganho_em`
  ).bind(clienteId).all()).results : [];

  /* AS FORMAS DE ENTRAR TAMBÉM SÃO DADOS DELA, e o artigo 20.º diz «os dados
     que lhe digam respeito», não «os que nos der jeito listar». Hoje é só o
     espelho do email; quando a Google e a Apple entrarem, é aqui que a pessoa
     vê quais é que estão ligadas à conta — e é a única forma de o saber sem
     nos perguntar. Uma consulta, com índice por `cliente_id`. */
  const identidades = (await env.DB.prepare(
    `SELECT provedor, sujeito, email, relay, rotulo, criada_em, verificada_em, usada_em
       FROM identidades WHERE cliente_id = ? ORDER BY criada_em`
  ).bind(clienteId).all()).results;

  /* E AS IDAS A UM PROVEDOR QUE ESTEJAM A MEIO. É uma linha técnica que vive
     minutos e quase nunca existe quando alguém carrega no botão — mas a app
     promete «tudo o que temos sobre ti», e uma promessa dessas não tem
     excepções por conveniência. Vão as datas e o provedor; não vai o
     verificador do PKCE nem os resumos, que não dizem nada a ninguém e são as
     únicas coisas da linha que se parecem com uma chave. */
  const entradasAMeio = (await env.DB.prepare(
    `SELECT provedor, criada_em, expira_em, usada_em, concluida_em
       FROM ligacoes WHERE cliente_id = ? OR sessao_resumo IN
            (SELECT resumo FROM sessoes WHERE sujeito = ?)
      ORDER BY criada_em`
  ).bind(clienteId, `cliente:${clienteId}`).all()).results;

  /* OS APARELHOS QUE RECEBEM AVISOS. O endereço de push identifica um
     telemóvel — é a coisa mais identificadora que esta base guarda — por isso
     entra na exportação. As CHAVES não: são material de cifra, não dizem nada
     a quem lê, e publicá-las num ficheiro que anda por aí não ajuda ninguém. */
  const aparelhos = (await env.DB.prepare(
    `SELECT endereco, criada_em, usada_em FROM subscricoes
      WHERE cliente_id = ? ORDER BY criada_em`
  ).bind(clienteId).all()).results;

  const detalhados = await moldarCartoes(env, cartoes);
  return {
    geradoEm: agora(), cliente, identidades, entradasAMeio, aparelhos,
    cartoes: detalhados, movimentos, premios,
  };
});

/**
 * Apaga uma conta e tudo o que pende dela.
 *
 * Tem dois chamadores — o botão «Apagar a conta» no perfil e a limpeza das
 * contas paradas — e é de propósito que é um só sítio: duas listas de tabelas
 * escritas à mão divergem à primeira tabela nova, e o que fica para trás numa
 * delas são dados pessoais de alguém que pediu para desaparecer.
 *
 * As chaves estrangeiras estão em CASCADE, mas o D1 só as aplica com
 * PRAGMA foreign_keys ligado — que nem sempre está. Apaga-se à mão, pela
 * ordem certa, para não ficarem órfãos na base de dados.
 */
async function apagarCliente(env, clienteId) {
  const cartoes = (await env.DB.prepare('SELECT id FROM cartoes WHERE cliente_id = ?').bind(clienteId).all()).results;

  /* OS PASSES MORREM ANTES DOS CARTÕES, e a ordem não é indiferente: depois de
     a linha desaparecer já não há por onde saber que o passe existia, e ele
     ficava na carteira da pessoa para sempre, com um saldo velho, sem nada
     que o tirasse de lá. Isso não é um pormenor — é o direito ao apagamento.

     Falhar aqui não impede o apagamento. Entre deixar um cartão na base de
     dados de quem pediu para desaparecer e deixar um rectângulo morto numa
     carteira, a escolha é fácil.

     ISTO TRATA DA GOOGLE, E SÓ DELA. O parágrafo acima era verdade inteira
     enquanto a Apple estava desligada, e deixou de o ser no dia em que o
     certificado entrou. Um `.pkpass` não tem serviço web — não escrevemos
     `webServiceURL` — por isso não há por onde lhe tocar depois de sair daqui:
     fica no iPhone, com o saldo do dia em que foi guardado, e o código de
     barras passa a dar «Este passe já não vale» ao balcão.

     Não é um descuido escondido: é uma consequência de uma decisão de
     arquitectura, e o que se pode fazer é DIZÊ-LO a quem apaga a conta — o
     painel de apagar na app di-lo, e o email de conta parada também, que é o
     único aviso que recebe quem é apagado por inactividade sem ter carregado
     em botão nenhum. Ver `PLANO.md` para o que custaria fechá-lo de verdade. */
  if (walletLigada(env)) {
    /* Só os que TÊM passe. A primeira versão percorria todos os cartões e
       chamava a Google para cada um — incluindo os de quem nunca tocou na
       Wallet. Gastava subpedidos e um testemunho de acesso por cada conta
       apagada, para não fazer nada. */
    const comPasse = (await env.DB.prepare(
      'SELECT id FROM cartoes WHERE cliente_id = ? AND wallet_em IS NOT NULL'
    ).bind(clienteId).all()).results;
    for (const c of comPasse) {
      try {
        await googlePedir(env, `/loyaltyObject/${env.GOOGLE_EMISSOR}.${c.id}`, {
          metodo: 'PATCH', corpo: { state: 'EXPIRED' },
        });
      } catch (erro) {
        console.error('wallet: não deu para expirar o passe', c.id, String(erro));
      }
    }
  }
  const instrucoes = [];
  for (const c of cartoes) {
    instrucoes.push(env.DB.prepare('DELETE FROM movimentos WHERE cartao_id = ?').bind(c.id));
    instrucoes.push(env.DB.prepare('DELETE FROM premios WHERE cartao_id = ?').bind(c.id));
  }
  instrucoes.push(
    env.DB.prepare('DELETE FROM cartoes WHERE cliente_id = ?').bind(clienteId),
    env.DB.prepare('DELETE FROM sessoes WHERE sujeito = ?').bind(`cliente:${clienteId}`),
    env.DB.prepare('DELETE FROM entradas WHERE alvo = ?').bind(`cliente:${clienteId}`),
    /* E uma ida a um provedor de identidade que estivesse a meio. Não tem
       chave estrangeira — a linha nasce antes de se saber de que conta é — por
       isso ninguém a leva atrás. Deixá-la lá dava um bilhete que, ao ser
       levantado, ia procurar uma conta que já não existe. */
    env.DB.prepare('DELETE FROM ligacoes WHERE cliente_id = ?').bind(clienteId),
    /* E os aparelhos que estavam a receber avisos. O CASCADE leva-os — a
       chave estrangeira está lá — mas o modo de falha se ela algum dia não
       estiver é mandar uma notificação para o telemóvel de quem pediu para
       desaparecer, e isso não se deixa a um talvez. */
    env.DB.prepare('DELETE FROM subscricoes WHERE cliente_id = ?').bind(clienteId),
    /* E os convites entre clientes, dos DOIS lados: os que esta conta fez e os
       que a trouxeram. Quem convidou fica sem o registo de quem trouxe — é o
       preço de o outro ter pedido para desaparecer, e o carimbo que já ganhou
       não se lhe tira. */
    env.DB.prepare('DELETE FROM amigos WHERE convidador = ? OR convidado = ?')
      .bind(clienteId, clienteId),
    /* REDE A MAIS, e fica dito para ninguém a tomar por necessária: o
       `PRAGMA foreign_keys` está a 1 no D1, local e remoto — conferido — por
       isso o ON DELETE CASCADE da declaração já leva estas linhas à frente.
       Tirar esta instrução não parte nenhum teste, e não é por isso que ela
       fica: é que o modo de falha do outro lado é silencioso e definitivo —
       uma identidade que sobrevivesse à conta trancava aquela morada para
       sempre, pelo índice único, e ninguém perceberia porquê. Uma instrução
       num `batch` que já leva sete é barata de mais para se poupar nela. */
    env.DB.prepare('DELETE FROM identidades WHERE cliente_id = ?').bind(clienteId),
    /* E as sombras que apontavam para esta conta. Sem isto ficavam a apontar
       para nada: o `resolverSombra` devolve `null` e o balcão diz «cartão
       desconhecido», que é a resposta certa — mas ficava lixo a ocupar
       números de cartão que nunca mais podiam voltar a sair. */
    env.DB.prepare('DELETE FROM clientes WHERE fundida_em = ?').bind(clienteId),
    env.DB.prepare('DELETE FROM clientes WHERE id = ?').bind(clienteId),
  );
  await env.DB.batch(instrucoes);
}

/**
 * Sair de UM café, sem apagar a conta.
 *
 * NÃO HAVIA COMO. Em toda a API existia uma única rota `DELETE`, e apagava a
 * conta inteira: para deixar de estar na lista de um sítio, a pessoa tinha de
 * perder os carimbos de TODOS os outros. Nove carimbos na padaria ao lado
 * deitados fora para sair de uma lista.
 *
 * Enquanto a lista do balcão era anónima, isto quase não mordia. Com a alcunha
 * lá dentro passa a ser um dado sobre uma pessoa identificável, e o art. 21.º
 * dá-lhe o direito de se opor. Um direito que só se exerce destruindo tudo o
 * resto é o prejuízo que o art. 7.º/4 proíbe.
 *
 * Leva tudo o que é DAQUELE cartão — movimentos, prémios, a alcunha com a
 * linha — e não toca em mais nada. O passe da Google é expirado; o da Apple
 * não tem por onde se lhe tocar, e o que o mata é o `wallet_codigo` deixar de
 * existir com o cartão.
 *
 * O CAFÉ PERDE O HISTÓRICO, e isso diz-se à pessoa antes: o dono deixa de ver
 * aquelas visitas para sempre. É o preço certo — os dados eram dela.
 */
rota('DELETE', /^\/v1\/cliente\/cartoes\/([\w-]+)$/, async (env, pedido, [cartaoId]) => {
  const clienteId = await exigirCliente(env, pedido);
  const cartao = await env.DB.prepare(
    'SELECT id, wallet_em FROM cartoes WHERE id = ? AND cliente_id = ?'
  ).bind(cartaoId, clienteId).first();
  if (!cartao) throw new Falha('Cartão não encontrado', { estado: 404, codigo: 'sem-cartao' });

  if (walletLigada(env) && cartao.wallet_em) {
    try {
      await googlePedir(env, `/loyaltyObject/${env.GOOGLE_EMISSOR}.${cartao.id}`, {
        metodo: 'PATCH', corpo: { state: 'EXPIRED' },
      });
    } catch (erro) {
      /* Falhar aqui não trava o apagamento, pela mesma razão do
         `apagarCliente`: entre deixar o cartão na base de quem pediu para sair
         e deixar um rectângulo morto numa carteira, a escolha é fácil. */
      console.error('wallet: não deu para expirar o passe ao largar o cartão', cartao.id, String(erro));
    }
  }

  await env.DB.batch([
    env.DB.prepare('DELETE FROM movimentos WHERE cartao_id = ?').bind(cartaoId),
    env.DB.prepare('DELETE FROM premios WHERE cartao_id = ?').bind(cartaoId),
    env.DB.prepare('DELETE FROM cartoes WHERE id = ? AND cliente_id = ?').bind(cartaoId, clienteId),
  ]);
  return { largado: true };
});

/**
 * Tirar o email, e mais nada.
 *
 * O EMAIL FOI DADO POR CONSENTIMENTO — está escrito assim na política, art.
 * 6.º/1/a — e o art. 7.º/3 diz que retirar tem de ser tão fácil como dar. Dar
 * era escrever a morada e um código de seis algarismos; tirar era apagar a
 * conta e perder os cartões todos. Não é a mesma facilidade: é o contrário.
 *
 * Sai dos dois sítios, e os dois são precisos: a identidade, que é quem manda
 * desde a migração 009, e o espelho em `clientes.email`, que a app que está
 * nos telemóveis ainda lê.
 *
 * O QUE SE PERDE DIZ-SE ANTES, e não é pouco: sem email guardado, mudar de
 * telemóvel passa a perder os cartões. É o painel da app que o diz — aqui só
 * se faz o que foi pedido.
 */
rota('DELETE', '/v1/cliente/email', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  await env.DB.batch([
    env.DB.prepare("DELETE FROM identidades WHERE cliente_id = ? AND provedor = 'email'")
      .bind(clienteId),
    env.DB.prepare('UPDATE clientes SET email = NULL, email_verificado = 0 WHERE id = ?')
      .bind(clienteId),
    /* Os códigos por usar morrem com ele: um código emitido para uma morada
       que já não é da conta não tem para onde levar ninguém. */
    env.DB.prepare('DELETE FROM entradas WHERE alvo = ?').bind(`cliente:${clienteId}`),
  ]);
  return { email: null };
});

/**
 * Desligar a conta da Google.
 *
 * A MESMA OBRIGAÇÃO QUE O EMAIL, pela mesma razão: a entrada pela Google é
 * consentimento (art. 6.º/1/a), e o art. 7.º/3 diz que retirar tem de ser tão
 * fácil como dar. Dar é um toque; tirar tinha de ser um toque. Publicar a
 * porta sem esta rota era publicar um consentimento sem saída.
 *
 * NÃO SE DESLIGA A ÚLTIMA PORTA SEM AVISO — mas o aviso é da app, não daqui.
 * Aqui responde-se com quantas formas de entrar sobraram, para o painel poder
 * dizer a verdade a seguir sem ter de ir perguntar outra vez.
 *
 * O `sub` fica livre: se a mesma pessoa voltar a entrar pela Google, a
 * identidade nasce outra vez — noutra conta, se for esse o caso, porque a
 * morada nunca decidiu nada e continua a não decidir.
 */
rota('DELETE', /^\/v1\/cliente\/identidades\/(google)$/, async (env, pedido, [provedor]) => {
  const clienteId = await exigirCliente(env, pedido);
  await env.DB.prepare('DELETE FROM identidades WHERE cliente_id = ? AND provedor = ?')
    .bind(clienteId, provedor).run();
  /* E as idas a meio, que doutra forma podiam concluir-se depois de a pessoa
     ter carregado em desligar e voltar a colar a identidade. */
  await env.DB.prepare(
    'DELETE FROM ligacoes WHERE provedor = ? AND concluida_em IS NULL AND cliente_id IS NULL AND sessao_resumo IS NOT NULL AND sessao_resumo IN (SELECT resumo FROM sessoes WHERE sujeito = ?)'
  ).bind(provedor, `cliente:${clienteId}`).run();

  const restantes = (await env.DB.prepare(
    'SELECT provedor, email, relay, rotulo, criada_em, usada_em FROM identidades WHERE cliente_id = ? ORDER BY criada_em'
  ).bind(clienteId).all()).results;
  return { identidades: restantes };
});

rota('DELETE', '/v1/cliente', async (env, pedido) => {
  const clienteId = await exigirCliente(env, pedido);
  await apagarCliente(env, clienteId);
  return { apagado: true };
});

/* --- balcão ------------------------------------------------------------- */

/**
 * Fundar um negócio com um código de convite.
 *
 * O problema do primeiro operador: para entrar no balcão é preciso uma
 * sessão, para ter sessão é preciso um código por email, e para receber o
 * código é preciso já existir um operador. Alguém tem de criar o primeiro.
 *
 * Quem o cria é este endereço, aberto por um convite — uma linha da tabela
 * `convites`, com usos, validade e revogação próprios. Era um segredo do
 * Worker igual para toda a gente, com usos infinitos e sem forma de anular um
 * sem partir os outros; e que nem o dono do produto conseguia ler de volta,
 * porque o Cloudflare não devolve segredos.
 *
 * Os convites geram-se com `node scripts/convite.mjs criar --para "..."`.
 * Quando a inscrição passar a ser livre, troca-se o convite por uma
 * confirmação de email e o resto fica igual.
 */
/**
 * Normaliza um código de convite escrito por uma pessoa.
 *
 * Ele lê-o de um papel ou ouve-o em voz alta e escreve-o como lhe sai:
 * minúsculas, com ou sem o hífen, às vezes com um espaço no meio. Nada disso
 * pode ser motivo para recusar — o que conta são os caracteres do alfabeto.
 */
const normalizarConvite = (v) => String(v || '').toUpperCase().replace(/[^A-Z0-9]/g, '');

/**
 * Reivindica um convite, ou explica porque não deu.
 *
 * O gesto todo é UM `UPDATE` condicional, e isso não é preciosismo: ler o
 * convite, decidir em JavaScript e escrever a seguir deixa cinquenta pedidos
 * em paralelo passarem todos pela mesma porta antes de qualquer um deles a
 * fechar. O `meta.changes` diz quantas linhas mudaram de facto — uma, ou
 * nenhuma. É a base de dados a arbitrar, e não nós.
 *
 * O `SELECT` só corre DEPOIS, e só quando já se sabe que falhou: serve para
 * dizer à pessoa se o código não existe, se caducou, se já foi gasto ou se foi
 * revogado — quatro paredes diferentes, e mandá-la embora com «convite
 * inválido» nas quatro é fazê-la tentar outra vez o que nunca vai funcionar.
 */
async function reivindicarConvite(env, codigo, email) {
  const limpo = normalizarConvite(codigo);
  if (limpo.length < 4) throw new Falha('Falta o código do convite.', { codigo: 'convite' });
  const r = await resumo(limpo);
  const agoraISO = agora();

  const feito = await env.DB.prepare(
    `UPDATE convites SET usos = usos + 1, usado_em = ?1
      WHERE resumo = ?2
        AND revogado_em IS NULL
        AND (expira_em IS NULL OR expira_em > ?1)
        AND usos < usos_max
        AND (email IS NULL OR email = ?3)`
  ).bind(agoraISO, r, email).run();

  if (feito.meta && feito.meta.changes === 1) return r;

  const c = await env.DB.prepare('SELECT * FROM convites WHERE resumo = ?').bind(r).first();
  if (!c) throw new Falha('Esse código não existe. Confere as letras.', { estado: 403, codigo: 'convite' });
  if (c.revogado_em) throw new Falha('Esse código foi anulado. Pede outro.', { estado: 403, codigo: 'convite-revogado' });
  if (c.expira_em && c.expira_em <= agoraISO) throw new Falha('Esse código caducou. Pede outro.', { estado: 403, codigo: 'convite-expirado' });
  if (c.usos >= c.usos_max) throw new Falha('Esse código já foi usado.', { estado: 403, codigo: 'convite-gasto' });
  if (c.email && c.email !== email) {
    throw new Falha('Esse código está reservado a outra morada de email.', { estado: 403, codigo: 'convite-email' });
  }
  throw new Falha('Esse código não serve.', { estado: 403, codigo: 'convite' });
}

/** Devolve um uso ao convite, quando a fundação falha depois de reivindicado. */
async function devolverConvite(env, r) {
  await env.DB.prepare(
    'UPDATE convites SET usos = MAX(0, usos - 1) WHERE resumo = ?'
  ).bind(r).run();
}

rota('POST', '/v1/balcao/fundar', async (env, pedido) => {
  const d = await corpoJSON(pedido);

  const nome = String(d.nome || '').trim().slice(0, 60);
  const email = normalizarEmail(d.email);
  if (nome.length < 2) throw new Falha('Falta o nome do negócio.');
  if (!EMAIL_VALIDO.test(email)) throw new Falha('Email inválido.');

  /* Entrar no balcão faz-se pelo email, e a procura devolve o primeiro
     operador que casar. Fundar um segundo negócio com o mesmo email criava
     uma conta em que nunca mais se conseguia entrar — o código chegava
     sempre ao primeiro. Vale mais recusar aqui do que deixar um negócio
     órfão na base de dados. */
  const jaHa = await env.DB.prepare(
    'SELECT 1 FROM operadores WHERE email = ? AND ativo = 1'
  ).bind(email).first();
  if (jaHa) {
    throw new Falha('Já há um balcão com este email. Entra por «Entrar com o email».',
      { estado: 409, codigo: 'email-usado' });
  }

  /* O convite gasta-se aqui, depois de tudo o que se pode recusar sem lhe
     tocar. Recusar o nome ou o email DEPOIS de o gastar queimava um convite
     por causa de um engano de escrita. */
  const convite = await reivindicarConvite(env, d.codigo, email);

  /* O slug sai do nome: sem acentos, sem pontuação, sem espaços. Se já
     existir, junta-se um sufixo curto em vez de recusar. */
  let slug = nome.normalize('NFD').replace(/[\u0300-\u036f]/g, '')
    .toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40)
    || 'negocio';
  for (let i = 0; i < 12; i++) {
    const existe = await env.DB.prepare('SELECT 1 FROM negocios WHERE slug = ?').bind(slug).first();
    if (!existe) break;
    slug = `${slug.replace(/-[a-z0-9]{4}$/, '')}-${publicoNovo(4).toLowerCase()}`;
  }

  const negocioId = id();
  const programaId = id();
  const operadorId = id();
  /* A cor vai para um atributo de estilo no cartão de toda a gente, e aqui
     entrava como viesse — o `PUT /v1/balcao/negocio` já a testava, esta porta
     não. A categoria e a localidade também são pintadas na lista pública. */
  const cor = /^#[0-9a-fA-F]{6}$/.test(String(d.cor || '')) ? d.cor : '#17161C';
  const corte = (v, n) => { const t = String(v ?? '').trim(); return t ? t.slice(0, n) : null; };
  try {
  await env.DB.batch([
    env.DB.prepare(
      `INSERT INTO negocios (id, slug, nome, categoria, cor, localidade, criado_em, convite)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(negocioId, slug, nome, corte(d.categoria, 40), cor,
           corte(d.localidade, 60), agora(), convite),
    env.DB.prepare(
      `INSERT INTO programas (id, negocio_id, nome, tipo, selo, objetivo, premio, regras,
                              arrefecimento, criado_em)
       VALUES (?, ?, ?, 'carimbos', ?, ?, ?, ?, ?, ?)`
    /* Pela MESMA limpeza da outra porta. Este ramo escrevia
       `d.programa || 'Cartão de cliente'` em cru — os tectos que a rota dos
       programas passou a ter não valiam nada se se pudesse entrar por aqui.
       O nome do campo é `programa` e não `nome`, que já é o do negócio. */
    ).bind(programaId, negocioId,
           ...(() => {
             const c = camposDoPrograma({
               nome: d.programa || 'Cartão de cliente', selo: d.selo,
               objetivo: d.objetivo, premio: d.premio || 'Um brinde por conta da casa',
               regras: d.regras || 'Um carimbo por visita.',
             });
             return [c.nome, c.selo, c.objetivo, c.premio, c.regras];
           })(), 3600, agora()),
    env.DB.prepare(
      `INSERT INTO operadores (id, negocio_id, nome, email, papel, criado_em)
       VALUES (?, ?, ?, ?, 'dono', ?)`
    ).bind(operadorId, negocioId, corte(d.operador, 40) || 'Balcão', email, agora()),
  ]);
  } catch (erro) {
    /* A fundação falhou depois de o convite estar gasto. Devolve-se o uso: um
       convite queimado por um erro da base obrigava a gerar outro, e quem
       está à espera é o dono do café com o telemóvel na mão. */
    await devolverConvite(env, convite);
    throw erro;
  }

  return {
    negocio: { id: negocioId, slug, nome },
    sessao: await criarSessao(env, `operador:${operadorId}`),
  };
});

rota('POST', '/v1/balcao/entrar', async (env, pedido) => {
  const { email } = await corpoJSON(pedido);
  const correio = normalizarEmail(email);
  if (!EMAIL_VALIDO.test(correio)) throw new Falha('Email inválido');

  const trava = await podeEnviar(env, correio);
  if (trava) throw new Falha(trava, { estado: 429, codigo: 'demasiados' });

  const op = await env.DB.prepare(
    'SELECT id, negocio_id FROM operadores WHERE email = ? AND ativo = 1'
  ).bind(correio).first();

  /* Responde-se sempre o mesmo, exista ou não a conta: senão este endereço
     torna-se uma forma de descobrir que emails estão registados.

     O que mudou: antes respondia-se `enviado: true` mesmo quando nenhum
     email tinha saído — incluindo quando o envio falhava a sério. Quem
     ficasse à espera não tinha como saber que não vinha nada. Agora o
     campo diz a verdade do envio; o que continua a não distinguir é a
     existência da conta, que é o que se quer esconder. */
  let saiu = true;
  if (op) {
    const codigo = await emitirCodigo(env, { email: correio, alvo: `operador:${op.id}` });
    const negocio = await env.DB.prepare(
      'SELECT nome FROM negocios WHERE id = ?'
    ).bind(op.negocio_id).first();
    const r = await enviarEmail(env, {
      para: correio,
      ...emailCodigoBalcao({
        codigo, minutos: ENTRADA_MINUTOS, negocio: negocio && negocio.nome,
      }),
    });
    saiu = r.enviado;
  }
  return { enviado: saiu };
});

rota('POST', '/v1/balcao/sessao', async (env, pedido) => {
  const { email, codigo } = await corpoJSON(pedido);
  const linha = await consumirEntrada(env, email, codigo);
  const [tipo, valor] = linha.alvo.split(':');
  if (tipo !== 'operador') throw new Falha('Código inválido', { estado: 400 });
  /* QUANDO É QUE ESTA PESSOA CÁ ESTEVE. Sem isto, a lista do balcão mostra
     nomes e mais nada, e o dono não tem como distinguir um colega que anda cá
     todos os dias de uma morada que ficou de um convite nunca usado. */
  await env.DB.prepare('UPDATE operadores SET visto_em = ? WHERE id = ?')
    .bind(agora(), valor).run();
  return { sessao: await criarSessao(env, `operador:${valor}`) };
});

rota('GET', '/v1/balcao/negocio', async (env, pedido) => {
  const op = await exigirOperador(env, pedido);
  const negocio = await env.DB.prepare('SELECT * FROM negocios WHERE id = ?').bind(op.negocio_id).first();
  const programas = (await env.DB.prepare(
    'SELECT * FROM programas WHERE negocio_id = ? AND ativo = 1'
  ).bind(op.negocio_id).all()).results;
  const comMarcos = [];
  for (const p of programas) {
    const marcos = p.tipo === 'pontos'
      ? (await env.DB.prepare('SELECT pontos, premio FROM marcos WHERE programa_id = ? ORDER BY pontos').bind(p.id).all()).results
      : null;
    comMarcos.push(moldarPrograma({ ...p, marcos }));
  }
  /* O `logotipo` NÃO vai aqui dentro. É um PNG em base64 — umas dezenas de
     kilobytes — e esta rota é chamada a cada abertura do balcão e a seguir a
     cada gravação. Quem precisa da imagem pede-a ao endereço próprio, que tem
     cache de um ano; aqui vai só a resposta a «há logótipo?» e a data, que é
     o que serve para não mostrar a imagem velha depois de uma troca. */
  const { logotipo, ...semImagem } = negocio;
  return {
    operador: { id: op.id, nome: op.nome, papel: op.papel },
    /* Vai TAMBÉM aqui, e não só na resposta ao PUT: é este o pedido que o
       balcão faz a cada abertura, e é o que faz o aviso da morada sobreviver a
       fechar a app. */
    moradaMudou: moradaEnvelheceu(negocio),
    /* O `demonstracao` vai a booleano para o balcão poder dizer ao dono porque
       é que ele não aparece na lista pública. Um negócio fora da lista sem
       explicação nenhuma é um bilhete de suporte à espera de acontecer. */
    negocio: {
      ...semImagem, logotipo: Boolean(logotipo),
      demonstracao: Boolean(negocio.demonstracao), programas: comMarcos,
    },
  };
});

/* =========================================================================
   Onde fica o estabelecimento

   O mapa do «Descobrir» é desenhado dentro da app, a partir das fronteiras dos
   concelhos guardadas no próprio site — daqui só vai o par de números.
   ========================================================================= */

/* A caixa de Portugal, e é generosa de propósito: do Corvo (-31,4) a Miranda
   do Douro (-6,1), e da Madeira (32,3) a Melgaço (42,3). */
const PORTUGAL = { latMin: 32.3, latMax: 42.3, lonMin: -31.4, lonMax: -6.1 };
const GEO_FONTES = new Set(['gps', 'mao', 'concelho']);

/**
 * Um par de coordenadas, ou uma falha que explica qual das duas está mal.
 *
 * O ERRO QUE INTERESSA APANHAR NÃO É O VALOR ABSURDO — é a TROCA. Escrever a
 * longitude no campo da latitude é o engano mais comum de quem mexe nisto à
 * mão, e em Portugal um par trocado dá latitude -8 e longitude 40: cai no
 * Golfo da Guiné, a 3000 km da costa, e sai sempre desta caixa. O par (0,0) é
 * o outro clássico — a «Ilha Nula» — e diz-se em separado, porque quem o
 * manda quase sempre quer dizer «não sei».
 *
 * E ARREDONDA-SE A CINCO CASAS. A 40° de latitude a quinta casa vale 1,11 m;
 * o telemóvel devolve catorze, e as outras nove são ruído com ar de medição.
 */
function lerCoordenadas(lat, lon) {
  const a = Number(lat), o = Number(lon);
  if (!Number.isFinite(a) || !Number.isFinite(o)) {
    throw new Falha('As coordenadas têm de ser dois números.',
      { estado: 400, codigo: 'geo-numeros' });
  }
  if (a === 0 && o === 0) {
    throw new Falha('(0, 0) não é um sítio: é o que fica quando não se sabe onde é.',
      { estado: 400, codigo: 'geo-nulo' });
  }
  if (a < PORTUGAL.latMin || a > PORTUGAL.latMax
      || o < PORTUGAL.lonMin || o > PORTUGAL.lonMax) {
    /* A mensagem diz o que quase sempre aconteceu, em vez de repetir os
       números que quem os mandou já viu. */
    const trocado = o >= PORTUGAL.latMin && o <= PORTUGAL.latMax
      && a >= PORTUGAL.lonMin && a <= PORTUGAL.lonMax;
    throw new Falha(trocado
      ? 'A latitude e a longitude estão trocadas.'
      : 'Esse ponto fica fora de Portugal.',
    { estado: 400, codigo: trocado ? 'geo-trocada' : 'geo-fora' });
  }
  const casas = (n) => Math.round(n * 1e5) / 1e5;
  return { latitude: casas(a), longitude: casas(o) };
}

rota('PUT', '/v1/balcao/negocio', async (env, pedido, _p, ctx) => {
  const op = await exigirOperador(env, pedido);
  if (op.papel !== 'dono') throw new Falha('Só o dono pode mudar isto', { estado: 403 });
  const d = await corpoJSON(pedido);

  /* `fundar` corta o nome aos 60 e valida o email; isto não validava nada.
     Um nome de cinco mil caracteres entrava tal e qual e ia parar ao cartão
     de todos os clientes do negócio. E a cor, que é escrita directamente
     numa custom property do CSS, aceitava qualquer texto. */
  const corta = (v, n) => (v === undefined || v === null ? null : String(v).trim().slice(0, n) || null);
  const cor = d.cor === undefined || d.cor === null ? null : String(d.cor).trim();
  if (cor !== null && !/^#[0-9a-fA-F]{6}$/.test(cor)) {
    throw new Falha('A cor tem de ser um hexadecimal de seis dígitos, como #5A31E8.',
      { estado: 400, codigo: 'cor' });
  }
  const nome = corta(d.nome, 60);
  if (d.nome !== undefined && d.nome !== null && (!nome || nome.length < 2)) {
    throw new Falha('O nome do negócio tem de ter pelo menos dois caracteres.');
  }

  /* --- onde fica ---------------------------------------------------------
     Vem do telemóvel de quem está ao balcão, ou do alfinete arrastado à mão.
     Guarda-se com a morada que a gerou, para se poder avisar quando a morada
     mudar e o ponto ficar a apontar para a porta anterior. */
  let geo = null;
  if (d.latitude !== undefined && d.latitude !== null) {
    const { latitude, longitude } = lerCoordenadas(d.latitude, d.longitude);
    const fonte = GEO_FONTES.has(d.geoFonte) ? d.geoFonte : 'mao';
    /* A morada que fica agarrada ao ponto é a que o negócio VAI ter depois
       desta gravação — não a que tinha antes. Gravar a antiga punha o aviso da
       morada a disparar no pedido seguinte, sozinho. */
    const antes = await env.DB.prepare(
      'SELECT morada FROM negocios WHERE id = ?').bind(op.negocio_id).first();
    geo = {
      latitude, longitude, fonte,
      morada: corta(d.morada, 120) ?? (antes && antes.morada) ?? null,
    };
  }

  /* TIRAR DO MAPA é um pedido próprio, e não um `latitude: null` — com o
     `COALESCE` do UPDATE, mandar `null` quer dizer «não mexas nisto», que é o
     que faz o resto desta rota funcionar. Um campo que quer dizer duas coisas
     opostas conforme o contexto é o género de coisa que se descobre tarde.

     E CORRE DEPOIS DE TUDO ESTAR VALIDADO, não antes. Estava em cima, e um
     pedido com `apagarPonto` mais uma coordenada trocada apagava o ponto e
     respondia 400 — a pessoa lia «a latitude e a longitude estão trocadas» e
     ficava sem o que já lá estava. Nada se escreve antes de tudo passar. */
  if (d.apagarPonto) {
    await env.DB.prepare(
      `UPDATE negocios SET latitude = NULL, longitude = NULL, geo_fonte = NULL,
              geo_em = NULL, geo_morada = NULL WHERE id = ?`
    ).bind(op.negocio_id).run();
  }

  await env.DB.prepare(
    `UPDATE negocios SET nome = COALESCE(?, nome), cor = COALESCE(?, cor),
            morada = COALESCE(?, morada), localidade = COALESCE(?, localidade),
            telefone = COALESCE(?, telefone),
            latitude = COALESCE(?, latitude), longitude = COALESCE(?, longitude),
            geo_fonte = COALESCE(?, geo_fonte), geo_em = COALESCE(?, geo_em),
            geo_morada = COALESCE(?, geo_morada)
      WHERE id = ?`
  ).bind(nome, cor, corta(d.morada, 120), corta(d.localidade, 60),
         corta(d.telefone, 30),
         geo && geo.latitude, geo && geo.longitude,
         geo && geo.fonte, geo && agora(), geo && geo.morada,
         op.negocio_id).run();
  /* O nome e a cor vivem também na classe da Wallet. Sem isto, quem já tem o
     passe guardado fica a ver o nome antigo para sempre — e não volta a abrir
     a app para descobrir que mudou. */
  await espelharClassesDoNegocio(env, op.negocio_id, pedido, ctx);
  const depois = await env.DB.prepare(
    'SELECT * FROM negocios WHERE id = ?').bind(op.negocio_id).first();

  /* A MORADA MUDOU E O PONTO FICOU. Não se apaga a coordenada — o dono pode
     ter corrigido uma gralha com o alfinete já no sítio certo, e apagar-lhe o
     trabalho por causa de um acento seria pior do que o problema. Diz-se, e
     quem sabe decide. Compara-se com a folga de quem escreve à mão: sem
     maiúsculas e sem espaços a mais. */
  return { ...depois, moradaMudou: moradaEnvelheceu(depois) };
});

/**
 * A morada mudou desde que o ponto foi marcado?
 *
 * VIVE À PARTE porque tem de ser respondida nos DOIS sítios: na resposta ao
 * `PUT`, que é quando acontece, e no `GET` do negócio, que é o que o balcão
 * pede sempre que alguém abre o ecrã. Só na resposta do `PUT`, o aviso
 * aparecia uma vez e desaparecia à primeira recarga — e um aviso que não
 * sobrevive a fechar a app é um aviso que ninguém chega a ler.
 *
 * Compara-se com a folga de quem escreve à mão: sem maiúsculas e sem espaços a
 * mais. Um aviso a disparar por causa de um acento é um aviso que se aprende a
 * ignorar.
 */
function moradaEnvelheceu(negocio) {
  const arrumar = (s) => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase();
  return Boolean(negocio.latitude !== null && negocio.latitude !== undefined
    && negocio.geo_morada && negocio.morada
    && arrumar(negocio.geo_morada) !== arrumar(negocio.morada));
}

/** Segundos entre dois carimbos no mesmo cartão. Zero é válido: quer dizer
    «sem arrefecimento». Lixo não é, e o tecto é um dia. */
/**
 * O intervalo mínimo entre dois carimbos do mesmo cartão, em segundos.
 *
 * «NÃO FOI DITO» NÃO É ZERO, e era o que acontecia. `Number(null)` é 0, que é
 * finito e não é negativo — por isso escapava ao `if` e saía `Math.min(86400,
 * 0)`. O primeiro cartão de um negócio escapava por sorte, porque a fundação
 * escreve 3600 à mão; qualquer cartão criado DEPOIS nascia sem arrefecimento
 * nenhum, e o balcão nunca envia o campo.
 *
 * Um cartão sem arrefecimento é um cartão que se carimba dez vezes seguidas
 * com o telemóvel na mão. A defesa estava escrita, tinha nome, e devolvia o
 * contrário do que o nome diz.
 *
 * Zero continua a valer zero quando é DITO: um negócio que queira carimbar
 * sem intervalo manda `0`, e isso é uma escolha. O que não pode é o silêncio
 * ser lido como escolha.
 */
function arrefecimentoValido(valor) {
  if (valor === null || valor === undefined || valor === '') return 3600;
  const n = Number(valor);
  if (!Number.isFinite(n) || n < 0) return 3600;
  return Math.min(86400, Math.round(n));
}

/**
 * Os campos de um programa, limpos.
 *
 * Existe porque os dois ramos da rota — criar e actualizar — tinham cada um a
 * sua versão disto, e afastaram-se: o de actualização cortava o nome a 60 e o
 * prémio a 120, e o de criação escrevia `d.nome || 'Cartão'` em cru. As regras
 * não eram cortadas em nenhum dos dois. Duas cópias da mesma limpeza divergem
 * sempre; a defesa é não haver duas.
 *
 * O `tipo` é o que mais importa validar, e não é óbvio porquê: é ele que
 * decide, lá no carimbar, se a quantidade é forçada a 1. Um valor que não seja
 * «carimbos» nem «pontos» deixava a porta aberta a carimbos de quantidade
 * arbitrária.
 */
function camposDoPrograma(d, antigo = null) {
  const texto = (v, cai, max) => {
    const t = String(v ?? '').trim();
    return (t || String(cai ?? '')).slice(0, max);
  };
  const tipo = TIPOS.includes(d.tipo) ? d.tipo : (antigo ? antigo.tipo : 'carimbos');
  /* O selo é o nome de um ícone. Um nome que a app não conheça desenha nada —
     o que é feio mas inofensivo; o que não pode é ser um texto qualquer a
     caminho do HTML, nem ter tamanho livre. */
  const selo = /^[a-z][a-z0-9-]{0,19}$/.test(String(d.selo || ''))
    ? d.selo : (antigo ? antigo.selo : 'carimbo');
  return {
    nome: texto(d.nome, antigo ? antigo.nome : 'Cartão', 60),
    premio: texto(d.premio, antigo ? antigo.premio : 'Prémio', 120),
    /* As regras podem ficar vazias de propósito — mas não podem ser um
       romance: também vão para o cartão de toda a gente. */
    regras: (() => {
      const t = String(d.regras ?? (antigo ? antigo.regras : '') ?? '').trim();
      return t ? t.slice(0, 240) : null;
    })(),
    tipo,
    selo,
    objetivo: Math.max(2, Math.min(30, Math.round(Number(d.objetivo)) || (antigo ? antigo.objetivo : 10))),
    arrefecimento: arrefecimentoValido(d.arrefecimento ?? (antigo ? antigo.arrefecimento : null)),
    /* «Traz um amigo». Zero é ligado a zero — e é o valor de nascença: um
       programa que dá coisas sem o dono ter dito quanto tira-lhe dinheiro do
       bolso sem lhe perguntar. O tecto de três carimbos por lado não é gosto:
       é o que impede que um engano de teclado — «30» em vez de «3» — ofereça
       um cartão inteiro a cada amigo que entra pela porta. */
    amigoConvidador: entre0e3(d.amigoConvidador, antigo ? antigo.amigo_convidador : 0),
    amigoConvidado: entre0e3(d.amigoConvidado, antigo ? antigo.amigo_convidado : 0),
    amigoMax: Math.max(1, Math.min(50,
      Math.round(Number(d.amigoMax)) || (antigo ? antigo.amigo_max : 5) || 5)),
  };
}

/** Zero a três, com o valor antigo para quem não mandar nada. */
function entre0e3(valor, antigo = 0) {
  if (valor === undefined || valor === null || valor === '') return antigo || 0;
  const n = Math.round(Number(valor));
  if (!Number.isFinite(n)) return antigo || 0;
  return Math.max(0, Math.min(3, n));
}

/* =========================================================================
   A Wallet do telemóvel

   Aqui vive o que FALA com a Google. O que constrói e assina vive em
   `wallet.js`, que não conhece rede nenhuma — é essa separação que deixa a
   parte difícil ser provada sem conta, sem chave e sem Internet.

   A REGRA QUE MANDA EM TUDO ISTO: a Google é um ESPELHO, nunca a fonte da
   verdade. O carimbo grava-se no D1 aconteça o que acontecer; o passe é
   actualizado a seguir, fora do caminho da resposta, e se falhar fica para o
   reconciliador da madrugada. Um balcão com uma fila à frente não pode ficar
   à espera de um servidor em Mountain View, e um cliente não pode deixar de
   levar o carimbo porque a Google teve um mau dia.

   TUDO ISTO DORME ENQUANTO NÃO HOUVER CHAVES. Sem `GOOGLE_EMISSOR` e
   `GOOGLE_CHAVE`, as rotas respondem 404 e o botão não aparece na app. É o
   que permite ter isto publicado e em CI verde antes de existir uma conta.
   ========================================================================= */

const walletLigada = (env) => Boolean(env.GOOGLE_EMISSOR && env.GOOGLE_CHAVE && env.GOOGLE_EMAIL);

/* O endereço da API. Uma variável e não uma constante para os testes poderem
   apontá-lo a um servidor de mentira — é o que torna todo este caminho
   provável sem tocar na Google a sério. */
const googleBase = (env) => env.GOOGLE_API_BASE || 'https://walletobjects.googleapis.com';
const googleOAuth = (env) => env.GOOGLE_OAUTH_BASE || 'https://oauth2.googleapis.com';

/**
 * O testemunho de acesso, em cache.
 *
 * Não é optimização: o plano gratuito dá 50 SUBPEDIDOS por invocação, e sem
 * cache cada carimbo gastava dois — um para ir buscar o testemunho e outro
 * para o trabalho. Guarda-se em variável de módulo com a hora a que morre, e
 * reutiliza-se enquanto faltarem mais de cinco minutos.
 */
let tokenEmCache = null;

async function tokenGoogle(env) {
  const agoraS = Math.floor(Date.now() / 1000);
  if (tokenEmCache && tokenEmCache.expira - 300 > agoraS) return tokenEmCache.token;

  const jwt = await assinarRS256(env.GOOGLE_CHAVE, {
    iss: env.GOOGLE_EMAIL,
    scope: 'https://www.googleapis.com/auth/wallet_object.issuer',
    aud: `${googleOAuth(env)}/token`,
    iat: agoraS,
    exp: agoraS + 3600,
  });
  const r = await fetch(`${googleOAuth(env)}/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer',
      assertion: jwt,
    }),
  });
  if (!r.ok) throw new Error(`a Google recusou a chave (${r.status})`);
  const d = await r.json();
  tokenEmCache = { token: d.access_token, expira: agoraS + (Number(d.expires_in) || 3600) };
  return tokenEmCache.token;
}

async function googlePedir(env, caminho, { metodo = 'GET', corpo } = {}) {
  const token = await tokenGoogle(env);
  const r = await fetch(`${googleBase(env)}/walletobjects/v1${caminho}`, {
    method: metodo,
    headers: {
      authorization: `Bearer ${token}`,
      ...(corpo ? { 'content-type': 'application/json' } : {}),
    },
    body: corpo ? JSON.stringify(corpo) : undefined,
  });
  /* 409 é «já existe», e para uma classe isso é sucesso e não erro: duas
     pessoas a pedir o passe do mesmo café ao mesmo tempo criam-na as duas. */
  if (r.status === 409) return { jaExistia: true };
  if (!r.ok) {
    const texto = await r.text();
    throw new Error(`Google ${metodo} ${caminho}: ${r.status} ${texto.slice(0, 200)}`);
  }
  return r.json();
}

/**
 * SÃO DOIS DOMÍNIOS, e confundi-los custou um 400 da Google.
 *
 * O `DOMINIO` é onde vive o SITE — `carimbodigital.pt`, servido pelo GitHub
 * Pages. É esse que vai no `origins` do endereço de gravação, porque é de lá
 * que a pessoa carrega no botão.
 *
 * Mas o logótipo é servido pelo WORKER, que atende noutro endereço. Pôr o
 * domínio do site no `programLogo` dava «Image cannot be loaded. Invalid
 * image URL» — a Google ia buscar a imagem ao GitHub Pages, que não tem
 * rota `/v1/` nenhuma.
 *
 * Tira-se do próprio pedido em vez de se pôr numa variável: assim está sempre
 * certo, atenda o Worker onde atender, e não há um segundo sítio para
 * desactualizar no dia em que a API mudar de casa.
 */
const origemDaAPI = (pedido) => new URL(pedido.url).origin;

/**
 * A mesma origem, para quem NÃO tem pedido — o reconciliador do cron.
 *
 * É a única coisa neste ficheiro que repete, numa variável, algo que está
 * escrito noutro sítio. E uma coisa escrita em dois sítios desactualiza-se
 * num deles. Por isso não fica sozinha: o `confirmarOrigemDaAPI` compara-a
 * com a origem verdadeira sempre que passa um pedido de verdade por aqui.
 */
const origemDaAPIsemPedido = (env) =>
  (env.DOMINIO_API ? `https://${env.DOMINIO_API}` : null);

/** A guarda. Grita uma vez por pedido e não estraga nada se estiver errada. */
function confirmarOrigemDaAPI(env, origemReal) {
  const escrita = origemDaAPIsemPedido(env);
  if (escrita && origemReal && escrita !== origemReal) {
    console.error('wallet: DOMINIO_API está desactualizado —'
      + ` a variável diz ${escrita} e o pedido chegou a ${origemReal}.`
      + ' O reconciliador do cron vai escrever endereços de faixa que não existem.');
  }
}

/**
 * O endereço do logótipo, com a versão colada.
 *
 * O `?v=` não é enfeite: é o que faz a Google ver uma imagem nova. Ela guarda
 * o `programLogo` numa cache própria, à chave do ENDEREÇO — e este endereço
 * responde `immutable` por um ano, que é literalmente dizer-lhe «não voltes a
 * perguntar». Trocar o logótipo no D1 e recriar a classe não mexia nisso: a
 * Google continuava a servir os bytes do primeiro dia, e o cartão ficava com
 * o logótipo antigo para sempre, sem erro nenhum a dizer porquê.
 *
 * Medido: o logótipo do Titi mudou para branco-sobre-laranja no D1, a classe
 * foi recriada, e a cópia em `lh3.googleusercontent.com` continuava
 * transparente. Só um endereço diferente a obriga a ir buscar outra vez.
 *
 * A versão vem do `logotipo_em`, que já existia para isto e muda a cada
 * gravação. Os traços e os dois-pontos saem porque não acrescentam nada.
 */
/* =========================================================================
   A faixa, servida à Carteira da Google

   A GOOGLE NÃO RECEBE BYTES: recebe um ENDEREÇO, vai lá uma vez, e guarda a
   cópia para sempre. Já se mediu neste projecto com o logótipo do Titi — mudou
   na base, a classe foi recriada, e a cópia em `lh3.googleusercontent.com`
   continuou a ser a antiga. Só um endereço DIFERENTE a obriga a ir buscar
   outra vez. Por isso o saldo vai DENTRO do endereço, e não numa query: um
   endereço que descreve o seu próprio conteúdo pode responder `immutable` sem
   mentir.

   O ENDEREÇO DESCREVE O DESENHO, NÃO A PESSOA. Duas pessoas com sete carimbos
   no mesmo café partilham o mesmo endereço, byte a byte — e por isso o
   endereço não diz nada sobre ninguém. São no máximo `objetivo + 1` endereços
   por programa.

   E VAI ASSINADO. Desenhar custa milissegundos de CPU e a rota é aberta: sem
   selo, qualquer pessoa podia percorrer o espaço de endereços e gastar os
   100 000 pedidos diários do plano gratuito, que são partilhados com a API
   toda. O selo é um HMAC do próprio caminho com a chave-mestra — continua
   determinista, que é o que a cache da Google precisa.
   ========================================================================= */

/* As únicas medidas que se servem. Uma LISTA e não um intervalo: sem isto,
   um pedido de 4000×4000 era um pedido de 48 MB de memória e de muito mais
   CPU do que o tecto. */
/* A VERSÃO DO DESENHO, DENTRO DO ENDEREÇO.

   O endereço da faixa responde `immutable, max-age=31536000` — um ano — e a
   Google guarda a imagem à chave do endereço e não volta a perguntar. Isso é
   verdade e é de propósito: o endereço contém o ESTADO, por isso o que está
   por trás dele nunca muda.

   Só que o estado não é a única coisa que decide a imagem: o DESENHO também.
   No dia em que o desenho dos carimbos mudou — o aro passou a tracejado, a
   tinta passou a ser a mesma da app, a opacidade passou a ser medida no pixel
   — todos os endereços já emitidos continuavam a apontar para o desenho
   velho, e não havia nada que os fizesse actualizar. Os cartões novos ficavam
   bonitos e os antigos ficavam como estavam, para sempre.

   Um caractere no corpo assinado resolve: muda-se aqui, e todos os endereços
   passam a ser outros. Sobe-se sempre que o desenho mudar de forma visível.
   O `2` é o desenho a seguir ao original. */
const DESENHO_VERSAO = 'd2';

const FAIXAS_MEDIDAS = new Set([
  `${GOOGLE_HERO.largura}x${GOOGLE_HERO.altura}`,
  `${APPLE_STRIP.largura * 2}x${APPLE_STRIP.altura * 2}`,
]);

async function seloDaFaixa(env, caminho) {
  return base64url(await hmac(deBase64url(env.CHAVE_MESTRA), `faixa:${caminho}`)).slice(0, 12);
}

/**
 * O endereço da faixa de um cartão.
 *
 * NOS PONTOS VAI A PERCENTAGEM, e não o número. Um programa que dê um ponto
 * por euro gerava milhares de endereços distintos — e a barra só precisa de
 * posições relativas. São 101 posições, e quem quer o número lê-o no
 * `loyaltyPoints.balance`, que é texto a sério.
 *
 * E VAI O SELO. A Apple leva-o (`selo: prog.selo`) e este endereço não o
 * levava: o cartão da Google ficava com a chávena por omissão enquanto o da
 * Apple tinha a tesoura do barbeiro. O mesmo cartão com dois desenhos em duas
 * carteiras é o género de diferença que ninguém repara a escrever e toda a
 * gente repara a usar.
 */
async function enderecoDaFaixa(env, { cor, tipo, selo, feitos, objetivo, marcos }, origemAPI, medida) {
  if (!origemAPI) return null;
  const hex = /^#([0-9a-fA-F]{6})$/.test(String(cor || '')) ? String(cor).slice(1) : '17161C';
  /* O selo é validado contra a lista dos que existem: ele vai num caminho, e
     um caminho que aceite qualquer cadeia é um caminho por onde entra lixo. */
  const nomeSelo = SELOS.SELOS_NOMES.includes(String(selo)) ? String(selo) : 'carimbo';
  let desenho;
  if (tipo === 'pontos') {
    const lista = (marcos || [])
      .map((m) => Number(m && typeof m === 'object' ? m.pontos : m) || 0)
      .filter((v) => v > 0).sort((a, b) => a - b);
    if (!lista.length) return null;
    const alto = lista[lista.length - 1];
    const pct = Math.max(0, Math.min(100, Math.round((Number(feitos) || 0) * 100 / alto)));
    const pos = lista.map((m) => Math.round(m * 100 / alto)).join('.');
    desenho = `p-${hex}-${pct}-${pos}-x`;
  } else {
    const obj = Math.max(1, Math.min(60, Number(objetivo) || 10));
    const f = Math.max(0, Math.min(obj, Number(feitos) || 0));
    desenho = `c-${hex}-${f}-${obj}-${nomeSelo}`;
  }
  const corpo = `${desenho}-${DESENHO_VERSAO}-${medida}`;
  return `${origemAPI}/v1/faixa/${corpo}-${await seloDaFaixa(env, corpo)}.png`;
}

/**
 * A faixa de um cartão, pronta a pôr num `heroImage` da Google.
 *
 * Existe para os dois sítios que precisam dela — a criação do objecto e o
 * PATCH do saldo — escreverem exactamente o mesmo endereço. Escrito à mão nos
 * dois, bastava um esquecer o selo ou os marcos para o mesmo cartão ter dois
 * desenhos consoante o caminho por onde passou.
 *
 * Devolve `null` sem se queixar quando não há origem (o cron sem
 * `DOMINIO_API`) ou quando um programa de pontos não tem marcos nenhuns: aí
 * não há barra para desenhar, e um `heroImage` omitido deixa ficar o que lá
 * estava, que é melhor do que um endereço que responde 404.
 */
async function faixaDoCartao(env, cartao, programa, negocio, origemAPI) {
  if (!origemAPI || !cartao || !programa) return null;
  const prog = moldarPrograma(programa);
  /* Os marcos vivem noutra tabela e o `moldarPrograma` só os passa adiante se
     já lá estiverem. Num programa de pontos sem eles, o `enderecoDaFaixa`
     devolvia null e o cartão ficava sem desenho nenhum — silenciosamente. */
  if (prog.tipo === 'pontos' && !prog.marcos) {
    prog.marcos = (await env.DB.prepare(
      'SELECT pontos, premio FROM marcos WHERE programa_id = ? ORDER BY pontos'
    ).bind(programa.id).all()).results || [];
  }
  return enderecoDaFaixa(env, {
    cor: negocio && negocio.cor,
    tipo: prog.tipo === 'pontos' ? 'pontos' : 'carimbos',
    selo: prog.selo,
    feitos: prog.tipo === 'pontos' ? (cartao.pontos ?? 0) : (cartao.carimbos ?? 0),
    objetivo: prog.objetivo,
    marcos: prog.marcos,
  }, origemAPI, `${GOOGLE_HERO.largura}x${GOOGLE_HERO.altura}`);
}

function enderecoDoLogotipo(negocio, origemAPI) {
  if (!negocio || !negocio.logotipo) return null;
  const base = `${origemAPI}/v1/negocio/${negocio.slug}/logotipo`;
  const versao = String(negocio.logotipo_em || '').replace(/\D/g, '');
  return versao ? `${base}?v=${versao}` : base;
}

/** Garante que a classe do programa existe lá fora. Uma vez por programa. */
async function garantirClasse(env, programa, negocio, origemAPI) {
  if (programa.wallet_classe) return;
  const logotipo = enderecoDoLogotipo(negocio, origemAPI);
  const classe = classeDePrograma(programa, negocio, {
    emissor: env.GOOGLE_EMISSOR, logotipo,
  });
  const r = await googlePedir(env, '/loyaltyClass', { metodo: 'POST', corpo: classe });
  /* Se já existia lá fora, actualiza-se em vez de se dar por feito. O 409
     acontece de duas maneiras: duas pessoas a pedir o passe do mesmo café ao
     mesmo tempo, e — a que interessa — uma classe criada numa vida anterior,
     com dados que entretanto mudaram. Tratar o 409 como sucesso deixava a
     classe congelada no que tinha no dia em que nasceu, e sem forma de a
     corrigir a não ser à mão. */
  if (r && r.jaExistia) {
    /* O PATCH é o melhor esforço, e não uma condição. A classe EXISTE — é isso
       que o 409 diz — e é isso que faz falta para haver passe. Se a
       actualização falhar (a Google a não conseguir ir buscar o logótipo, um
       503 do lado dela), deixar a excepção subir cancelava o passe da pessoa
       que está a tocar no botão E impedia o `wallet_classe` de ser gravado —
       o que punha a tentativa seguinte a repetir tudo, para sempre. O que
       ficar por actualizar é apanhado pelo `espelharClasse`, que corre a cada
       mudança de nome, de cor ou de logótipo. */
    try {
      await googlePedir(env, `/loyaltyClass/${env.GOOGLE_EMISSOR}.${programa.id}`, {
        metodo: 'PATCH', corpo: actualizacaoDeClasse(programa, negocio, { logotipo }),
      });
    } catch (erro) {
      /* A classe EXISTE — é isso que o 409 diz — por isso o passe pode sair, e
         é por isso que não se deixa a excepção subir. Mas NÃO se carimba o
         `wallet_classe`: o `garantirClasse` começa por `if (wallet_classe)
         return`, e carimbá-lo aqui fechava para sempre a única porta que
         voltaria a tentar esta actualização. A classe ficaria com os dados de
         uma vida anterior — o nome antigo do café — e ninguém teria por onde
         a corrigir.

         Sem o carimbo, a próxima pessoa que peça o passe repete o POST (que dá
         409 outra vez, barato) e volta a tentar o PATCH. */
      console.error('wallet: a classe existe mas não deu para actualizar',
        programa.id, String(erro));
      return;
    }
  }
  await env.DB.prepare('UPDATE programas SET wallet_classe = ? WHERE id = ?')
    .bind(agora(), programa.id).run();
}

/**
 * O passe de um cartão: cria-o lá fora e devolve o endereço que o guarda.
 *
 * O objecto é criado por REST ANTES de se assinar o endereço, e não vai dentro
 * dele. É isso que mantém o endereço nos setecentos caracteres em vez de
 * passar do tecto dos mil e oitocentos — e acima desse tecto o browser
 * corta-o, e a gravação não acontece sem dar erro nenhum.
 */
rota('POST', /^\/v1\/cliente\/cartoes\/([\w-]+)\/wallet$/, async (env, pedido, [cartaoId]) => {
  if (!walletLigada(env)) throw new Falha('Não existe', { estado: 404 });
  const clienteId = await exigirCliente(env, pedido);

  const cartao = await env.DB.prepare(
    'SELECT * FROM cartoes WHERE id = ? AND cliente_id = ?'
  ).bind(cartaoId, clienteId).first();
  if (!cartao) throw new Falha('Cartão não encontrado', { estado: 404 });

  const programa = await env.DB.prepare('SELECT * FROM programas WHERE id = ?')
    .bind(cartao.programa_id).first();
  const negocio = await env.DB.prepare('SELECT * FROM negocios WHERE id = ?')
    .bind(cartao.negocio_id).first();
  if (!negocio || !negocio.logotipo) {
    throw new Falha('Este negócio ainda não tem logótipo, e a Wallet exige um.',
      { estado: 409, codigo: 'sem-logotipo' });
  }

  await garantirClasse(env, programa, negocio, origemDaAPI(pedido));

  /* O código do passe nasce uma vez e fica. É ele que vai no código de barras
     e é por ele que o balcão reconhece o passe — se mudasse, os passes já
     guardados deixavam de servir. */
  const codigo = cartao.wallet_codigo || publicoNovo(16);
  const objeto = objetoDeCartao(cartao, programa, {
    emissor: env.GOOGLE_EMISSOR, codigo,
    faixa: await faixaDoCartao(env, cartao, programa, negocio, origemDaAPI(pedido)),
  });
  await googlePedir(env, '/loyaltyObject', { metodo: 'POST', corpo: objeto });

  await env.DB.prepare(
    'UPDATE cartoes SET wallet_codigo = ?, wallet_em = ?, wallet_sincronizado = ? WHERE id = ?'
  ).bind(codigo, cartao.wallet_em || agora(), agora(), cartao.id).run();

  const { ligacao } = await ligacaoDeGravacao(env.GOOGLE_CHAVE, {
    emissorEmail: env.GOOGLE_EMAIL,
    objeto,
    origem: `https://${env.DOMINIO || 'carimbodigital.pt'}`,
  });
  return { ligacao };
});

/**
 * Manda para a Google o que mudou na CLASSE — nome, cor, prémio, logótipo.
 *
 * Sem isto, a classe era escrita uma vez e nunca mais: o dono mudava o nome do
 * cartão no balcão e quem tivesse o passe guardado continuava a ver o antigo,
 * para sempre. Quem tem o passe não volta a abrir a app — o que ele vê é o que
 * a Google tem.
 *
 * Como o espelho do saldo, corre fora do caminho da resposta e engole o erro:
 * gravar o nome novo no D1 não pode falhar porque a Google não respondeu.
 */
/** Todas as classes de um negócio — o nome, a cor e o logótipo são dele. */
async function espelharClassesDoNegocio(env, negocioId, pedido, ctx) {
  if (!walletLigada(env) || !ctx) return;
  const ps = (await env.DB.prepare(
    'SELECT id FROM programas WHERE negocio_id = ? AND wallet_classe IS NOT NULL'
  ).bind(negocioId).all()).results;
  /* NENHUMA CLASSE É O CASO NORMAL, e não uma excepção: um negócio só tem
     classe na Google depois de alguém pôr um cartão dele na Carteira. Sem esta
     linha, o `const [primeira] = ps` que está em baixo apanhava `undefined` e
     o `primeira.id` atirava DENTRO do `waitUntil` — depois de a resposta já ter
     saído, portanto sem ninguém notar. Ficava um erro por atender no registo a
     cada gravação de um negócio novo, e é assim que o registo deixa de servir
     para encontrar o erro seguinte. */
  if (!ps.length) return;
  const origem = origemDaAPI(pedido);
  /* A PRIMEIRA SOZINHA, AS OUTRAS JUNTAS.

     Doze tarefas a arrancar ao mesmo tempo vêem a cache do testemunho fria as
     doze e fazem doze pedidos de OAuth em paralelo — que a Google estrangula,
     e que gastam doze dos cinquenta subpedidos que o plano gratuito dá por
     invocação. Mas pô-las todas em FILA era o extremo oposto: o orçamento do
     `waitUntil` é tempo de relógio, e com a Google lenta as primeiras
     gastavam-no todo e as últimas nem chegavam a ser tentadas.

     A primeira corre sozinha e aquece a cache; as restantes vão juntas e
     aproveitam-na. Uma espera em vez de doze, e uma janela partilhada em vez
     de uma corrida. */
  ctx.waitUntil((async () => {
    const [primeira, ...resto] = ps;
    await espelharClasse(env, primeira.id, origem);
    await Promise.all(resto.map((p) => espelharClasse(env, p.id, origem)));
  })());
}

async function espelharClasse(env, programaId, origemAPI) {
  if (!walletLigada(env)) return;
  try {
    const p = await env.DB.prepare('SELECT * FROM programas WHERE id = ?').bind(programaId).first();
    if (!p || !p.wallet_classe) return;
    const n = await env.DB.prepare('SELECT * FROM negocios WHERE id = ?').bind(p.negocio_id).first();
    await googlePedir(env, `/loyaltyClass/${env.GOOGLE_EMISSOR}.${p.id}`, {
      metodo: 'PATCH',
      corpo: actualizacaoDeClasse(p, n, { logotipo: enderecoDoLogotipo(n, origemAPI) }),
    });
  } catch (erro) {
    console.error('wallet: não deu para actualizar a classe', programaId, String(erro));
  }
}

/**
 * Manda o saldo novo para a Google, sem fazer ninguém esperar.
 *
 * Chamado com `ctx.waitUntil()` a partir de carimbar, resgatar e anular. O
 * erro é engolido de propósito e registado: o carimbo já está gravado no D1, e
 * o que falhar aqui é apanhado pelo reconciliador da madrugada. Fazer o
 * carimbo falhar porque a Google não respondeu seria deixar o cliente sem o
 * seu café por causa de uma coisa que ele nem sabe que existe.
 */
/**
 * Marca um cartão para o passe da Apple ser avisado.
 *
 * SÓ MARCA. O aviso sai no cron, e a razão é aritmética: uma invocação de
 * Worker tem tecto de CINQUENTA subpedidos, e um push é um subpedido POR
 * APARELHO. Uma pessoa com iPhone, iPad e relógio são três; uma família são
 * dez. Mandá-los dentro do pedido do balcão era pôr o carimbo — a coisa que o
 * cliente está ali a fazer — a depender de quantos aparelhos alguém tem.
 *
 * Custa até um minuto de atraso no toque. Ganha um carimbo que nunca falha
 * por causa de uma coisa que o cliente nem sabe que existe.
 *
 * E escreve TAMBÉM o `apple_actualizado`, que é a etiqueta que o protocolo
 * compara: sem ela o iPhone vinha, perguntava o que tinha mudado, e a resposta
 * era «nada» — o push saía, chegava, e não acontecia coisa nenhuma.
 */
async function marcarPasseDaApple(env, cartaoId) {
  if (!applePronta(env)) return;
  try {
    const cartao = await env.DB.prepare(
      'SELECT apple_servico FROM cartoes WHERE id = ?').bind(cartaoId).first();
    /* Um passe emitido ANTES de isto existir não tem `webServiceURL` lá
       dentro: nenhum aparelho se registou para ele e nenhum se vai registar.
       Marcá-lo era encher uma fila com trabalho que nunca ninguém vem buscar. */
    if (!cartao || !cartao.apple_servico) return;
    await env.DB.batch([
      env.DB.prepare('UPDATE cartoes SET apple_actualizado = ? WHERE id = ?')
        .bind(Math.floor(Date.now() / 1000), cartaoId),
      env.DB.prepare(
        `INSERT INTO wallet_por_avisar (serial, marcado_em) VALUES (?, ?)
         ON CONFLICT(serial) DO UPDATE SET marcado_em = excluded.marcado_em`
      ).bind(cartaoId, agora()),
    ]);

    /* E AGORA O TOQUE, JÁ — mas com tecto.

       Marcar e esperar pelo cron dava até um minuto de atraso, e «actualiza-se
       sozinho» com um minuto de atraso é a pessoa a olhar para a carteira ao
       balcão e a ver o número velho. Quem tem UM telemóvel — que é quase toda
       a gente — merece o toque no mesmo segundo.

       O tecto de CINCO é o que separa isto do defeito que a fila veio evitar:
       uma invocação tem cinquenta subpedidos, o carimbo já gasta uns quinze, e
       cinco pushes deixam folga de sobra. Quem tiver mais aparelhos do que isso
       — uma família com iPads e relógios — fica na fila e é o cron que trata,
       sem que o carimbo corra risco nenhum.

       A linha só sai da fila se TODOS os aparelhos tiverem sido tocados. Em
       desenvolvimento isto falha sempre (o workerd local não faz HTTP/2 e a
       APNs é HTTP/2), e falhar deixa a linha na fila — que é exactamente o
       comportamento certo. */
    if (apnsLigada(env)) {
      const quantos = await env.DB.prepare(
        'SELECT COUNT(*) AS n FROM wallet_registos WHERE serial = ?').bind(cartaoId).first();
      const total = Number(quantos && quantos.n) || 0;
      if (total > 0 && total <= AVISO_INLINE) {
        const r = await avisarAparelhos(env, cartaoId, { tecto: AVISO_INLINE });
        if (r.tocados + r.mortos >= total) {
          await env.DB.prepare('DELETE FROM wallet_por_avisar WHERE serial = ?')
            .bind(cartaoId).run();
        }
      }
    }
  } catch (erro) {
    console.error('wallet(apple): não deu para marcar', cartaoId, String(erro));
  }
}

/* Quantos aparelhos se toca DENTRO do pedido do balcão. Acima disto, fica
   para o cron. Ver a explicação no corpo da função. */
const AVISO_INLINE = 5;

/**
 * Drena a fila dos que ficaram por avisar.
 *
 * Corre de minuto a minuto. O que apanha é pouco e raro: cartões com muitos
 * aparelhos, e os que falharam porque a APNs não respondeu. Um cartão que
 * falhe fica na fila e volta no minuto seguinte — e é isso que torna a
 * promessa verdadeira mesmo quando a Apple tem um mau dia.
 *
 * AOS BOCADOS, como o reconciliador da Google e pela mesma razão: cinquenta
 * subpedidos por invocação, e cada push é um.
 */
async function drenarAvisosDaApple(env) {
  if (!apnsLigada(env)) return { feitos: 0 };
  let feitos = 0;
  const fila = (await env.DB.prepare(
    'SELECT serial FROM wallet_por_avisar ORDER BY marcado_em LIMIT 8').all()).results || [];
  for (const linha of fila) {
    try {
      await avisarAparelhos(env, linha.serial, { tecto: 5 });
      await env.DB.prepare('DELETE FROM wallet_por_avisar WHERE serial = ?')
        .bind(linha.serial).run();
      feitos += 1;
    } catch (erro) {
      /* FICA NA FILA. Apagar aqui era transformar uma falha de rede num
         cartão que nunca mais se actualiza — e sem nada no ecrã a dizê-lo. */
      console.error('wallet(apple): a fila falhou em', linha.serial, String(erro));
    }
  }
  return { feitos };
}

async function espelharNaWallet(env, cartaoId, { notificar = false, origemAPI } = {}) {
  if (!walletLigada(env)) return;
  confirmarOrigemDaAPI(env, origemAPI);
  try {
    const cartao = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartaoId).first();
    if (!cartao || !cartao.wallet_em || !cartao.wallet_codigo) return;
    const programa = await env.DB.prepare('SELECT * FROM programas WHERE id = ?')
      .bind(cartao.programa_id).first();
    const negocio = await env.DB.prepare('SELECT * FROM negocios WHERE id = ?')
      .bind(cartao.negocio_id).first();
    /* A faixa TEM de ir no mesmo PATCH que o saldo. Se fosse só o número, o
       cartão na carteira ficava a dizer «8 de 10» por cima de sete carimbos
       desenhados — e a Google guarda a imagem à chave do endereço, para
       sempre, por isso nada a mandaria buscar outra vez. */
    const faixa = await faixaDoCartao(env, cartao, programa, negocio,
      origemAPI || origemDaAPIsemPedido(env));
    await googlePedir(env, `/loyaltyObject/${env.GOOGLE_EMISSOR}.${cartao.id}`, {
      metodo: 'PATCH',
      corpo: actualizacaoDeSaldo(cartao, programa, { notificar, faixa }),
    });
    await env.DB.prepare('UPDATE cartoes SET wallet_sincronizado = ? WHERE id = ?')
      .bind(agora(), cartao.id).run();
  } catch (erro) {
    console.error('wallet: não deu para actualizar', cartaoId, String(erro));
  }
}

/* =========================================================================
   O logótipo do negócio

   A coluna existia desde o primeiro dia e nunca ninguém lhe tocou. Passou a
   ser precisa porque a classe de fidelização da Google exige um `programLogo`,
   e esse campo quer um ENDEREÇO público — não um ficheiro nem um data URI.
   Daí haver aqui duas rotas: uma para o dono o gravar, e outra, aberta, que o
   serve como imagem.

   Guarda-se em base64 no D1 e não noutro lado nenhum. É o que evita mais um
   serviço, mais uma chave e mais um terceiro na página de privacidade — e
   estamos a falar de uma imagem quadrada de 512 px por negócio, que são umas
   dezenas de kilobytes. A redução acontece no browser antes de subir: mandar
   para aqui a fotografia de quatro megapixéis que o telemóvel tirou seria
   gastar o tecto do pedido e a paciência de quem está a usar dados móveis.
   ========================================================================= */

/* Os bytes iniciais que um PNG e um JPEG têm sempre. Não se confia na
   extensão nem no que o browser diz que é: confia-se nos bytes, como o
   `enviar-fotos` de outro projecto aprendeu a fazer. */
function tipoDaImagem(base64) {
  const cabeca = atob(base64.slice(0, 32));
  const b = Array.from(cabeca, (c) => c.charCodeAt(0));
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4E && b[3] === 0x47) return 'image/png';
  if (b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF) return 'image/jpeg';
  return null;
}

rota('PUT', '/v1/balcao/logotipo', async (env, pedido, _p, ctx) => {
  const op = await exigirOperador(env, pedido);
  if (op.papel !== 'dono') throw new Falha('Só o dono pode mudar isto', { estado: 403 });
  const d = await corpoJSON(pedido, LOGOTIPO_MAX);

  /* Apagar é pôr a null, e não uma rota à parte: é o mesmo gesto do lado de
     quem usa — «tirar a imagem». */
  if (d.logotipo === null || d.logotipo === '') {
    /* NÃO SE APAGA UM LOGÓTIPO QUE JÁ ESTÁ EM CARTEIRAS ALHEIAS.

       Apagar punha a coluna a NULL e mandava o espelho para a Google — só
       que o corpo do PATCH só inclui o `programLogo` se houver um, e um
       PATCH que OMITE um campo deixa lá o valor antigo. O resultado era o
       pior dos dois: o endereço público passava a dar 404, a app deixava de
       mostrar o botão, e o logótipo apagado continuava no cartão de toda a
       gente que já o tinha guardado — sem gesto nenhum na interface que o
       tirasse de lá. E a Google nem sequer o releria: guarda a imagem numa
       cache própria.

       Também não se pode simplesmente mandar vazio: a classe de fidelização
       EXIGE um logótipo, e uma classe sem ele é recusada. O que resta é a
       verdade — trocar, não apagar. */
    const publicada = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM programas WHERE negocio_id = ? AND wallet_classe IS NOT NULL'
    ).bind(op.negocio_id).first();
    if (publicada && publicada.n > 0) {
      throw new Falha(
        'Este logótipo já está em cartões guardados na carteira de clientes, '
        + 'e essas carteiras não o largam. Troca a imagem por outra em vez de a tirar.',
        { estado: 409, codigo: 'logotipo-publicado' });
    }
    await env.DB.prepare(
      'UPDATE negocios SET logotipo = NULL, logotipo_em = NULL, logotipo_fundo = NULL WHERE id = ?'
    ).bind(op.negocio_id).run();
    await espelharClassesDoNegocio(env, op.negocio_id, pedido, ctx);
    return { logotipo: null };
  }

  const bruto = String(d.logotipo || '');
  /* Aceita-se com ou sem o prefixo `data:`, porque o `canvas.toDataURL()` do
     browser dá-o com prefixo e é de lá que isto vem. */
  const base64 = bruto.includes(',') ? bruto.slice(bruto.indexOf(',') + 1) : bruto;
  if (!/^[A-Za-z0-9+/=]+$/.test(base64) || base64.length < 64) {
    throw new Falha('Isso não é uma imagem.', { estado: 400, codigo: 'imagem' });
  }
  if (base64.length > LOGOTIPO_MAX) {
    throw new Falha('A imagem é demasiado grande. Escolhe uma mais pequena.',
      { estado: 413, codigo: 'grande' });
  }
  const tipo = tipoDaImagem(base64);
  if (!tipo) throw new Falha('Só se aceita PNG ou JPEG.', { estado: 400, codigo: 'imagem' });

  /* A cor cozida vem do balcão, que é quem a pintou. Sem ela não há como
     saber, mais tarde, que a imagem deixou de condizer com o cartão. */
  const fundo = /^#[0-9a-fA-F]{6}$/.test(String(d.fundo || '')) ? d.fundo : null;
  await env.DB.prepare(
    'UPDATE negocios SET logotipo = ?, logotipo_em = ?, logotipo_fundo = ? WHERE id = ?'
  ).bind(`${tipo};${base64}`, agora(), fundo, op.negocio_id).run();
  await espelharClassesDoNegocio(env, op.negocio_id, pedido, ctx);
  return { logotipo: true, tipo, fundo };
});

/* Aberta, de propósito: é este endereço que vai dentro do passe da Wallet, e
   quem o abre é a Google e o telemóvel de quem tiver o cartão. Não há aqui
   nada de privado — é a marca de um estabelecimento, que está na montra. */
/* A faixa em si. Aberta e assinada — ver o comentário do `enderecoDaFaixa`. */
/* A CLASSE ACEITA MAIÚSCULAS E `_`, e a primeira versão não aceitava.
   O endereço leva o hexadecimal da cor (`EE9125`) e um selo em base64url, que
   usa o alfabeto inteiro mais `-` e `_`. Com `[a-z0-9.-]` o caminho nunca
   casava, a rota nem era chamada, e o que se via era um 404 — igual ao 404 de
   um selo errado. Ou seja: as afirmações de RECUSA passavam todas, e teria
   ficado convencido de que a rota estava provada. Foi a afirmação de SUCESSO
   que a apanhou. */
rota('GET', /^\/v1\/faixa\/([A-Za-z0-9._-]{1,140})\.png$/, async (env, pedido, [nome]) => {
  /* O CORTE É PELA POSIÇÃO, E NÃO PELO ÚLTIMO HÍFEN.

     Estava `lastIndexOf('-')`, e o selo é base64url — um alfabeto que INCLUI
     o hífen. Um selo de 12 caracteres tem 17,2% de probabilidade de conter
     pelo menos um: nesses casos o corte caía dentro do próprio selo, o corpo
     ficava com um pedaço dele colado, e a rota devolvia 404 a um endereço que
     ela própria tinha assinado.

     Em produção isso é um em cada seis cartões da Wallet do Google a ficar
     sem desenho nenhum — e para sempre, porque a Google guarda o resultado à
     chave do endereço. E não dava erro em lado nenhum: dava uma imagem que
     não carrega.

     O CI apanhou-o porque a chave-mestra é sorteada a cada corrida e um dia
     saiu uma que produzia um selo com hífen. Cinco corridas verdes antes
     disso não provaram nada: a falha era de um em seis, e eu teria lido o
     vermelho como «o CI está instável». O teste passou a forçar o caso.

     O selo tem sempre 12 caracteres e vem sempre a seguir a um hífen, por
     isso a posição é fixa e não depende do que lá está dentro. */
  const SELO_TAMANHO = 12;
  if (nome.length < SELO_TAMANHO + 2 || nome[nome.length - SELO_TAMANHO - 1] !== '-') {
    throw new Falha('Não existe', { estado: 404 });
  }
  const corpo = nome.slice(0, -(SELO_TAMANHO + 1));
  const selo = nome.slice(-SELO_TAMANHO);

  /* COMPARAÇÃO EM TEMPO CONSTANTE, como a do bilhete do passe. Um `===` sobre
     um HMAC vaza o tamanho do prefixo certo pelo tempo que demora a falhar. */
  const esperado = await seloDaFaixa(env, corpo);
  if (selo.length !== esperado.length) throw new Falha('Não existe', { estado: 404 });
  let diferenca = 0;
  for (let i = 0; i < selo.length; i += 1) {
    diferenca |= selo.charCodeAt(i) ^ esperado.charCodeAt(i);
  }
  if (diferenca) throw new Falha('Não existe', { estado: 404 });

  /* O `d\d+` é a versão do desenho — ver `DESENHO_VERSAO`. Aceita-se QUALQUER
     versão e não só a actual: um endereço de uma versão antiga que ainda ande
     em cache na Google tem de continuar a servir alguma coisa, e o que se
     serve é o desenho de hoje. Recusá-lo dava uma imagem partida num cartão
     que estava bem na véspera. */
  const p = /^([cp])-([0-9a-fA-F]{6})-(\d{1,5})-([\d.]{1,40}|\d{1,3})-([a-z]{1,12})-d(\d{1,2})-(\d{2,4}x\d{2,4})$/.exec(corpo);
  if (!p || !FAIXAS_MEDIDAS.has(p[7])) throw new Falha('Não existe', { estado: 404 });
  const [largura, altura] = p[7].split('x').map(Number);
  const feitos = Number(p[3]);
  const args = p[1] === 'p'
    ? { tipo: 'pontos', feitos,
        marcos: p[4].split('.').slice(0, 8).map((v) => ({ pontos: Number(v) })) }
    : { tipo: 'carimbos', feitos, objetivo: Number(p[4]), selo: p[5] };
  if (p[1] === 'c' && (args.objetivo < 1 || args.objetivo > 60 || feitos > args.objetivo)) {
    throw new Falha('Não existe', { estado: 404 });
  }

  const { bytes } = await faixaDeCartao({ cor: `#${p[2]}`, largura, altura, selos: SELOS, ...args });
  return new Response(bytes, {
    headers: {
      'content-type': 'image/png',
      /* O ENDEREÇO CONTÉM O ESTADO, por isso o que está por trás dele nunca
         muda. O `immutable` aqui é a verdade e não uma optimização — e é
         justamente o que impede a Google de servir a faixa de ontem depois de
         o saldo mudar, porque amanhã o endereço é outro. */
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
});

rota('GET', /^\/v1\/negocio\/([a-z0-9-]{1,40})\/logotipo$/, async (env, pedido, [slug]) => {
  const n = await env.DB.prepare(
    "SELECT logotipo FROM negocios WHERE slug = ? AND estado = 'ativo'"
  ).bind(slug).first();
  if (!n || !n.logotipo) throw new Falha('Sem logótipo', { estado: 404 });
  const [tipo, base64] = [n.logotipo.slice(0, n.logotipo.indexOf(';')),
                          n.logotipo.slice(n.logotipo.indexOf(';') + 1)];
  const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
  return new Response(bytes, {
    headers: {
      'content-type': tipo,
      /* Um ano, e `immutable` a sério: quem escreve o endereço cola-lhe o
         `?v=` do `logotipo_em` (ver `enderecoDoLogotipo`), por isso a imagem
         por detrás de um endereço destes nunca muda. Já foi ao contrário —
         endereço estável e conteúdo a mudar — e custou um logótipo velho
         preso na cache da Google, que honra o `immutable` à letra. */
      'cache-control': 'public, max-age=31536000, immutable',
    },
  });
});

/* =========================================================================
   O cartão na Apple Wallet

   O MESMO PORTÃO DA GOOGLE: enquanto os segredos não existirem, estas rotas
   respondiam 404 e o botão não aparecia na app — é o que permitiu ter isto
   publicado e provado antes de haver certificado.

   O CAMINHO É EM DOIS TEMPOS, e não por gosto. Um `.pkpass` só chega à
   carteira se o telemóvel NAVEGAR para ele — é o Safari que reconhece o tipo
   do ficheiro e abre o «Adicionar à Wallet». Uma navegação não leva cabeçalho
   `authorization` nenhum, por isso a rota que serve os bytes tem de ser
   aberta. Se fosse aberta e o endereço fosse o do cartão, qualquer pessoa
   descarregava o passe de qualquer pessoa.

   Daí o bilhete: o primeiro pedido é autenticado e devolve um endereço com um
   bilhete assinado lá dentro; o segundo abre-o. O bilhete vale minutos, diz
   de que cartão é, e é assinado com a CHAVE_MESTRA — não se guarda em lado
   nenhum, o que também evita mais uma tabela a limpar de madrugada.
   ========================================================================= */

const applePronta = (env) => Boolean(
  env.APPLE_CERTIFICADO && env.APPLE_CHAVE && env.APPLE_PASS_TIPO && env.APPLE_EQUIPA);

/* Minutos. Chega para tocar no botão e o telemóvel ir buscar o ficheiro; e é
   pouco para um endereço que apareça num registo ou numa captura de ecrã. */
const BILHETE_MINUTOS = 10;

async function bilheteDoPasse(env, cartaoId) {
  const expira = Date.now() + BILHETE_MINUTOS * 60000;
  const corpo = `${cartaoId}.${expira}`;
  const mestra = deBase64url(env.CHAVE_MESTRA);
  return `${base64url(new TextEncoder().encode(corpo))}.${base64url(await hmac(mestra, corpo))}`;
}

async function lerBilhete(env, bilhete) {
  const [parte, selo] = String(bilhete || '').split('.');
  if (!parte || !selo) return null;
  /* O `deBase64url` ATIRA com entrada que não seja base64 — e um bilhete
     truncado (um endereço partido a meio por um cliente de email, por
     exemplo) é exactamente isso. Sem este try, o que saía era um 500 «Erro
     interno» em vez do 403 com a frase que foi escrita para este caso. */
  let corpo;
  try { corpo = new TextDecoder().decode(deBase64url(parte)); }
  catch { return null; }
  const esperado = base64url(await hmac(deBase64url(env.CHAVE_MESTRA), corpo));
  /* Comparação de tempo constante. Um `!==` sobre textos devolve mais depressa
     quanto mais cedo diferirem, e isso chega para adivinhar um selo byte a
     byte se houver paciência. */
  if (selo.length !== esperado.length) return null;
  let diferenca = 0;
  for (let i = 0; i < selo.length; i += 1) diferenca |= selo.charCodeAt(i) ^ esperado.charCodeAt(i);
  if (diferenca !== 0) return null;
  const corte = corpo.lastIndexOf('.');
  const expira = Number(corpo.slice(corte + 1));
  if (!Number.isFinite(expira) || expira < Date.now()) return null;
  return corpo.slice(0, corte);
}

/**
 * O certificado da Apple está a chegar ao fim?
 *
 * Corre na limpeza da madrugada e não faz nada a não ser escrever. É o único
 * sítio do produto que olha para uma data que, quando passar, não dá erro
 * nenhum do lado de cá — só um cliente com um passe que o iPhone recusa.
 *
 * Trinta dias chegam para emitir outro no portal sem pressa: o CSR já existe e
 * o resto é um comando. Abaixo de sete, sobe a voz.
 *
 * Nunca rebenta: isto corre dentro do `scheduled`, e uma excepção aqui levava
 * à frente a limpeza toda que corre antes.
 */
function avisarDoCertificado(env) {
  try {
    if (!applePronta(env)) return;
    const certs = certificadosDoPEM(env.APPLE_CERTIFICADO, 'APPLE_CERTIFICADO');
    const ate = certs.length ? validadeDoCertificado(certs[0]) : null;
    if (!ate) return;
    const dias = Math.floor((ate.getTime() - Date.now()) / 86400000);
    const quando = ate.toISOString().slice(0, 10);
    if (dias < 0) {
      console.error(`apple: O CERTIFICADO CADUCOU em ${quando}. Não saem passes novos.`);
    } else if (dias <= 7) {
      console.error(`apple: o certificado caduca em ${dias} dias (${quando}). Renovar já.`);
    } else if (dias <= 30) {
      console.warn(`apple: o certificado caduca daqui a ${dias} dias (${quando}).`);
    }
  } catch (erro) {
    console.error('apple: não deu para ler a validade do certificado', String(erro));
  }
}

/**
 * Os segredos da Apple servem mesmo para assinar?
 *
 * O `applePronta` responde a «estão preenchidos?», que é outra pergunta. Isto
 * responde à de verdade, e responde barato: lê o certificado e importa a
 * chave, sem assinar nada. Serve para o erro sair no POST — onde a app o
 * apanha e o mostra — em vez de sair no GET, que é uma navegação do Safari e
 * onde um erro é um ecrã com JSON em cima.
 */
async function verificarSegredosApple(env) {
  try {
    const certs = certificadosDoPEM(env.APPLE_CERTIFICADO, 'APPLE_CERTIFICADO');
    if (!certs.length) throw new Error('não há certificado nenhum em APPLE_CERTIFICADO');
    emissorESerie(certs[0]);

    /* CADUCADO DIZ-SE COM ESSA PALAVRA. Um Pass Type ID Certificate dura pouco
       mais de um ano e, no dia seguinte, nada aqui dava erro: a assinatura
       continuava a ser feita, o ficheiro continuava a sair, e quem descobria
       era um cliente cujo iPhone o recusava ao balcão — longe daqui e sem
       registo nosso. Agora a rota recusa antes, com a data escrita, que é a
       diferença entre «alguém renova isto hoje» e uma semana a adivinhar.

       Não se refuta o que não se conseguiu ler: um parser que se engane não
       pode desligar o produto, por isso `null` passa. */
    const ate = validadeDoCertificado(certs[0]);
    if (ate && ate.getTime() < Date.now()) {
      throw new Error(`o certificado da Apple caducou em ${ate.toISOString().slice(0, 10)} `
        + '— é preciso emitir outro no portal e voltar a pôr APPLE_CERTIFICADO');
    }
    if (env.APPLE_CADEIA) certificadosDoPEM(env.APPLE_CADEIA, 'APPLE_CADEIA');
    await crypto.subtle.importKey('pkcs8', doPEM(env.APPLE_CHAVE),
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['sign']);
  } catch (erro) {
    /* A mensagem vai inteira de propósito: quem a lê é quem pôs os segredos,
       e «Erro interno» não ajuda ninguém a perceber que a chave está no
       formato errado. Não leva segredo nenhum lá dentro — só o diagnóstico. */
    throw new Falha(`Os segredos da Apple não servem para assinar: ${erro.message}`,
      { estado: 500, codigo: 'apple-mal-configurada' });
  }
}

/**
 * As peças de um passe, e as razões por que ele pode não existir.
 *
 * Separado do `passeDoCartao` porque o POST só precisa de SABER se o passe é
 * possível — construí-lo para o deitar fora custa o dobro. A assinatura é RSA
 * de 2048 bits e o logótipo são dezenas de kilobytes a passar de base64 para
 * bytes; o tecto de CPU de uma invocação no plano gratuito são dez
 * milissegundos, e o «adicionar à carteira» fazia essa conta DUAS vezes: uma
 * no POST, que deitava fora, e outra no GET, que serve.
 */
async function pecasDoPasse(env, cartaoId) {
  const cartao = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartaoId).first();
  if (!cartao) throw new Falha('Cartão não encontrado', { estado: 404 });
  const programa = await env.DB.prepare('SELECT * FROM programas WHERE id = ?')
    .bind(cartao.programa_id).first();
  const negocio = await env.DB.prepare('SELECT * FROM negocios WHERE id = ?')
    .bind(cartao.negocio_id).first();
  if (!negocio || !negocio.logotipo) {
    throw new Falha('Este negócio ainda não tem logótipo, e a Wallet exige um.',
      { estado: 409, codigo: 'sem-logotipo' });
  }
  /* A APPLE SÓ ACEITA PNG nas imagens de um passe. A coluna pode ter JPEG — o
     `PUT /v1/balcao/logotipo` aceita-o de propósito, e para a Google serve —
     mas metê-lo no arquivo com o nome `icon.png` dá um passe que o iPhone
     recusa sem dizer porquê. Mais vale a recusa sair daqui, com uma frase. */
  if (!String(negocio.logotipo).startsWith('image/png;')) {
    throw new Falha(
      'A Apple só aceita logótipos em PNG. Volta a carregar a imagem no balcão, '
      + 'que a converte.',
      { estado: 409, codigo: 'logotipo-nao-png' });
  }
  /* OS MARCOS SÓ SE VÃO BUSCAR A UM CARTÃO DE PONTOS, e até aqui não se iam
     buscar de todo: esta função lê a LINHA CRUA da tabela `programas`, onde a
     coluna `marcos` não existe — os marcos vivem numa tabela à parte. O
     `moldarPrograma` faz `marcos: p.marcos || null`, por isso chegava sempre
     null ao passe, e a barra de um cartão de pontos não tinha onde pôr os
     destinos. Uma consulta a mais, e só para um tipo de programa. */
  if (programa && programa.tipo === 'pontos') {
    programa.marcos = (await env.DB.prepare(
      'SELECT pontos, premio FROM marcos WHERE programa_id = ? ORDER BY pontos'
    ).bind(programa.id).all()).results;
  }
  return { cartao, programa, negocio };
}

/** O passe de um cartão, já assinado. */
async function passeDoCartao(env, cartaoId, origemAPI) {
  const { cartao, programa, negocio } = await pecasDoPasse(env, cartaoId);

  /* O `wallet_em` NÃO se toca aqui, e a diferença não é de nomes.

     Ele quer dizer «tem um loyaltyObject na Google» — é por ele que o espelho
     do saldo decide se manda o PATCH, e é por ele que o reconciliador da
     madrugada escolhe os atrasados. Um cartão só-Apple marcado assim fazia o
     Worker bater todas as noites num objecto que nunca existiu: o PATCH dava
     404, o `wallet_sincronizado` nunca era gravado, e a linha voltava a ser
     escolhida. Com `LIMIT 40` e sem ordenação, quarenta cartões destes
     bastavam para nenhum cartão da Google voltar a ser reconciliado.

     O `wallet_codigo` é que é partilhado, e de propósito: é o mesmo código de
     barras nas duas carteiras. */
  const codigo = cartao.wallet_codigo || publicoNovo(16);

  /* O SERVIÇO SÓ ENTRA SE HOUVER ORIGEM. Quem chama sem ela — e há um caminho
     que chama — emitiria um passe com `webServiceURL: undefined`, que a Apple
     aceita e ignora: um passe com ar de actualizável e congelado na mesma.
     Sem origem, não se promete nada. */
  const servico = origemAPI ? {
    url: enderecoDoServico(origemAPI),
    testemunho: await testemunhoDoPasse(env, cartao.id),
  } : null;

  /* SEGUNDOS INTEIROS. É a etiqueta que o protocolo compara, dos dois lados,
     através de cabeçalhos de HTTP que têm resolução de um segundo. */
  const quando = Math.floor(Date.now() / 1000);
  if (!cartao.wallet_codigo || !cartao.apple_em || (servico && !cartao.apple_servico)) {
    await env.DB.prepare(
      `UPDATE cartoes SET wallet_codigo = ?, apple_em = ?, apple_servico = ?,
                          apple_actualizado = COALESCE(apple_actualizado, ?)
        WHERE id = ?`
    ).bind(codigo, cartao.apple_em || agora(),
           servico ? servico.url : cartao.apple_servico, quando, cartao.id).run();
  }

  const prog = moldarPrograma(programa);
  const passe = passeDeCartao(cartao, prog, negocio, {
    passTipo: env.APPLE_PASS_TIPO, equipa: env.APPLE_EQUIPA,
    codigo, dominio: env.DOMINIO, servico,
    /* Quem responde pelo passe somos NÓS, e não o café: é o nosso certificado
       que o assina. Exigido pelo Anexo 5 §2.3 do contrato da Apple. */
    apoio: {
      nome: env.APOIO_NOME, morada: env.APOIO_MORADA,
      telefone: env.APOIO_TELEFONE, email: env.APOIO_EMAIL,
    },
  });

  /* A MESMA IMAGEM nos dois sítios, e de propósito. O que está guardado é um
     quadrado de 512, que é o que a Google quer; a Apple quer 38 pt de ícone e
     50 de altura de logótipo, e reduz o que lhe derem. Guardar mais tamanhos
     obrigava a mais colunas e a mais um gesto no balcão, para poupar umas
     dezenas de kilobytes num ficheiro que se descarrega uma vez. */
  const imagem = imagemDoNegocio(negocio);

  /* A FAIXA, que é a peça que faltava. O passe era um rectângulo de cor com
     texto: dizia «Carimbos 7/10» num campo de cabeçalho, e mais nada. Ninguém
     olha para um cartão de fidelidade para LER quantos carimbos tem — olha
     para ver quantos faltam, e isso quer-se desenhado.

     `strip@2x.png` E NÃO `strip.png`: o sufixo carrega peso. Um ficheiro
     chamado `strip.png` com 750 px de largura diz ao iOS que aquilo são 750
     PONTOS, e ele desenha-o ao dobro do tamanho, cortado — sem erro nenhum, só
     uma faixa errada.

     UMA ESCALA SÓ. Medido em Node: @2x custa ~2 ms e 15 KB; @3x custa mais 4
     ms e mais 24 KB. Este pedido já paga uma assinatura RSA-2048, quatro
     SHA-1 e o ZIP, e o tecto do plano gratuito são 10 ms de CPU por pedido. A
     segunda escala acrescenta-se no dia em que houver uma leitura de CPU a
     sério desta rota no painel — e não antes, por adivinhação. */
  const { bytes: faixa } = await faixaDeCartao({
    cor: negocio.cor,
    tipo: prog.tipo === 'pontos' ? 'pontos' : 'carimbos',
    selo: prog.selo,
    feitos: prog.tipo === 'pontos' ? (cartao.pontos ?? 0) : (cartao.carimbos ?? 0),
    objetivo: prog.objetivo,
    marcos: prog.marcos,
    largura: APPLE_STRIP.largura * 2,
    altura: APPLE_STRIP.altura * 2,
    selos: SELOS,
  });

  return construirPasse({
    passe,
    imagens: { 'icon.png': imagem, 'logo.png': imagem, 'strip@2x.png': faixa },
    certificado: env.APPLE_CERTIFICADO,
    chave: env.APPLE_CHAVE,
    cadeia: env.APPLE_CADEIA ? [env.APPLE_CADEIA] : [],
  });
}

/** Os bytes do logótipo guardado, sem o prefixo do tipo. */
function imagemDoNegocio(negocio) {
  const guardado = String(negocio.logotipo || '');
  const base64 = guardado.slice(guardado.indexOf(';') + 1);
  return Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
}

/* =========================================================================
   O PassKit Web Service — o que faz o passe actualizar-se sozinho

   São cinco rotas que o iPhone chama SOZINHO, sem interface nenhuma pelo
   meio, e um toque da APNs a dizer-lhe que venha ver. O desenho é:

     1. a pessoa guarda o passe       → o aparelho REGISTA-SE (POST)
     2. o balcão carimba              → nós marcamos o cartão e o cron TOCA
     3. o iPhone acorda               → pergunta QUE passes mudaram (GET lista)
     4. e vai buscar cada um          → GET do passe, com If-Modified-Since
     5. a pessoa apaga o passe        → DELETE

   PENDURADAS EM `/wallet` E NÃO NA RAIZ. O protocolo obriga a caminhos que
   começam por `/v1/`, e `/v1/` já é a API desta casa: sem prefixo, o
   `/v1/passes/...` da Apple entrava no mesmo espaço de nomes das nossas
   rotas e um dia colidia. O `webServiceURL` do passe leva o prefixo lá
   dentro, e a Apple cola o resto.

   DOIS SEGREDOS PARTILHADOS, E NÃO UM. O `authenticationToken` autentica
   registar, desregistar e ir buscar o passe. A lista NÃO leva testemunho
   nenhum — o segredo dela é o próprio `deviceLibraryIdentifier`, que o
   aparelho inventa. Pôr uma guarda de testemunho na lista parte as
   actualizações todas, e a Apple nem sequer documenta um 401 aí.
   ========================================================================= */

/**
 * O testemunho de um passe. DERIVADO, e nunca guardado.
 *
 * A Apple diz para não mudar o `authenticationToken` numa actualização —
 * mudá-lo parte todos os passes que já estão na rua. Derivá-lo do número de
 * série dá um valor constante para sempre, sem tabela nenhuma onde alguém um
 * dia lhe possa mexer. Trinta e dois caracteres, bem acima dos dezasseis que
 * a Apple exige como mínimo.
 */
async function testemunhoDoPasse(env, serial) {
  const mestra = deBase64url(env.CHAVE_MESTRA);
  return base64url(await hmac(mestra, `passe:${env.APPLE_PASS_TIPO}.${serial}`)).slice(0, 32);
}

/** O endereço do serviço, tal como vai escrito dentro do passe. */
const enderecoDoServico = (origemAPI) => `${origemAPI}/wallet`;

/**
 * Confere o cabeçalho `Authorization: ApplePass <testemunho>`.
 *
 * Comparação em tempo constante, como em todo o resto desta casa: um `===`
 * sobre um HMAC vaza o tamanho do prefixo certo pelo tempo que demora a
 * falhar.
 */
async function passeAutorizado(env, pedido, serial) {
  const cabecalho = pedido.headers.get('authorization') || '';
  const dado = cabecalho.startsWith('ApplePass ') ? cabecalho.slice(10).trim() : '';
  const esperado = await testemunhoDoPasse(env, serial);
  if (dado.length !== esperado.length) return false;
  let diferenca = 0;
  for (let i = 0; i < dado.length; i += 1) {
    diferenca |= dado.charCodeAt(i) ^ esperado.charCodeAt(i);
  }
  return diferenca === 0;
}

/* Um passe só se actualiza se o Pass Type ID do pedido for o NOSSO. A Apple
   manda-o no caminho, e um pedido com outro é ou engano ou sondagem. */
const meuPassTipo = (env, tipo) => tipo === env.APPLE_PASS_TIPO;

/* 1 · REGISTAR ------------------------------------------------------------
   201 quando é novo, 200 quando já lá estava. A diferença não é cosmética: a
   Apple usa-a para saber se precisa de repetir. */
rota('POST', /^\/wallet\/v1\/devices\/([\w.-]{1,128})\/registrations\/([\w.-]{1,128})\/([\w-]{1,64})$/,
  async (env, pedido, [aparelho, tipo, serial]) => {
    if (!applePronta(env) || !meuPassTipo(env, tipo)) throw new Falha('Não existe', { estado: 404 });
    if (!(await passeAutorizado(env, pedido, serial))) {
      throw new Falha('Request Not Authorized', { estado: 401 });
    }
    let testemunho = '';
    try { testemunho = String((await corpoJSON(pedido)).pushToken || ''); } catch { /* sem corpo */ }
    if (!/^[0-9a-fA-F]{16,256}$/.test(testemunho)) {
      throw new Falha('Request Not Authorized', { estado: 401 });
    }
    /* O cartão tem de existir — senão qualquer pessoa que adivinhasse um
       número de série enchia a tabela. O testemunho já o prova, mas provar
       duas coisas custa uma consulta e evita uma tabela a crescer sozinha. */
    const cartao = await env.DB.prepare('SELECT id FROM cartoes WHERE id = ?')
      .bind(serial).first();
    if (!cartao) throw new Falha('Não existe', { estado: 404 });

    const jaHavia = await env.DB.prepare(
      'SELECT 1 FROM wallet_registos WHERE aparelho = ? AND serial = ?'
    ).bind(aparelho, serial).first();

    /* O testemunho de push de um aparelho MUDA, e quando muda o iPhone volta
       a registar-se com o mesmo identificador. Um INSERT simples dava erro de
       chave e o aparelho ficava com o testemunho velho — vivo na tabela e
       morto na APNs. */
    await env.DB.batch([
      env.DB.prepare(
        `INSERT INTO wallet_aparelhos (aparelho, testemunho, visto_em) VALUES (?, ?, ?)
         ON CONFLICT(aparelho) DO UPDATE SET testemunho = excluded.testemunho,
                                             visto_em = excluded.visto_em`
      ).bind(aparelho, testemunho, agora()),
      env.DB.prepare(
        `INSERT OR IGNORE INTO wallet_registos (aparelho, serial, criado_em) VALUES (?, ?, ?)`
      ).bind(aparelho, serial, agora()),
    ]);
    return new Response(null, { status: jaHavia ? 200 : 201 });
  });

/* 2 · A LISTA DO QUE MUDOU ------------------------------------------------
   SEM TESTEMUNHO NENHUM, de propósito — ver a nota do topo. E 204 SEM CORPO
   quando não há nada: um 204 com corpo é uma resposta inválida. */
rota('GET', /^\/wallet\/v1\/devices\/([\w.-]{1,128})\/registrations\/([\w.-]{1,128})$/,
  async (env, pedido, [aparelho, tipo]) => {
    if (!applePronta(env) || !meuPassTipo(env, tipo)) throw new Falha('Não existe', { estado: 404 });
    const desde = Number(new URL(pedido.url).searchParams.get('passesUpdatedSince') || 0);

    /* MAIOR ESTRITO, e não maior-ou-igual. Com `>=`, um passe devolvido numa
       chamada voltava na seguinte, para sempre: o aparelho guarda o
       `lastUpdated` que lhe demos e devolve-o, e um cartão com esse mesmo
       valor casava outra vez. */
    const linhas = (await env.DB.prepare(
      `SELECT c.id, c.apple_actualizado
         FROM wallet_registos r JOIN cartoes c ON c.id = r.serial
        WHERE r.aparelho = ? AND c.apple_actualizado > ?`
    ).bind(aparelho, Number.isFinite(desde) ? desde : 0).all()).results || [];

    if (!linhas.length) return new Response(null, { status: 204 });
    const ultimo = Math.max(...linhas.map((l) => Number(l.apple_actualizado) || 0));
    return json({
      serialNumbers: linhas.map((l) => l.id),
      /* STRING, e não número. A Apple trata isto como uma etiqueta opaca, e
         há relatos de a Wallet não guardar um `lastUpdated` numérico — o
         `passesUpdatedSince` passa a chegar sempre vazio e o servidor devolve
         a lista inteira em todas as chamadas, sem nunca perceber porquê. */
      lastUpdated: String(ultimo),
    }, { pedido, env });
  });

/* 3 · O PASSE ACTUALIZADO -------------------------------------------------
   O 304 NÃO É UMA OPTIMIZAÇÃO: é o que faz esta rota caber no plano gratuito.
   Assinar um .pkpass é um ZIP, um SHA-1 por ficheiro e uma assinatura RSA de
   2048 bits, dentro de dez milissegundos de CPU. */
rota('GET', /^\/wallet\/v1\/passes\/([\w.-]{1,128})\/([\w-]{1,64})$/,
  async (env, pedido, [tipo, serial]) => {
    if (!applePronta(env) || !meuPassTipo(env, tipo)) throw new Falha('Não existe', { estado: 404 });
    if (!(await passeAutorizado(env, pedido, serial))) {
      throw new Falha('Request Not Authorized', { estado: 401 });
    }
    const cartao = await env.DB.prepare(
      'SELECT apple_actualizado FROM cartoes WHERE id = ?').bind(serial).first();
    if (!cartao) throw new Falha('Não existe', { estado: 404 });

    /* SEGUNDOS INTEIROS dos dois lados. As datas de HTTP têm resolução de um
       segundo: comparar um relógio em milissegundos com um cabeçalho truncado
       dá 304 errados para duas alterações dentro do mesmo segundo. */
    const mudou = Number(cartao.apple_actualizado) || 0;
    const desde = Date.parse(pedido.headers.get('if-modified-since') || '');
    if (Number.isFinite(desde) && mudou <= Math.floor(desde / 1000)) {
      return new Response(null, { status: 304 });
    }

    const bytes = await passeDoCartao(env, serial, origemDaAPI(pedido));
    return new Response(bytes, {
      headers: {
        'content-type': 'application/vnd.apple.pkpass',
        /* A HORA REAL DA ÚLTIMA ALTERAÇÃO, e não a de agora. Pôr `new Date()`
           aqui parece funcionar e é mentira: o aparelho passa a guardar uma
           marca que não corresponde a nada, e o 304 deixa de acontecer. */
        'last-modified': new Date(mudou * 1000).toUTCString(),
      },
    });
  });

/* 4 · DESREGISTAR ---------------------------------------------------------
   Quem apaga o passe SEM REDE nunca manda isto. Esses só desaparecem pelo
   410 da APNs — ver a limpeza em `avisarAparelhos`. */
rota('DELETE', /^\/wallet\/v1\/devices\/([\w.-]{1,128})\/registrations\/([\w.-]{1,128})\/([\w-]{1,64})$/,
  async (env, pedido, [aparelho, tipo, serial]) => {
    if (!applePronta(env) || !meuPassTipo(env, tipo)) throw new Falha('Não existe', { estado: 404 });
    if (!(await passeAutorizado(env, pedido, serial))) {
      throw new Falha('Request Not Authorized', { estado: 401 });
    }
    await env.DB.prepare('DELETE FROM wallet_registos WHERE aparelho = ? AND serial = ?')
      .bind(aparelho, serial).run();
    /* Um aparelho que ficou sem registos nenhuns não tem razão para ficar na
       tabela — e deixá-lo lá é guardar um testemunho de push de alguém que já
       não nos quer, que é precisamente o que o RGPD manda não fazer. */
    const sobra = await env.DB.prepare(
      'SELECT 1 FROM wallet_registos WHERE aparelho = ?').bind(aparelho).first();
    if (!sobra) {
      await env.DB.prepare('DELETE FROM wallet_aparelhos WHERE aparelho = ?')
        .bind(aparelho).run();
    }
    return new Response(null, { status: 200 });
  });

/* 5 · O REGISTO DE QUEIXAS ------------------------------------------------
   É o único sítio onde o iPhone diz PORQUE é que falhou, e por isso vale a
   pena existir. Mas não leva autenticação nenhuma — a Apple não a prevê — e
   isso faz dele a única rota desta casa por onde qualquer pessoa na internet
   escreve no nosso registo. Por isso não escreve na base de dados, não guarda
   nada, e tem tecto: vai para o `console`, que é onde a gente o lê. */
rota('POST', '/wallet/v1/log', async (env, pedido) => {
  let linhas = [];
  try {
    const corpo = await corpoJSON(pedido);
    linhas = Array.isArray(corpo.logs) ? corpo.logs : [];
  } catch { /* sem corpo: 200 na mesma, que é o que a Apple espera */ }
  for (const linha of linhas.slice(0, 20)) {
    console.log('wallet(apple):', String(linha).slice(0, 500));
  }
  return new Response(null, { status: 200 });
});

rota('POST', /^\/v1\/cliente\/cartoes\/([\w-]+)\/pkpass$/, async (env, pedido, [cartaoId]) => {
  if (!applePronta(env)) throw new Falha('Não existe', { estado: 404 });
  const clienteId = await exigirCliente(env, pedido);
  const cartao = await env.DB.prepare(
    'SELECT id FROM cartoes WHERE id = ? AND cliente_id = ?'
  ).bind(cartaoId, clienteId).first();
  if (!cartao) throw new Falha('Cartão não encontrado', { estado: 404 });
  /* VERIFICA-SE antes de dar o endereço, mas não se CONSTRÓI. Construir o
     passe inteiro só para o deitar fora era pagar a assinatura RSA e a
     descodificação do logótipo duas vezes por cada «adicionar à carteira»,
     num Worker com dez milissegundos de tecto.

     Mas verificar é mesmo verificar: os SEGREDOS também. O `applePronta` só
     diz que as quatro variáveis não estão vazias, não que sirvam — e uma
     chave em PKCS#1 em vez de PKCS#8 (que é o que o `openssl genrsa` dá) só
     rebentava lá à frente, no GET, que é uma navegação do Safari. O que a
     pessoa via era um JSON de erro no ecrã em vez do passe. Ler o certificado
     e importar a chave custa microssegundos; assinar é que não. */
  await pecasDoPasse(env, cartaoId);
  await verificarSegredosApple(env);
  return { ligacao: `${origemDaAPI(pedido)}/v1/passe/${await bilheteDoPasse(env, cartaoId)}` };
});

rota('GET', /^\/v1\/passe\/([\w.-]+)$/, async (env, pedido, [bilhete]) => {
  if (!applePronta(env)) throw new Falha('Não existe', { estado: 404 });
  const cartaoId = await lerBilhete(env, bilhete);
  if (!cartaoId) throw new Falha('Esta ligação já não serve. Pede outra na app.', { estado: 403 });
  const bytes = await passeDoCartao(env, cartaoId, origemDaAPI(pedido));
  return new Response(bytes, {
    headers: {
      'content-type': 'application/vnd.apple.pkpass',
      'content-disposition': 'attachment; filename="cartao.pkpass"',
      /* Nada de cache: o passe leva o saldo lá dentro, e um passe guardado é
         um passe com o número de carimbos errado. */
      'cache-control': 'no-store',
    },
  });
});

rota('POST', '/v1/balcao/programas', async (env, pedido, _p, ctx) => {
  const op = await exigirOperador(env, pedido);
  if (op.papel !== 'dono') throw new Falha('Só o dono pode mudar isto', { estado: 403 });
  const d = await corpoJSON(pedido);
  const existente = d.id
    ? await env.DB.prepare('SELECT * FROM programas WHERE id = ? AND negocio_id = ?')
        .bind(d.id, op.negocio_id).first()
    : null;
  const c = camposDoPrograma(d, existente);

  if (existente) {
    await env.DB.prepare(
      `UPDATE programas SET nome = ?, premio = ?, objetivo = ?, selo = ?, regras = ?,
              arrefecimento = ?, amigo_convidador = ?, amigo_convidado = ?,
              amigo_max = ? WHERE id = ?`
    ).bind(c.nome, c.premio, c.objetivo, c.selo, c.regras, c.arrefecimento,
           c.amigoConvidador, c.amigoConvidado, c.amigoMax, existente.id).run();
  } else {
    /* Um tecto ao número de cartões. Cada POST sem `id` criava mais um, sem
       fim — e cada um deles é um cartão pintado na lista pública de toda a
       gente, mais uma volta no `descobrir`, que já é uma consulta por
       programa. Não é preciso má intenção: um botão «Guardar» que responda
       devagar e leve dois toques chega. */
    const { n } = await env.DB.prepare(
      'SELECT COUNT(*) AS n FROM programas WHERE negocio_id = ?'
    ).bind(op.negocio_id).first();
    if (n >= PROGRAMAS_MAX) {
      throw new Falha(`Já tens ${PROGRAMAS_MAX} cartões neste negócio. Apaga um antes de criar outro.`,
        { estado: 409, codigo: 'demasiados-programas' });
    }
    await env.DB.prepare(
      `INSERT INTO programas (id, negocio_id, nome, tipo, selo, objetivo, premio,
                             regras, arrefecimento, criado_em,
                             amigo_convidador, amigo_convidado, amigo_max)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).bind(id(), op.negocio_id, c.nome, c.tipo, c.selo,
           c.objetivo, c.premio, c.regras, c.arrefecimento, agora(),
           c.amigoConvidador, c.amigoConvidado, c.amigoMax).run();
  }
  const programas = (await env.DB.prepare(
    'SELECT * FROM programas WHERE negocio_id = ? AND ativo = 1'
  ).bind(op.negocio_id).all()).results;
  /* O nome do cartão, o prémio e as regras vivem também na classe da Wallet.
     Mudá-los aqui sem os mandar para lá deixava o passe a dizer o que já não
     é verdade. */
  await espelharClassesDoNegocio(env, op.negocio_id, pedido, ctx);
  return programas.map(moldarPrograma);
});

rota('POST', '/v1/balcao/carimbar', async (env, pedido, _p, ctx) => {
  const op = await exigirOperador(env, pedido);
  const r = await carimbar(env, pedido, op);
  /* O espelho na Wallet vai depois da resposta, com `waitUntil`. O carimbo já
     está gravado; o que acontecer à Google não pode fazer o balcão esperar
     nem falhar.

     E a notificação só sai no carimbo que FECHA o cartão. O tecto é de três
     por passe em 24 horas: gastá-lo nos carimbos do meio deixava em silêncio
     o único que a pessoa quer sentir no bolso. */
  if (r && r.cartao && ctx) {
    /* `r.premio` NUNCA EXISTIU. O `carimbar()` devolve `ganhos`, que é uma
       lista — `Boolean(r.premio)` era `false` sempre, e o único toque no
       bolso que esta aplicação dá nunca saiu de casa. O tecto da Google são
       três notificações por dia; gasta-se no carimbo que fecha o cartão, que
       é o único que a pessoa quer sentir. */
    ctx.waitUntil(espelharNaWallet(env, r.cartao.id, {
      notificar: Boolean(r.ganhos && r.ganhos.length),
      origemAPI: origemDaAPI(pedido),
    }));
    /* E o da Apple. São duas carteiras e duas mecânicas: a Google recebe o
       saldo por PATCH, a Apple recebe um toque e vem ela buscar. O que é
       igual é a promessa, e por isso as duas marcas saem do mesmo sítio. */
    ctx.waitUntil(marcarPasseDaApple(env, r.cartao.id));
    /* E o toque no bolso de quem não tem passe na carteira. Mesma condição, e
       pela mesma razão: é o carimbo que fecha o cartão que a pessoa quer
       sentir, e ela está a sair do café quando ele acontece. */
    if (r.ganhos && r.ganhos.length) {
      ctx.waitUntil(avisarDoPremio(env, r.cartao, r.ganhos));
    }
  }
  return r;
});

rota('POST', '/v1/balcao/resgatar', async (env, pedido, _p, ctx) => {
  const op = await exigirOperador(env, pedido);
  const { premioId } = await corpoJSON(pedido);
  exigirTexto(premioId, 'premioId');
  const premio = await env.DB.prepare(
    `SELECT p.*, c.negocio_id FROM premios p JOIN cartoes c ON c.id = p.cartao_id WHERE p.id = ?`
  ).bind(premioId).first();
  if (!premio) throw new Falha('Prémio não encontrado', { estado: 404 });
  if (premio.negocio_id !== op.negocio_id) throw new Falha('Prémio de outro negócio', { estado: 403 });
  if (premio.resgatado_em) throw new Falha('Este prémio já foi entregue.', { estado: 409, codigo: 'ja-resgatado' });

  /* A leitura acima já viu que o prémio estava por entregar, mas entre a
     leitura e a escrita cabe outro pedido — e dois toques no mesmo botão,
     ou dois telemóveis ao balcão, entregavam o mesmo prémio duas vezes e
     deixavam dois resgates no histórico. A condição vai na própria escrita:
     quem chegar em segundo não muda nada e fica a saber. */
  const escrita = await env.DB.prepare(
    `UPDATE premios SET resgatado_em = ?, resgatado_por = ?
      WHERE id = ? AND resgatado_em IS NULL`
  ).bind(agora(), op.nome, premioId).run();
  if (escrita.meta && escrita.meta.changes === 0) {
    throw new Falha('Este prémio já foi entregue.', { estado: 409, codigo: 'ja-resgatado' });
  }
  await env.DB.prepare(
    'INSERT INTO movimentos (id, cartao_id, tipo, nota, operador, em) VALUES (?, ?, ?, ?, ?, ?)'
  ).bind(id(), premio.cartao_id, 'resgate', premio.descricao, op.nome, agora()).run();
  const c = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(premio.cartao_id).first();
  /* Sem notificar: o cliente está ali à frente a receber o prémio, não
     precisa de um toque no bolso a dizer-lho. */
  if (ctx) ctx.waitUntil(espelharNaWallet(env, premio.cartao_id,
    { origemAPI: origemDaAPI(pedido) }));
  if (ctx) ctx.waitUntil(marcarPasseDaApple(env, premio.cartao_id));
  return { premio: { id: premioId, resgatadoEm: agora() }, cartao: await moldarCartao(env, c) };
});

rota('POST', '/v1/balcao/anular', async (env, pedido, _p, ctx) => {
  const op = await exigirOperador(env, pedido);
  const { movimentoId } = await corpoJSON(pedido);
  exigirTexto(movimentoId, 'movimentoId');
  const m = await env.DB.prepare(
    `SELECT m.*, c.negocio_id, c.programa_id FROM movimentos m
       JOIN cartoes c ON c.id = m.cartao_id WHERE m.id = ?`
  ).bind(movimentoId).first();
  if (!m) throw new Falha('Movimento não encontrado', { estado: 404 });
  if (m.negocio_id !== op.negocio_id) throw new Falha('Movimento de outro negócio', { estado: 403 });
  /* Anular é para carimbos e pontos. Sem esta guarda, o movimento era
     apagado fosse ele qual fosse — dava para apagar a adesão de um cliente
     ou o registo de um prémio entregue, e nenhum dos dois ramos abaixo
     repunha o que quer que fosse. Ficava um buraco no histórico. */
  if (m.tipo !== 'carimbo' && m.tipo !== 'pontos') {
    throw new Falha('Só se anulam carimbos e pontos.', { estado: 400, codigo: 'tipo' });
  }
  /* Dois minutos. Passado isso o cliente já foi embora e anular passa a ser
     uma forma de tirar carimbos a quem não está a ver. */
  if (Date.now() - new Date(m.em).getTime() > 120000) {
    throw new Falha('Já passaram mais de 2 minutos — não dá para anular.',
      { estado: 409, codigo: 'tarde' });
  }
  const cartao = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(m.cartao_id).first();
  const p = await programaCompleto(env, m.programa_id);

  /* Se este carimbo completou o cartão e o prémio JÁ foi entregue, anular
     devolvia os carimbos e deixava o café a perder duas vezes: o brinde
     saiu e o cartão volta a estar quase cheio. O prémio ainda por entregar
     desfaz-se com o carimbo; o que já saiu pela porta não se desfaz. */
  const completou = m.tipo === 'carimbo' && cartao.carimbos - m.quantidade < 0;
  if (completou) {
    const entregue = await env.DB.prepare(
      `SELECT id FROM premios WHERE cartao_id = ? AND resgatado_em IS NOT NULL
        ORDER BY ganho_em DESC LIMIT 1`
    ).bind(cartao.id).first();
    if (entregue) {
      throw new Falha('Este carimbo deu um prémio que já foi entregue — não dá para anular.',
        { estado: 409, codigo: 'premio-entregue' });
    }
  }

  let carimbos = cartao.carimbos, pontos = cartao.pontos;
  let total = cartao.total_carimbos, ganhos = cartao.premios_ganhos;
  const instrucoes = [];
  if (m.tipo === 'pontos') {
    pontos = Math.max(0, pontos - m.quantidade);
  } else if (m.tipo === 'carimbo') {
    carimbos -= m.quantidade;
    total = Math.max(0, total - m.quantidade);
    if (carimbos < 0) {
      /* Anulou-se o carimbo que completou o cartão: o prémio tem de voltar
         atrás com ele, senão fica um prémio ganho sem nada que o justifique. */
      const premio = await env.DB.prepare(
        'SELECT id FROM premios WHERE cartao_id = ? AND resgatado_em IS NULL ORDER BY ganho_em DESC LIMIT 1'
      ).bind(cartao.id).first();
      if (premio) {
        instrucoes.push(env.DB.prepare('DELETE FROM premios WHERE id = ?').bind(premio.id));
        ganhos = Math.max(0, ganhos - 1);
      }
      carimbos += p.objetivo;
    }
  }
  /* Repor o relógio do arrefecimento no movimento anterior. Sem isto, quem
     se enganasse no cliente anulava — e a seguir não conseguia carimbar o
     cliente certo durante uma hora, porque o cartão ainda tinha a marca de
     um carimbo que já não existe. */
  const anterior = await env.DB.prepare(
    `SELECT em FROM movimentos
      WHERE cartao_id = ? AND id != ? AND tipo IN ('carimbo','pontos')
      ORDER BY em DESC LIMIT 1`
  ).bind(cartao.id, movimentoId).first();

  instrucoes.push(
    env.DB.prepare(
      `UPDATE cartoes SET carimbos = ?, pontos = ?, total_carimbos = ?,
              premios_ganhos = ?, ultimo_em = ? WHERE id = ?`)
      .bind(carimbos, pontos, total, ganhos, anterior ? anterior.em : null, cartao.id),
    env.DB.prepare('DELETE FROM movimentos WHERE id = ?').bind(movimentoId),
    env.DB.prepare('INSERT INTO movimentos (id, cartao_id, tipo, nota, operador, em) VALUES (?, ?, ?, ?, ?, ?)')
      .bind(id(), cartao.id, 'anulado', 'Movimento anulado', op.nome, agora()),
  );
  await env.DB.batch(instrucoes);
  const atualizado = await env.DB.prepare('SELECT * FROM cartoes WHERE id = ?').bind(cartao.id).first();
  /* Anular também muda o saldo, e o passe tem de o acompanhar — senão a
     carteira fica a dizer um número que já não é verdade, e é a carteira que
     a pessoa vê. */
  if (ctx) ctx.waitUntil(espelharNaWallet(env, atualizado.id,
    { origemAPI: origemDaAPI(pedido) }));
  if (ctx) ctx.waitUntil(marcarPasseDaApple(env, atualizado.id));
  return { cartao: await moldarCartao(env, atualizado) };
});

/**
 * O café escreve como trata este cliente.
 *
 * «A Joana da manhã», «o senhor do jornal», «mesa 4». É texto livre do BALCÃO,
 * e nunca se pede nada ao cliente — é isso que faz caber no produto uma coisa
 * que, desenhada ao contrário, obrigaria a consentimento, a acordo de
 * responsabilidade conjunta com cada café, e a reescrever a frase «não pedimos
 * nome, telefone nem morada» que está publicada em dois sítios.
 *
 * SÓ NO PRÓPRIO NEGÓCIO, e o `WHERE negocio_id` é a única coisa que impede um
 * café de escrever no cartão de outro. O cartão é identificado pelo `id`, não
 * pelo `publico`: o `publico` é do CLIENTE e é o mesmo em todos os cafés.
 *
 * Sessenta caracteres é de propósito. Chega para «a Joana da manhã» e não
 * chega para uma ficha de cliente — se alguém quiser escrever ali a morada e o
 * historial clínico de alguém, que não seja por termos deixado espaço.
 */
rota('PUT', /^\/v1\/balcao\/cartoes\/([\w-]+)\/alcunha$/, async (env, pedido, [cartaoId]) => {
  const op = await exigirOperador(env, pedido);
  const { alcunha } = await corpoJSON(pedido);
  const texto = String(alcunha ?? '').trim().slice(0, 60);

  const feito = await env.DB.prepare(
    'UPDATE cartoes SET alcunha = ? WHERE id = ? AND negocio_id = ?'
  ).bind(texto || null, cartaoId, op.negocio_id).run();

  if (!feito.meta || feito.meta.changes !== 1) {
    throw new Falha('Esse cartão não é deste balcão.', { estado: 404, codigo: 'sem-cartao' });
  }
  return { alcunha: texto || null };
});

/**
 * O cliente apaga a alcunha que lhe puseram.
 *
 * NÃO É UM EXTRA. A alcunha é um dado sobre uma pessoa identificável guardado
 * por nós por conta do café; ela tem direito a vê-la (art. 15.º) e a opor-se
 * (art. 21.º). A app mostra-lha no cartão e este é o botão.
 *
 * Apaga a alcunha e MAIS NADA — não toca nos carimbos, não sai do café, não
 * mexe na conta. Ao lado disto há um defeito maior e mais antigo, que é não
 * haver forma de largar um cartão sem apagar a conta inteira; esse trata-se à
 * parte, e este não espera por ele.
 *
 * O café pode escrever outra a seguir, e é assim que tem de ser: a alcunha é
 * dele. O que a pessoa tem é o direito de a ver e de a mandar apagar, não o de
 * proibir o café de a reconhecer.
 */
rota('DELETE', /^\/v1\/cliente\/cartoes\/([\w-]+)\/alcunha$/, async (env, pedido, [cartaoId]) => {
  const clienteId = await exigirCliente(env, pedido);
  const feito = await env.DB.prepare(
    'UPDATE cartoes SET alcunha = NULL WHERE id = ? AND cliente_id = ?'
  ).bind(cartaoId, clienteId).run();

  if (!feito.meta || feito.meta.changes !== 1) {
    throw new Falha('Cartão não encontrado', { estado: 404, codigo: 'sem-cartao' });
  }
  return { alcunha: null };
});

/**
 * O histórico de um cartão, visto pelo balcão.
 *
 * O café já vê as visitas a ESTE café na app do cliente; o que faltava era ele
 * próprio poder olhar. É o único dos três pedidos do dono que não recolhe nada
 * de novo: são os movimentos do programa dele, sobre o cartão dele.
 *
 * `negocio_id` na condição, outra vez: sem ele, um balcão pedia o histórico de
 * qualquer cartão de qualquer café só por adivinhar um identificador.
 *
 * Leva o `operador` e o `manual`, que estão gravados desde sempre e nunca
 * foram mostrados a ninguém — é o que distingue «a câmara leu o código» de
 * «alguém escreveu o número à mão», e é a diferença que interessa quando um
 * carimbo é discutido ao balcão.
 */
rota('GET', /^\/v1\/balcao\/cartoes\/([\w-]+)\/historico$/, async (env, pedido, [cartaoId]) => {
  const op = await exigirOperador(env, pedido);
  const cartao = await env.DB.prepare(
    `SELECT c.id, c.alcunha, c.carimbos, c.pontos, c.aderiu_em, c.ultimo_em,
            cl.publico, p.objetivo, p.tipo, p.nome AS programa
       FROM cartoes c
       JOIN clientes cl ON cl.id = c.cliente_id
       JOIN programas p ON p.id = c.programa_id
      WHERE c.id = ? AND c.negocio_id = ?`
  ).bind(cartaoId, op.negocio_id).first();
  if (!cartao) throw new Falha('Esse cartão não é deste balcão.', { estado: 404, codigo: 'sem-cartao' });

  const movimentos = (await env.DB.prepare(
    `SELECT id, tipo, quantidade, nota, operador, manual, em
       FROM movimentos WHERE cartao_id = ? ORDER BY em DESC LIMIT 100`
  ).bind(cartaoId).all()).results;

  const premios = (await env.DB.prepare(
    `SELECT id, descricao, ganho_em, resgatado_em FROM premios
      WHERE cartao_id = ? ORDER BY ganho_em DESC LIMIT 60`
  ).bind(cartaoId).all()).results;

  return {
    cartao: {
      id: cartao.id, publico: cartao.publico, alcunha: cartao.alcunha || null,
      carimbos: cartao.carimbos, pontos: cartao.pontos, objetivo: cartao.objetivo,
      tipo: cartao.tipo, programa: cartao.programa,
      aderiuEm: cartao.aderiu_em, ultimoEm: cartao.ultimo_em,
    },
    movimentos: movimentos.map((m) => ({
      id: m.id, tipo: m.tipo, quantidade: m.quantidade, nota: m.nota,
      operador: m.operador || null, manual: Boolean(m.manual), em: m.em,
    })),
    premios: premios.map((x) => ({
      id: x.id, descricao: x.descricao, ganhoEm: x.ganho_em, resgatadoEm: x.resgatado_em,
    })),
  };
});

/**
 * Expulsar os outros balcões.
 *
 * O CENÁRIO É BANAL E NÃO HAVIA RESPOSTA NENHUMA: o telemóvel do balcão fica
 * no táxi, ou alguém sai zangado com a app instalada. A rota que expulsa
 * aparelhos, `/v1/cliente/sair-dos-outros`, recusa liminarmente quem não é
 * cliente — e não havia equivalente deste lado.
 *
 * E EU PIOREI ISTO, no mesmo dia em que o escrevo: para o balcão «ficar sempre
 * ligado» pus a sessão a deslizar, o que resolveu o problema certo e fez com
 * que um balcão activo NUNCA expire. Antes havia ao menos um fim de linha aos
 * 180 dias; agora não havia nenhum, e a única saída seria apagar o negócio.
 *
 * O que está em causa cresceu com a alcunha: um balcão perdido já não expõe só
 * códigos de seis caracteres sem dono — expõe a lista de clientes com o nome
 * por que o café os trata, e o histórico de visitas de cada um.
 *
 * Fica ESTA sessão e morrem as outras, que é o que permite carregar no botão
 * do telemóvel novo sem se pôr fora a si próprio. Vale para todos os
 * operadores do negócio, e não só para quem carrega: o telemóvel perdido pode
 * ter entrado com outra morada.
 */
rota('POST', '/v1/balcao/sair-dos-outros', async (env, pedido) => {
  const s = await lerSessao(env, pedido);
  if (!s || s.tipo !== 'operador') throw new Falha('Sessão inválida', { estado: 401 });
  const op = await env.DB.prepare(
    'SELECT id, negocio_id FROM operadores WHERE id = ? AND ativo = 1'
  ).bind(s.id).first();
  if (!op) throw new Falha('Operador desativado', { estado: 403 });

  /* Todos os operadores DESTE negócio. Um balcão é do negócio, e não da
     pessoa: quem perde o telemóvel quer fechar a porta, não auditar quem
     entrou por onde. */
  const operadores = (await env.DB.prepare(
    'SELECT id FROM operadores WHERE negocio_id = ?'
  ).bind(op.negocio_id).all()).results;

  const instrucoes = operadores.map((o) => env.DB.prepare(
    'DELETE FROM sessoes WHERE sujeito = ? AND resumo != ?'
  ).bind(`operador:${o.id}`, s.resumo));

  /* E os códigos de entrada por usar. Um código que ficasse vivo era uma
     segunda chave deixada para trás, a valer quinze minutos — e quinze
     minutos chegam para quem tem o telemóvel na mão. */
  instrucoes.push(...operadores.map((o) => env.DB.prepare(
    'DELETE FROM entradas WHERE alvo = ?').bind(`operador:${o.id}`)));

  await env.DB.batch(instrucoes);
  return { feito: true, operadores: operadores.length };
});

/* =========================================================================
   Quem está ao balcão

   Um café com três turnos tem três pessoas a carimbar, e o dono quer saber
   quem atendeu. O `movimentos.operador` já guardava o nome desde o primeiro
   dia e o histórico por cartão já está no ar; o que faltava era poder haver
   um segundo nome.

   TRÊS DECISÕES, e a primeira já estava tomada por quem manda:

   · SEM PIN. O colega entra uma vez com o email dele e fica ligado, como o
     dono. Um PIN ao balcão é uma palavra-passe partilhada escrita num
     papelinho ao lado da caixa, que é pior do que não ter nada.

   · O HISTÓRICO GUARDA O NOME, não o identificador. Por isso um operador que
     sai não se apaga — desactiva-se —, e por isso dois nomes iguais e activos
     no mesmo balcão são recusados: «João» e «João» no histórico não respondem
     à pergunta que isto existe para responder.

   · SÓ O DONO MEXE. Quem carimba carimba; juntar e tirar colegas é do dono,
     senão o primeiro colega pode tirar o dono do próprio café.
   ========================================================================= */

/* Dez é muito para um café e pouco para servir de lista de correio. */
const OPERADORES_MAX = 10;

/** O dono, ou um erro que diz porquê. */
async function exigirDono(env, pedido) {
  const op = await exigirOperador(env, pedido);
  if (op.papel !== 'dono') {
    throw new Falha('Só o dono do balcão pode mexer em quem cá trabalha.',
      { estado: 403, codigo: 'so-o-dono' });
  }
  return op;
}

/**
 * Molda um operador para o ecrã.
 *
 * O EMAIL SÓ VAI PARA O DONO. Para ele é preciso — é por ele que se tira um
 * colega que saiu. Para os outros é a morada pessoal de um colega, e mostrá-la
 * a toda a gente que passa pelo balcão é recolher o que não faz falta.
 */
const moldarOperador = (o, { comEmail }) => ({
  id: o.id,
  nome: o.nome,
  papel: o.papel,
  ...(comEmail ? { email: o.email || null } : {}),
  desde: o.criado_em,
  visto: o.visto_em || null,
});

rota('GET', '/v1/balcao/operadores', async (env, pedido) => {
  const eu = await exigirOperador(env, pedido);
  const linhas = (await env.DB.prepare(
    `SELECT id, nome, email, papel, criado_em, visto_em
       FROM operadores WHERE negocio_id = ? AND ativo = 1
      ORDER BY CASE papel WHEN 'dono' THEN 0 ELSE 1 END, criado_em`
  ).bind(eu.negocio_id).all()).results;
  return {
    eu: eu.id,
    sou: eu.papel,
    tecto: OPERADORES_MAX,
    operadores: linhas.map((o) => moldarOperador(o, { comEmail: eu.papel === 'dono' })),
  };
});

rota('POST', '/v1/balcao/operadores', async (env, pedido) => {
  const dono = await exigirDono(env, pedido);
  const d = await corpoJSON(pedido);
  const nome = String(d.nome || '').trim().slice(0, 40);
  const correio = normalizarEmail(d.email);
  if (!nome) throw new Falha('Falta o nome.', { estado: 400, codigo: 'sem-nome' });
  if (!EMAIL_VALIDO.test(correio)) {
    throw new Falha('Esse email não parece válido.', { estado: 400, codigo: 'email-mau' });
  }

  const quantos = (await env.DB.prepare(
    'SELECT COUNT(*) AS n FROM operadores WHERE negocio_id = ? AND ativo = 1'
  ).bind(dono.negocio_id).first()).n;
  if (quantos >= OPERADORES_MAX) {
    throw new Falha(`Um balcão tem no máximo ${OPERADORES_MAX} pessoas.`,
      { estado: 409, codigo: 'cheio' });
  }

  /* AS DUAS COLISÕES DIZEM-SE ANTES DE ACONTECER, e não como um erro de base
     de dados. Os índices continuam lá — são eles que fecham a corrida entre
     dois pedidos ao mesmo tempo —, mas quem está a escrever um nome merece
     uma frase que explique, e não um «erro interno». */
  const jaComEsseEmail = await env.DB.prepare(
    'SELECT negocio_id FROM operadores WHERE email = ? AND ativo = 1'
  ).bind(correio).first();
  if (jaComEsseEmail) {
    throw new Falha(jaComEsseEmail.negocio_id === dono.negocio_id
      ? 'Essa morada já está neste balcão.'
      : 'Essa morada já está noutro balcão. Uma morada, um balcão.',
    { estado: 409, codigo: 'email-repetido' });
  }
  const jaComEsseNome = await env.DB.prepare(
    'SELECT id FROM operadores WHERE negocio_id = ? AND ativo = 1 AND lower(trim(nome)) = ?'
  ).bind(dono.negocio_id, nome.toLowerCase()).first();
  if (jaComEsseNome) {
    throw new Falha(`Já há um «${nome}» neste balcão. O histórico guarda o nome `
      + 'de quem carimbou — dá-lhe um que o distinga.',
    { estado: 409, codigo: 'nome-repetido' });
  }

  const novoId = id();
  await env.DB.prepare(
    `INSERT INTO operadores (id, negocio_id, nome, email, papel, criado_em)
     VALUES (?, ?, ?, ?, 'balcao', ?)`
  ).bind(novoId, dono.negocio_id, nome, correio, agora()).run();

  /* O CONVITE SAI DEPOIS DE A LINHA ESTAR GRAVADA, e o que ele traz não é um
     código: é o caminho. Se o correio falhar, o operador existe na mesma e o
     dono pode dizer-lhe de viva voz — que é o que acontece num café. */
  const negocio = await env.DB.prepare(
    'SELECT nome FROM negocios WHERE id = ?').bind(dono.negocio_id).first();
  const r = await enviarEmail(env, {
    para: correio,
    ...emailConviteOperador({ negocio: negocio && negocio.nome, quem: dono.nome }),
  });

  return {
    operador: moldarOperador({
      id: novoId, nome, email: correio, papel: 'balcao',
      criado_em: agora(), visto_em: null,
    }, { comEmail: true }),
    avisado: r.enviado,
  };
});

rota('PATCH', /^\/v1\/balcao\/operadores\/([\w-]+)$/, async (env, pedido, [alvoId]) => {
  const dono = await exigirDono(env, pedido);
  const d = await corpoJSON(pedido);
  const alvo = await env.DB.prepare(
    'SELECT * FROM operadores WHERE id = ? AND negocio_id = ? AND ativo = 1'
  ).bind(alvoId, dono.negocio_id).first();
  if (!alvo) throw new Falha('Essa pessoa já não está neste balcão.', { estado: 404 });

  const mudancas = [], valores = [];
  if (d.nome !== undefined) {
    const nome = String(d.nome || '').trim().slice(0, 40);
    if (!nome) throw new Falha('Falta o nome.', { estado: 400, codigo: 'sem-nome' });
    const outro = await env.DB.prepare(
      `SELECT id FROM operadores
        WHERE negocio_id = ? AND ativo = 1 AND id != ? AND lower(trim(nome)) = ?`
    ).bind(dono.negocio_id, alvo.id, nome.toLowerCase()).first();
    if (outro) {
      throw new Falha(`Já há um «${nome}» neste balcão.`,
        { estado: 409, codigo: 'nome-repetido' });
    }
    mudancas.push('nome = ?'); valores.push(nome);
  }
  if (d.papel !== undefined) {
    const papel = d.papel === 'dono' ? 'dono' : 'balcao';
    /* NÃO SE DESPROMOVE O ÚLTIMO DONO. Um balcão sem dono é um balcão que
       ninguém consegue voltar a arrumar, e ninguém nota até precisar. */
    if (alvo.papel === 'dono' && papel !== 'dono') {
      const donos = (await env.DB.prepare(
        `SELECT COUNT(*) AS n FROM operadores
          WHERE negocio_id = ? AND ativo = 1 AND papel = 'dono'`
      ).bind(dono.negocio_id).first()).n;
      if (donos <= 1) {
        throw new Falha('Este é o último dono do balcão. Faz outro dono primeiro.',
          { estado: 409, codigo: 'ultimo-dono' });
      }
    }
    mudancas.push('papel = ?'); valores.push(papel);
  }
  if (!mudancas.length) throw new Falha('Não há nada para mudar.', { estado: 400 });

  await env.DB.prepare(`UPDATE operadores SET ${mudancas.join(', ')} WHERE id = ?`)
    .bind(...valores, alvo.id).run();
  const depois = await env.DB.prepare(
    'SELECT id, nome, email, papel, criado_em, visto_em FROM operadores WHERE id = ?'
  ).bind(alvo.id).first();
  return { operador: moldarOperador(depois, { comEmail: true }) };
});

rota('DELETE', /^\/v1\/balcao\/operadores\/([\w-]+)$/, async (env, pedido, [alvoId]) => {
  const dono = await exigirDono(env, pedido);
  if (alvoId === dono.id) {
    /* Tirar-se a si próprio é a forma mais rápida de um dono ficar de fora do
       seu próprio café. Se for mesmo para sair, primeiro faz-se outro dono. */
    throw new Falha('Não te podes tirar a ti. Faz outro dono primeiro.',
      { estado: 409, codigo: 'eu-nao' });
  }
  const alvo = await env.DB.prepare(
    'SELECT id, papel FROM operadores WHERE id = ? AND negocio_id = ? AND ativo = 1'
  ).bind(alvoId, dono.negocio_id).first();
  if (!alvo) throw new Falha('Essa pessoa já não está neste balcão.', { estado: 404 });

  /* DESACTIVA-SE, NÃO SE APAGA. O histórico de cada cartão guarda o NOME de
     quem carimbou e não este identificador — apagar a linha não apagaria o
     histórico —, mas a linha é o que sobra a dizer que aquela morada já teve
     acesso aqui. E o índice do nome é parcial: sair liberta o nome. */
  await env.DB.batch([
    env.DB.prepare('UPDATE operadores SET ativo = 0 WHERE id = ?').bind(alvo.id),
    /* E FECHA-SE A PORTA NO MESMO GESTO. Uma sessão viva depois de alguém ser
       tirado do balcão é a pessoa a continuar a carimbar; e um código de
       entrada por usar é uma segunda chave deixada para trás. */
    env.DB.prepare('DELETE FROM sessoes WHERE sujeito = ?').bind(`operador:${alvo.id}`),
    env.DB.prepare('DELETE FROM entradas WHERE alvo = ?').bind(`operador:${alvo.id}`),
  ]);
  return { feito: true };
});

rota('GET', '/v1/balcao/clientes', async (env, pedido) => {
  const op = await exigirOperador(env, pedido);
  const linhas = (await env.DB.prepare(
    `SELECT c.*, cl.publico, p.objetivo, p.tipo
       FROM cartoes c
       JOIN clientes cl ON cl.id = c.cliente_id
       JOIN programas p ON p.id = c.programa_id
      WHERE c.negocio_id = ?
      ORDER BY COALESCE(c.ultimo_em, c.aderiu_em) DESC
      LIMIT 300`
  ).bind(op.negocio_id).all()).results;

  /* OS PRÉMIOS POR ENTREGAR VÃO INTEIROS, e não só contados.

     Era uma contagem, e com uma contagem não se entrega nada: a lista dizia
     «prémio» ao lado do número do cartão e não havia como o dar. O único
     caminho para o painel de entrega era CARIMBAR — e quem já tinha carimbado
     há menos de uma hora esbarrava no arrefecimento. Um cliente que fechasse
     o cartão e dissesse «levo noutro dia» ficava sem café até voltar noutro
     dia E ganhar um carimbo que não pediu.

     Uma consulta para a lista toda, e não uma por cartão: a subconsulta
     correlacionada que aqui estava corria trezentas vezes. */
  const pendentes = (await env.DB.prepare(
    `SELECT pr.id, pr.cartao_id, pr.descricao, pr.ganho_em
       FROM premios pr
       JOIN cartoes c ON c.id = pr.cartao_id
      WHERE c.negocio_id = ? AND pr.resgatado_em IS NULL
      ORDER BY pr.ganho_em`
  ).bind(op.negocio_id).all()).results;
  const porCartao = new Map();
  for (const pr of pendentes) {
    const lista = porCartao.get(pr.cartao_id) || [];
    lista.push({ id: pr.id, descricao: pr.descricao, ganhoEm: pr.ganho_em });
    porCartao.set(pr.cartao_id, lista);
  }

  return linhas.map((c) => {
    const premios = porCartao.get(c.id) || [];
    return {
      /* O `id` do cartão passa a ir junto. Sem ele o balcão não tem por onde
         escrever a alcunha nem pedir o histórico — só tinha o `publico`, que
         é do CLIENTE e não do cartão, e usá-lo como chave era misturar as
         duas coisas. */
      id: c.id,
      publico: c.publico, carimbos: c.carimbos, pontos: c.pontos,
      objetivo: c.objetivo, tipo: c.tipo,
      ultimoEm: c.ultimo_em, aderiuEm: c.aderiu_em,
      /* Como este café trata este cliente. É o que responde a «quem é o
         UTUEVN?» sem se ter pedido nada a ninguém. */
      alcunha: c.alcunha || null,
      /* A contagem FICA: é o que a versão da app que está nos telemóveis lê,
         e esta API acrescenta em vez de renomear. */
      porResgatar: premios.length,
      premios,
    };
  });
});

rota('GET', '/v1/balcao/resumo', async (env, pedido) => {
  const op = await exigirOperador(env, pedido);
  const n = op.negocio_id;
  const inicioDia = new Date(); inicioDia.setHours(0, 0, 0, 0);
  const ha30 = new Date(Date.now() - 30 * 86400000).toISOString();
  const ha60 = new Date(Date.now() - 60 * 86400000).toISOString();

  const uma = async (sql, ...args) => (await env.DB.prepare(sql).bind(...args).first()).n;

  return {
    clientes: await uma('SELECT COUNT(*) AS n FROM cartoes WHERE negocio_id = ?', n),
    novos30: await uma('SELECT COUNT(*) AS n FROM cartoes WHERE negocio_id = ? AND aderiu_em >= ?', n, ha30),
    carimbosHoje: await uma(
      `SELECT COUNT(*) AS n FROM movimentos m JOIN cartoes c ON c.id = m.cartao_id
        WHERE c.negocio_id = ? AND m.tipo IN ('carimbo','pontos') AND m.em >= ?`, n, inicioDia.toISOString()),
    carimbos30: await uma(
      `SELECT COUNT(*) AS n FROM movimentos m JOIN cartoes c ON c.id = m.cartao_id
        WHERE c.negocio_id = ? AND m.tipo IN ('carimbo','pontos') AND m.em >= ?`, n, ha30),
    premiosGanhos: await uma(
      'SELECT COUNT(*) AS n FROM premios p JOIN cartoes c ON c.id = p.cartao_id WHERE c.negocio_id = ?', n),
    premiosResgatados: await uma(
      `SELECT COUNT(*) AS n FROM premios p JOIN cartoes c ON c.id = p.cartao_id
        WHERE c.negocio_id = ? AND p.resgatado_em IS NOT NULL`, n),
    porResgatar: await uma(
      `SELECT COUNT(*) AS n FROM premios p JOIN cartoes c ON c.id = p.cartao_id
        WHERE c.negocio_id = ? AND p.resgatado_em IS NULL`, n),
    quaseLa: await uma(
      `SELECT COUNT(*) AS n FROM cartoes c JOIN programas p ON p.id = c.programa_id
        WHERE c.negocio_id = ? AND p.tipo = 'carimbos'
          AND (p.objetivo - c.carimbos) BETWEEN 1 AND 2`, n),
    aFugir: await uma(
      'SELECT COUNT(*) AS n FROM cartoes WHERE negocio_id = ? AND ultimo_em IS NOT NULL AND ultimo_em < ?', n, ha60),
  };
});

/* --- público ------------------------------------------------------------ */

rota('GET', /^\/v1\/p\/([\w-]+)$/, async (env, pedido, [slug]) => {
  const n = await env.DB.prepare(
    "SELECT * FROM negocios WHERE slug = ? AND estado = 'ativo'"
  ).bind(slug).first();
  if (!n) throw new Falha('Não encontrado', { estado: 404 });
  const programas = (await env.DB.prepare(
    'SELECT * FROM programas WHERE negocio_id = ? AND ativo = 1'
  ).bind(n.id).all()).results;
  return {
    id: n.id, slug: n.slug, nome: n.nome, cor: n.cor, categoria: n.categoria,
    localidade: n.localidade, morada: n.morada, telefone: n.telefone,
    programas: programas.map(moldarPrograma),
  };
});

rota('GET', '/v1/saude', async (env) => {
  const r = await env.DB.prepare('SELECT COUNT(*) AS n FROM negocios').first();
  return { bem: true, negocios: r.n, em: agora() };
});

/* =========================================================================
   Entrada
   ========================================================================= */

export default {
  /* O `ctx` é o terceiro parâmetro e faltava. É dele que depende a promessa de
     que uma falha da Google nunca faz falhar um carimbo: o `ctx.waitUntil()`
     deixa o Worker responder já e continuar o trabalho depois. Sem ele, ou se
     esperava pela Google — e o balcão ficava à espera com uma fila à frente —
     ou se atirava o pedido ao ar sem garantia de que chegava a sair. */
  async fetch(pedido, env, ctx) {
    if (pedido.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cabecalhosCORS(pedido, env) });
    }
    const url = new URL(pedido.url);
    /* BARRAS REPETIDAS COLAPSAM. Há muita gente convencida de que o
       `webServiceURL` de um passe leva barra final, e escrevê-la faz a Apple
       chamar `/wallet//v1/devices/...`. Nós escrevemo-lo SEM barra, mas um
       passe emitido com barra fica assim para sempre no telemóvel de quem o
       tem — não há forma de o corrigir à distância. Colapsar custa uma linha. */
    const caminho = url.pathname.replace(/\/{2,}/g, '/').replace(/\/+$/, '') || '/';

    try {
      if (!env.CHAVE_MESTRA) {
        throw new Falha('O Worker não está configurado: falta a CHAVE_MESTRA.', { estado: 500 });
      }
      for (const r of rotas) {
        if (r.metodo !== pedido.method) continue;
        let resposta;
        if (typeof r.padrao === 'string') {
          if (r.padrao !== caminho) continue;
          resposta = await r.mao(env, pedido, [], ctx);
        } else {
          const m = caminho.match(r.padrao);
          if (!m) continue;
          resposta = await r.mao(env, pedido, m.slice(1), ctx);
        }
        /* Quase tudo aqui devolve dados e sai como JSON. Mas o logótipo sai
           como imagem, com o seu tipo e a sua cache — e uma rota que já
           construiu a resposta passa à frente inteira. Sem isto, a imagem ia
           embrulhada em JSON e o browser desenhava um quadrado partido. */
        if (resposta instanceof Response) {
          for (const [k, v] of Object.entries(cabecalhosCORS(pedido, env))) {
            if (!resposta.headers.has(k)) resposta.headers.set(k, v);
          }
          return resposta;
        }
        return json(resposta, { pedido, env });
      }
      return json({ erro: 'Não existe' }, { estado: 404, pedido, env });
    } catch (e) {
      if (e instanceof Falha) {
        return json({ erro: e.message, codigo: e.codigo, ...e.extra },
          { estado: e.estado, pedido, env });
      }
      console.error(e);
      return json({ erro: 'Erro interno' }, { estado: 500, pedido, env });
    }
  },

  /* Limpeza. Corre uma vez por dia (ver o cron no wrangler.toml). Sem isto,
     `codigos_usados` cresce para sempre: são quatro linhas por minuto por
     cliente activo, e o plano gratuito do D1 tem 5 GB. */
  async scheduled(evento, env) {
    /* SÃO DOIS HORÁRIOS E NÃO UM.

       O de minuto a minuto existe para uma coisa só: drenar os avisos da
       Apple que ficaram por dar. Fazer a limpeza da madrugada todos os
       minutos era varrer a base inteira 1440 vezes por dia; e pôr os avisos
       na limpeza da madrugada era dizer «actualiza-se sozinho» e o cartão
       acertar-se no dia seguinte.

       O `evento.cron` diz qual deles disparou — é o próprio horário, tal como
       está escrito no `wrangler.toml`. */
    if (evento && evento.cron === '* * * * *') {
      await drenarAvisosDaApple(env);
      return;
    }

    const ontem = new Date(Date.now() - USADOS_HORAS * 3600000).toISOString();
    await env.DB.batch([
      env.DB.prepare('DELETE FROM codigos_usados WHERE usado_em < ?').bind(ontem),
      env.DB.prepare('DELETE FROM sessoes WHERE expira_em < ?').bind(agora()),
      /* E AS QUE APONTAM PARA NINGUÉM. Uma sessão de um cliente ou de um
         operador que já não existe não faz mal a ninguém — lê-se como sessão
         inválida e a app volta a registar-se —, mas é uma linha que mente a
         quem um dia contar sessões para saber quantas pessoas há.

         O produto não as faz: o `apagarCliente` e o `apagarOperador` levam-nas
         atrás. Faz-nas a mão que apaga uma conta de prova com um DELETE
         escrito à mão, e foram trinta e seis antes de isto existir. A varredura
         é aqui porque a próxima mão apressada vai ser igual à anterior. */
      env.DB.prepare(
        `DELETE FROM sessoes WHERE sujeito LIKE 'cliente:%'
           AND NOT EXISTS (SELECT 1 FROM clientes c WHERE 'cliente:' || c.id = sessoes.sujeito)`),
      env.DB.prepare(
        `DELETE FROM sessoes WHERE sujeito LIKE 'operador:%'
           AND NOT EXISTS (SELECT 1 FROM operadores o WHERE 'operador:' || o.id = sessoes.sujeito)`),
      env.DB.prepare('DELETE FROM entradas WHERE expira_em < ?').bind(agora()),
      env.DB.prepare('DELETE FROM envios WHERE em < ?')
        .bind(new Date(Date.now() - 86400000).toISOString()),
      /* A trava de registos conta uma hora; guardar mais do que isso era
         guardar origens sem nenhuma razão para as guardar. */
      env.DB.prepare('DELETE FROM registos WHERE em < ?')
        .bind(new Date(Date.now() - 3600000).toISOString()),
      /* As idas a um provedor de identidade que ficaram a meio. Uma ligação
         por concluir não é dados de ninguém — é um `state` e um verificador —
         mas guardá-la depois de caducada é guardar por guardar. */
      env.DB.prepare('DELETE FROM ligacoes WHERE expira_em < ?').bind(agora()),
    ]);
    await limparContasParadas(env);
    await reconciliarWallet(env);
    /* Rede por baixo do de minuto a minuto: se ele estiver em baixo uma noite
       inteira, a madrugada apanha o que ficou. */
    await drenarAvisosDaApple(env);
    avisarDoCertificado(env);
  },
};

/* =========================================================================
   O reconciliador da Wallet

   O que falhou durante o dia acerta-se de madrugada. É esta função que torna
   verdadeira a promessa do `espelharNaWallet`: falhar não custa nada, porque
   de manhã está certo.

   AOS BOCADOS, e não todos de uma vez. O plano gratuito dá 50 SUBPEDIDOS por
   invocação — e isto corre dentro de uma invocação só. Cinco carimbos por
   segundo num café não enchem isto nunca; uma noite em que a Google esteve em
   baixo durante horas, enche. Leva-se um punhado por noite e o resto fica
   para a seguinte, que é melhor do que rebentar a meio e não gravar nenhum.
   ========================================================================= */

const RECONCILIAR_MAX = 40;

async function reconciliarWallet(env) {
  if (!walletLigada(env)) return { feitos: 0 };
  /* Por sincronizar = nunca foi, ou foi antes do último carimbo. */
  const atrasados = (await env.DB.prepare(
    `SELECT id FROM cartoes
      WHERE wallet_em IS NOT NULL
        AND (wallet_sincronizado IS NULL
             OR (ultimo_em IS NOT NULL AND wallet_sincronizado < ultimo_em))
      LIMIT ?`
  ).bind(RECONCILIAR_MAX).all()).results;
  for (const c of atrasados) await espelharNaWallet(env, c.id);
  return { feitos: atrasados.length };
}

/* =========================================================================
   Contas paradas

   O RGPD não deixa guardar dados pessoais mais tempo do que o preciso, e uma
   conta que ninguém abre há dois anos é isso mesmo. Há duas passagens, e
   correm por esta ordem: primeiro avisa-se quem deixou email, `AVISO_DIAS`
   antes; depois apaga-se quem já passou dos `INACTIVA_MESES`.

   O QUE CONTA COMO SINAL DE VIDA, e é aqui que está a parte que se esquece:
   não é só abrir a app. Quem passa no café e leva um carimbo nunca toca na
   app — quem carimba é o balcão, com a sessão do balcão, e o `visto_em` do
   cliente não mexe. Por isso a pergunta olha para as duas coisas: a conta e
   os cartões dela. Apagar por uma só apagava clientes fiéis que não gostam
   de mexer no telemóvel.
   ========================================================================= */

/** Quantos meses para trás, em ISO. Os meses do JavaScript tratam do resto. */
function mesesAtras(meses) {
  const d = new Date();
  d.setMonth(d.getMonth() - meses);
  return d.toISOString();
}

/** As contas sem sinal de vida desde `limite`. */
async function contasParadas(env, limite, extra = '') {
  return (await env.DB.prepare(
    `SELECT c.id, c.email, c.email_verificado, c.avisada_em,
            -- PARA ONDE SE AVISA. O espelho clientes.email só existe para
            -- quem entrou pela porta do email: quem entra pela Google deixa-o
            -- a NULL (ver instrucoesDeIdentidade), e o aviso de conta parada
            -- olhava só para ele. Resultado: uma conta só-Google era apagada
            -- aos dois anos EM SILÊNCIO, com a morada dela guardada na tabela
            -- ao lado. A política de privacidade promete o aviso a quem tenha
            -- deixado email, e uma morada que a Google confirmou é email.
            -- O relay fica de fora de propósito: um relay da Apple pode ser
            -- desligado por quem o criou, e um aviso enviado para uma parede
            -- é pior do que nenhum, porque dá a marca por avisada.
            COALESCE(
              CASE WHEN c.email_verificado = 1 THEN c.email END,
              (SELECT i.email FROM identidades i
                WHERE i.cliente_id = c.id AND i.email IS NOT NULL AND i.relay = 0
                ORDER BY i.criada_em LIMIT 1)
            ) AS morada
       FROM clientes c
      WHERE COALESCE(c.visto_em, c.criado_em) < ?1
        -- AS SOMBRAS NÃO CONTAM. Uma sombra não tem cartões nem sinal de vida
        -- que mexa: está parada por definição, e a limpeza apagava-a ao fim de
        -- dois anos. Isso não parecia grave, e parte a única coisa para que
        -- ela existe -- o número antigo deixava de carimbar, em silêncio, dois
        -- anos depois de uma fusão de que ninguém se lembra. Caducar sombras é
        -- decisão à parte, e a coluna fundida_quando está lá para isso.
        AND c.fundida_em IS NULL
        AND NOT EXISTS (
          SELECT 1 FROM cartoes k
           WHERE k.cliente_id = c.id
             AND COALESCE(k.ultimo_em, k.aderiu_em) >= ?1
        )
        ${extra}`
  ).bind(limite).all()).results;
}

async function limparContasParadas(env) {
  const limiteApagar = mesesAtras(INACTIVA_MESES);
  const limiteAvisar = new Date(
    new Date(mesesAtras(INACTIVA_MESES)).getTime() + AVISO_DIAS * 86400000
  ).toISOString();

  /* 1. Avisar. Só quem tem morada — escrita aqui ou vinda de um provedor que a
        confirmou. A quem não tem não há por onde falar, e é o preço de uma
        conta sem morada nenhuma. O `avisada_em` impede que o aviso saia outra
        vez todos os dias durante um mês. */
  const aAvisar = await contasParadas(env, limiteAvisar,
    `AND c.avisada_em IS NULL
     AND (
       (c.email IS NOT NULL AND c.email_verificado = 1)
       OR EXISTS (SELECT 1 FROM identidades i
                   WHERE i.cliente_id = c.id AND i.email IS NOT NULL AND i.relay = 0)
     )`);
  for (const conta of aAvisar) {
    const r = await enviarEmail(env, {
      para: conta.morada,
      ...emailContaAApagar({ dias: AVISO_DIAS, meses: INACTIVA_MESES }),
    });
    /* Só se marca como avisada se o email saiu mesmo. Se a marca fosse posta
       à frente do envio, uma falha de correio calava o aviso para sempre e a
       conta era apagada sem ninguém ter sido avisado de nada. */
    if (r.enviado) {
      await env.DB.prepare('UPDATE clientes SET avisada_em = ? WHERE id = ?')
        .bind(agora(), conta.id).run();
    }
  }

  /* 2. Apagar. Uma a uma, e não num DELETE só: cada conta arrasta cartões,
        movimentos, prémios, sessões e entradas, e quem sabe essa lista é o
        `apagarCliente` — o mesmo que corre quando alguém carrega no botão. */
  const aApagar = await contasParadas(env, limiteApagar);
  for (const conta of aApagar) await apagarCliente(env, conta.id);

  return { avisadas: aAvisar.length, apagadas: aApagar.length };
}
