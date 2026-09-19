#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — bateria do Worker

   Corre contra um `wrangler dev --local` já a andar. Não testa só o caminho
   feliz: a maior parte destes casos é gente a tentar carimbar-se a si
   própria. Um cartão de fidelidade sem estas regras é um cartão que se
   fotografa e se manda aos amigos.

   Uso:  node worker/testes.mjs [http://localhost:8787]
   ========================================================================= */

import { createHash, createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = dirname(fileURLToPath(import.meta.url));
const BASE = process.argv[2] || 'http://localhost:8787';
/* Um PNG de 1×1, que chega para o que aqui se prova. */
const PNG_FIXO = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';

let passou = 0, falhou = 0;
const falhas = [];

function certo(condicao, descricao, detalhe = '') {
  if (condicao) { passou++; console.log(`  ✓ ${descricao}`); }
  else { falhou++; falhas.push(descricao); console.log(`  ✗ ${descricao}${detalhe ? ` — ${detalhe}` : ''}`); }
}

function grupo(nome) { console.log(`\n${nome}`); }

/**
 * Uma sessão de balcão para um operador qualquer, sem passar pelo correio.
 *
 * Mete-se o código na tabela das entradas, como o email faria, e troca-se.
 * É o mesmo caminho que a pessoa percorre — só sem o carteiro pelo meio.
 */
async function sessaoDeOperador(operadorId, correio) {
  const codigo = String(100000 + Math.floor(Math.random() * 899999));
  const resumo = createHash('sha256').update(`${correio}|${codigo}`).digest('hex');
  const expira = new Date(Date.now() + 600000).toISOString();
  sql(`DELETE FROM entradas WHERE email = '${correio}'`);
  sql(`INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em)
       VALUES ('${resumo}', 'operador:${operadorId}', '${correio}', datetime('now'), '${expira}')`);
  const r = await pedir('/v1/balcao/sessao', { metodo: 'POST', corpo: { email: correio, codigo } });
  return r.dados.sessao;
}

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Um pedido à API, com paciência para o servidor reiniciar.
 *
 * Não é indulgência com defeitos: é que `wrangler d1 execute --local` — que
 * é como estes testes preparam o estado — faz o `wrangler dev` reiniciar, e o
 * pedido que apanhar essa janela leva com um ECONNREFUSED que não tem nada a
 * ver com o código que se está a provar.
 *
 * ERA UMA TENTATIVA SÓ, com 1,5 s, e isso chegava nesta máquina e não chegava
 * no runner do CI — que é mais lento e estava a arrancar sob carga. O resultado
 * foi uma publicação vermelha com `TypeError: fetch failed` no meio de um grupo
 * que passa sempre: um flocado, que é a pior espécie de vermelho porque ensina
 * a ignorar o vermelho.
 *
 * As tentativas param de distinguir um defeito de um reinício se forem
 * infinitas. Não são: são quatro, e um Worker que morreu a sério não volta em
 * nenhuma delas — a mensagem final diz isso por palavras, para ninguém
 * diagnosticar o produto quando quem caiu foi o servidor de testes.
 */
const ESPERAS = [1500, 3000, 5000];

async function pedir(caminho, opcoes = {}) {
  for (let i = 0; ; i++) {
    try {
      return await pedirUmaVez(caminho, opcoes);
    } catch (erro) {
      const deLigacao = /fetch failed|ECONNRESET|ECONNREFUSED|socket hang up/.test(String(erro));
      if (!deLigacao) throw erro;
      if (i >= ESPERAS.length) {
        throw new Error(
          `O Worker não voltou depois de ${ESPERAS.length + 1} tentativas a ${caminho}. `
          + 'Isto é o servidor de testes em baixo, não o produto: ver o registo do wrangler. '
          + `Último erro: ${erro}`);
      }
      await dormir(ESPERAS[i]);
    }
  }
}

async function pedirUmaVez(caminho, { metodo = 'GET', corpo, sessao, cabecalhos } = {}) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(sessao ? { authorization: `Bearer ${sessao}` } : {}),
      ...(cabecalhos || {}),
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  let dados = null;
  const texto = await r.text();
  try { dados = texto ? JSON.parse(texto) : null; } catch { dados = { cru: texto }; }
  return { estado: r.status, dados };
}

function sql(instrucao) {
  return execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'carimbodigital',
    '--local', '--command', instrucao], { cwd: AQUI, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** Corre um ficheiro de migração, para se poder provar o que ele faz. */
function sqlFicheiro(caminho) {
  return execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'carimbodigital',
    '--local', '--file', caminho], { cwd: AQUI, stdio: ['ignore', 'pipe', 'pipe'] }).toString();
}

/** As linhas de um SELECT, já desembrulhadas do JSON que o wrangler cospe. */
function linhas(instrucao) {
  const o = sql(instrucao);
  return JSON.parse(o.slice(o.indexOf('[')))[0].results;
}

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const JANELA = 15;
function codigoPara(publico, segredo, deslocamento = 0) {
  const janela = Math.floor(Date.now() / 1000 / JANELA) + deslocamento;
  const mac = createHmac('sha256', deB64url(segredo)).update(`${publico}.${janela}`).digest('hex').slice(0, 16);
  return `C1.${publico}.${janela}.${mac}`;
}

/* --------------------------------------------------------------------- */

/* A TRAVA DE REGISTOS NÃO SE APLICA A ESTA BATERIA, e tem de ser dita assim.
   O `wrangler dev` põe `cf-connecting-ip` como qualquer pedido da borda, por
   isso a bateria inteira conta como UMA origem — e ela cria umas três dezenas
   de contas, que é exactamente o padrão que a trava existe para travar. Limpa-
   se o contador ao arrancar; o grupo «Criar contas em série» usa origens
   próprias e confere, antes de limpar, quantas é que a bateria gastou. */
sql(`DELETE FROM registos`);

grupo('Saúde');
{
  const r = await pedir('/v1/saude');
  certo(r.estado === 200 && r.dados.bem, 'o Worker responde', JSON.stringify(r.dados));
}

grupo('Registo do cliente');
let cliente, segredo, sessaoCliente;
{
  const r = await pedir('/v1/cliente/registar', { metodo: 'POST' });
  cliente = r.dados.cliente; segredo = r.dados.segredo; sessaoCliente = r.dados.sessao;
  certo(r.estado === 200, 'regista sem pedir nada');
  certo(/^[234679ACDEFGHJKLMNPQRTUVWXYZ]{6}$/.test(cliente.publico),
    'o número do cartão não tem letras que se confundam', cliente.publico);
  certo(!!segredo && segredo.length > 20, 'devolve o segredo do dispositivo');
  certo(cliente.email === null, 'não guarda email nenhum à partida');

  const outro = await pedir('/v1/cliente/registar', { metodo: 'POST' });
  certo(outro.dados.cliente.publico !== cliente.publico, 'dois clientes têm números diferentes');
  certo(outro.dados.segredo !== segredo, 'e segredos diferentes');
}

grupo('Sessão do balcão');
let sessaoBalcao;
{
  /* Simula-se o que o email faria: mete-se o código na base de dados e
     troca-se por uma sessão. */
  const correio = 'teste@exemplo.pt';
  const codigo = '314159';
  const resumo = createHash('sha256').update(`${correio}|${codigo}`).digest('hex');
  const expira = new Date(Date.now() + 600000).toISOString();
  sql(`DELETE FROM entradas`);
  sql(`INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em)
       VALUES ('${resumo}', 'operador:o1', '${correio}', datetime('now'), '${expira}')`);

  const r = await pedir('/v1/balcao/sessao', { metodo: 'POST', corpo: { email: correio, codigo } });
  sessaoBalcao = r.dados.sessao;
  certo(r.estado === 200 && !!sessaoBalcao, 'troca o código por uma sessão',
    JSON.stringify(r.dados).slice(0, 120));

  const outra = await pedir('/v1/balcao/sessao', { metodo: 'POST', corpo: { email: correio, codigo } });
  certo(outra.estado === 401, 'o mesmo código não serve duas vezes', String(outra.estado));

  /* Cinco enganos e o código morre — é isto que impede que se tentem um
     milhão de hipóteses num código de seis algarismos. */
  const resumo2 = createHash('sha256').update(`bruta@exemplo.pt|424242`).digest('hex');
  sql(`INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em)
       VALUES ('${resumo2}', 'operador:o1', 'bruta@exemplo.pt', datetime('now'), '${expira}')`);
  for (let i = 0; i < 5; i++) {
    await pedir('/v1/balcao/sessao', { metodo: 'POST', corpo: { email: 'bruta@exemplo.pt', codigo: '000000' } });
  }
  const morto = await pedir('/v1/balcao/sessao', {
    metodo: 'POST', corpo: { email: 'bruta@exemplo.pt', codigo: '424242' } });
  certo(morto.estado === 401, 'ao fim de cinco enganos o código certo já não vale',
    String(morto.estado));

  const curto = await pedir('/v1/balcao/sessao', { metodo: 'POST', corpo: { email: correio, codigo: '12' } });
  certo(curto.estado === 400, 'um código com menos de seis algarismos é recusado logo');

  const semSessao = await pedir('/v1/balcao/resumo');
  certo(semSessao.estado === 401, 'sem sessão não se vê nada');

  const comSessaoDeCliente = await pedir('/v1/balcao/resumo', { sessao: sessaoCliente });
  certo(comSessaoDeCliente.estado === 401, 'a sessão de um cliente não abre o balcão');
}

grupo('Carimbar');
{
  const r = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(cliente.publico, segredo), programaId: 'p1' },
  });
  certo(r.estado === 200, 'carimba', JSON.stringify(r.dados).slice(0, 120));
  certo(r.dados.cartao?.carimbos === 1, 'fica com 1 carimbo');
  certo(r.dados.novo === true, 'cria o cartão à primeira, sem adesão nenhuma');
  certo(r.dados.cartao?.programa?.objetivo === 10, 'traz o programa junto');
}

grupo('O que a app que está nos telemóveis espera');
{
  /* ESTA API ACRESCENTA. NÃO RENOMEIA NEM TIRA.

     A regra custou um botão a menos na produção. O campo `wallet` de um
     cartão passou a `carteiras`, o Worker publica-se num minuto e o site
     demora dez — e nesse intervalo a app pedia um campo que já não vinha,
     sem erro nenhum, só um botão que deixou de lá estar.

     E o intervalo é o menor dos problemas. Isto é uma aplicação instalada no
     ecrã inicial de gente, com o JavaScript em cache de um service worker: a
     cópia que uma pessoa tem pode ser de há semanas, e nenhuma publicação a
     obriga a actualizar. Um nome que muda parte essas cópias em silêncio.

     Por isso esta lista. Tirar um destes nomes tem de doer AQUI, e não no
     telemóvel de alguém. Acrescentar não mexe nesta lista; tirar obriga a
     apagar a linha à mão, que é o momento em que se pensa duas vezes. */
  const r = await pedir('/v1/cliente/cartoes', { sessao: sessaoCliente });
  const cartao = r.dados[0];
  const CAMPOS = ['id', 'carimbos', 'pontos', 'totalCarimbos', 'premiosGanhos',
    'aderiuEm', 'ultimoEm', 'negocio', 'programa', 'porResgatar', 'premios',
    'wallet', 'carteiras'];
  const faltam = CAMPOS.filter((c) => !(c in cartao));
  certo(faltam.length === 0,
    'um cartão continua a trazer todos os campos que a app espera',
    `faltam: ${faltam.join(', ')}`);

  const DO_NEGOCIO = ['id', 'nome', 'slug', 'cor', 'categoria', 'localidade', 'morada', 'telefone'];
  const faltamN = DO_NEGOCIO.filter((c) => !(c in (cartao.negocio || {})));
  certo(faltamN.length === 0, 'e o negócio também', `faltam: ${faltamN.join(', ')}`);

  certo(typeof cartao.wallet === 'boolean' && cartao.carteiras
     && typeof cartao.carteiras.google === 'boolean',
    'o nome velho e o novo convivem, que é o que deixa publicar os dois lados por ordens diferentes',
    JSON.stringify({ wallet: cartao.wallet, carteiras: cartao.carteiras }));
}

grupo('Defesas');
{
  /* Arrefecimento a zero para este grupo: senão o que recusa o segundo
     carimbo é a espera obrigatória e não a repetição, e o teste passava
     sem provar nada. */
  sql(`UPDATE programas SET arrefecimento = 0 WHERE id = 'p1'`);
  const codigo = codigoPara(cliente.publico, segredo, -2);
  await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo, programaId: 'p1' } });
  const repetido = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo, programaId: 'p1' } });
  certo(repetido.estado === 409 && repetido.dados.codigo === 'repetido',
    'o mesmo código não passa duas vezes', `${repetido.estado} ${repetido.dados.codigo}`);

  const velho = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(cliente.publico, segredo, -10), programaId: 'p1' } });
  certo(velho.dados.codigo === 'expirado', 'um código de há dois minutos já não vale',
    JSON.stringify(velho.dados));

  const futuro = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(cliente.publico, segredo, +10), programaId: 'p1' } });
  certo(futuro.dados.codigo === 'expirado', 'nem um código do futuro');

  const forjado = codigoPara(cliente.publico, b64url(randomBytes(32)));
  const r = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: forjado, programaId: 'p1' } });
  certo(r.estado === 403 && r.dados.codigo === 'assinatura',
    'um código assinado com outro segredo é recusado', JSON.stringify(r.dados));

  /* Troca-se o último dígito por outro qualquer, mas garantidamente
     diferente: substituir sempre por 'f' não mudava nada nas vezes em que o
     dígito já era 'f', e o teste passava a falhar de vez em quando sem razão
     aparente. */
  const original = codigoPara(cliente.publico, segredo);
  const ultimo = original.slice(-1);
  const trocado = original.slice(0, -1) + (ultimo === 'f' ? '0' : 'f');
  const r2 = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: trocado, programaId: 'p1' } });
  certo(r2.estado === 403 || r2.dados.codigo === 'assinatura',
    'mudar um dígito da assinatura chega para o código não valer');

  const lixo = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: 'https://exemplo.pt', programaId: 'p1' } });
  certo(lixo.dados.codigo === 'formato', 'um QR de outra coisa qualquer é recusado com jeito');

  const inexistente = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: 'M1.ZZZZZZ', programaId: 'p1' } });
  certo(inexistente.dados.codigo === 'sem-cliente', 'um número que não existe dá erro claro');

  /* UM CÓDIGO DE DEMONSTRAÇÃO LIDO NUM BALCÃO A SÉRIO.

     Nunca poderia ser carimbado — é assinado com outro segredo e o cliente
     dele vive dentro do browser de outra pessoa —, mas a resposta era
     «formato», a mesma que se dá a um QR de um site qualquer. Quem estava ao
     balcão ia procurar o defeito na câmara, no leitor, no cartão; e o que
     estava errado era a app do outro lado estar em demonstração.

     É por isso que o código da demonstração leva `D1` e não `C1`: para haver
     uma resposta que se possa ler em voz alta. */
  const demo = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(cliente.publico, segredo).replace(/^C1\./, 'D1.'),
             programaId: 'p1' } });
  certo(demo.dados.codigo === 'demonstracao',
    'um código de demonstração é reconhecido como tal, e não confundido com lixo',
    JSON.stringify(demo.dados));
  certo(/demonstra/i.test(demo.dados.erro || ''),
    'e a frase diz a palavra, para o balcão a poder ler ao cliente', demo.dados.erro);
}

grupo('A faixa servida à Google');
{
  /* A rota é ABERTA — a Google não leva cabeçalho nenhum — e desenha uma
     imagem, que custa CPU. Tudo o que a protege é o selo no fim do nome. */
  const r404 = await fetch(`${BASE}/v1/faixa/c-EE9125-7-10-tesoura-750x288-lixolixolixo.png`);
  certo(r404.status === 404,
    'um endereço de faixa com o selo errado não desenha nada', String(r404.status));

  const semSelo = await fetch(`${BASE}/v1/faixa/c-EE9125-7-10-tesoura-750x288.png`);
  certo(semSelo.status === 404,
    'e um endereço sem selo nenhum também não', String(semSelo.status));

  /* E AGORA A QUE FALTAVA: que um endereço BEM assinado serve mesmo a imagem.

     As três acima são todas recusas — uma rota que devolvesse 404 a tudo
     passava nas três, e eu teria ficado convencido de que a tinha provado. A
     chave-mestra é sorteada a cada corrida e escrita no `.dev.vars`; lê-se de
     lá e calcula-se o selo exactamente como o Worker o calcula. */
  const { readFileSync: lerFicheiro } = await import('node:fs');
  const chaveMestra = (lerFicheiro(join(AQUI, '.dev.vars'), 'utf8')
    .match(/^CHAVE_MESTRA=(.+)$/m) || [])[1];
  certo(!!chaveMestra, 'a chave-mestra lê-se do .dev.vars (senão o resto não prova nada)');

  const paraBytes = (b64) => Buffer.from(b64.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const selar = (caminho) => createHmac('sha256', paraBytes(chaveMestra))
    .update(`faixa:${caminho}`).digest('base64')
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '').slice(0, 12);

  const corpo = 'c-EE9125-7-10-tesoura-750x288';
  const boa = await fetch(`${BASE}/v1/faixa/${corpo}-${selar(corpo)}.png`);
  certo(boa.status === 200 && boa.headers.get('content-type') === 'image/png',
    'um endereço BEM assinado serve a faixa',
    `${boa.status} ${boa.headers.get('content-type')}`);
  certo((boa.headers.get('cache-control') || '').includes('immutable'),
    'e diz que nunca muda — o endereço contém o estado, por isso é verdade',
    String(boa.headers.get('cache-control')));

  const desenhada = Buffer.from(await boa.arrayBuffer());
  certo(desenhada.readUInt32BE(16) === 750 && desenhada.readUInt32BE(20) === 288,
    'e o que vem tem as medidas que o endereço pediu',
    `${desenhada.readUInt32BE(16)}×${desenhada.readUInt32BE(20)}`);

  /* E as medidas são uma LISTA, não um intervalo: sem isso, um pedido de
     4000×4000 era um pedido de 48 MB de memória e de muito mais CPU do que o
     tecto do plano gratuito. Aqui o selo vai CERTO, para a recusa ser da
     medida e não da assinatura. */
  const gigCorpo = 'c-EE9125-7-10-tesoura-4000x4000';
  const gigante = await fetch(`${BASE}/v1/faixa/${gigCorpo}-${selar(gigCorpo)}.png`);
  certo(gigante.status === 404,
    'e uma medida fora da lista não se serve, mesmo bem assinada', String(gigante.status));
}

grupo('Arrefecimento');
{
  sql(`UPDATE programas SET arrefecimento = 3600 WHERE id = 'p1'`);
  /* Janela -1: ainda dentro da tolerância, mas é um código que nunca foi
     usado — senão o que dispara primeiro é a repetição e não se testa nada. */
  const r = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(cliente.publico, segredo, -1), programaId: 'p1' } });
  certo(r.estado === 429 && r.dados.codigo === 'arrefecimento',
    'não deixa carimbar duas vezes seguidas', JSON.stringify(r.dados));
  certo(typeof r.dados.faltam === 'number', 'e diz quanto falta esperar');
}

grupo('Prémio');
let premioId, cartaoId;
{
  sql(`UPDATE programas SET arrefecimento = 0, maximo_diario = 0 WHERE id = 'p1'`);
  /* Para encher o cartão usa-se a entrada manual: um código assinado só vale
     dentro de duas janelas de 15 s, e inventar janelas futuras é exactamente
     o que o servidor recusa (e bem).
     Carimba-se até completar em vez de contar à mão — assim o teste não se
     parte de cada vez que se mexe no número de carimbos do programa. */
  let ultimo, voltas = 0;
  do {
    ultimo = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
      corpo: { codigo: `M1.${cliente.publico}`, programaId: 'p1' } });
    voltas++;
  } while (ultimo.estado === 200 && !ultimo.dados.ganhos?.length && voltas < 20);
  certo(ultimo.estado === 200, 'chega aos dez carimbos', JSON.stringify(ultimo.dados).slice(0, 140));
  certo(ultimo.dados.ganhos?.length === 1, 'e ganha um prémio');
  certo(ultimo.dados.cartao?.carimbos === 0, 'o cartão recomeça a zero');
  certo(ultimo.dados.cartao?.porResgatar === 1, 'com o prémio à espera');
  premioId = ultimo.dados.ganhos?.[0]?.id;
  cartaoId = ultimo.dados.cartao?.id;
}

grupo('Anular');
{
  const antes = await pedir(`/v1/cliente/cartoes/${cartaoId}`, { sessao: sessaoCliente });
  const movimento = antes.dados.movimentos.find((m) => m.tipo === 'carimbo');
  const r = await pedir('/v1/balcao/anular', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { movimentoId: movimento.id } });
  certo(r.estado === 200, 'anula o carimbo que se acabou de dar');
  certo(r.dados.cartao.carimbos === 9, 'o cartão volta a nove de dez',
    String(r.dados.cartao.carimbos));
  certo(r.dados.cartao.porResgatar === 0, 'e o prémio desaparece com ele');

  const outraVez = await pedir('/v1/balcao/anular', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { movimentoId: movimento.id } });
  certo(outraVez.estado === 404, 'não se anula duas vezes o mesmo movimento');
}

grupo('Resgatar');
{
  let r, voltas = 0;
  do {
    r = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
      corpo: { codigo: `M1.${cliente.publico}`, programaId: 'p1' } });
    voltas++;
  } while (r.estado === 200 && !r.dados.ganhos?.length && voltas < 20);
  const premio = r.dados.ganhos?.[0];
  certo(!!premio, 'volta a completar o cartão', JSON.stringify(r.dados).slice(0, 120));
  if (!premio) { console.log('\n(sem prémio — o resto do grupo não corre)'); }
  else {

  const entrega = await pedir('/v1/balcao/resgatar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { premioId: premio.id } });
  certo(entrega.estado === 200, 'entrega o prémio');
  certo(entrega.dados.cartao.porResgatar === 0, 'e deixa de estar à espera');

  const outra = await pedir('/v1/balcao/resgatar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { premioId: premio.id } });
  certo(outra.estado === 409, 'o mesmo prémio não se entrega duas vezes');
  }
}

grupo('Entrada manual');
{
  sql(`UPDATE programas SET arrefecimento = 0 WHERE id = 'p1'`);
  const r = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${cliente.publico}`, programaId: 'p1' } });
  certo(r.estado === 200, 'aceita o número escrito à mão');
  certo(r.dados.manual === true, 'e marca-o como manual, para ficar no histórico');
}

grupo('Tecto diário');
{
  sql(`UPDATE programas SET maximo_diario = 1 WHERE id = 'p1'`);
  const r = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${cliente.publico}`, programaId: 'p1' } });
  certo(r.estado === 429 && r.dados.codigo === 'maximo-diario',
    'o tecto diário trava', JSON.stringify(r.dados));
  sql(`UPDATE programas SET maximo_diario = 0 WHERE id = 'p1'`);
}

grupo('O que o cliente vê');
{
  const r = await pedir('/v1/cliente/cartoes', { sessao: sessaoCliente });
  certo(r.estado === 200 && r.dados.length === 1, 'vê o seu cartão');
  certo(r.dados[0].negocio.nome === 'O Meu Café', 'com o nome do negócio');
  certo(r.dados[0].programa.selo === 'chavena', 'e o desenho do carimbo');

  const alheio = await pedir(`/v1/cliente/cartoes/${cartaoId}`);
  certo(alheio.estado === 401, 'sem sessão não vê cartão nenhum');
}

grupo('Muitos cartões não rebentam a resposta');
{
  /* O TECTO SÃO CINQUENTA SUBPEDIDOS POR INVOCAÇÃO.

     A carteira e a exportação de dados faziam duas a cinco consultas POR
     CARTÃO, em ciclo. A partir de uns dez cartões, o «Descarregar os meus
     dados» — que é o direito de portabilidade do artigo 20.º do RGPD —
     rebentava com «Too many subrequests» e a pessoa via «Erro interno». O
     direito de levar os dados consigo não pode depender de se ter poucos
     cartões.

     Doze programas em negócios diferentes, que é mais do que os dez onde isto
     partia e o máximo que um negócio pode ter. */
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST' });
  const sessaoM = c.dados.sessao;

  /* A LIMPEZA CORRE MESMO QUE ISTO REBENTE. Estava no fim do bloco, sem rede:
     um `sql()` que falhasse — ou um `Object.keys` sobre `undefined` — deixava
     doze negócios de mentira na base local, e os grupos que leem o
     `/v1/descobrir` passavam a provar outro programa qualquer, a verde. Um
     teste que estraga o estado de outro só se nota à segunda corrida, que é
     quando já ninguém liga o resultado à causa. */
  const levantarAMesa = () => {
    try {
      sql(`DELETE FROM marcos WHERE programa_id LIKE 'p-muitos-%';
           DELETE FROM programas WHERE id LIKE 'p-muitos-%';
           DELETE FROM negocios WHERE id LIKE 'n-muitos-%';
           DELETE FROM programas WHERE id LIKE 'p-cem-%';
           DELETE FROM negocios WHERE id LIKE 'n-cem-%'`);
    } catch { /* se nem isto dá, o `--limpo` resolve */ }
  };

  try {

  const programas = [];
  for (let i = 0; i < 12; i += 1) {
    const nid = `n-muitos-${i}`;
    const pid = `p-muitos-${i}`;
    sql(`INSERT OR REPLACE INTO negocios (id, slug, nome, cor, estado, criado_em)
         VALUES ('${nid}', 'muitos-${i}', 'Casa ${i}', '#3B2417', 'ativo',
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    sql(`INSERT OR REPLACE INTO programas (id, negocio_id, nome, tipo, objetivo, premio,
         selo, ativo, criado_em)
         VALUES ('${pid}', '${nid}', 'Cartão ${i}', '${i % 3 === 0 ? 'pontos' : 'carimbos'}',
                 10, 'Um brinde', 'chavena', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    if (i % 3 === 0) {
      sql(`INSERT OR REPLACE INTO marcos (programa_id, pontos, premio)
           VALUES ('${pid}', 50, 'Meio caminho')`);
    }
    programas.push(pid);
  }
  for (const pid of programas) {
    await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: sessaoM, corpo: { programaId: pid } });
  }

  const carteira = await pedir('/v1/cliente/cartoes', { sessao: sessaoM });
  certo(carteira.estado === 200 && carteira.dados.length === 12,
    'a carteira com doze cartões responde, e traz os doze',
    `${carteira.estado} · ${Array.isArray(carteira.dados) ? carteira.dados.length : JSON.stringify(carteira.dados).slice(0, 80)}`);
  certo(carteira.dados.every((x) => x.negocio && x.negocio.nome && x.programa && x.programa.objetivo),
    'e cada um traz o negócio e o programa, como sempre trouxe');
  const dePontos = carteira.dados.filter((x) => x.programa.tipo === 'pontos');
  certo(dePontos.length === 4 && dePontos.every((x) => Array.isArray(x.programa.marcos)
    && x.programa.marcos.length === 1),
    'e os programas de pontos trazem os marcos certos — que é a consulta a mais do lote',
    JSON.stringify(dePontos.map((x) => x.programa.marcos)));

  const dados = await pedir('/v1/cliente/dados', { sessao: sessaoM });
  certo(dados.estado === 200 && dados.dados.cartoes.length === 12,
    'e a exportação de dados também — era aqui que dava «Erro interno»',
    `${dados.estado} · ${dados.dados && dados.dados.cartoes ? dados.dados.cartoes.length : JSON.stringify(dados.dados).slice(0, 80)}`);
  certo(dados.estado === 200 && dados.dados.movimentos.length === 12,
    'com um movimento de adesão por cartão', String(dados.dados.movimentos?.length));

  /* A FORMA TEM DE SER A MESMA. Há dois caminhos para moldar um cartão — um
     a um, e em lote — e duas cópias de uma forma divergem ao primeiro campo
     novo. Compara-se um contra o outro. */
  /* UM DE CADA TIPO, e o de PONTOS não é opcional: os `marcos` são o ÚNICO
     campo que os dois caminhos calculam de maneira diferente — um com um
     `SELECT ... FROM marcos`, o outro a encher um mapa à mão — e num cartão de
     carimbos são `null` nos dois por razões triviais. Comparar só o primeiro
     cartão caía sempre num de carimbos, e a afirmação passava por cima
     justamente do sítio onde eles podem divergir. */
  for (const tipo of ['carimbos', 'pontos']) {
    const alvo = carteira.dados.find((x) => x.programa.tipo === tipo);
    certo(!!alvo, `há um cartão de ${tipo} para comparar`, String(Boolean(alvo)));
    if (!alvo) continue;
    const umPorUm = await pedir(`/v1/cliente/cartoes/${alvo.id}`, { sessao: sessaoM });
    const { movimentos: _m, ...soCartao } = umPorUm.dados;
    certo(JSON.stringify(Object.keys(soCartao).sort()) === JSON.stringify(Object.keys(alvo).sort()),
      `${tipo}: sozinho e em lote têm exactamente os mesmos campos`,
      `sozinho ${Object.keys(soCartao).sort().join(',')} | lote ${Object.keys(alvo).sort().join(',')}`);
    certo(JSON.stringify(soCartao) === JSON.stringify(alvo),
      `${tipo}: e exactamente os mesmos valores`,
      `${JSON.stringify(soCartao).slice(0, 110)} ≠ ${JSON.stringify(alvo).slice(0, 110)}`);
  }
  const deMarcos = carteira.dados.find((x) => x.programa.tipo === 'pontos');
  certo(deMarcos && Array.isArray(deMarcos.programa.marcos)
     && deMarcos.programa.marcos.length === 1
     && deMarcos.programa.marcos[0].pontos === 50
     && deMarcos.programa.marcos[0].premio === 'Meio caminho',
    'e os marcos vêm inteiros — pontos E prémio, que é onde o lote podia perder um campo',
    JSON.stringify(deMarcos && deMarcos.programa.marcos));

  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: sessaoM });

  {
    /* E ACIMA DOS CEM. O D1 aceita cem parâmetros por consulta e nem um a
       mais: o `IN (?, ?, …)` que resolveu o N+1 punha o mesmo tecto cento e
       um cartões à frente. É o género de limite que ninguém encontra a testar
       e alguém encontra a usar.

       Os cartões escrevem-se directamente na base, e não por cento e dez
       chamadas à API — o que se prova aqui é a LEITURA. */
    const c2 = await pedir('/v1/cliente/registar', { metodo: 'POST' });
    const eu = c2.dados.cliente.id;
    const QUANTOS = 110;
    /* NUMA INSTRUÇÃO SÓ. Cada `sql()` levanta um processo do wrangler e leva
       segundos; trezentas e trinta chamadas punham este bloco a demorar mais
       do que a bateria inteira. */
    const linhas = [];
    for (let i = 0; i < QUANTOS; i += 1) {
      linhas.push(`INSERT OR REPLACE INTO negocios (id, slug, nome, cor, estado, criado_em)`
        + ` VALUES ('n-cem-${i}', 'cem-${i}', 'Cem ${i}', '#3B2417', 'ativo', strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
      linhas.push(`INSERT OR REPLACE INTO programas (id, negocio_id, nome, tipo, objetivo, premio, selo, ativo, criado_em)`
        + ` VALUES ('p-cem-${i}', 'n-cem-${i}', 'Cartão ${i}', 'carimbos', 10, 'Um brinde', 'chavena', 1, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
      linhas.push(`INSERT OR REPLACE INTO cartoes (id, cliente_id, programa_id, negocio_id, carimbos, pontos, total_carimbos, premios_ganhos, aderiu_em)`
        + ` VALUES ('c-cem-${i}', '${eu}', 'p-cem-${i}', 'n-cem-${i}', 1, 0, 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    }
    sql(linhas.join('; '));

    const muitos = await pedir('/v1/cliente/cartoes', { sessao: c2.dados.sessao });
    certo(muitos.estado === 200 && muitos.dados.length === QUANTOS,
      `a carteira com ${QUANTOS} cartões responde — acima dos cem parâmetros do D1`,
      `${muitos.estado} · ${Array.isArray(muitos.dados) ? muitos.dados.length : JSON.stringify(muitos.dados).slice(0, 90)}`);
    certo(muitos.estado === 200 && muitos.dados.every((x) => x.negocio && x.negocio.nome),
      'e todos trazem o negócio — nenhum lote ficou por ler');

    const exp = await pedir('/v1/cliente/dados', { sessao: c2.dados.sessao });
    certo(exp.estado === 200 && exp.dados.cartoes.length === QUANTOS,
      'e a exportação de dados também',
      `${exp.estado} · ${exp.dados && exp.dados.cartoes ? exp.dados.cartoes.length : JSON.stringify(exp.dados).slice(0, 90)}`);

    await pedir('/v1/cliente', { metodo: 'DELETE', sessao: c2.dados.sessao });
  }

  } finally { levantarAMesa(); }
}

grupo('O código do passe carimba mesmo');
{
  /* ESTE É O TESTE QUE FALTAVA, e a falta dele custou a funcionalidade toda.

     Havia duas afirmações a dizer que o código de barras «leva o prefixo W1.,
     por onde o balcão reconhece um passe» — e as duas olhavam para o texto
     que o `wallet.js` escreve, nenhuma o mandava ao balcão. O `carimbar()`
     não tinha ramo nenhum para `W1.`: caía no `else` e respondia «Este código
     não é de um cartão Carimbo Digital». Um cliente com o cartão na carteira
     do telemóvel mostrava-o ao café e não levava carimbo.

     Uma afirmação sobre o que uma função ESCREVE não prova que alguém saiba
     LER — é preciso fechar o círculo, mandando ao balcão o mesmo texto que
     vai dentro do passe. */
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST' });
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: c.dados.sessao,
    corpo: { programaId: 'p1' } });
  const meus = await pedir('/v1/cliente/cartoes', { sessao: c.dados.sessao });
  const cartaoId = meus.dados[0].id;

  sql(`UPDATE programas SET arrefecimento = 0, maximo_diario = 0 WHERE id = 'p1'`);
  /* Sem logótipo não há passe — a Google recusa a classe. Põe-se aqui porque
     este grupo corre antes daquele que grava um. */
  sql(`UPDATE negocios SET logotipo = 'image/png;${PNG_FIXO}',
       logotipo_em = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'n1'`);
  const passe = await pedir(`/v1/cliente/cartoes/${cartaoId}/wallet`,
    { metodo: 'POST', sessao: c.dados.sessao });
  certo(passe.estado === 200, 'o cartão ganha passe na carteira', String(passe.estado));

  /* O código que ficou GRAVADO, que é o que vai no QR do passe. */
  const guardado = (() => {
    const o = sql(`SELECT wallet_codigo FROM cartoes WHERE id = '${cartaoId}'`);
    return JSON.parse(o.slice(o.indexOf('[')))[0].results[0].wallet_codigo;
  })();
  certo(typeof guardado === 'string' && guardado.length === 16,
    'e esse passe tem um código próprio, que não é o número do cliente',
    String(guardado));
  certo(typeof guardado === 'string' && guardado !== c.dados.cliente.publico,
    'mesmo — é um token à parte, para se poder revogar um passe fotografado',
    `${guardado} vs ${c.dados.cliente.publico}`);

  const lido = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `W1.${guardado}`, programaId: 'p1' } });
  certo(lido.estado === 200,
    'O BALCÃO CARIMBA O CÓDIGO DO PASSE — era isto que não acontecia',
    `${lido.estado} ${JSON.stringify(lido.dados).slice(0, 90)}`);
  certo(lido.dados.cartao && lido.dados.cartao.carimbos === 1,
    'e o carimbo cai no cartão certo', JSON.stringify(lido.dados.cartao?.carimbos));
  certo(lido.dados.cliente && lido.dados.cliente.publico === c.dados.cliente.publico,
    'e é mesmo o cliente do passe', JSON.stringify(lido.dados.cliente));

  const movimento = (() => {
    const o = sql(`SELECT manual FROM movimentos WHERE cartao_id = '${cartaoId}'
                    AND tipo = 'carimbo' ORDER BY em DESC LIMIT 1`);
    return JSON.parse(o.slice(o.indexOf('[')))[0].results[0];
  })();
  certo(movimento && movimento.manual === 0,
    'e não fica marcado como escrito à mão — quem leu isto foi a câmara',
    JSON.stringify(movimento));

  const inventado = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: 'W1.NAOEXISTENADA0', programaId: 'p1' } });
  certo(inventado.estado === 404 && inventado.dados.codigo === 'sem-passe',
    'um passe que já não vale diz-se com uma frase, e não com um 500',
    `${inventado.estado} ${inventado.dados.codigo}`);

  sql(`UPDATE programas SET arrefecimento = 3600, maximo_diario = 4 WHERE id = 'p1'`);
  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: c.dados.sessao });
}

grupo('Descobrir');
{
  const r = await pedir('/v1/descobrir');
  certo(r.estado === 200 && r.dados.length >= 1, 'lista os negócios');
  certo(!!r.dados[0].programas?.length, 'com os programas de cada um');
  const p = await pedir('/v1/p/o-meu-cafe');
  certo(p.estado === 200 && p.dados.nome === 'O Meu Café', 'a página pública do negócio existe');

  /* UM NEGÓCIO DE DEMONSTRAÇÃO NÃO SE ANUNCIA.
     Há um café em produção que não existe na rua: é o banco de provas, e
     provar um cartão de fidelidade a sério exige uma loja com clientes,
     carimbos e prémios. Só que ele estava nesta lista, ao lado de uma
     barbearia que existe, e alguém em Ovar podia juntar o cartão de uma porta
     que não abre. O endereço PRÓPRIO continua a responder — é o que o cartaz
     e o código QR usam, e sem isso a marca deixava de haver forma de provar
     seja o que for. */
  const antes = (await pedir('/v1/descobrir')).dados.length;
  sql(`UPDATE negocios SET demonstracao = 1 WHERE id = 'n1'`);
  const lista = await pedir('/v1/descobrir');
  certo(lista.dados.length === antes - 1,
    'um negócio marcado como demonstração sai da lista pública',
    `${antes} → ${lista.dados.length}`);
  certo(!lista.dados.some((n) => n.slug === 'o-meu-cafe'),
    'e é mesmo ele que sai', JSON.stringify(lista.dados.map((n) => n.slug)));

  const directo = await pedir('/v1/p/o-meu-cafe');
  certo(directo.estado === 200 && directo.dados.nome === 'O Meu Café',
    'mas o endereço próprio continua a responder — é o que o cartaz e o QR usam',
    String(directo.estado));

  const noBalcao = await pedir('/v1/balcao/negocio', { sessao: sessaoBalcao });
  certo(noBalcao.dados.negocio.demonstracao === true,
    'e o balcão sabe-o, para poder dizer ao dono porque é que não aparece na lista',
    JSON.stringify(noBalcao.dados.negocio.demonstracao));

  sql(`UPDATE negocios SET demonstracao = 0 WHERE id = 'n1'`);
  certo((await pedir('/v1/descobrir')).dados.length === antes,
    'e tirar a marca devolve-o à lista', String(antes));
}

grupo('RGPD');
{
  const dados = await pedir('/v1/cliente/dados', { sessao: sessaoCliente });
  certo(dados.estado === 200 && !!dados.dados.cliente, 'exporta tudo o que temos');
  certo(Array.isArray(dados.dados.movimentos) && dados.dados.movimentos.length > 0,
    'incluindo o histórico');

  const apagar = await pedir('/v1/cliente', { metodo: 'DELETE', sessao: sessaoCliente });
  certo(apagar.estado === 200 && apagar.dados.apagado, 'apaga a conta');

  const depois = await pedir('/v1/cliente/cartoes', { sessao: sessaoCliente });
  certo(depois.estado === 401, 'e a sessão morre com ela');

  const orfaos = sql(`SELECT COUNT(*) AS n FROM cartoes WHERE cliente_id = '${cliente.id}'`);
  certo(/"n":\s*0/.test(orfaos), 'não ficam cartões órfãos na base de dados');
}

grupo('Entregar e anular: o que o café não pode perder duas vezes');
{
  /* Um cliente próprio, para não estragar o estado dos grupos acima. */
  sql(`UPDATE programas SET arrefecimento = 0, maximo_diario = 0 WHERE id = 'p1'`);
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: c.dados.sessao, corpo: { programaId: 'p1' } });

  const carimbar = () => pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${c.dados.cliente.publico}`, programaId: 'p1' } });

  let r, voltas = 0;
  do { r = await carimbar(); voltas++; } while (r.estado === 200 && !r.dados.ganhos?.length && voltas < 25);
  certo(r.dados?.ganhos?.length === 1, 'enche-se o cartão e sai um prémio',
    JSON.stringify(r.dados?.ganhos?.length));
  const premio = r.dados.ganhos[0].id;
  const movimento = r.dados.movimentoId;

  /* --- ENTREGAR SEM CARIMBAR -------------------------------------------
     A lista de clientes dizia «prémio» ao lado do número do cartão e mandava
     só uma CONTAGEM. Com uma contagem não se entrega nada: o balcão precisa
     do id. E o único caminho para o painel de entrega era carimbar outra
     vez — que o arrefecimento fecha durante uma hora. Quem fechasse o cartão
     e dissesse «levo noutro dia» ficava sem café até voltar noutro dia e
     ganhar um carimbo que não pediu. */
  {
    const lista = await pedir('/v1/balcao/clientes', { sessao: sessaoBalcao });
    const dele = lista.dados.find((x) => x.publico === c.dados.cliente.publico);
    certo(dele && Array.isArray(dele.premios) && dele.premios.length === 1,
      'a lista de clientes traz os prémios por entregar, e não só a conta deles',
      JSON.stringify(dele && { porResgatar: dele.porResgatar, premios: dele.premios }));
    certo(dele && dele.premios[0].id === premio && dele.premios[0].descricao,
      'com o id, que é o que permite entregá-lo daqui',
      JSON.stringify(dele && dele.premios[0]));
    certo(dele && dele.porResgatar === 1,
      'e a contagem antiga fica — esta API acrescenta, não renomeia',
      String(dele && dele.porResgatar));
  }

  /* --- entregar duas vezes ---------------------------------------------- */
  const uma = await pedir('/v1/balcao/resgatar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { premioId: premio, operador: 'Balcão' } });
  certo(uma.estado === 200, 'o prémio entrega-se', String(uma.estado));
  const outra = await pedir('/v1/balcao/resgatar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { premioId: premio, operador: 'Balcão' } });
  certo(outra.estado === 409, 'e não se entrega uma segunda vez', String(outra.estado));

  const historico = sql(`SELECT COUNT(*) AS n FROM movimentos
                          WHERE tipo = 'resgate' AND cartao_id = '${r.dados.cartao.id}'`);
  certo(/"n":\s*1/.test(historico), 'e fica um resgate no histórico, não dois', historico.slice(0, 90));

  {
    /* E depois de entregue some da lista: um prémio entregue que continuasse
       a aparecer punha o balcão a dá-lo outra vez. */
    const lista = await pedir('/v1/balcao/clientes', { sessao: sessaoBalcao });
    const dele = lista.dados.find((x) => x.publico === c.dados.cliente.publico);
    certo(dele && dele.premios.length === 0 && dele.porResgatar === 0,
      'e depois de entregue sai da lista de por-entregar',
      JSON.stringify(dele && { porResgatar: dele.porResgatar, premios: dele.premios }));
  }

  /* --- anular por cima de um prémio já entregue -------------------------- */
  const tarde = await pedir('/v1/balcao/anular', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { movimentoId: movimento } });
  certo(tarde.estado === 409,
    'não se anula o carimbo que deu um prémio que já saiu pela porta', String(tarde.estado));
  certo(/premio-entregue/.test(JSON.stringify(tarde.dados)),
    'e diz-se porquê', JSON.stringify(tarde.dados));

  /* --- anular o que não é carimbo --------------------------------------- */
  const adesao = sql(`SELECT id FROM movimentos WHERE cartao_id = '${r.dados.cartao.id}'
                       AND tipo = 'adesao' LIMIT 1`);
  const idAdesao = (adesao.match(/"id":\s*"([^"]+)"/) || [])[1];
  if (idAdesao) {
    const nao = await pedir('/v1/balcao/anular', { metodo: 'POST', sessao: sessaoBalcao,
      corpo: { movimentoId: idAdesao } });
    certo(nao.estado === 400, 'nem a adesão de um cliente se anula', String(nao.estado));
    const aindaLa = sql(`SELECT COUNT(*) AS n FROM movimentos WHERE id = '${idAdesao}'`);
    certo(/"n":\s*1/.test(aindaLa), 'e ela continua no histórico', aindaLa.slice(0, 80));
  }

  /* --- um id em falta é um pedido mal feito, não uma avaria ------------- */
  for (const [rota, corpo] of [
    ['/v1/balcao/anular', {}],
    ['/v1/balcao/resgatar', {}],
  ]) {
    const mau = await pedir(rota, { metodo: 'POST', sessao: sessaoBalcao, corpo });
    certo(mau.estado === 400, `${rota} sem id dá 400, não 500`, String(mau.estado));
  }

  /* --- anular repõe o relógio do arrefecimento --------------------------- */
  /* O cenário verdadeiro: o balcão carimba o cliente errado e anula logo a
     seguir. Precisa de um cartão limpo, porque num cartão com carimbos de há
     dez segundos o arrefecimento continua a bloquear — e bem: repor o relógio
     é pô-lo no carimbo ANTERIOR, não deitá-lo fora.

     O que estava partido era isso mesmo: o `ultimo_em` ficava com a marca do
     carimbo anulado, que já não existe em lado nenhum. Um cartão acabado de
     estrear ficava uma hora fechado por causa de um engano de dois segundos. */
  sql(`UPDATE programas SET arrefecimento = 3600 WHERE id = 'p1'`);
  const enganado = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: enganado.dados.sessao,
    corpo: { programaId: 'p1' } });
  const carimbarEnganado = () => pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${enganado.dados.cliente.publico}`, programaId: 'p1' } });

  const engano = await carimbarEnganado();
  certo(engano.estado === 200, 'carimba-se o cliente errado', String(engano.estado));
  const travado = await carimbarEnganado();
  certo(travado.estado === 429, 'e o arrefecimento tranca o cartão', String(travado.estado));

  const desfeito = await pedir('/v1/balcao/anular', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { movimentoId: engano.dados.movimentoId } });
  certo(desfeito.estado === 200, 'anula-se', JSON.stringify(desfeito.dados).slice(0, 100));

  const outraVez = await carimbarEnganado();
  certo(outraVez.estado === 200,
    'e o cartão volta a aceitar carimbo — não fica uma hora fechado por um engano',
    JSON.stringify(outraVez.dados).slice(0, 140));

  sql(`UPDATE programas SET arrefecimento = 0 WHERE id = 'p1'`);
}

grupo('Rotas do balcão que nunca tinham sido tocadas');
{
  /* Sete das vinte e duas rotas não tinham teste nenhum. Estas são as que
     um dono de café usa no primeiro dia: fundar, ver o negócio, mudar o
     cartão, e ver quem lá anda. */
  const correio = `dono-${Date.now()}@exemplo.pt`;
  const f = await pedir('/v1/balcao/fundar', { metodo: 'POST', corpo: {
    codigo: 'TESTE1', nome: 'Padaria da Sonda', email: correio, objetivo: 8 } });
  certo(f.estado === 200 && !!f.dados.sessao, 'fundar devolve sessão logo',
    JSON.stringify(f.dados).slice(0, 120));
  /* Sem sessão não há nada a fazer aqui — e continuar rebentava com um
     TypeError que levava a bateria inteira à frente, escondendo os grupos
     que vêm a seguir. Uma falha de configuração tem de reprovar um grupo,
     não matar a corrida. */
  const S = f.dados && f.dados.sessao;
  if (!S) {
    certo(false, 'sem sessão de fundador, o resto deste grupo não pode correr',
      'falta CODIGO_FUNDADOR em worker/.dev.vars?');
  } else {

  /* Sem isto, fundar duas vezes com o mesmo email deixava o segundo negócio
     sem forma de entrar: a procura do operador devolve sempre o primeiro. */
  const outra = await pedir('/v1/balcao/fundar', { metodo: 'POST', corpo: {
    codigo: 'TESTE1', nome: 'Outra Padaria', email: correio } });
  certo(outra.estado === 409, 'o mesmo email não funda um segundo negócio', String(outra.estado));

  /* O nome vai bem escrito de propósito: o que se quer provar aqui é a recusa
     do CONVITE, e o nome é validado antes dele — para que um engano de escrita
     não queime um convite de um uso. Com `nome: 'X'` isto respondia 400 e
     passava a acreditar que tinha provado o convite. */
  const convite = await pedir('/v1/balcao/fundar', { metodo: 'POST', corpo: {
    codigo: 'NAOSERVEDETODO', nome: 'Casa do Convite Errado', email: 'x@exemplo.pt' } });
  certo(convite.estado === 403, 'sem o convite certo não se funda nada', String(convite.estado));

  const neg = await pedir('/v1/balcao/negocio', { sessao: S });
  certo(neg.estado === 200 && neg.dados.negocio.nome === 'Padaria da Sonda',
    'o balcão lê o seu negócio', JSON.stringify(neg.dados?.negocio?.nome));
  certo(neg.dados.negocio.programas[0].objetivo === 8,
    'com o objectivo que foi pedido', String(neg.dados?.negocio?.programas?.[0]?.objetivo));

  /* --- o que entra no negócio ------------------------------------------- */
  const longo = await pedir('/v1/balcao/negocio', { metodo: 'PUT', sessao: S,
    corpo: { nome: 'A'.repeat(5000) } });
  certo(longo.estado === 200 && longo.dados.nome.length <= 60,
    'um nome de cinco mil caracteres é cortado, não guardado',
    `ficou com ${longo.dados?.nome?.length}`);

  const corMa = await pedir('/v1/balcao/negocio', { metodo: 'PUT', sessao: S,
    corpo: { cor: 'javascript:alert(1)' } });
  certo(corMa.estado === 400, 'uma cor que não é hexadecimal é recusada', String(corMa.estado));

  const corBoa = await pedir('/v1/balcao/negocio', { metodo: 'PUT', sessao: S,
    corpo: { cor: '#3B2417', nome: 'Padaria da Sonda' } });
  certo(corBoa.estado === 200 && corBoa.dados.cor === '#3B2417',
    'uma cor válida entra', JSON.stringify(corBoa.dados?.cor));

  /* --- o que entra no programa ------------------------------------------ */
  const PROG = neg.dados.negocio.programas[0].id;
  const lixo = await pedir('/v1/balcao/programas', { metodo: 'POST', sessao: S,
    corpo: { id: PROG, arrefecimento: 'abc' } });
  certo(Number.isFinite(lixo.dados?.[0]?.arrefecimento),
    'arrefecimento com lixo não vira NaN na base de dados',
    JSON.stringify(lixo.dados?.[0]?.arrefecimento));

  const alto = await pedir('/v1/balcao/programas', { metodo: 'POST', sessao: S,
    corpo: { id: PROG, objetivo: 999 } });
  certo(alto.dados?.[0]?.objetivo === 30, 'o objectivo é limitado a 30',
    String(alto.dados?.[0]?.objetivo));
  /* Zero não vira 2, vira 10: o `Number(x) || 10` do Worker lê o zero como
     «não veio nada» e usa o valor por omissão. Não é bonito, mas o que
     importa aqui é o que chega à base de dados, e nenhum destes valores
     absurdos lá entra. Que o formulário do balcão devia recusar isto antes
     de enviar é outro assunto, e está tratado no lado do cliente. */
  for (const mau of [0, -5, 999, 'abc', null, 3.7, '7', Infinity]) {
    const r = await pedir('/v1/balcao/programas', { metodo: 'POST', sessao: S,
      corpo: { id: PROG, objetivo: mau } });
    const o = r.dados?.[0]?.objetivo;
    certo(Number.isInteger(o) && o >= 2 && o <= 30,
      `objectivo ${JSON.stringify(mau)} acaba dentro de 2..30`, String(o));
  }

  /* --- o segundo cartão nascia sem arrefecimento nenhum ------------------ */
  {
    /* O DEFEITO: `arrefecimentoValido(null)` devolvia ZERO, não 3600.
       `Number(null)` é 0, que é finito e não é negativo — por isso escapava ao
       `if` que devia apanhar o «não foi dito» e saía `Math.min(86400, 0)`.

       O primeiro cartão de um negócio escapava por sorte: a fundação escreve
       3600 à mão. Qualquer cartão criado DEPOIS — e o balcão nunca envia o
       campo — nascia sem intervalo nenhum entre carimbos do mesmo cliente.
       Ou seja: a defesa contra carimbar dez vezes seguidas estava escrita,
       tinha nome, e devolvia o contrário do que o nome diz. */
    const segundo = await pedir('/v1/balcao/programas', { metodo: 'POST', sessao: S,
      corpo: { nome: 'Cartão do pão', selo: 'bolo', objetivo: 8, premio: 'Um pão' } });
    const novo = (segundo.dados || []).find((p) => p.nome === 'Cartão do pão');
    certo(!!novo, 'o segundo cartão é criado (o teste é válido)',
      JSON.stringify(segundo.dados?.map?.((p) => p.nome)));
    certo(novo && novo.arrefecimento === 3600,
      'e nasce com uma hora de intervalo, como o primeiro — não com zero',
      String(novo && novo.arrefecimento));

    /* E ZERO CONTINUA A VALER ZERO QUANDO É DITO. Um negócio que queira
       carimbar sem intervalo manda `0`, e isso é uma escolha; o que não pode
       é o silêncio ser lido como escolha. */
    const semIntervalo = await pedir('/v1/balcao/programas', { metodo: 'POST', sessao: S,
      corpo: { id: novo.id, arrefecimento: 0 } });
    const depois = (semIntervalo.dados || []).find((p) => p.id === novo.id);
    certo(depois && depois.arrefecimento === 0,
      'e um zero DITO em voz alta é respeitado', String(depois && depois.arrefecimento));
  }

  /* --- cada balcão vê só o que é seu ------------------------------------ */
  const f2 = await pedir('/v1/balcao/fundar', { metodo: 'POST', corpo: {
    codigo: 'TESTE1', nome: 'Barbearia da Sonda', email: `outro-${Date.now()}@exemplo.pt` } });
  const meus = await pedir('/v1/balcao/clientes', { sessao: S });
  const alheios = await pedir('/v1/balcao/clientes', { sessao: f2.dados.sessao });
  certo(meus.estado === 200 && Array.isArray(meus.dados), 'a lista de clientes responde');
  certo(alheios.dados.length === 0,
    'um negócio acabado de fundar não vê clientes de outro',
    `viu ${alheios.dados?.length}`);

  const alheio = await pedir('/v1/balcao/negocio', { metodo: 'PUT', sessao: f2.dados.sessao,
    corpo: { nome: 'Roubado' } });
  const conferir = await pedir('/v1/balcao/negocio', { sessao: S });
  certo(conferir.dados.negocio.nome === 'Padaria da Sonda',
    'e não lhe consegue mudar o nome', JSON.stringify(conferir.dados?.negocio?.nome));

  /* --- uma sessão de cliente não serve no balcão ------------------------- */
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  for (const rota of ['/v1/balcao/clientes', '/v1/balcao/negocio', '/v1/balcao/resumo']) {
    const r = await pedir(rota, { sessao: c.dados.sessao });
    certo(r.estado === 401 || r.estado === 403,
      `${rota} recusa uma sessão de cliente`, String(r.estado));
  }
  }
}

grupo('Aderir duas vezes ao mesmo programa');
{
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const prog = (await pedir('/v1/descobrir')).dados[0].programas[0].id;
  const um = await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: c.dados.sessao, corpo: { programaId: prog } });
  const dois = await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: c.dados.sessao, corpo: { programaId: prog } });
  certo(um.estado === 200 && dois.estado === 200, 'as duas adesões respondem bem');
  certo(um.dados.id === dois.dados.id, 'e devolvem o mesmo cartão, não dois');
  const cartoes = await pedir('/v1/cliente/cartoes', { sessao: c.dados.sessao });
  certo(cartoes.dados.filter((x) => x.programa.id === prog).length === 1,
    'a carteira fica com um cartão só',
    String(cartoes.dados?.filter((x) => x.programa.id === prog).length));

  const inventado = await pedir('/v1/cliente/aderir', { metodo: 'POST',
    sessao: c.dados.sessao, corpo: { programaId: 'nao-existe' } });
  certo(inventado.estado === 404, 'um programa que não existe dá 404', String(inventado.estado));
}

grupo('Recuperar a conta noutro telemóvel');
{
  /* O defeito que isto tranca: a app prometia em três sítios que os cartões
     iam com a pessoa para o telemóvel novo, e não iam. O código era emitido
     sempre contra o cliente da sessão em curso — e no telemóvel novo esse é
     uma conta vazia acabada de criar. A pessoa confirmava, ouvia «os cartões
     já não se perdem», e ficava a olhar para uma carteira sem nada. */
  /* UMA MORADA NOVA A CADA CORRIDA, e não uma escrita à mão.

     Era `recupera@exemplo.pt`, com um `UPDATE clientes SET email = NULL` à
     frente a tentar limpar a corrida anterior. Não limpava: a morada vive
     TAMBÉM na tabela `identidades`, e é por lá que o `entrar` resolve quem é
     que ela é. À segunda corrida sobre a mesma base, o que devia ser uma
     adesão era uma recuperação, e cinco afirmações deste grupo reprovavam.

     Só se via sem `--limpo` — que é o comportamento por omissão de quem
     desenvolve, e nunca o do CI. Ou seja: o caminho que este projecto diz
     querer provar, o das migrações sobre uma base que já existe, era o único
     em que a bateria não passava duas vezes seguidas. */
  const correio = `recupera-${Date.now()}@exemplo.pt`;
  sql(`DELETE FROM entradas`); sql(`DELETE FROM envios`);

  /* Telemóvel A: conta com um cartão, e a morada confirmada. */
  const a = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const sessaoA = a.dados.sessao;
  const prog = (await pedir('/v1/descobrir')).dados[0].programas[0].id;
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: sessaoA, corpo: { programaId: prog } });

  const pedirCodigo = async (sessao) => {
    sql(`DELETE FROM envios`);            /* o tecto por hora não é o que se testa aqui */
    const r = await pedir('/v1/cliente/email', { metodo: 'POST', sessao, corpo: { email: correio } });
    const linha = sql(`SELECT alvo FROM entradas WHERE email = '${correio}' AND usada_em IS NULL`);
    return { resposta: r, alvo: (linha.match(/"alvo":\s*"([^"]+)"/) || [])[1] };
  };

  const p1 = await pedirCodigo(sessaoA);
  certo(p1.resposta.estado === 200, 'A pede o código', JSON.stringify(p1.resposta.dados));
  certo(p1.resposta.dados.recuperar === false,
    'a primeira vez não é uma recuperação, é uma adesão', String(p1.resposta.dados.recuperar));
  certo(p1.alvo === `cliente:${a.dados.cliente.id}`,
    'o código aponta para a conta de A', String(p1.alvo));

  /* Confirma-se com um código forjado, que é o que o email faria chegar. */
  const forjar = (alvo, codigo) => {
    const r = createHash('sha256').update(`${correio}|${codigo}`).digest('hex');
    sql(`DELETE FROM entradas WHERE alvo = '${alvo}'`);
    sql(`INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em)
         VALUES ('${r}', '${alvo}', '${correio}', datetime('now'),
                 '${new Date(Date.now() + 600000).toISOString()}')`);
  };
  forjar(`cliente:${a.dados.cliente.id}`, '111111');
  const conf = await pedir('/v1/cliente/entrar', { metodo: 'POST', corpo: { email: correio, codigo: '111111' } });
  certo(conf.estado === 200 && conf.dados.cliente.id === a.dados.cliente.id,
    'A confirma a morada e continua a ser A', JSON.stringify(conf.dados?.cliente));
  certo(!!conf.dados.segredo && !!conf.dados.sessao,
    'a resposta traz o segredo e a sessão — é com isto que o telemóvel novo se levanta');

  /* Telemóvel B: conta nova e vazia, como a app faz ao arrancar. */
  const b = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  certo(b.dados.cliente.id !== a.dados.cliente.id, 'B é mesmo outra conta');

  const p2 = await pedirCodigo(b.dados.sessao);
  certo(p2.resposta.dados.recuperar === true,
    'B pede a mesma morada e o servidor reconhece uma recuperação',
    String(p2.resposta.dados.recuperar));
  certo(p2.alvo === `cliente:${a.dados.cliente.id}`,
    'e o código aponta para a conta ANTIGA, não para a vazia', String(p2.alvo));

  forjar(`cliente:${a.dados.cliente.id}`, '222222');
  const volta = await pedir('/v1/cliente/entrar', { metodo: 'POST', corpo: { email: correio, codigo: '222222' } });
  certo(volta.estado === 200 && volta.dados.cliente.id === a.dados.cliente.id,
    'B entra e recebe a conta de A', JSON.stringify(volta.dados?.cliente?.id));

  const cartoes = await pedir('/v1/cliente/cartoes', { sessao: volta.dados.sessao });
  certo(cartoes.estado === 200 && cartoes.dados.length >= 1,
    'e com ela os cartões', `${cartoes.dados?.length} cartões`);
  certo(volta.dados.segredo === conf.dados.segredo,
    'o segredo do aparelho é o mesmo — o QR de B vale tanto como o de A');
}

grupo('A morada não é sensível a maiúsculas');
{
  sql(`DELETE FROM entradas`); sql(`DELETE FROM envios`);
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const r = await pedir('/v1/cliente/email', { metodo: 'POST', sessao: c.dados.sessao,
    corpo: { email: '  Maiusculas@Exemplo.PT ' } });
  certo(r.estado === 200, 'aceita a morada com maiúsculas e espaços', JSON.stringify(r.dados));
  const guardado = sql(`SELECT email FROM entradas WHERE usada_em IS NULL`);
  certo(guardado.includes('maiusculas@exemplo.pt'),
    'guarda-a em minúsculas, que é como vai ser procurada', guardado.slice(0, 120));
}

grupo('Tecto de envios');
{
  sql(`DELETE FROM entradas`); sql(`DELETE FROM envios`);
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const correio = 'tecto@exemplo.pt';
  const um = await pedir('/v1/cliente/email', { metodo: 'POST', sessao: c.dados.sessao, corpo: { email: correio } });
  certo(um.estado === 200, 'o primeiro pedido passa');

  const dois = await pedir('/v1/cliente/email', { metodo: 'POST', sessao: c.dados.sessao, corpo: { email: correio } });
  certo(dois.estado === 429, 'o segundo, logo a seguir, é recusado', String(dois.estado));

  /* Passado o intervalo mínimo, o tecto por hora continua a contar.

     A data escreve-se em ISO e não com o `datetime()` do SQLite: o código
     compara strings, e `2026-09-05 18:00` fica ANTES de `2026-09-05T17:00`
     porque o espaço vale menos do que o «T». Com o formato errado o teste
     passava a dizer que não havia tecto nenhum. */
  const hAtras = (m) => new Date(Date.now() - m * 60000).toISOString();
  sql(`UPDATE envios SET em = '${hAtras(10)}' WHERE email = '${correio}'`);
  for (let i = 0; i < 4; i++) {
    await pedir('/v1/cliente/email', { metodo: 'POST', sessao: c.dados.sessao, corpo: { email: correio } });
    sql(`UPDATE envios SET em = '${hAtras(10)}' WHERE email = '${correio}'`);
  }
  const sexto = await pedir('/v1/cliente/email', { metodo: 'POST', sessao: c.dados.sessao, corpo: { email: correio } });
  certo(sexto.estado === 429, 'ao sexto na mesma hora, chega', String(sexto.estado));
  sql(`DELETE FROM envios`);
}

grupo('Corpo do pedido estragado');
{
  const casos = [
    ['/v1/cliente/registar', 'POST', 'isto não é json'],
    ['/v1/cliente/aderir', 'POST', '{"programaId":'],
    ['/v1/balcao/entrar', 'POST', '<html>'],
  ];
  for (const [caminho, metodo, corpo] of casos) {
    const r = await fetch(BASE + caminho, {
      method: metodo, headers: { 'content-type': 'application/json' }, body: corpo,
    });
    certo(r.status !== 500, `${caminho}: lixo no corpo não dá 500`, String(r.status));
  }
  /* Um corpo vazio é um objecto vazio, não um erro: /v1/cliente/registar não
     precisa de corpo nenhum e era chamado sem ele. */
  const vazio = await fetch(BASE + '/v1/cliente/registar', { method: 'POST' });
  certo(vazio.status === 200, 'um corpo vazio continua a servir para registar', String(vazio.status));
}

grupo('Emails');
{
  const { emailCodigoCliente, emailCodigoBalcao } = await import('./src/emails.js');

  const a = emailCodigoCliente({ codigo: '318204', minutos: 15 });
  certo(a.assunto.includes('318204'), 'o código vai no assunto');
  /* COLADOS, e é o contrário do que aqui estava escrito. Havia um `&#160;` a
     meio para se ler em dois grupos de três — mas quem lê este email para
     oferecer o código por cima do teclado é o iOS e o Android, e o que eles
     procuram é uma sequência de dígitos CONTÍGUA perto de uma palavra como
     «código». Partido ao meio, o que lá está são dois números de três
     algarismos, e a sugestão nunca aparece. O espaço passou a ser
     `letter-spacing`: desenho, que o detector não vê, e o olho vê. */
  certo(a.html.includes('>318204<'), 'e no HTML os seis algarismos ficam colados');
  certo(!/318&#160;204|318 204/.test(a.html),
    'nada os parte ao meio — é isso que mata a sugestão do teclado');
  certo(/letter-spacing:\s*\dpx/.test(a.html),
    'e a folga entre eles é espaçamento de letra, não um espaço a sério');
  /* A palavra tem de estar PERTO do número, nas duas versões: os detectores
     procuram o código à volta de «código», «code», «verification». */
  certo(/código[^0-9]{0,60}318204/s.test(a.texto),
    'na versão em texto, o código está ao pé da palavra «código»');
  /* O ASSUNTO COMEÇAVA PELO NÚMERO SOLTO — `318204 — o teu código…` — e isso
     parecia bem: o código aparece primeiro, mesmo que a notificação corte o
     resto. Mas era o detector do telemóvel que ficava a olhar para um número
     sem contexto, seguido de um travessão.

     Foi visto numa captura de um iPhone a sério: notificação do Gmail em cima
     do ecrã, código bem visível, e a barra do teclado vazia por baixo — nenhuma
     sugestão. Agora a palavra vai à frente, o número continua nos primeiros
     caracteres, e as duas coisas cabem. */
  certo(/^Código 318204\b/.test(a.assunto),
    'o assunto começa por «Código» e o número logo a seguir — é o que o telemóvel lê',
    a.assunto);
  certo(a.assunto.indexOf('318204') < 12,
    'e o número continua nos primeiros caracteres, para sobreviver ao corte da notificação',
    `posição ${a.assunto.indexOf('318204')}`);
  /* O PREHEADER É O QUE APARECE NA NOTIFICAÇÃO por baixo do assunto, e era
     onde a palavra faltava por completo: dizia «Escreve 318204 na app». */
  certo(/código[^0-9]{0,20}318204/i.test(a.html),
    'e o preheader diz «o teu código é» antes do número, que é o padrão que os detectores procuram');
  certo(a.texto.includes('318204'), 'e na versão em texto');
  certo(a.html.includes('aria-label="3 1 8 2 0 4"'),
    'soletrado para quem ouve o email em vez de o ler');

  /* Estas três são cicatrizes. As duas primeiras deram email partido no
     Outlook — que desenha com o motor do Word e não sabe o que é rgba()
     nem letter-spacing em em. A terceira é o número de contribuinte de um
     particular, que não tem que andar a espalhar-se por caixas de correio
     alheias só porque coube no rodapé. */
  certo(!/rgba\(/.test(a.html), 'nenhum rgba() — o motor do Word desenha-o a preto');
  certo(!/letter-spacing:\s*[-.\d]+em/.test(a.html), 'espaçamento em px, que o Word lê');
  certo(!/\b273363620\b/.test(a.html + a.texto), 'o NIF não vai no email');

  /* A largura foi a segunda cicatriz: width="560" ganha ao max-width e o
     email transbordava do ecrã do telemóvel. */
  certo(a.html.includes('max-width:560px') && a.html.includes('[if mso]'),
    'largura fluida com tabela-fantasma para o Outlook');

  const b = emailCodigoBalcao({ codigo: '705193', negocio: '<script>x</script>' });
  certo(!b.html.includes('<script>'), 'o nome do negócio é escapado');
  certo(b.html.includes('&lt;script&gt;'), 'e chega escapado ao HTML');

  /* Um código com menos de seis algarismos não parte o agrupamento. */
  const c = emailCodigoCliente({ codigo: '1234' });
  certo(c.html.includes('>1234</div>'), 'um código curto sai inteiro, sem espaço a meio');

  for (const [nome, m] of [['cliente', a], ['balcão', b]]) {
    certo(m.texto.length > 100 && m.html.length > 1000,
      `${nome}: tem as duas versões, HTML e texto`);
  }
}

/* --------------------------------------------------------------------- */

grupo('O logótipo do negócio');
{
  /* A coluna existia desde o primeiro dia e nunca ninguém lhe tocou. Passou a
     ser precisa porque a classe de fidelização da Google EXIGE um logótipo por
     programa — sem ele não há passe nenhum. E como vai dentro do passe, tem de
     ser servido por um endereço público, não por um data URI. */
  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';

  /* O ESTADO DE QUE ESTE TESTE DEPENDE É DELE. A base local sobrevive entre
     corridas: à segunda, o `wallet_classe` já estava preenchido e a classe
     não voltava a ser criada — e a afirmação «criou a classe» falhava sem
     haver defeito nenhum. É o mesmo que já tinha mordido nos convites: um
     teste que só falha a quem já correu antes é a pior espécie deles. */
  sql(`UPDATE programas SET wallet_classe = NULL WHERE id = 'p1'`);
  sql(`UPDATE cartoes SET wallet_codigo = NULL, wallet_em = NULL, wallet_sincronizado = NULL`);
  const guardar = (logotipo) => pedir('/v1/balcao/logotipo', {
    metodo: 'PUT', sessao: sessaoBalcao, corpo: { logotipo } });

  {
    const r = await guardar(`data:image/png;base64,${PNG}`);
    certo(r.estado === 200 && r.dados.tipo === 'image/png',
      'um PNG a sério é aceite', JSON.stringify(r.dados).slice(0, 80));
  }

  {
    /* O TIPO SAI DOS BYTES, e não do que o pedido diz que é. Quem manda isto
       pode escrever `data:image/png` à frente do que lhe apetecer — o que
       conta são os primeiros oito bytes de um PNG. */
    const texto = Buffer.from('não sou uma imagem nenhuma, sou texto').toString('base64');
    const r = await guardar(`data:image/png;base64,${texto}`);
    certo(r.estado === 400 && r.dados.codigo === 'imagem',
      'um ficheiro que se diz PNG mas não tem os bytes de um PNG é recusado',
      `${r.estado} ${r.dados.codigo}`);
  }

  {
    const r = await guardar('data:image/png;base64,####');
    certo(r.estado === 400, 'e o que nem sequer é base64 também', String(r.estado));
  }

  {
    /* O tecto. Sem ele, a coluna aceitava o que lhe mandassem — e isto é uma
       base de dados de 5 GB partilhada por toda a gente. */
    const enorme = PNG + 'A'.repeat(300 * 1024);
    const r = await guardar(`data:image/png;base64,${enorme}`);
    certo(r.estado === 413, 'uma imagem grande de mais é recusada com 413', String(r.estado));
  }

  {
    /* O endereço público, que é o que vai DENTRO do passe da Wallet: tem de
       devolver bytes de imagem, e não JSON. */
    const n = await pedir('/v1/balcao/negocio', { sessao: sessaoBalcao });
    const slug = n.dados.negocio.slug;
    certo(n.dados.negocio.logotipo === true,
      'o balcão sabe que há logótipo', String(n.dados.negocio.logotipo));
    certo(typeof n.dados.negocio.logotipo !== 'string',
      'e NÃO recebe o base64 inteiro a cada abertura', typeof n.dados.negocio.logotipo);

    const img = await fetch(`${BASE}/v1/negocio/${slug}/logotipo`);
    certo(img.status === 200, 'o endereço público serve a imagem', String(img.status));
    certo(img.headers.get('content-type') === 'image/png',
      'com o tipo certo, e não JSON', String(img.headers.get('content-type')));
    certo(/max-age=\d{6,}/.test(img.headers.get('cache-control') || ''),
      'e com cache longa, que é o que a Google vai reler', String(img.headers.get('cache-control')));
    const bytes = new Uint8Array(await img.arrayBuffer());
    certo(bytes[0] === 0x89 && bytes[1] === 0x50,
      'e o que sai são mesmo os bytes de um PNG', `${bytes[0]},${bytes[1]}`);
  }

  {
    const r = await guardar(null);
    certo(r.estado === 200 && r.dados.logotipo === null, 'tirar a imagem é pôr a null', String(r.estado));

    {
      /* MAS NÃO SE TIRA O QUE JÁ ESTÁ EM CARTEIRAS ALHEIAS. O PATCH que ia
         para a Google OMITIA o `programLogo` quando não havia logótipo — e um
         PATCH que omite deixa lá o valor antigo. O endereço público passava a
         dar 404, o botão desaparecia da app, e o logótipo apagado ficava no
         cartão de toda a gente que já o tinha guardado, para sempre. */
      await guardar(`data:image/png;base64,${PNG}`);
      sql(`UPDATE programas SET wallet_classe = '2026-09-16T00:00:00.000Z' WHERE id = 'p1'`);
      const recusa = await guardar(null);
      certo(recusa.estado === 409 && recusa.dados.codigo === 'logotipo-publicado',
        'um logótipo que já está em carteiras de clientes não se apaga — troca-se',
        `${recusa.estado} ${recusa.dados.codigo}`);
      certo(/troca/i.test(String(recusa.dados.erro)),
        'e diz-se o que fazer em vez disso', String(recusa.dados.erro));
      const trocar = await guardar(`data:image/png;base64,${PNG}`);
      certo(trocar.estado === 200, 'trocar continua a poder-se', String(trocar.estado));
      sql(`UPDATE programas SET wallet_classe = NULL WHERE id = 'p1'`);
      await guardar(null);
    }
    const n = await pedir('/v1/balcao/negocio', { sessao: sessaoBalcao });
    certo(n.dados.negocio.logotipo === false, 'e o balcão passa a dizer que não há');
  }

  {
    /* Um corpo gigante numa rota NORMAL. Não havia tecto nenhum: qualquer
       pessoa podia mandar cem megabytes para qualquer endereço. */
    const r = await pedir('/v1/balcao/programas', {
      metodo: 'POST', sessao: sessaoBalcao, corpo: { nome: 'x'.repeat(40 * 1024) } });
    certo(r.estado === 413, 'e um corpo grande de mais numa rota normal leva 413', String(r.estado));
  }
}

/* --------------------------------------------------------------------- */

grupo('Uma morada, uma conta');
{
  /* DUAS CONTAS COM O MESMO EMAIL VERIFICADO é o pior estado em que esta base
     pode ficar. A recuperação faz `SELECT ... WHERE email = ? AND
     email_verificado = 1 LIMIT 1`: com duas, o `LIMIT 1` escolhe uma ao calhas
     e os cartões da outra deixam de ter por onde ser alcançados. Não é roubo —
     as duas pessoas provaram a mesma caixa — é perda de dados em silêncio.

     O caminho real: alguém põe o email no telemóvel e não chega a escrever o
     código; noutro aparelho põe o mesmo e conclui; volta ao primeiro e usa o
     código antigo, que ainda vale quinze minutos. Aqui o estado é montado à
     mão, porque o limitador de envios não deixa pedir dois códigos seguidos
     para a mesma morada — e o caminho real demora minutos, não segundos. */
  const morada = `duplo${Math.random().toString(36).slice(2, 8)}@exemplo.pt`;
  const conta = (q) => {
    const o = sql(q);
    return JSON.parse(o.slice(o.indexOf('[')))[0].results[0].n;
  };

  const a = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const b = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });

  /* Um código pendente para cada conta, os dois para a mesma morada e os dois
     dentro do prazo — que é exactamente o que acontece a quem deixou um a
     meio. */
  const entrarCom = async (cliente, codigo) => {
    const r = createHash('sha256').update(`${morada}|${codigo}`).digest('hex');
    sql(`INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em)
         VALUES ('${r}', 'cliente:${cliente}', '${morada}',
                 strftime('%Y-%m-%dT%H:%M:%fZ','now'),
                 strftime('%Y-%m-%dT%H:%M:%fZ','now','+15 minutes'))`);
    return pedir('/v1/cliente/entrar', { metodo: 'POST', corpo: { email: morada, codigo } });
  };

  const entrouA = await entrarCom(a.dados.cliente.id, '424242');
  certo(entrouA.estado === 200, 'a primeira conta fica com a morada', String(entrouA.estado));

  const entrouB = await entrarCom(b.dados.cliente.id, '515151');
  const verificadas = conta(
    `SELECT COUNT(*) n FROM clientes WHERE email = '${morada}' AND email_verificado = 1`);
  certo(verificadas === 1,
    'e a segunda NÃO deixa duas contas com a mesma morada verificada',
    `ficaram ${verificadas}`);
  certo(entrouB.estado === 200 && entrouB.dados.cliente
     && entrouB.dados.cliente.id === a.dados.cliente.id,
    'quem prova a caixa entra na conta que já é dela, e não numa segunda',
    entrouB.dados.cliente ? `entrou em ${entrouB.dados.cliente.id}` : JSON.stringify(entrouB.dados));
}

/* --------------------------------------------------------------------- */

grupo('Convites');
{
  /* O convite era UM segredo do Worker, igual para toda a gente, sem limite de
     usos, sem validade e sem forma de revogar um sem partir os outros. Passou
     a ser uma linha numa tabela — e o que interessa provar são as quatro
     maneiras de não servir, e a reivindicação não deixar dois pedidos gastarem
     o mesmo código. Os códigos vêm do semear.sql, em resumo. */
  /* AS SEMENTES REPÕEM-SE AQUI, e não se confia no semear.sql.

     Um convite de um uso é gasto pelo primeiro teste que o usa — e o
     `INSERT OR IGNORE` do semear não o repõe na corrida seguinte, porque a
     linha já lá está. A bateria passava à primeira numa base limpa e falhava
     à segunda, que é a pior espécie de teste: o que só falha a quem já correu
     antes. O estado de que um teste depende é dele. */
  sql(`DELETE FROM convites WHERE etiqueta LIKE 'testes:%'`);
  /* E o que nasceu deles na corrida anterior. O convite preso a
     `dono.certo@exemplo.pt` só se prova uma vez por base: à segunda, o
     operador já existe e a rota responde 409 antes de olhar para o convite. */
  sql(`DELETE FROM operadores WHERE email = 'dono.certo@exemplo.pt' OR email LIKE 'f%@exemplo.pt'`);
  sql(`DELETE FROM programas WHERE negocio_id IN (SELECT id FROM negocios WHERE nome = 'Casa de Provas')`);
  sql(`DELETE FROM negocios WHERE nome = 'Casa de Provas'`);
  sql(`INSERT INTO convites (resumo, etiqueta, email, usos_max, usos, criado_em, expira_em, revogado_em) VALUES
    ('e552a301d65a81d4ad746a07ad3025e67c16dc5d4a390bc61cad62a01522c99d','testes: serve sempre',NULL,999,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL),
    ('962a654a00bb101136a505c5e960a981e753debd698754a79866907d7d51f962','testes: um uso só',NULL,1,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL),
    ('e9727823d5f18cfbf09672f6d3598d0e319ef2d1e13fc65d61cf9d67a8335380','testes: já gasto',NULL,1,1,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL),
    ('08676a82fee009a6b7c68066c82f76932b42716776102b0f0cf481fd07c909c4','testes: caducado',NULL,9,0,strftime('%Y-%m-%dT%H:%M:%fZ','now','-30 days'),strftime('%Y-%m-%dT%H:%M:%fZ','now','-1 day'),NULL),
    ('7d9d9e379b6ed3341be6e84182917445f72be978352d39a83b8b546c79774503','testes: anulado',NULL,9,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,strftime('%Y-%m-%dT%H:%M:%fZ','now')),
    ('c649c3d20b990e0a95b01376e60e37dc49ee28096d49d30d7452a1a6418f3abb','testes: preso a uma morada','dono.certo@exemplo.pt',9,0,strftime('%Y-%m-%dT%H:%M:%fZ','now'),NULL,NULL)`);

  const fundar = (codigo, extra = {}) => pedir('/v1/balcao/fundar', {
    metodo: 'POST',
    corpo: { codigo, nome: 'Casa de Provas', email: `f${Math.random().toString(36).slice(2, 9)}@exemplo.pt`, ...extra },
  });

  {
    const r = await fundar('TESTEUMAVEZ');
    certo(r.estado === 200 && !!r.dados.sessao, 'um convite bom funda e devolve sessão', JSON.stringify(r.dados).slice(0, 90));
    const outra = await fundar('TESTEUMAVEZ');
    certo(outra.estado === 403 && outra.dados.codigo === 'convite-gasto',
      'e à segunda já não serve — um uso é um uso', `${outra.estado} ${outra.dados.codigo}`);
  }

  {
    const r = await fundar('NAOEXISTEDETODO');
    certo(r.estado === 403 && /não existe/i.test(r.dados.erro || ''),
      'um código inventado é recusado, e diz que não existe', r.dados.erro);
  }
  {
    const r = await fundar('TESTEREVOGADO');
    certo(r.estado === 403 && r.dados.codigo === 'convite-revogado',
      'um código anulado diz que foi anulado, e não «inválido»', `${r.estado} ${r.dados.codigo}`);
  }
  {
    const r = await fundar('TESTEEXPIRADO');
    certo(r.estado === 403 && r.dados.codigo === 'convite-expirado',
      'um código caducado diz que caducou', `${r.estado} ${r.dados.codigo}`);
  }
  {
    const r = await fundar('TESTEGASTO');
    certo(r.estado === 403 && r.dados.codigo === 'convite-gasto',
      'um código já gasto diz que foi gasto', `${r.estado} ${r.dados.codigo}`);
  }
  {
    const r = await fundar('TESTEPRESO', { email: 'outro.qualquer@exemplo.pt' });
    certo(r.estado === 403 && r.dados.codigo === 'convite-email',
      'um código preso a uma morada recusa as outras', `${r.estado} ${r.dados.codigo}`);
    const certo1 = await fundar('TESTEPRESO', { email: 'dono.certo@exemplo.pt' });
    certo(certo1.estado === 200, 'e aceita a morada a que está preso', String(certo1.estado));
  }

  {
    /* O código escreve-se como sai: minúsculas, com hífen, com espaço. Nada
       disso pode ser motivo para recusar. */
    const r = await fundar(' teste-1 ');
    certo(r.estado === 200, 'minúsculas, hífen e espaços não estragam o código', String(r.estado));
  }

  {
    /* A CORRIDA, e ela precisa de um convite FRESCO. A primeira versão deste
       teste corria dois pedidos com o `TESTEUMAVEZ`, que o caso de cima já
       tinha gasto — e depois afirmava que ninguém ganhava. Passava sempre, e
       não provava nada: «ganharam 0» era garantido pelo estado, não pela
       reivindicação. Um convite por estrear, e exactamente um vencedor.

       Ler o convite, decidir em JavaScript e escrever a seguir deixa os dois
       passarem. O que impede isso é o `UPDATE` condicional com o
       `meta.changes`, e é isso que esta afirmação mede. */
    sql(`DELETE FROM convites WHERE resumo = '9c1cde06202ce8ddbac1ab675a888002e36cbec3844ee37f1c03636a4c279d6c'`);
    sql(`INSERT INTO convites (resumo, etiqueta, usos_max, usos, criado_em)
         VALUES ('9c1cde06202ce8ddbac1ab675a888002e36cbec3844ee37f1c03636a4c279d6c',
                 'testes: a corrida', 1, 0, strftime('%Y-%m-%dT%H:%M:%fZ','now'))`);
    const [a, b] = await Promise.all([fundar('TESTECORRIDA'), fundar('TESTECORRIDA')]);
    const ganhou = [a, b].filter((x) => x.estado === 200).length;
    certo(ganhou === 1, 'dois pedidos ao mesmo tempo: um convite de um uso dá exactamente um balcão',
      `ganharam ${ganhou} (${a.estado}, ${b.estado})`);
    const usos = JSON.parse((() => { const o = sql(`SELECT usos FROM convites WHERE resumo = '9c1cde06202ce8ddbac1ab675a888002e36cbec3844ee37f1c03636a4c279d6c'`); return o.slice(o.indexOf('[')); })())[0].results[0].usos;
    certo(usos === 1, 'e o contador do convite ficou em 1, não em 2', String(usos));
  }

  {
    /* Um convite recusado por causa do NOME não pode ser gasto: o engano de
       escrita mais banal queimava um convite. */
    const antes = await fundar('TESTE1', { nome: 'x' });
    certo(antes.estado !== 200, 'um nome curto é recusado', String(antes.estado));
    const depois = await fundar('TESTE1');
    certo(depois.estado === 200, 'e o convite não foi gasto por causa disso', String(depois.estado));
  }
}

/* --------------------------------------------------------------------- */

grupo('O que um negócio pode escrever');
{
  /* Tudo isto é pintado na LISTA PÚBLICA, a toda a gente. Um convite legítimo
     — o café que se inscreveu ontem — chegava para encher o ecrã dos outros.
     Os dois ramos da rota tinham limpezas diferentes e afastaram-se: o de
     actualização cortava o nome e o prémio, o de criação escrevia em cru, e
     nenhum dos dois cortava as regras. */
  const criar = (corpo) => pedir('/v1/balcao/programas', { metodo: 'POST', sessao: sessaoBalcao, corpo });
  const doNegocio = async (nome) => {
    const r = await pedir('/v1/balcao/negocio', { sessao: sessaoBalcao });
    const ps = (r.dados.negocio && r.dados.negocio.programas) || [];
    return ps.find((p) => p.nome === nome || p.nome === nome.slice(0, 60));
  };

  {
    const longo = 'N'.repeat(500);
    await criar({ nome: longo, premio: 'P'.repeat(500), regras: 'R'.repeat(2000) });
    const p = await doNegocio(longo);
    certo(p && p.nome.length === 60, 'a criar: o nome é cortado a 60', p && String(p.nome.length));
    certo(p && p.premio.length === 120, 'a criar: o prémio é cortado a 120', p && String(p.premio.length));
    certo(p && p.regras !== null && p.regras.length === 240,
      'a criar: as regras são cortadas a 240 — não eram em ramo nenhum',
      p && String(p.regras && p.regras.length));
  }

  {
    /* O `tipo` não é cosmética: é ele que decide, no carimbar, se a quantidade
       é forçada a 1. Um valor inventado deixava passar carimbos de quantidade
       arbitrária. */
    await criar({ nome: 'Tipo inventado', tipo: 'o-que-me-apetecer', selo: '<script>x</script>' });
    const p = await doNegocio('Tipo inventado');
    certo(p && p.tipo === 'carimbos', 'um tipo que não existe cai em «carimbos»', p && p.tipo);
    certo(p && /^[a-z][a-z0-9-]*$/.test(p.selo),
      'e um selo que não parece um nome de ícone é recusado', p && p.selo);
  }

  {
    /* O tecto. Cada POST sem `id` criava mais um cartão, sem fim. */
    let recusou = null;
    for (let i = 0; i < 20 && recusou === null; i++) {
      const r = await criar({ nome: `Enchente ${i}` });
      if (r.estado === 409) recusou = i;
    }
    certo(recusou !== null, 'há um tecto ao número de cartões por negócio',
      recusou === null ? 'criou vinte e não se queixou' : `parou ao ${recusou}.º`);
  }
}

/* --------------------------------------------------------------------- */

grupo('Contas paradas');
{
  /* Dispara a limpeza diária à mão. O `--test-scheduled` do wrangler dev abre
     esta rota; em produção ela não existe, quem chama é o cron. */
  const limpeza = () => pedir('/__scheduled?cron=17+4+*+*+*');

  const haMeses = (m) => {
    const d = new Date(); d.setMonth(d.getMonth() - m); return d.toISOString();
  };

  /* Lê as linhas a sério, em vez de procurar texto na saída do comando.
     A primeira versão disto perguntava se a saída continha «│ 1 », à espera
     de uma tabela desenhada — e o wrangler devolve JSON. Nenhuma das buscas
     dava positivo nunca, e metade das afirmações passava por isso mesmo:
     `!existe(...)` é verdade quando a pergunta está partida. */
  const consulta = (instrucao) => {
    /* O wrangler escreve um cabeçalho com o sol e a versão antes do JSON.
       Corta-se a partir do primeiro `[`, que é onde o resultado começa. */
    const saida = sql(instrucao);
    const i = saida.indexOf('[');
    if (i < 0) throw new Error(`sem resultado em: ${saida.slice(0, 200)}`);
    return JSON.parse(saida.slice(i))[0].results;
  };
  const umValor = (instrucao) => {
    const linhas = consulta(instrucao);
    return linhas.length ? Object.values(linhas[0])[0] : undefined;
  };
  const existe = (id) => umValor(`SELECT COUNT(*) n FROM clientes WHERE id = '${id}'`) === 1;
  const campo = (id, nome) => umValor(`SELECT ${nome} v FROM clientes WHERE id = '${id}'`);

  /* A guarda da guarda: se a leitura estiver partida, o resto desta secção
     não prova nada — e prova-o em silêncio, dizendo que está tudo bem. */
  {
    const r = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
    certo(existe(r.dados.cliente.id), 'a leitura da base funciona (senão o resto não prova nada)');
    await pedir('/v1/cliente', { metodo: 'DELETE', sessao: r.dados.sessao });
    certo(!existe(r.dados.cliente.id), 'e vê a diferença quando a conta desaparece');
  }

  /* --- as sessões que ficam a apontar para ninguém --- */
  {
    /* NÃO É O PRODUTO QUE AS FAZ: é a mão que apaga uma conta de prova com um
       `DELETE FROM clientes` escrito à mão, em vez do caminho que a API usa —
       que leva sessões, cartões, movimentos e mais cinco tabelas à frente.
       Foram trinta e seis na base de produção, e a limpeza diária passou a
       varrê-las porque a próxima mão apressada vai ser igual à anterior.

       Não davam erro: um bilhete que aponta para uma conta que não existe
       lê-se como sessão inválida. Mentem à pergunta mais óbvia que se faz a
       esta base — «quantas pessoas há?». */
    const r = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
    const id = r.dados.cliente.id;
    const sessoes = () => umValor(
      `SELECT COUNT(*) n FROM sessoes WHERE sujeito = 'cliente:${id}'`);

    certo(sessoes() === 1, 'a conta acabada de nascer tem uma sessão (o teste é válido)');

    sql(`DELETE FROM clientes WHERE id = '${id}'`);
    certo(sessoes() === 1,
      'apagar a conta à mão deixa a sessão para trás — é exactamente este o defeito');

    await limpeza();
    certo(sessoes() === 0,
      'e a limpeza diária varre-a, sem ninguém ter de se lembrar dela');
  }

  /* --- abrir a app conta como sinal de vida --- */
  {
    const r = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
    const id = r.dados.cliente.id;
    sql(`UPDATE clientes SET visto_em = '${haMeses(10)}' WHERE id = '${id}'`);
    await pedir('/v1/cliente/cartoes', { sessao: r.dados.sessao });
    certo(campo(id, 'visto_em') > haMeses(1), 'abrir a app actualiza o visto_em');
  }

  /* --- uma conta parada há dois anos é apagada --- */
  {
    const r = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
    const id = r.dados.cliente.id;
    sql(`UPDATE clientes SET criado_em = '${haMeses(30)}', visto_em = '${haMeses(26)}' WHERE id = '${id}'`);
    await limpeza();
    certo(!existe(id), 'uma conta parada há 26 meses é apagada');
  }

  /* --- e leva os cartões e os movimentos com ela --- */
  {
    const r = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
    const id = r.dados.cliente.id;
    await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: r.dados.sessao, corpo: { programaId: 'p1' } });
    sql(`UPDATE clientes SET visto_em = '${haMeses(26)}' WHERE id = '${id}'`);
    sql(`UPDATE cartoes SET aderiu_em = '${haMeses(26)}', ultimo_em = NULL WHERE cliente_id = '${id}'`);
    await limpeza();
    certo(umValor(`SELECT COUNT(*) n FROM cartoes WHERE cliente_id = '${id}'`) === 0,
      'e os cartões dela vão atrás');
  }

  /* --- O CASO QUE SE ESQUECE: quem é carimbado ao balcão nunca abre a app.
         Quem carimba é o operador, com a sessão dele, e o visto_em do cliente
         não mexe. Se a regra olhasse só para a conta, apagava um cliente que
         passa no café todas as semanas. --- */
  {
    const r = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
    const id = r.dados.cliente.id;
    await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: r.dados.sessao, corpo: { programaId: 'p1' } });
    sql(`UPDATE clientes SET criado_em = '${haMeses(30)}', visto_em = '${haMeses(26)}' WHERE id = '${id}'`);
    sql(`UPDATE cartoes SET ultimo_em = '${haMeses(1)}' WHERE cliente_id = '${id}'`);
    await limpeza();
    certo(existe(id), 'um cartão carimbado há um mês salva a conta, mesmo sem abrir a app');
  }

  /* --- o aviso, e a garantia de que um envio falhado não o gasta ---
         Aqui não há canal de email: o `.dev.vars` dos testes não tem
         MAIL_TOKEN nem MAIL_CAIXA, e o envio devolve «sem-chave». É o caso
         que interessa provar, porque é o que acontece quando o correio está
         em baixo: a conta NÃO pode ficar marcada como avisada, senão o aviso
         perdia-se e ela era apagada 30 dias depois sem ninguém saber. --- */
  {
    const r = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
    const id = r.dados.cliente.id;
    sql(`UPDATE clientes SET email = 'parado@exemplo.pt', email_verificado = 1,
         criado_em = '${haMeses(30)}', visto_em = '${haMeses(23)}' WHERE id = '${id}'`);
    await limpeza();
    certo(existe(id), 'aos 23 meses a conta ainda lá está');
    certo(campo(id, 'avisada_em') == null,
      'e um aviso que não chegou a sair não fica marcado como dado');
  }

  /* --- quem volta limpa a marca, e tem direito a aviso novo da próxima --- */
  {
    const r = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
    const id = r.dados.cliente.id;
    sql(`UPDATE clientes SET avisada_em = '${haMeses(1)}', visto_em = '${haMeses(23)}' WHERE id = '${id}'`);
    await pedir('/v1/cliente/cartoes', { sessao: r.dados.sessao });
    certo(campo(id, 'avisada_em') == null, 'voltar à app apaga a marca do aviso');
  }

  /* --- uma conta sem email é apagada na mesma, só que sem aviso --- */
  {
    const r = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
    const id = r.dados.cliente.id;
    sql(`UPDATE clientes SET criado_em = '${haMeses(30)}', visto_em = '${haMeses(23)}' WHERE id = '${id}'`);
    await limpeza();
    certo(existe(id) && campo(id, 'avisada_em') == null,
      'sem email não há aviso, e a conta fica à espera do prazo');
  }

  /* LEVANTA-SE A MESA. Este bloco deixa de propósito contas vivas — é isso
     que ele prova. Mas uma delas tem `parado@exemplo.pt` VERIFICADO, e a
     regra «uma morada, uma conta» é um índice único: na corrida seguinte, a
     linha velha fazia o `UPDATE` da nova rebentar, e o que se lia era um erro
     de SQL no meio da montagem, sem relação visível com o teste que o causou.
     Numa base que nasce vazia — o CI — nunca aparecia. */
  sql(`DELETE FROM clientes WHERE email = 'parado@exemplo.pt'`);
}

/* --------------------------------------------------------------------- */

grupo('O cartão na Wallet');
{
  /* Este módulo não fala com a Google: constrói e assina. Por isso prova-se
     todo aqui, sem rede e sem conta nenhuma — que é o que permite ter isto
     escrito e em CI verde antes de existir uma chave. */
  const w = await import('./src/wallet.js');
  const { generateKeyPairSync, createVerify } = await import('node:crypto');

  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const PEM = privateKey.export({ type: 'pkcs8', format: 'pem' });

  const NEGOCIO = { id: 'n1', nome: 'Café Torrado', cor: '#3B2417', slug: 'cafe-torrado' };
  const PROGRAMA = { id: 'p1', nome: 'Cartão do café', tipo: 'carimbos', objetivo: 10,
                     premio: 'Um café por conta da casa', regras: 'Um carimbo por visita.' };
  const CARTAO = { id: 'c1', carimbos: 7, pontos: 0 };
  const EMISSOR = '3388000000012345678';
  const LOGO = 'https://carimbodigital.pt/v1/negocio/cafe-torrado/logotipo';

  /* --- a assinatura ---------------------------------------------------- */
  {
    const jwt = await w.assinarRS256(PEM, { ola: 'mundo', n: 7 });
    const [cab, corpo, assinatura] = jwt.split('.');
    certo(jwt.split('.').length === 3, 'o JWT tem as três partes');

    const deB64 = (x) => Buffer.from(x.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
    certo(JSON.parse(deB64(cab)).alg === 'RS256', 'e diz que é RS256',
      JSON.parse(deB64(cab)).alg);
    certo(JSON.parse(deB64(corpo)).ola === 'mundo', 'e o corpo chega inteiro');
    certo(!/[+/=]/.test(jwt), 'vai em base64url — sem +, / nem = , que partiriam o endereço');

    /* A PROVA QUE INTERESSA. Sem isto, só se provava que a função devolve uma
       cadeia de caracteres com pontos. Verifica-se a assinatura com a chave
       PÚBLICA, pelo `node:crypto`, como a Google fará do lado dela. */
    const v = createVerify('RSA-SHA256');
    v.update(`${cab}.${corpo}`);
    certo(v.verify(publicKey, deB64(assinatura)),
      'e a assinatura confere contra a chave pública — é isto que a Google verifica');

    /* E o contrário: uma assinatura mexida tem de falhar, senão o teste de
       cima passava com qualquer coisa. */
    const outro = await w.assinarRS256(PEM, { ola: 'outro' });
    const v2 = createVerify('RSA-SHA256');
    v2.update(`${cab}.${corpo}`);
    certo(!v2.verify(publicKey, deB64(outro.split('.')[2])),
      'e a assinatura de OUTRO corpo não confere — a verificação sabe dizer que não');
  }

  /* --- a classe -------------------------------------------------------- */
  {
    const c = w.classeDePrograma(PROGRAMA, NEGOCIO, { emissor: EMISSOR, logotipo: LOGO });
    certo(c.id === `${EMISSOR}.p1`, 'a classe é por PROGRAMA, não por negócio', c.id);
    certo(c.issuerName === 'Café Torrado' && c.programName === 'Cartão do café',
      'o emissor é a casa e o programa é o cartão', `${c.issuerName} / ${c.programName}`);
    certo(c.programLogo.sourceUri.uri === LOGO, 'e leva o logótipo, que é obrigatório');
    certo(c.reviewStatus === 'underReview',
      'nasce em underReview — com draft a Google não deixa criar objectos', c.reviewStatus);
    certo(c.hexBackgroundColor === '#3B2417', 'e com a cor da casa', c.hexBackgroundColor);

    let rebentou = null;
    try { w.classeDePrograma(PROGRAMA, NEGOCIO, { emissor: EMISSOR, logotipo: null }); }
    catch (e) { rebentou = e.message; }
    certo(rebentou !== null && /logótipo/i.test(rebentou),
      'sem logótipo recusa-se a construir — mais vale isso do que a Google recusar depois',
      String(rebentou));

    const feia = w.classeDePrograma(PROGRAMA, { ...NEGOCIO, cor: 'azul bonito' },
      { emissor: EMISSOR, logotipo: LOGO });
    certo(/^#[0-9A-Fa-f]{6}$/.test(feia.hexBackgroundColor),
      'e uma cor que não é hexadecimal cai na cor da marca', feia.hexBackgroundColor);
  }

  /* --- o objecto ------------------------------------------------------- */
  {
    const o = w.objetoDeCartao(CARTAO, PROGRAMA, { emissor: EMISSOR, codigo: 'ABC123XYZ' });
    certo(o.id === `${EMISSOR}.c1` && o.classId === `${EMISSOR}.p1`,
      'o objecto aponta para a classe do seu programa', `${o.id} → ${o.classId}`);
    certo(o.loyaltyPoints.balance.string === '7/10',
      'o saldo lê-se «7/10»', JSON.stringify(o.loyaltyPoints.balance));
    certo(o.loyaltyPoints.balance.string.length <= 7,
      'e cabe nos sete caracteres que a Google recomenda — «10 de 10» não cabia',
      o.loyaltyPoints.balance.string);
    certo(o.barcode.value === 'W1.ABC123XYZ',
      'o código de barras leva o token do PASSE, com prefixo próprio', o.barcode.value);
    certo(!o.barcode.value.includes(CARTAO.id),
      'e não o número do cartão — um passe fotografado revoga-se sem mexer nele');

    const pontos = w.objetoDeCartao({ ...CARTAO, pontos: 340 },
      { ...PROGRAMA, tipo: 'pontos' }, { emissor: EMISSOR, codigo: 'X' });
    certo(pontos.loyaltyPoints.balance.int === 340,
      'num cartão de pontos o saldo é um número, que «3 de 10» não faria sentido',
      JSON.stringify(pontos.loyaltyPoints.balance));
  }

  /* --- o endereço de gravação ------------------------------------------ */
  {
    const o = w.objetoDeCartao(CARTAO, PROGRAMA, { emissor: EMISSOR, codigo: 'ABC123XYZ' });
    const r = await w.ligacaoDeGravacao(PEM, {
      emissorEmail: 'carimbo@projecto.iam.gserviceaccount.com',
      objeto: o, origem: 'https://carimbodigital.pt',
    });
    certo(r.ligacao.startsWith('https://pay.google.com/gp/v/save/'),
      'o endereço é o da Google', r.ligacao.slice(0, 40));

    const corpo = JSON.parse(Buffer.from(
      r.jwt.split('.')[1].replace(/-/g, '+').replace(/_/g, '/'), 'base64'));
    certo(corpo.typ === 'savetowallet' && corpo.aud === 'google',
      'com os campos que a Google espera', `${corpo.typ}/${corpo.aud}`);
    certo(corpo.payload.loyaltyObjects[0].classId === o.classId,
      'e leva o `classId` a par do `id` — é o que a amostra oficial faz');
    certo(Object.keys(corpo.payload.loyaltyObjects[0]).length === 2,
      'e SÓ esses dois: o objecto vai-se buscar por REST, não vai aqui dentro',
      JSON.stringify(corpo.payload.loyaltyObjects[0]));

    /* O TECTO QUE MORDE EM SILÊNCIO. Acima de 1800 caracteres o browser corta
       o endereço, e o que acontece não é um erro — é a gravação não
       acontecer. Prova-se com o caso mau: nomes longos, prémio longo. */
    certo(r.comprimento < w.JWT_MAX,
      `o JWT cabe no tecto dos ${w.JWT_MAX} (tem ${r.comprimento})`, String(r.comprimento));

    /* E note-se PORQUE é que cabe com folga: o JWT não leva nome nenhum — nem
       da casa, nem do cartão, nem do prémio. Leva dois identificadores e o
       email da conta de serviço. É isso que o mantém do mesmo tamanho para um
       café chamado «Zé» e para outro com sessenta caracteres no nome, e é a
       razão de o objecto ser criado por REST em vez de ir aqui dentro.

       O caso mau é este: identificadores no comprimento máximo e um email de
       conta de serviço dos compridos. */
    const mau = w.objetoDeCartao(
      { ...CARTAO, id: 'c'.repeat(32) },
      { ...PROGRAMA, id: 'p'.repeat(32) },
      { emissor: EMISSOR, codigo: 'Z'.repeat(32) });
    const rMau = await w.ligacaoDeGravacao(PEM, {
      emissorEmail: 'um-nome-de-conta-de-servico-bem-comprido@um-projecto-com-nome-longo.iam.gserviceaccount.com',
      objeto: mau, origem: 'https://carimbodigital.pt',
    });
    certo(rMau.comprimento < w.JWT_MAX,
      `com os identificadores no máximo continua a caber (tem ${rMau.comprimento})`,
      String(rMau.comprimento));

    /* E a guarda do outro lado: se um dia alguém puser o objecto inteiro no
       JWT, isto tem de dar o alarme antes de chegar a um telemóvel. */
    const inteiro = await w.assinarRS256(PEM, {
      iss: 'x@y.iam.gserviceaccount.com', aud: 'google', typ: 'savetowallet',
      payload: { loyaltyObjects: [{ ...mau, textModulesData: [{ body: 'x'.repeat(900) }] }] },
    });
    certo(inteiro.length > w.JWT_MAX,
      'e um JWT com o objecto inteiro lá dentro passaria do tecto — é esse o perigo',
      String(inteiro.length));
  }

  /* --- a actualização --------------------------------------------------- */
  {
    const calado = w.actualizacaoDeSaldo({ ...CARTAO, carimbos: 3 }, PROGRAMA);
    certo(calado.loyaltyPoints.balance.string === '3/10', 'a actualização leva o saldo novo');
    certo(calado.notifyPreference === undefined,
      'e por omissão NÃO notifica — o tecto é de três por dia, e gasta-se no que importa');

    const toca = w.actualizacaoDeSaldo({ ...CARTAO, carimbos: 10 }, PROGRAMA, { notificar: true });
    certo(toca.notifyPreference === 'NOTIFY_ON_UPDATE',
      'e quando notifica usa o valor do documento de descoberta, não o da página velha',
      String(toca.notifyPreference));
  }

  /* --- a faixa desenhada ------------------------------------------------ */

  /* A Google guarda a imagem à chave do ENDEREÇO e não volta a perguntar. Um
     cartão cujo saldo sobe e cuja imagem fica na mesma é um cartão que diz
     «8 de 10» por cima de sete carimbos desenhados — e a pessoa acredita no
     desenho, não no número. As duas afirmações que interessam são estas: que
     a faixa vai no mesmo pedido que o saldo, e que o endereço MUDA. */
  {
    const semFaixa = w.objetoDeCartao(CARTAO, PROGRAMA, { emissor: EMISSOR, codigo: 'ABC123XYZ' });
    certo(semFaixa.heroImage === undefined,
      'sem faixa não se inventa um heroImage — um endereço que dá 404 é pior do que nenhum');

    const sete = w.objetoDeCartao(CARTAO, PROGRAMA, {
      emissor: EMISSOR, codigo: 'ABC123XYZ', faixa: 'https://api.exemplo/v1/faixa/c-8B5E3C-7-10-carimbo-1032x812-aaa.png',
    });
    certo(sete.heroImage && sete.heroImage.sourceUri
      && sete.heroImage.sourceUri.uri.includes('-7-10-'),
      'a faixa vai no objecto, e é a do cartão desta pessoa e não a da classe',
      JSON.stringify(sete.heroImage));

    const patch = w.actualizacaoDeSaldo({ ...CARTAO, carimbos: 8 }, PROGRAMA, {
      faixa: 'https://api.exemplo/v1/faixa/c-8B5E3C-8-10-carimbo-1032x812-bbb.png',
    });
    certo(patch.heroImage && patch.heroImage.sourceUri.uri.includes('-8-10-'),
      'e vai TAMBÉM no PATCH do saldo — senão o número sobe e o desenho fica',
      JSON.stringify(patch.heroImage));
    certo(patch.heroImage.sourceUri.uri !== sete.heroImage.sourceUri.uri,
      'e o endereço muda com os carimbos: a Google guarda a imagem para sempre à chave do endereço');

    const igual = w.actualizacaoDeSaldo({ ...CARTAO, carimbos: 8 }, PROGRAMA);
    certo(igual.heroImage === undefined,
      'um PATCH sem faixa omite o campo e deixa ficar a que lá está — não a apaga');
  }
}

/* --------------------------------------------------------------------- */

grupo('A Wallet, de ponta a ponta');
{
  /* Isto corre contra uma Google DE MENTIRA (scripts/google-de-mentira.mjs),
     levantada ao lado do Worker. Sem ela, este caminho todo — pedir o passe,
     actualizar no carimbo, reconciliar, expirar ao apagar a conta — só se
     podia provar com conta a sério, o que nunca correria no CI.

     O que se prova aqui é o que o `index.js` FAZ: em que ordem chama, o que
     envia, o que grava a seguir, e o que faz quando a Google responde mal.
     Que a assinatura está certa prova-se noutro sítio, contra o node:crypto. */
  const MENTIRA = 'http://localhost:8799';
  const visto = async () => (await fetch(`${MENTIRA}/__visto`)).json();
  const limpar = () => fetch(`${MENTIRA}/__limpar`, { method: 'POST' });
  const avariar = (n = 1) => fetch(`${MENTIRA}/__avariar?n=${n}`, { method: 'POST' });
  /* O `ctx.waitUntil` corre DEPOIS da resposta. Sem esperar, lia-se o «visto»
     antes de o Worker lá ter chegado — e o teste passava a dizer que não
     houve pedido nenhum. */
  const assentar = () => dormir(900);

  const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC';

  /* Um cliente com cartão no negócio da semente. */
  const reg = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const sessaoC = reg.dados.sessao;
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: sessaoC, corpo: { programaId: 'p1' } });
  const meus = await pedir('/v1/cliente/cartoes', { sessao: sessaoC });
  const cartaoId = meus.dados[0].id;

  {
    /* SEM LOGÓTIPO NÃO HÁ PASSE, e diz-se porquê em vez de deixar a Google
       recusar mais à frente com uma mensagem que ninguém percebe. */
    sql(`UPDATE negocios SET logotipo = NULL WHERE id = 'n1'`);
    const r = await pedir(`/v1/cliente/cartoes/${cartaoId}/wallet`, { metodo: 'POST', sessao: sessaoC });
    certo(r.estado === 409 && r.dados.codigo === 'sem-logotipo',
      'sem logótipo o passe é recusado com uma razão', `${r.estado} ${r.dados.codigo}`);
  }

  sql(`UPDATE negocios SET logotipo = 'image/png;${PNG}', logotipo_em = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'n1'`);
  await limpar();

  {
    const r = await pedir(`/v1/cliente/cartoes/${cartaoId}/wallet`, { metodo: 'POST', sessao: sessaoC });
    certo(r.estado === 200 && String(r.dados.ligacao || '').startsWith('https://pay.google.com/gp/v/save/'),
      'o passe devolve um endereço de gravação da Google',
      String(r.dados.ligacao || JSON.stringify(r.dados)).slice(0, 60));
    /* Com um `undefined` isto passava: `String(undefined).length` são nove, e
       nove é menos do que mil e novecentos. A afirmação tem de exigir que o
       endereço EXISTA antes de medir se é curto. */
    certo(typeof r.dados.ligacao === 'string' && r.dados.ligacao.length > 200
       && r.dados.ligacao.length < 1900,
      'e esse endereço existe e cabe no tecto que o browser aguenta',
      String(r.dados.ligacao && r.dados.ligacao.length));

    const chamadas = await visto();
    /* No máximo UM. Zero é legítimo — o testemunho pode já estar em cache de
       um pedido anterior, e é isso que se quer. Dois é que nunca. */
    const token = chamadas.filter((c) => c.caminho === '/token');
    certo(token.length <= 1, 'não foi buscar mais do que um testemunho de acesso',
      String(token.length));
    certo(chamadas.some((c) => c.metodo === 'POST' && c.caminho.endsWith('/loyaltyClass')),
      'criou a classe do programa');
    certo(chamadas.some((c) => c.metodo === 'POST' && c.caminho.endsWith('/loyaltyObject')),
      'e o objecto do cartão');

    const classe = chamadas.find((c) => c.caminho.endsWith('/loyaltyClass')).corpo;
    certo(String(classe.programLogo.sourceUri.uri).includes('/logotipo'),
      'a classe leva o endereço PÚBLICO do logótipo, não a imagem',
      classe.programLogo.sourceUri.uri);
  }

  {
    /* O TESTEMUNHO FICA EM CACHE. Sem isso, cada carimbo gastava dois dos 50
       subpedidos que o plano gratuito dá por invocação. */
    await limpar();
    await pedir(`/v1/cliente/cartoes/${cartaoId}/wallet`, { metodo: 'POST', sessao: sessaoC });
    const chamadas = await visto();
    certo(chamadas.filter((c) => c.caminho === '/token').length === 0,
      'à segunda vez não vai buscar outro testemunho — fica em cache',
      String(chamadas.filter((c) => c.caminho === '/token').length));
    certo(chamadas.filter((c) => c.caminho.endsWith('/loyaltyClass')).length === 0,
      'e não volta a criar a classe, que já existe');
  }

  {
    /* O CARIMBO ESPELHA-SE, e não notifica: o tecto é de três por dia e
       gasta-se no que fecha o cartão. */
    await limpar();
    sql(`UPDATE programas SET arrefecimento = 0 WHERE id = 'p1'`);
    const c = await pedir('/v1/balcao/carimbar', {
      metodo: 'POST', sessao: sessaoBalcao,
      corpo: { codigo: `M1.${reg.dados.cliente.publico}`, programaId: 'p1', manual: true } });
    certo(c.estado === 200, 'o carimbo passa', String(c.estado));
    await assentar();
    const patch = (await visto()).find((x) => x.metodo === 'PATCH');
    certo(patch, 'e o saldo foi para a Wallet', JSON.stringify(await visto()).slice(0, 120));
    certo(patch && patch.corpo.loyaltyPoints.balance.string === '1/10',
      'com o número certo', patch && JSON.stringify(patch.corpo.loyaltyPoints.balance));
    certo(patch && patch.corpo.notifyPreference === undefined,
      'e sem notificar — um carimbo do meio não toca no bolso de ninguém');
  }

  {
    /* O CARIMBO QUE FECHA O CARTÃO NOTIFICA, e não notificava.

       A chamada dizia `notificar: Boolean(r.premio)` — e o `carimbar()`
       devolve `ganhos`, que é uma lista. Nunca houve um `r.premio`: a
       expressão era `false` sempre, e o único toque no bolso que esta
       aplicação dá nunca saiu de casa. A Google dá três notificações por dia
       e gasta-se no carimbo que a pessoa quer sentir — este. */
    /* CLIENTE PRÓPRIO. Encher um cartão gasta o arrefecimento e o tecto
       diário dele, e os blocos a seguir contam com o cartão partilhado como
       ele estava — um teste que estraga o estado de outro só se nota à
       segunda vez, que é quando já ninguém liga o resultado à causa. */
    const dele = await pedir('/v1/cliente/registar', { metodo: 'POST' });
    await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: dele.dados.sessao,
      corpo: { programaId: 'p1' } });
    const oCartao = (await pedir('/v1/cliente/cartoes', { sessao: dele.dados.sessao })).dados[0].id;
    /* Só um cartão COM passe é espelhado — é o `wallet_em` que abre essa porta. */
    await pedir(`/v1/cliente/cartoes/${oCartao}/wallet`,
      { metodo: 'POST', sessao: dele.dados.sessao });

    await limpar();
    /* GUARDA-SE O QUE ESTAVA, em vez de se repor um valor a adivinhar. Pôr
       3600 de volta «porque é o normal» partiu o bloco seguinte, que contava
       com o zero que o bloco anterior tinha deixado. Quem mexe repõe o que
       encontrou, não o que julga ser o certo. */
    const antesDoPrograma = (() => {
      const o = sql(`SELECT arrefecimento, maximo_diario FROM programas WHERE id = 'p1'`);
      return JSON.parse(o.slice(o.indexOf('[')))[0].results[0];
    })();
    sql(`UPDATE programas SET arrefecimento = 0, maximo_diario = 0 WHERE id = 'p1'`);
    let fechou = null;
    for (let i = 0; i < 12 && !fechou; i += 1) {
      const c = await pedir('/v1/balcao/carimbar', {
        metodo: 'POST', sessao: sessaoBalcao,
        corpo: { codigo: `M1.${dele.dados.cliente.publico}`, programaId: 'p1', manual: true } });
      if (c.dados && c.dados.ganhos && c.dados.ganhos.length) fechou = c.dados;
    }
    certo(fechou, 'enche-se o cartão até sair o prémio', JSON.stringify(fechou && fechou.ganhos));
    await assentar();
    const comAviso = (await visto()).filter((x) => x.metodo === 'PATCH'
      && x.corpo && x.corpo.notifyPreference);
    certo(comAviso.length >= 1,
      'o carimbo que FECHA o cartão pede à Google para tocar no bolso da pessoa',
      JSON.stringify((await visto()).filter((x) => x.metodo === 'PATCH')
        .map((x) => x.corpo && x.corpo.notifyPreference)));
    certo(comAviso[0] && comAviso[0].corpo.notifyPreference === 'NOTIFY_ON_UPDATE',
      'e pede-o com o nome que ela conhece',
      String(comAviso[0] && comAviso[0].corpo.notifyPreference));
    sql(`UPDATE programas SET arrefecimento = ${antesDoPrograma.arrefecimento},
         maximo_diario = ${antesDoPrograma.maximo_diario} WHERE id = 'p1'`);
    await pedir('/v1/cliente', { metodo: 'DELETE', sessao: dele.dados.sessao });
  }

  {
    /* A GOOGLE EM BAIXO NÃO PODE FAZER FALHAR UM CARIMBO. É a promessa
       inteira do `waitUntil`: o carimbo grava-se no D1 aconteça o que
       acontecer, e o que falhar fica para o reconciliador. */
    await limpar();
    await avariar(5);
    const c = await pedir('/v1/balcao/carimbar', {
      metodo: 'POST', sessao: sessaoBalcao,
      corpo: { codigo: `M1.${reg.dados.cliente.publico}`, programaId: 'p1', manual: true } });
    certo(c.estado === 200, 'com a Google avariada, o carimbo passa na mesma', String(c.estado));
    await assentar();
    const porSincronizar = (() => {
      const o = sql(`SELECT wallet_sincronizado, ultimo_em FROM cartoes WHERE id = '${cartaoId}'`);
      return JSON.parse(o.slice(o.indexOf('[')))[0].results[0];
    })();
    certo(porSincronizar.wallet_sincronizado < porSincronizar.ultimo_em,
      'e o cartão fica marcado como por sincronizar',
      JSON.stringify(porSincronizar));

    /* E o reconciliador da madrugada acerta-o. */
    await limpar();
    await pedir('/__scheduled?cron=17+4+*+*+*');
    await assentar();
    certo((await visto()).some((x) => x.metodo === 'PATCH'),
      'o reconciliador da madrugada volta a tentar');
    const depois = (() => {
      const o = sql(`SELECT wallet_sincronizado, ultimo_em FROM cartoes WHERE id = '${cartaoId}'`);
      return JSON.parse(o.slice(o.indexOf('[')))[0].results[0];
    })();
    certo(depois.wallet_sincronizado >= depois.ultimo_em,
      'e o cartão deixa de estar atrasado', JSON.stringify(depois));
  }

  {
    /* A CLASSE TAMBÉM TEM DE ACOMPANHAR. Era escrita uma vez e nunca mais:
       o dono mudava o nome do cartão ou a cor no balcão, e quem já tinha o
       passe guardado continuava a ver o antigo para sempre — porque quem tem
       o passe não volta a abrir a app. O que ele vê é o que a Google tem. */
    await limpar();
    await pedir('/v1/balcao/negocio', { metodo: 'PUT', sessao: sessaoBalcao,
      corpo: { nome: 'Café Rebaptizado', cor: '#EE9125' } });
    await assentar();
    const patchClasse = (await visto()).find(
      (x) => x.metodo === 'PATCH' && x.caminho.includes('/loyaltyClass/'));
    certo(patchClasse, 'mudar o nome do negócio vai à classe da Wallet',
      JSON.stringify((await visto()).map((x) => `${x.metodo} ${x.caminho}`)).slice(0, 200));
    certo(patchClasse && patchClasse.corpo.issuerName === 'Café Rebaptizado',
      'com o nome novo', patchClasse && patchClasse.corpo.issuerName);
    certo(patchClasse && patchClasse.corpo.hexBackgroundColor === '#EE9125',
      'e com a cor nova — que é o que estava errado no primeiro cartão a sério',
      patchClasse && patchClasse.corpo.hexBackgroundColor);

    await limpar();
    await pedir('/v1/balcao/programas', { metodo: 'POST', sessao: sessaoBalcao,
      corpo: { id: 'p1', nome: 'Cartão com nome novo', premio: 'Outro prémio' } });
    await assentar();
    const patchP = (await visto()).find(
      (x) => x.metodo === 'PATCH' && x.caminho.includes('/loyaltyClass/'));
    certo(patchP && patchP.corpo.programName === 'Cartão com nome novo',
      'e mudar o nome do cartão também', patchP && patchP.corpo.programName);
    /* Uma classe que a Google já aprovou recusa o PATCH com «Invalid review
       status "APPROVED". Use "UNDER_REVIEW" instead» — e não basta omitir o
       campo, porque então fica o valor antigo e é esse que ela rejeita. Ao
       criar aceita `underReview`; ao actualizar exige `UNDER_REVIEW`. */
    certo(patchP && patchP.corpo.reviewStatus === 'UNDER_REVIEW',
      'e leva o reviewStatus na forma que a Google exige ao actualizar',
      patchP && String(patchP.corpo.reviewStatus));
  }

  {
    /* O ENDEREÇO DO LOGÓTIPO LEVA A VERSÃO COLADA.

       A Google guarda o `programLogo` numa cache própria, à chave do
       ENDEREÇO, e o Worker serve essa imagem com `immutable` por um ano — que
       é dizer-lhe «não voltes a perguntar». Sem o `?v=`, trocar o logótipo no
       balcão não mudava nada no cartão de ninguém: media-se a cópia em
       `lh3.googleusercontent.com` e ela continuava a ser a do primeiro dia.
       Foi o que aconteceu com o primeiro negócio a sério.

       A data põe-se à mão em vez de se depender do relógio: duas gravações no
       mesmo milissegundo davam a mesma versão, e um teste que falha de vez em
       quando não prova nada. */
    sql(`UPDATE negocios SET logotipo_em = '2026-01-02T03:04:05.678Z' WHERE id = 'n1'`);
    await limpar();
    await pedir('/v1/balcao/negocio', { metodo: 'PUT', sessao: sessaoBalcao,
      corpo: { nome: 'O Meu Café', cor: '#EE9125' } });
    await assentar();
    const comVersao = (await visto()).find(
      (x) => x.metodo === 'PATCH' && x.caminho.includes('/loyaltyClass/'));
    const uriA = comVersao && comVersao.corpo.programLogo
      && comVersao.corpo.programLogo.sourceUri.uri;
    certo(String(uriA).startsWith(`${BASE}/v1/negocio/`)
       && String(uriA).endsWith('/logotipo?v=20260102030405678'),
      'o endereço do logótipo leva a versão — senão a Google nunca mais o relê',
      String(uriA));

    sql(`UPDATE negocios SET logotipo_em = '2026-03-04T05:06:07.890Z' WHERE id = 'n1'`);
    await limpar();
    await pedir('/v1/balcao/negocio', { metodo: 'PUT', sessao: sessaoBalcao,
      corpo: { nome: 'O Meu Café', cor: '#EE9125' } });
    await assentar();
    const depois = (await visto()).find(
      (x) => x.metodo === 'PATCH' && x.caminho.includes('/loyaltyClass/'));
    const uriB = depois && depois.corpo.programLogo && depois.corpo.programLogo.sourceUri.uri;
    certo(uriB && uriB !== uriA, 'e muda quando a imagem muda', `${uriA} → ${uriB}`);

    /* E pelo gesto de verdade: o dono a carregar outra imagem no balcão. */
    await limpar();
    const g = await pedir('/v1/balcao/logotipo', { metodo: 'PUT', sessao: sessaoBalcao,
      corpo: { logotipo: `data:image/png;base64,${PNG}` } });
    certo(g.estado === 200, 'o dono grava um logótipo novo', String(g.estado));
    await assentar();
    const aoGravar = (await visto()).find(
      (x) => x.metodo === 'PATCH' && x.caminho.includes('/loyaltyClass/'));
    const uriC = aoGravar && aoGravar.corpo.programLogo
      && aoGravar.corpo.programLogo.sourceUri.uri;
    certo(uriC && uriC !== uriB && /\?v=\d+$/.test(uriC),
      'gravar no balcão dá logo um endereço novo à Google', String(uriC));
  }

  {
    /* APAGAR A CONTA TEM DE MATAR O PASSE, e antes de apagar a linha: depois
       já não há por onde saber que ele existia, e ficava na carteira da
       pessoa para sempre com um saldo velho. */
    await limpar();
    const r = await pedir('/v1/cliente', { metodo: 'DELETE', sessao: sessaoC });
    certo(r.estado === 200, 'a conta apaga-se', String(r.estado));
    const expirou = (await visto()).find((x) => x.metodo === 'PATCH' && x.corpo && x.corpo.state === 'EXPIRED');
    certo(expirou, 'e o passe é posto a EXPIRED na Google — senão fica na carteira para sempre',
      JSON.stringify(await visto()).slice(0, 160));
  }

  /* REPÕE-SE O QUE ESTE BLOCO MEXEU. A base local sobrevive entre corridas, e
     os testes que leem o nome do negócio correm ANTES deste — mas na corrida
     SEGUINTE encontravam «Café Rebaptizado» e falhavam sem haver defeito
     nenhum. Um teste que estraga o estado de outro só se nota à segunda vez,
     que é quando já ninguém liga o resultado à causa. */
  sql(`UPDATE programas SET arrefecimento = 3600, nome = 'Cartão do café',
       premio = 'Um café por conta da casa' WHERE id = 'p1'`);
  sql(`UPDATE negocios SET nome = 'O Meu Café', cor = '#3B2417' WHERE id = 'n1'`);
}


/* =========================================================================
   O cartão na Apple Wallet

   Isto prova o ficheiro, não a Apple. Constrói-se um `.pkpass` com um
   certificado feito aqui na hora, e verifica-se com o `openssl` — que é o
   mesmo verificador que o telemóvel usa por baixo. O que fica por provar é o
   que só um iPhone prova: que a Apple aceita a CADEIA dela. Isso não se
   finge, e não se diz que está provado.

   O certificado é gerado a cada corrida em vez de ficar no repositório: uma
   chave privada num repositório público é um mau hábito mesmo quando não
   serve para nada, e faz disparar os leitores de segredos de meio mundo.
   ========================================================================= */
grupo('O cartão na Apple Wallet');
{
  const p = await import('./src/pkpass.js');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const pasta = mkdtempSync(join(tmpdir(), 'carimbo-apple-'));
  const caminho = (n) => join(pasta, n);
  const openssl = (...args) => execFileSync('openssl', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });

  try {
    openssl('req', '-x509', '-newkey', 'rsa:2048', '-keyout', caminho('k.pem'),
      '-out', caminho('c.pem'), '-days', '2', '-nodes',
      '-subj', '/C=PT/O=Carimbo Digital/CN=Pass Type ID: pass.pt.carimbodigital.cartao');
    openssl('pkcs8', '-topk8', '-nocrypt', '-in', caminho('k.pem'), '-out', caminho('k8.pem'));
    const cert = readFileSync(caminho('c.pem'), 'utf8');
    const chave = readFileSync(caminho('k8.pem'), 'utf8');

    const PNG1 = Uint8Array.from(atob(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4//8/AAX+Av4N70a4AAAAAElFTkSuQmCC',
    ), (c) => c.charCodeAt(0));
    const CARTAO = { id: 'cartao-de-prova', carimbos: 3 };
    const PROGRAMA = { tipo: 'carimbos', objetivo: 10, nome: 'Cartão do café',
      premio: 'Um café por conta da casa', regras: 'Um por dia.' };
    const NEGOCIO = { nome: 'O Meu Café', cor: '#EE9125', morada: 'Rua A', localidade: 'Ovar' };

    const passe = p.passeDeCartao(CARTAO, PROGRAMA, NEGOCIO, {
      passTipo: 'pass.pt.carimbodigital.cartao', equipa: 'ABCDE12345',
      codigo: 'GEPCL23XZLL29LME', dominio: 'carimbodigital.pt',
    });

    /* --- o pass.json ---------------------------------------------------- */
    certo(passe.formatVersion === 1 && passe.passTypeIdentifier && passe.teamIdentifier
       && passe.serialNumber && passe.organizationName && passe.description,
      'o pass.json leva as seis chaves que a Apple exige',
      JSON.stringify(Object.keys(passe)).slice(0, 120));
    certo(passe.serialNumber === 'cartao-de-prova',
      'o número de série é o do cartão — é ele que faz o passe novo SUBSTITUIR o velho',
      String(passe.serialNumber));
    certo(passe.backgroundColor === 'rgb(238,145,37)',
      'a cor vai em rgb() e não em #hex, que é o único formato que a Apple aceita',
      String(passe.backgroundColor));
    certo(passe.foregroundColor === 'rgb(0,0,0)',
      'e a tinta por cima da cor é medida: preto sobre o laranja da barbearia',
      String(passe.foregroundColor));
    certo(passe.storeCard.headerFields[0].value === '3/10',
      'o contador mostra o saldo do cartão', String(passe.storeCard.headerFields[0].value));
    certo(passe.barcodes[0].message === 'W1.GEPCL23XZLL29LME',
      'o código de barras leva o prefixo W1., por onde o balcão reconhece um passe',
      String(passe.barcodes[0].message));
    certo(passe.storeCard.backFields.some((f) => f.value.includes('Um café por conta da casa')),
      'e o prémio está escrito nas costas, como num cartão de papel');

    /* --- o ficheiro ----------------------------------------------------- */
    const bytes = await p.construirPasse({
      passe, imagens: { 'icon.png': PNG1, 'logo.png': PNG1 },
      certificado: cert, chave, quando: '2026-09-16T00:00:00Z',
    });
    writeFileSync(caminho('cartao.pkpass'), bytes);

    certo(bytes[0] === 0x50 && bytes[1] === 0x4B,
      'o passe é um ZIP a sério — começa por PK',
      `${bytes[0]} ${bytes[1]}`);

    execFileSync('unzip', ['-o', '-q', caminho('cartao.pkpass'), '-d', caminho('fora')]);
    const manifesto = JSON.parse(readFileSync(join(caminho('fora'), 'manifest.json'), 'utf8'));
    certo(['pass.json', 'icon.png', 'logo.png'].every((n) => manifesto[n]),
      'o manifesto tem o SHA-1 de cada ficheiro', JSON.stringify(Object.keys(manifesto)));

    certo(!manifesto['manifest.json'] && !manifesto.signature,
      'e não se inclui a si próprio nem à assinatura — não daria');

    const sha1 = (b) => createHash('sha1').update(b).digest('hex');
    certo(manifesto['pass.json'] === sha1(readFileSync(join(caminho('fora'), 'pass.json'))),
      'e o SHA-1 do pass.json bate com o ficheiro que lá está');

    /* --- a assinatura --------------------------------------------------- */
    const verificar = (ficheiroConteudo) => {
      try {
        execFileSync('openssl', ['cms', '-verify', '-inform', 'DER',
          '-in', join(caminho('fora'), 'signature'), '-content', ficheiroConteudo,
          '-noverify', '-purpose', 'any', '-out', '/dev/null'],
        { stdio: ['ignore', 'ignore', 'pipe'] });
        return true;
      } catch { return false; }
    };

    certo(verificar(join(caminho('fora'), 'manifest.json')),
      'o openssl verifica a assinatura PKCS#7 — a mesma conta que o telemóvel faz');

    /* E a afirmação de cima só vale se esta falhar. Uma verificação que dá
       certo seja qual for o conteúdo não está a verificar nada. */
    writeFileSync(caminho('mexido.json'),
      readFileSync(join(caminho('fora'), 'manifest.json'), 'utf8').replace('icon.png', 'icon.pnh'));
    certo(!verificar(caminho('mexido.json')),
      'e RECUSA um manifesto mexido — senão não estava a verificar nada');

    const estrutura = execFileSync('openssl', ['cms', '-cmsout', '-inform', 'DER',
      '-in', join(caminho('fora'), 'signature'), '-print'], { encoding: 'utf8' });
    certo(/eContent: <ABSENT>/.test(estrutura),
      'a assinatura é DESTACADA — o manifesto não vai lá dentro, que é o que a Apple quer');
    /* CONTAR, e não procurar a palavra. O `openssl cms -cmsout -print` escreve
       SEMPRE o rótulo `certificates:` — quando não há nenhum, escreve
       `<ABSENT>` na linha a seguir, e um `/certificates:/` dá verdadeiro à
       mesma. A afirmação nomeava uma coisa e media outra: passava com uma
       assinatura construída sem certificado nenhum lá dentro. */
    const quantosCertificados = (texto) => (texto.match(/certificate:\s*$/gmi) || []).length
      || (texto.match(/\bcert_info:/g) || []).length;
    certo(!/certificates:\s*<ABSENT>/i.test(estrutura) && quantosCertificados(estrutura) >= 1,
      'e leva o certificado de quem assinou, senão o telemóvel não sabe contra o que verificar',
      `${quantosCertificados(estrutura)} certificado(s)`);

    {
      /* A CADEIA INTEIRA, e não o primeiro bloco. O `doPEM` fazia `match` sem
         `g`: quem colasse o WWDR e a raiz na mesma variável — que é como eles
         vêm de uma exportação do Acesso a Chaves — mandava dois e o passe
         levava um. O ficheiro saía bem formado, o `openssl -noverify`
         verificava, os testes passavam, e o iPhone recusava-o por não
         conseguir fechar a cadeia. */
      openssl('req', '-x509', '-newkey', 'rsa:2048', '-keyout', caminho('k2.pem'),
        '-out', caminho('c2.pem'), '-days', '2', '-nodes', '-subj', '/CN=Intermedio de mentira');
      const intermedio = readFileSync(caminho('c2.pem'), 'utf8');

      const comCadeia = await p.construirPasse({
        passe, imagens: { 'icon.png': PNG1, 'logo.png': PNG1 },
        certificado: cert, chave, cadeia: [intermedio], quando: '2026-09-16T00:00:00Z',
      });
      writeFileSync(caminho('cadeia.pkpass'), comCadeia);
      execFileSync('unzip', ['-o', '-q', caminho('cadeia.pkpass'), '-d', caminho('c1')]);
      const e1 = execFileSync('openssl', ['cms', '-cmsout', '-inform', 'DER',
        '-in', join(caminho('c1'), 'signature'), '-print'], { encoding: 'utf8' });
      certo(quantosCertificados(e1) === 2,
        'a cadeia entra no passe: dois certificados, o signatário e o intermédio',
        `${quantosCertificados(e1)}`);

      /* E o caso que partia: os dois colados na MESMA variável. */
      const colados = await p.construirPasse({
        passe, imagens: { 'icon.png': PNG1, 'logo.png': PNG1 },
        certificado: cert + intermedio, chave, quando: '2026-09-16T00:00:00Z',
      });
      writeFileSync(caminho('colados.pkpass'), colados);
      execFileSync('unzip', ['-o', '-q', caminho('colados.pkpass'), '-d', caminho('c2')]);
      const e2 = execFileSync('openssl', ['cms', '-cmsout', '-inform', 'DER',
        '-in', join(caminho('c2'), 'signature'), '-print'], { encoding: 'utf8' });
      certo(quantosCertificados(e2) === 2,
        'e dois colados na mesma variável contam os dois — era aqui que se perdia um',
        `${quantosCertificados(e2)}`);

      {
        /* A CHAVE PRIVADA NUNCA ENTRA NUM PASSE, e isto é a guarda de uma
           fuga a sério que esteve escrita.

           Ao passar a ler todos os blocos de um PEM — para a cadeia caber
           numa variável — passou-se a enfiar no CMS tudo o que aparecesse,
           sem olhar ao rótulo. E o ficheiro que a receita normal produz
           (`openssl pkcs12 -in Certificates.p12 -nodes`) traz o certificado
           E A CHAVE. Medido na altura: os bytes completos da chave de
           assinatura ficavam dentro do ficheiro `signature` do `.pkpass` —
           que a rota ABERTA serve a quem tiver o endereço.

           Recusa-se em vez de se ignorar em silêncio: uma chave privada na
           variável dos certificados quer dizer que um segredo foi colado no
           sítio errado, e quem o fez tem de saber. */
        const combinado = `${cert}\n${readFileSync(caminho('k8.pem'), 'utf8')}`;
        let recusou = null;
        try {
          await p.construirPasse({
            passe, imagens: { 'icon.png': PNG1, 'logo.png': PNG1 },
            certificado: combinado, chave, quando: '2026-09-16T00:00:00Z',
          });
        } catch (erro) { recusou = erro.message; }
        certo(recusou && /chave privada/i.test(recusou),
          'um PEM com a chave lá dentro é RECUSADO — nunca chega a sair um passe',
          String(recusou));
        certo(recusou && /APPLE_CHAVE/.test(recusou),
          'e diz onde é que a chave devia estar', String(recusou));

        /* E a prova de que a recusa é o que interessa: com o certificado
           sozinho, os bytes da chave NÃO aparecem na assinatura. */
        const limpo = await p.construirPasse({
          passe, imagens: { 'icon.png': PNG1, 'logo.png': PNG1 },
          certificado: cert, chave, quando: '2026-09-16T00:00:00Z',
        });
        writeFileSync(caminho('limpo.pkpass'), limpo);
        execFileSync('unzip', ['-o', '-q', caminho('limpo.pkpass'), '-d', caminho('c3')]);
        openssl('pkey', '-in', caminho('k8.pem'), '-outform', 'DER', '-out', caminho('k8.der'));
        const assinatura = readFileSync(join(caminho('c3'), 'signature'));
        const chaveDER = readFileSync(caminho('k8.der'));
        certo(assinatura.indexOf(chaveDER) === -1,
          'e num passe bem feito a chave privada não está lá dentro, byte nenhum',
          `assinatura ${assinatura.length} bytes`);

        /* A MESMA FUGA, POR UMA PORTA QUE A CORRECÇÃO DE 2026 NÃO FECHOU.
           A guarda de cima distinguia certificado de chave PELO RÓTULO — e há
           uma forma de escrever um PEM que não tem rótulo nenhum: o base64
           achatado, sem BEGIN/END. Não é um caso exótico: é a forma que cabe
           numa variável de ambiente, está documentada no `doPEM` como aceite,
           e é a que a nota de entrega manda usar. Por aí, os MESMOS bytes que
           a linha de cima recusa passavam direitos.

           Foi reproduzido com a chave de produção antes de isto ser escrito.
           Agora, sem rótulo, quem decide é o DER: um INTEGER logo a seguir ao
           SEQUENCE de fora é chave; um SEQUENCE é certificado.

           E prova-se nas DUAS variáveis. No `certificado` a verificação do par
           chave/certificado apanhava-o por acidente mais à frente; na `cadeia`
           não há verificação nenhuma, e era por lá que a chave saía inteira. */
        const achatar = (pem) => pem.replace(/-----[^-]+-----/g, '').replace(/\s+/g, '');
        const chaveAchatada = achatar(readFileSync(caminho('k8.pem'), 'utf8'));

        for (const [onde, argumentos] of [
          ['APPLE_CERTIFICADO', { certificado: chaveAchatada, chave }],
          ['APPLE_CADEIA', { certificado: cert, chave, cadeia: [chaveAchatada] }],
        ]) {
          let recusa = null;
          try {
            await p.construirPasse({
              passe, imagens: { 'icon.png': PNG1, 'logo.png': PNG1 },
              quando: '2026-09-16T00:00:00Z', ...argumentos,
            });
          } catch (erro) { recusa = erro.message; }
          certo(recusa && /chave privada/i.test(recusa),
            `a chave ACHATADA (sem BEGIN/END) em ${onde} também é recusada — `
            + 'era a porta que ficou aberta',
            String(recusa));
        }

        /* E a guarda nova não pode recusar certificados: um certificado
           achatado é exactamente a forma que uma variável de ambiente leva. */
        const limpoAchatado = await p.construirPasse({
          passe, imagens: { 'icon.png': PNG1, 'logo.png': PNG1 },
          certificado: achatar(cert), chave, quando: '2026-09-16T00:00:00Z',
        });
        certo(limpoAchatado && limpoAchatado.length > 0,
          'e um CERTIFICADO achatado continua a ser aceite — senão a guarda nova partia a configuração real',
          `${limpoAchatado && limpoAchatado.length} bytes`);
      }

      {
        /* A CADEIA AO CONTRÁRIO NÃO ASSINA EM SILÊNCIO. O primeiro bloco é
           tomado como signatário; se a ordem não corresponder à chave, o
           `SignerInfo` apontava para um certificado que não tem nada que ver
           com a assinatura e nada se queixava — o `emissorESerie` lê o emissor
           e a série de qualquer SEQUENCE que lhe dêem. O passe saía, o
           telemóvel recusava-o, e não havia por onde perceber porquê. */
        let aoContrario = null;
        try {
          await p.construirPasse({
            passe, imagens: { 'icon.png': PNG1 },
            certificado: `${intermedio}${cert}`, chave, quando: '2026-09-16T00:00:00Z',
          });
        } catch (erro) { aoContrario = erro.message; }
        certo(aoContrario && /não corresponde/i.test(aoContrario),
          'a cadeia colada ao contrário é recusada — a chave não bate com o primeiro certificado',
          String(aoContrario).slice(0, 110));
        certo(aoContrario && /PRIMEIRO/.test(aoContrario),
          'e diz qual é a ordem certa', String(aoContrario).slice(0, 130));

        /* UM CERTIFICADO EM BRANCO NÃO PROMOVE A CADEIA A SIGNATÁRIO. */
        let embranco = null;
        try {
          await p.construirPasse({
            passe, imagens: { 'icon.png': PNG1 },
            certificado: '   ', chave, cadeia: [intermedio], quando: '2026-09-16T00:00:00Z',
          });
        } catch (erro) { embranco = erro.message; }
        certo(embranco && /APPLE_CERTIFICADO/.test(embranco),
          'um APPLE_CERTIFICADO em branco é recusado — a cadeia não serve de signatário',
          String(embranco).slice(0, 110));

        /* UM BLOCO TRUNCADO DIZ QUAL. Lendo mais do que um bloco, um caracter
           perdido num copiar-colar do segundo dava um «Erro interno» que não
           nomeava nada. */
        const partido = `${cert}${intermedio.replace(/^(.{80})./m, '$1')}`;
        let truncado = null;
        try { p.todosOsPEM(partido); } catch (erro) { truncado = erro.message; }
        certo(truncado === null || /bloco \d/.test(truncado),
          'e um bloco estragado diz QUAL dos blocos é que está estragado',
          String(truncado));
      }

      /* Com os `\n` achatados, que é como um PEM cabe numa variável. */
      const achatado = await p.construirPasse({
        passe, imagens: { 'icon.png': PNG1, 'logo.png': PNG1 },
        certificado: (cert + intermedio).replace(/\n/g, '\\n'), chave,
        quando: '2026-09-16T00:00:00Z',
      });
      certo(Buffer.compare(Buffer.from(colados), Buffer.from(achatado)) === 0,
        'e um PEM achatado em «\\n» dá exactamente o mesmo passe');
    }

    /* --- o mesmo pedido duas vezes dá o mesmo ficheiro ------------------- */
    const outra = await p.construirPasse({
      passe, imagens: { 'icon.png': PNG1, 'logo.png': PNG1 },
      certificado: cert, chave, quando: '2026-09-16T00:00:00Z',
    });
    certo(Buffer.compare(Buffer.from(bytes), Buffer.from(outra)) === 0,
      'dois passes iguais dão o mesmo ficheiro byte a byte — a data do ZIP vai a zeros de propósito',
      `${bytes.length} vs ${outra.length}`);

    /* --- o que tem de falhar -------------------------------------------- */
    let semIcone = null;
    try {
      await p.construirPasse({ passe, imagens: { 'logo.png': PNG1 }, certificado: cert, chave });
    } catch (erro) { semIcone = erro.message; }
    certo(semIcone && /icon/.test(semIcone),
      'um passe sem ícone é recusado aqui, e não pelo telemóvel de um cliente',
      String(semIcone));

    let semEquipa = null;
    try { p.passeDeCartao(CARTAO, PROGRAMA, NEGOCIO, { passTipo: 'x' }); }
    catch (erro) { semEquipa = erro.message; }
    certo(semEquipa && /equipa/.test(semEquipa),
      'e sem identificador de equipa também — é uma das seis chaves obrigatórias');

    /* --- as peças à parte ----------------------------------------------- */
    certo(p.crc32(new TextEncoder().encode('123456789')) === 0xCBF43926,
      'o CRC-32 dá o valor de referência para «123456789»',
      p.crc32(new TextEncoder().encode('123456789')).toString(16));

    const certDER = p.doPEM(cert);
    const { serie, emissor } = p.emissorESerie(certDER);
    certo(serie[0] === 0x02 && emissor[0] === 0x30,
      'do certificado tira-se o número de série e o emissor, que é como o CMS diz quem assinou',
      `${serie[0]} ${emissor[0]}`);
  } finally {
    rmSync(pasta, { recursive: true, force: true });
  }
}


grupo('O passe da Apple, de ponta a ponta');
{
  /* Aqui prova-se o WORKER, não a Apple: que o bilhete é assinado, que expira,
     que só serve para o cartão de quem o pediu, e que do outro lado sai um
     ficheiro com a assinatura certa. O certificado é auto-assinado, feito pelo
     `com-worker.mjs` — o que fica por provar é o que só um iPhone prova: que
     a Apple aceita a cadeia dela. */
  const { execFileSync: correr } = await import('node:child_process');
  const { mkdtempSync, writeFileSync, readFileSync, rmSync } = await import('node:fs');
  const { tmpdir } = await import('node:os');

  const reg = await pedir('/v1/cliente/registar', { metodo: 'POST' });
  const sessaoA = reg.dados.sessao;
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: sessaoA, corpo: { programaId: 'p1' } });
  const meus = await pedir('/v1/cliente/cartoes', { sessao: sessaoA });
  const cartaoId = meus.dados[0].id;

  /* Uma segunda pessoa, para o cartão dela não poder ser pedido pela primeira. */
  const outro = await pedir('/v1/cliente/registar', { metodo: 'POST' });
  const sessaoB = outro.dados.sessao;
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: sessaoB, corpo: { programaId: 'p1' } });
  const seus = await pedir('/v1/cliente/cartoes', { sessao: sessaoB });
  const cartaoDoOutro = seus.dados[0].id;

  {
    const r = await pedir(`/v1/cliente/cartoes/${cartaoId}/pkpass`, { metodo: 'POST' });
    certo(r.estado === 401, 'sem sessão não há passe', String(r.estado));
  }
  {
    const r = await pedir(`/v1/cliente/cartoes/${cartaoDoOutro}/pkpass`,
      { metodo: 'POST', sessao: sessaoA });
    certo(r.estado === 404,
      'e o cartão de outra pessoa não se pede — nem se diz que existe', String(r.estado));
  }

  const r = await pedir(`/v1/cliente/cartoes/${cartaoId}/pkpass`, { metodo: 'POST', sessao: sessaoA });
  certo(r.estado === 200 && typeof r.dados.ligacao === 'string',
    'o passe da Apple devolve um endereço', `${r.estado} ${JSON.stringify(r.dados).slice(0, 80)}`);
  /* ISTO DIZIA «o endereço NÃO leva o número do cartão» e comparava com
     `includes`. Um texto em base64url nunca contém o original em claro, seja
     o que for que lá esteja dentro — a afirmação dava certo por construção, e
     daria certo se o bilhete deixasse de ser assinado ou se passasse a levar
     a morada da pessoa. Não provava nada.

     E o que ela dizia era falso: o identificador do cartão ESTÁ lá, só que
     codificado. Isso é aceitável e é a razão de o bilhete existir — mas quem
     lê o teste tem de saber a verdade, não o contrário dela. O que interessa
     provar é que o bilhete só leva o cartão e o prazo, que não leva nada
     sobre a PESSOA, e que sem o selo não abre nada. */
  const bilheteDentro = (() => {
    const b = String(r.dados.ligacao || '').split('/v1/passe/')[1] || '';
    const corpo = Buffer.from(b.split('.')[0], 'base64url').toString('utf8');
    return { corpo, partes: corpo.split('.') };
  })();
  certo(bilheteDentro.partes.length === 2 && bilheteDentro.partes[0] === cartaoId
     && /^\d{10,}$/.test(bilheteDentro.partes[1]),
    'o bilhete leva o cartão e o prazo, e mais nada — descodificado e conferido',
    bilheteDentro.corpo);
  certo(!bilheteDentro.corpo.includes(reg.dados.cliente.publico),
    'e NADA sobre a pessoa: nem o número do cliente, nem a morada',
    bilheteDentro.corpo);

  const bilhete = String(r.dados.ligacao || '').split('/v1/passe/')[1] || '';

  {
    /* O ficheiro vai-se buscar SEM sessão: é o Safari que navega para lá, e
       uma navegação não leva cabeçalho nenhum. É por isso que o bilhete tem
       de ser a fechadura. */
    const resposta = await fetch(`${BASE}/v1/passe/${bilhete}`);
    const tipo = resposta.headers.get('content-type');
    certo(resposta.status === 200 && tipo === 'application/vnd.apple.pkpass',
      'e abre-se sem sessão, porque quem o abre é o Safari e não a app',
      `${resposta.status} ${tipo}`);
    certo((resposta.headers.get('cache-control') || '').includes('no-store'),
      'sem cache: um passe guardado é um passe com o número de carimbos errado',
      String(resposta.headers.get('cache-control')));

    const bytes = new Uint8Array(await resposta.arrayBuffer());
    certo(bytes[0] === 0x50 && bytes[1] === 0x4B && bytes.length > 500,
      'o que vem é um ZIP a sério', `${bytes[0]} ${bytes[1]} ${bytes.length}`);

    /* E verifica-se com o openssl, como o telemóvel faria. */
    const pasta = mkdtempSync(join(tmpdir(), 'carimbo-passe-'));
    try {
      writeFileSync(join(pasta, 'p.pkpass'), Buffer.from(bytes));
      correr('unzip', ['-o', '-q', join(pasta, 'p.pkpass'), '-d', join(pasta, 'fora')]);
      const passe = JSON.parse(readFileSync(join(pasta, 'fora', 'pass.json'), 'utf8'));
      certo(passe.serialNumber === cartaoId,
        'o passe é do cartão certo', String(passe.serialNumber));

      /* A FAIXA, e medida NO PASSE QUE O PRODUTO EMITE.
 
         A primeira versão desta afirmação ficou no teste que constrói um passe
         à mão com `imagens: { icon.png, logo.png }` — nunca passa pelo
         `index.js`, por isso media o que o teste lhe deu em vez do que o
         produto faz. Reprovou, e ainda bem: uma afirmação no sítio errado que
         passasse era pior.
 
         O `every` da outra é sobre três nomes, e uma chave a MAIS passa
         sempre: não notaria se a faixa desaparecesse amanhã. Esta nota.
 
         O sufixo faz parte da afirmação. Um ficheiro chamado `strip.png` com
         750 px de largura diz ao iOS que aquilo são 750 PONTOS, e ele desenha-o
         ao dobro do tamanho, cortado, sem erro nenhum. */
      const manifestoReal = JSON.parse(
        readFileSync(join(pasta, 'fora', 'manifest.json'), 'utf8'));
      certo(!!manifestoReal['strip@2x.png'],
        'o passe leva a FAIXA — sem ela volta a ser um rectângulo de cor com texto',
        JSON.stringify(Object.keys(manifestoReal)));
      certo(!manifestoReal['strip.png'],
        'e não leva um «strip.png» sem escala, que o iOS leria ao dobro');

      /* E é mesmo um PNG das medidas certas: a Apple quer 375 × 144 pt na
         faixa de um storeCard, o que a 2× são 750 × 288. Lê-se o cabeçalho do
         ficheiro, em vez de acreditar no nome dele. */
      const faixaBytes = readFileSync(join(pasta, 'fora', 'strip@2x.png'));
      certo([137, 80, 78, 71, 13, 10, 26, 10].every((b, i) => faixaBytes[i] === b),
        'e a faixa é um PNG a sério', [...faixaBytes.slice(0, 8)].join(' '));
      certo(faixaBytes.readUInt32BE(16) === 750 && faixaBytes.readUInt32BE(20) === 288,
        'com as medidas que a Apple pede, a 2×',
        `${faixaBytes.readUInt32BE(16)}×${faixaBytes.readUInt32BE(20)}`);
      certo(passe.passTypeIdentifier === 'pass.pt.carimbodigital.dementira'
         && passe.teamIdentifier === 'DEMENTIRA1',
        'com o Pass Type ID e a equipa que o Worker tem configurados',
        `${passe.passTypeIdentifier} ${passe.teamIdentifier}`);
      certo(/^W1\./.test(passe.barcodes[0].message),
        'e o código de barras é o do passe, com o prefixo que o balcão conhece',
        String(passe.barcodes[0].message));

      let verificou = true;
      try {
        correr('openssl', ['cms', '-verify', '-inform', 'DER',
          '-in', join(pasta, 'fora', 'signature'),
          '-content', join(pasta, 'fora', 'manifest.json'),
          '-noverify', '-purpose', 'any', '-out', '/dev/null'], { stdio: 'ignore' });
      } catch { verificou = false; }
      certo(verificou,
        'e a assinatura que o Worker fez verifica — a mesma conta que o telemóvel faz');
    } finally {
      rmSync(pasta, { recursive: true, force: true });
    }
  }

  {
    /* O BILHETE TEM DE SER UMA FECHADURA, e não um enfeite. */
    const mexido = bilhete.slice(0, -2) + (bilhete.endsWith('AA') ? 'BB' : 'AA');
    const r1 = await fetch(`${BASE}/v1/passe/${mexido}`);
    certo(r1.status === 403, 'um bilhete mexido é recusado', String(r1.status));

    const [corpo] = bilhete.split('.');
    const r2 = await fetch(`${BASE}/v1/passe/${corpo}.`);
    certo(r2.status === 403, 'e um sem selo também', String(r2.status));

    /* Forjar um que aponte para o cartão de outra pessoa, sem selo válido. */
    const forjado = `${Buffer.from(`${cartaoDoOutro}.${Date.now() + 600000}`).toString('base64url')}.${bilhete.split('.')[1]}`;
    const r3 = await fetch(`${BASE}/v1/passe/${forjado}`);
    certo(r3.status === 403,
      'e trocar o cartão dentro do bilhete não passa — o selo é sobre o conteúdo todo',
      String(r3.status));
  }

  {
    /* SEM LOGÓTIPO NÃO HÁ PASSE, e diz-se porquê aqui e não no telemóvel. */
    sql(`UPDATE negocios SET logotipo = NULL WHERE id = 'n1'`);
    const r4 = await pedir(`/v1/cliente/cartoes/${cartaoId}/pkpass`,
      { metodo: 'POST', sessao: sessaoA });
    certo(r4.estado === 409 && r4.dados.codigo === 'sem-logotipo',
      'sem logótipo o passe da Apple é recusado com uma razão',
      `${r4.estado} ${r4.dados.codigo}`);
    sql(`UPDATE negocios SET logotipo = 'image/png;${PNG_FIXO}', logotipo_em = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'n1'`);
  }

  {
    /* UM JPEG NÃO ENTRA NUM PASSE DA APPLE. A coluna aceita-o de propósito — o
       balcão diz «PNG ou JPEG» e para a Google serve — mas a Apple só aceita
       PNG nas imagens, e metê-lo no arquivo com o nome `icon.png` dava um
       ficheiro que o iPhone recusa sem dizer porquê. A recusa sai daqui, com
       uma frase e um caminho. */
    const JPEG = '/9j/4AAQSkZJRgABAQEAYABgAAD/2wBDAAgGBgcGBQgHBwcJCQgKDBQNDAsL'
      + 'DBkSEw8UHRofHh0aHBwgJC4nICIsIxwcKDcpLDAxNDQ0Hyc5PTgyPC4zNDL/wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAACf/EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AKp//2Q==';
    sql(`UPDATE negocios SET logotipo = 'image/jpeg;${JPEG}' WHERE id = 'n1'`);
    const r5 = await pedir(`/v1/cliente/cartoes/${cartaoId}/pkpass`,
      { metodo: 'POST', sessao: sessaoA });
    certo(r5.estado === 409 && r5.dados.codigo === 'logotipo-nao-png',
      'um logótipo JPEG é recusado aqui, e não pelo iPhone de um cliente',
      `${r5.estado} ${r5.dados.codigo}`);
    certo(/PNG/.test(String(r5.dados.erro)) && /balcão/i.test(String(r5.dados.erro)),
      'e diz o que fazer', String(r5.dados.erro));

    /* E A APP NÃO PROMETE O BOTÃO. Este campo existe justamente para que um
       botão não falhe só quando é tocado — prometer a Apple a um negócio com
       logótipo JPEG era pôr aqui o defeito que ele veio resolver. */
    const comJpeg = await pedir(`/v1/cliente/cartoes/${cartaoId}`, { sessao: sessaoA });
    certo(comJpeg.dados.carteiras && comJpeg.dados.carteiras.apple === false,
      'e a app deixa de prometer o botão da Apple a um negócio com logótipo JPEG',
      JSON.stringify(comJpeg.dados.carteiras));
    certo(comJpeg.dados.carteiras && comJpeg.dados.carteiras.google === true,
      'mas a Google continua — essa aceita JPEG',
      JSON.stringify(comJpeg.dados.carteiras));
    sql(`UPDATE negocios SET logotipo = 'image/png;${PNG_FIXO}' WHERE id = 'n1'`);
  }

  {
    /* UM SEGREDO MAL POSTO É UM ERRO NO POST, e não um JSON dentro do Safari.

       O `applePronta` só diz que as quatro variáveis não estão vazias. Uma
       chave em PKCS#1 — a forma antiga, que o `openssl rsa -traditional`
       ainda dá e que muita ferramenta mais velha dá por omissão — só rebentava
       no GET, que é uma NAVEGAÇÃO: a pessoa tocava no botão, o Safari saía da
       app, e o que aparecia era um ecrã com «Erro interno» em vez do passe.
       (O `openssl genrsa` de hoje já dá PKCS#8; a armadilha continua a existir
       para quem traga a chave de outro lado.)

       Não se pode mexer nas variáveis do Worker a correr, por isso prova-se
       pelo lado de cá: o mesmo caminho de verificação, com uma chave no
       formato errado. */
    const { execFileSync: correr2 } = await import('node:child_process');
    const p2 = await import('./src/pkpass.js');
    const { mkdtempSync: pasta2, readFileSync: ler2, rmSync: apagar2 } = await import('node:fs');
    const { tmpdir: tmp2 } = await import('node:os');
    const dir = pasta2(join(tmp2(), 'carimbo-pk1-'));
    let recusou = null;
    try {
      correr2('openssl', ['genrsa', '-out', join(dir, 'p8.pem'), '2048'], { stdio: 'ignore' });
      /* A forma ANTIGA, que é a que não serve ao WebCrypto. */
      correr2('openssl', ['rsa', '-in', join(dir, 'p8.pem'), '-traditional',
        '-out', join(dir, 'pk1.pem')], { stdio: 'ignore' });
      correr2('openssl', ['req', '-x509', '-key', join(dir, 'p8.pem'), '-out',
        join(dir, 'c.pem'), '-days', '2', '-subj', '/CN=x'], { stdio: 'ignore' });
      await p2.construirPasse({
        passe: { formatVersion: 1 },
        imagens: { 'icon.png': Uint8Array.from(atob(PNG_FIXO), (c) => c.charCodeAt(0)) },
        certificado: ler2(join(dir, 'c.pem'), 'utf8'),
        chave: ler2(join(dir, 'pk1.pem'), 'utf8'),
        quando: '2026-09-16T00:00:00Z',
      });
    } catch (erro) { recusou = erro.message; }
    apagar2(dir, { recursive: true, force: true });
    certo(recusou,
      'uma chave em PKCS#1 não passa — e é por isso que o POST a experimenta antes de dar o endereço',
      String(recusou).slice(0, 110));
  }

  {
    /* E a app tem de SABER que pode mostrar o botão. */
    /* O PASSE DA APPLE NÃO MARCA O CARTÃO COMO SENDO DA GOOGLE.

       O `wallet_em` quer dizer «tem um loyaltyObject na Google»: é por ele
       que o espelho do saldo decide se manda o PATCH, e é por ele que o
       reconciliador da madrugada escolhe os atrasados. Um cartão só-Apple
       marcado assim punha o Worker a bater todas as noites num objecto que
       nunca existiu — e como a consulta leva `LIMIT 40` sem ordenação,
       quarenta destes bastavam para nenhum cartão da Google voltar a ser
       reconciliado, em silêncio. */
    const colunas = (() => {
      const o = sql(`SELECT wallet_codigo, wallet_em, apple_em FROM cartoes WHERE id = '${cartaoId}'`);
      return JSON.parse(o.slice(o.indexOf('[')))[0].results[0];
    })();
    certo(colunas.apple_em, 'o passe da Apple marca a coluna da Apple',
      JSON.stringify(colunas));
    certo(colunas.wallet_em === null,
      'e NÃO marca a da Google — senão o reconciliador persegue para sempre um objecto que não existe',
      JSON.stringify(colunas));
    certo(colunas.wallet_codigo && colunas.wallet_codigo.length === 16,
      'o código do passe é um só para as duas carteiras — é o mesmo código de barras',
      JSON.stringify(colunas.wallet_codigo));

    const c = await pedir(`/v1/cliente/cartoes/${cartaoId}`, { sessao: sessaoA });
    certo(c.dados.carteiras && c.dados.carteiras.apple === true,
      'o cartão diz à app que a Apple está pronta neste Worker',
      JSON.stringify(c.dados.carteiras));
    certo(c.dados.carteiras && c.dados.carteiras.google === true,
      'e a Google também', JSON.stringify(c.dados.carteiras));
  }

  /* Limpa-se o que este bloco criou: dois clientes com cartões no p1 ficavam
     na base local e a corrida seguinte contava-os. */
  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: sessaoA });
  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: sessaoB });
}

grupo('Quem sou eu');
{
  /* O segredo saía uma vez no registo e outra na entrada, e nunca mais. Quem o
     perdesse — ou quem ficasse com um de uma versão já revogada — tinha um
     código QR que o balcão recusa e nenhuma forma de se endireitar. */
  const semSessao = await pedir('/v1/cliente/eu');
  certo(semSessao.estado === 401, 'sem sessão não se sabe quem é', String(semSessao.estado));

  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const eu = await pedir('/v1/cliente/eu', { sessao: c.dados.sessao });
  certo(eu.estado === 200, 'com sessão, a conta responde', String(eu.estado));
  certo(eu.dados.cliente?.id === c.dados.cliente.id,
    'e é a MESMA conta da sessão', String(eu.dados.cliente?.id));
  certo(eu.dados.segredo === c.dados.segredo,
    'o segredo que devolve é o mesmo que o registo deu — é isto que permite recuperá-lo',
    `${String(eu.dados.segredo).slice(0, 8)} vs ${String(c.dados.segredo).slice(0, 8)}`);

  certo(Array.isArray(eu.dados.identidades) && eu.dados.identidades.length === 0,
    'e diz que ainda não há forma nenhuma de entrar — é isto que faz o perfil pedir login',
    JSON.stringify(eu.dados.identidades));
  certo(!('sujeito' in (eu.dados.identidades[0] || {})),
    'sem o `sujeito`: o `sub` da Google não se mostra a ninguém nem serve para o ecrã');

  const codigo = codigoPara(eu.dados.cliente.publico, eu.dados.segredo);
  const r = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao, corpo: { codigo, programaId: 'p1' } });
  certo(r.estado === 200, 'e um código feito com ele carimba mesmo',
    JSON.stringify(r.dados).slice(0, 120));

  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: c.dados.sessao });
}

grupo('Expulsar os outros aparelhos');
{
  /* A COLUNA QUE NUNCA TINHA SIDO LIDA. A `chave_versao` estava no esquema
     desde o primeiro dia, com um comentário a explicar que servia para
     revogar, e não aparecia em nenhum SELECT nem em nenhum UPDATE em todo o
     Worker. Um telemóvel perdido com a app aberta era uma conta perdida para
     sempre: quem o apanhasse mostrava o código e levava carimbos.

     São TRÊS credenciais, e o teste prova as três. Provar só uma dava um botão
     que diz «expulsei os outros» e deixa lá dentro as outras duas. */
  sql(`UPDATE programas SET arrefecimento = 0, maximo_diario = 0 WHERE id = 'p1'`);
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const sessaoA = c.dados.sessao;
  const publico = c.dados.cliente.publico;
  const segredoVelho = c.dados.segredo;

  /* Um segundo aparelho na MESMA conta. É o que a recuperação por email faz;
     aqui mete-se a sessão à mão para não se ter de a encenar outra vez. */
  const testemunhoB = 'testemunho-do-outro-aparelho-' + randomBytes(8).toString('hex');
  const resumoB = createHash('sha256').update(testemunhoB).digest('hex');
  sql(`INSERT INTO sessoes (resumo, sujeito, criada_em, expira_em)
       VALUES ('${resumoB}', 'cliente:${c.dados.cliente.id}', datetime('now'),
               '${new Date(Date.now() + 86400000).toISOString()}')`);
  const antes = await pedir('/v1/cliente/cartoes', { sessao: testemunhoB });
  certo(antes.estado === 200, 'o segundo aparelho entra na conta', String(antes.estado));

  /* E um passe na carteira, que é a terceira credencial. */
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: sessaoA,
    corpo: { programaId: 'p1' } });
  const meus = await pedir('/v1/cliente/cartoes', { sessao: sessaoA });
  const cartaoId = meus.dados[0].id;
  sql(`UPDATE negocios SET logotipo = 'image/png;${PNG_FIXO}',
       logotipo_em = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = 'n1'`);
  await pedir(`/v1/cliente/cartoes/${cartaoId}/wallet`, { metodo: 'POST', sessao: sessaoA });
  const codigoPasse = (() => {
    const o = sql(`SELECT wallet_codigo FROM cartoes WHERE id = '${cartaoId}'`);
    return JSON.parse(o.slice(o.indexOf('[')))[0].results[0].wallet_codigo;
  })();
  certo(typeof codigoPasse === 'string' && codigoPasse.length === 16,
    'e o cartão ganha um passe na carteira', String(codigoPasse));

  const passeAntes = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `W1.${codigoPasse}`, programaId: 'p1' } });
  certo(passeAntes.estado === 200, 'que carimba, como deve ser', String(passeAntes.estado));

  /* --- a expulsão --- */
  const fora = await pedir('/v1/cliente/sair-dos-outros', { metodo: 'POST', sessao: sessaoA });
  certo(fora.estado === 200, 'a conta manda expulsar os outros aparelhos',
    JSON.stringify(fora.dados).slice(0, 120));

  /* 1. a sessão */
  const depois = await pedir('/v1/cliente/cartoes', { sessao: testemunhoB });
  certo(depois.estado === 401, 'o outro aparelho perde a sessão', String(depois.estado));
  const eu = await pedir('/v1/cliente/eu', { sessao: sessaoA });
  certo(eu.estado === 200,
    'e quem mandou expulsar NÃO se expulsa a si próprio', String(eu.estado));

  /* 2. o segredo do código QR */
  certo(fora.dados.segredo && fora.dados.segredo !== segredoVelho,
    'o segredo muda — senão não havia revogação nenhuma');
  certo(eu.dados.segredo === fora.dados.segredo,
    'e é o novo que a conta passa a dar', `${String(eu.dados.segredo).slice(0, 8)}`);

  const velho = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(publico, segredoVelho), programaId: 'p1' } });
  certo(velho.estado === 403,
    'O CÓDIGO DO APARELHO PERDIDO DEIXA DE CARIMBAR — é para isto que a coluna existe',
    `${velho.estado} ${JSON.stringify(velho.dados)}`);

  const novoQR = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(publico, fora.dados.segredo), programaId: 'p1' } });
  certo(novoQR.estado === 200, 'e o novo carimba', `${novoQR.estado} ${JSON.stringify(novoQR.dados)}`);

  /* 3. o passe na carteira — o que quase escapou. O `W1.` não leva assinatura
        nenhuma: o código É a credencial, e o `carimbar()` nem sequer olha para
        a versão da chave nesse caminho. Subir a versão não lhe tocava, e o
        passe do telemóvel perdido continuava a carimbar para sempre. */
  const passeDepois = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `W1.${codigoPasse}`, programaId: 'p1' } });
  certo(passeDepois.estado === 404,
    'O PASSE DA CARTEIRA TAMBÉM MORRE — subir a versão não lhe tocava, e ele não leva assinatura',
    `${passeDepois.estado} ${JSON.stringify(passeDepois.dados)}`);
  certo(fora.dados.passesRevogados === 1,
    'e a resposta diz quantos passes caíram, para a app poder avisar',
    String(fora.dados.passesRevogados));

  const carteiras = (() => {
    const o = sql(`SELECT wallet_codigo, wallet_em, apple_em FROM cartoes WHERE id = '${cartaoId}'`);
    return JSON.parse(o.slice(o.indexOf('[')))[0].results[0];
  })();
  certo(carteiras.wallet_em === null && carteiras.apple_em === null,
    'o cartão volta a dizer que não tem passe — senão a app não oferecia juntá-lo outra vez',
    JSON.stringify(carteiras));

  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: sessaoA });
}

grupo('Criar contas em série');
{
  /* A rota de registo é a única aberta a quem nunca se identificou: devolve
     uma conta, um segredo e uma sessão a quem bater à porta, e não contava
     nada. Um ciclo de três linhas esgotava as 100 000 escritas diárias do D1 —
     que são POR CONTA da Cloudflare, ou seja, levava atrás tudo o resto. */
  /* Quanto é que a BATERIA gastou até aqui, na origem do wrangler. Sem esta
     conta, acrescentar meia dúzia de registos à bateria um dia qualquer punha
     um teste sem relação nenhuma a rebentar com «Cannot read properties of
     undefined», que foi precisamente o que aconteceu ao escrever isto. */
  const gastos = (() => {
    const o = sql(`SELECT COUNT(*) AS n FROM registos`);
    return JSON.parse(o.slice(o.indexOf('[')))[0].results[0].n;
  })();
  certo(gastos < 50,
    `a bateria cria ${gastos} contas da mesma origem, e o tecto é 60 — se isto falhar, `
    + 'é a bateria que cresceu, não o código que partiu', String(gastos));

  sql(`DELETE FROM registos`);
  const origem = { 'cf-connecting-ip': '203.0.113.7' };
  const criados = [];
  let travado = null, quantas = 0;

  for (let i = 0; i < 70; i++) {
    const r = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {}, cabecalhos: origem });
    if (r.estado === 429) { travado = r; break; }
    if (r.dados?.cliente?.id) criados.push(r.dados.cliente.id);
    quantas++;
  }
  certo(travado !== null, 'a mesma origem acaba por ser travada', `${quantas} passaram`);
  certo(travado?.dados?.codigo === 'demasiados-registos',
    'e diz porquê, em vez de um erro interno', JSON.stringify(travado?.dados));
  certo(quantas <= 60, 'o tecto é de 60 por hora, não mais', String(quantas));

  /* Outra origem não paga o que esta fez. Sem isto, a trava era um interruptor
     para desligar o registo a toda a gente a partir de uma máquina só. */
  const outra = await pedir('/v1/cliente/registar', {
    metodo: 'POST', corpo: {}, cabecalhos: { 'cf-connecting-ip': '198.51.100.4' } });
  certo(outra.estado === 200, 'outra origem continua a poder criar conta', String(outra.estado));
  if (outra.dados?.cliente?.id) criados.push(outra.dados.cliente.id);

  /* NÃO SE TESTA AQUI o caminho «sem cabeçalho não há trava»: o `wrangler dev`
     põe sempre o `cf-connecting-ip`, por isso uma afirmação sobre a falta dele
     passaria por acidente e não provaria nada. Na borda o cabeçalho também vem
     sempre — a Cloudflare põe-no e substitui o que o cliente mandar, logo não
     se forja nem se apaga —, e é por isso que o `return` que lá está serve só
     para o desenvolvimento local não ficar refém do contador. */

  /* O QUE SE GUARDA NÃO É A ORIGEM. A política de privacidade enumera o que é
     recolhido, e o endereço não está lá: o que fica na base é um HMAC dele com
     a chave-mestra, que não se percorre de trás para a frente. */
  const guardadas = (() => {
    const o = sql(`SELECT DISTINCT origem FROM registos`);
    return JSON.parse(o.slice(o.indexOf('[')))[0].results.map((l) => l.origem);
  })();
  certo(guardadas.length > 0 && !guardadas.some((o) => String(o).includes('203.0.113')),
    'a base guarda um HMAC da origem, nunca a origem', JSON.stringify(guardadas).slice(0, 80));

  /* Limpa-se o que este bloco criou: são dezenas de contas, e a corrida
     seguinte contava-as. */
  for (let i = 0; i < criados.length; i += 20) {
    const lote = criados.slice(i, i + 20);
    sql(`DELETE FROM clientes WHERE id IN ('${lote.join("','")}')`);
  }
  sql(`DELETE FROM registos`);
}

grupo('A identidade é (provedor, sujeito)');
{
  /* A conta tinha UMA forma de entrar, guardada em duas colunas da própria
     conta. Com o Google e a Apple a caminho, a morada deixa de poder ser a
     chave: o `sub` de cada provedor é um espaço de nomes diferente, e a mesma
     morada em dois sítios não prova nada.

     O que estes testes provam é que a decisão MUDOU DE SÍTIO — que quem manda
     é a tabela e já não a coluna. Sem isso, a migração era só uma tabela nova
     a apanhar pó ao lado do código que continuava a decidir como antes. */
  const correio = 'identidade@exemplo.pt';
  sql(`DELETE FROM entradas`); sql(`DELETE FROM envios`);
  sql(`DELETE FROM identidades WHERE sujeito = '${correio}'`);
  sql(`UPDATE clientes SET email = NULL, email_verificado = 0 WHERE email = '${correio}'`);

  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const forjar = (alvo, codigo, morada) => {
    const r = createHash('sha256').update(`${morada}|${codigo}`).digest('hex');
    sql(`DELETE FROM entradas WHERE alvo = '${alvo}'`);
    sql(`INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em)
         VALUES ('${r}', '${alvo}', '${morada}', datetime('now'),
                 '${new Date(Date.now() + 600000).toISOString()}')`);
  };

  forjar(`cliente:${c.dados.cliente.id}`, '111111', correio);
  const entrou = await pedir('/v1/cliente/entrar',
    { metodo: 'POST', corpo: { email: correio, codigo: '111111' } });
  certo(entrou.estado === 200, 'confirmar a morada continua a funcionar', String(entrou.estado));

  const euDepois = await pedir('/v1/cliente/eu', { sessao: c.dados.sessao });
  certo(euDepois.dados?.identidades?.length === 1
        && euDepois.dados.identidades[0].provedor === 'email',
    'e o /eu passa a dizer que há uma forma de entrar (a lista vazia de cima não passava por acidente)',
    JSON.stringify(euDepois.dados?.identidades));

  const ident = linhas(`SELECT provedor, sujeito, email, relay, cliente_id, verificada_em, usada_em
                          FROM identidades WHERE sujeito = '${correio}'`);
  certo(ident.length === 1, 'e nasce UMA identidade', JSON.stringify(ident).slice(0, 120));
  certo(ident[0]?.provedor === 'email' && ident[0]?.sujeito === correio,
    'com o provedor e o sujeito certos', JSON.stringify(ident[0]));
  certo(ident[0]?.cliente_id === c.dados.cliente.id,
    'colada à conta que provou a caixa', String(ident[0]?.cliente_id));
  certo(!!ident[0]?.verificada_em,
    'já verificada — não existe estado «por verificar», que é o que mata o pré-registo');
  certo(!!ident[0]?.usada_em, 'e marcada como usada, que é o que permite caducar as paradas');

  const espelho = linhas(`SELECT email, email_verificado FROM clientes WHERE id = '${c.dados.cliente.id}'`)[0];
  certo(espelho.email === correio && espelho.email_verificado === 1,
    'o espelho em clientes.email continua escrito — a PWA de alguém pode ser de há semanas',
    JSON.stringify(espelho));

  /* O TESTE QUE PROVA QUE A DECISÃO MUDOU DE SÍTIO. Põe-se uma conta com a
     coluna preenchida e SEM identidade nenhuma: se o dono ainda saísse do
     `clientes.email`, esta conta era encontrada e a outra pessoa entrava na
     conta dela. */
  const fantasma = 'so-na-coluna@exemplo.pt';
  sql(`DELETE FROM identidades WHERE sujeito = '${fantasma}'`);
  const outro = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  sql(`UPDATE clientes SET email = '${fantasma}', email_verificado = 1
        WHERE id = '${outro.dados.cliente.id}'`);

  const terceiro = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  sql(`DELETE FROM envios`);
  const pedido = await pedir('/v1/cliente/email', { metodo: 'POST',
    sessao: terceiro.dados.sessao, corpo: { email: fantasma } });
  certo(pedido.dados?.recuperar === false,
    'uma morada que só existe na COLUNA já não reclama conta nenhuma — quem decide é a tabela',
    JSON.stringify(pedido.dados));

  /* A exportação do RGPD leva-as: são dados da pessoa, e quando a Google e a
     Apple entrarem é a única forma de ela saber o que está ligado à conta. */
  const dados = await pedir('/v1/cliente/dados', { sessao: c.dados.sessao });
  certo(Array.isArray(dados.dados?.identidades) && dados.dados.identidades.length === 1,
    'o «descarregar os meus dados» leva as formas de entrar',
    JSON.stringify(dados.dados?.identidades));
  certo(dados.dados?.identidades?.[0]?.sujeito === correio,
    'e são as certas', JSON.stringify(dados.dados?.identidades?.[0]));

  /* Apagar a conta leva-as à frente. O QUE ISTO PROVA É O RESULTADO, não o
     mecanismo: o `PRAGMA foreign_keys` está a 1 no D1, por isso a cascata
     sozinha já cumpre, e tirar o DELETE explícito do Worker não põe esta
     afirmação a vermelho. Fica porque o invariante é que interessa — uma
     identidade órfã trancava aquela morada para sempre, pelo índice único, e
     ninguém perceberia porquê. Quem prova mesmo que a morada se liberta é a
     afirmação a seguir, que reutiliza a morada numa conta nova. */
  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: c.dados.sessao });
  certo(linhas(`SELECT 1 FROM identidades WHERE sujeito = '${correio}'`).length === 0,
    'apagar a conta apaga as identidades — senão a morada ficava trancada para sempre');

  const revive = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  sql(`DELETE FROM envios`);
  forjar(`cliente:${revive.dados.cliente.id}`, '222222', correio);
  const outraVez = await pedir('/v1/cliente/entrar',
    { metodo: 'POST', corpo: { email: correio, codigo: '222222' } });
  certo(outraVez.estado === 200,
    'e a morada volta a poder ser usada por outra pessoa', String(outraVez.estado));

  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: outraVez.dados.sessao });
  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: outro.dados.sessao });
  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: terceiro.dados.sessao });
}

grupo('A migração das identidades corre sobre dados que já existem');
{
  /* A PARTE QUE SÓ CORRE UMA VEZ, e por isso é a única que não se pode
     remendar depois. Numa base limpa o `INSERT ... SELECT` não encontra
     ninguém e não faz nada — o que passaria por verde sem provar nada. Aqui
     põe-se uma conta como as que JÁ estão em produção: morada verificada na
     coluna, identidade nenhuma. */
  const antigo = 'veterano@exemplo.pt';
  sql(`DELETE FROM identidades WHERE sujeito = '${antigo}'`);
  sql(`DELETE FROM clientes WHERE email = '${antigo}'`);
  const idAntigo = randomBytes(16).toString('hex');
  sql(`INSERT INTO clientes (id, publico, criado_em, visto_em, email, email_verificado)
       VALUES ('${idAntigo}', 'VET111', '2026-01-02T03:04:05.000Z', '2026-05-06T07:08:09.000Z',
               '${antigo}', 1)`);
  certo(linhas(`SELECT 1 FROM identidades WHERE sujeito = '${antigo}'`).length === 0,
    'a conta antiga começa sem identidade nenhuma (o teste é válido)');

  sqlFicheiro('migracoes/009-identidades.sql');

  const veio = linhas(`SELECT provedor, sujeito, email, cliente_id, criada_em, verificada_em, usada_em
                         FROM identidades WHERE sujeito = '${antigo}'`);
  certo(veio.length === 1, 'a migração dá-lhe uma identidade', JSON.stringify(veio).slice(0, 140));
  certo(veio[0]?.cliente_id === idAntigo && veio[0]?.provedor === 'email',
    'da conta certa e com o provedor certo', JSON.stringify(veio[0]));
  certo(veio[0]?.criada_em === '2026-01-02T03:04:05.000Z',
    'com a data da CONTA, que é a única que existe — nunca se guardou quando é que a morada foi confirmada',
    String(veio[0]?.criada_em));
  certo(veio[0]?.usada_em === '2026-05-06T07:08:09.000Z',
    'e o `usada_em` traz o último sinal de vida, para não caducar quem está activo',
    String(veio[0]?.usada_em));

  /* Correr duas vezes não pode duplicar: uma migração que só se possa correr
     uma vez é uma migração que não se pode repetir quando falha a meio. */
  sqlFicheiro('migracoes/009-identidades.sql');
  certo(linhas(`SELECT 1 FROM identidades WHERE sujeito = '${antigo}'`).length === 1,
    'e correr a migração outra vez não duplica nada');

  /* Uma conta com morada NÃO verificada não ganha identidade: nunca ninguém
     provou aquela caixa, e dar-lhe linha era escrever pré-registo na base. */
  const porProvar = 'nunca-provou@exemplo.pt';
  sql(`DELETE FROM clientes WHERE email = '${porProvar}'`);
  sql(`INSERT INTO clientes (id, publico, criado_em, visto_em, email, email_verificado)
       VALUES ('${randomBytes(16).toString('hex')}', 'VET222', datetime('now'), datetime('now'),
               '${porProvar}', 0)`);
  sqlFicheiro('migracoes/009-identidades.sql');
  certo(linhas(`SELECT 1 FROM identidades WHERE sujeito = '${porProvar}'`).length === 0,
    'uma morada por verificar NÃO ganha identidade — isso era escrever pré-registo na base');

  sql(`DELETE FROM identidades WHERE sujeito = '${antigo}'`);
  sql(`DELETE FROM clientes WHERE email IN ('${antigo}', '${porProvar}')`);
}

grupo('Contas-sombra: o número antigo não morre');
{
  /* A conta que sai de uma fusão NÃO se apaga. O número de cartão foi dito em
     voz alta ao balcão, escrito num guardanapo e fotografado — seis caracteres
     que alguém tem apontados não deixam de existir porque a pessoa entrou pela
     Google no telemóvel novo.

     Nada cria sombras ainda: quem as cria é a fusão, na fase 3. Aqui prova-se
     o código que as ATRAVESSA, que é o que tem de estar de pé ANTES de haver
     uma única — senão a fase 3 constrói por cima de caminhos nunca percorridos. */
  sql(`UPDATE programas SET arrefecimento = 0, maximo_diario = 0 WHERE id = 'p1'`);

  const sombra = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const viva = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const numeroAntigo = sombra.dados.cliente.publico;
  const segredoAntigo = sombra.dados.segredo;

  /* A fusão, à mão: é tudo o que a fase 3 vai escrever, reduzido ao que este
     grupo precisa. */
  sql(`UPDATE clientes SET fundida_em = '${viva.dados.cliente.id}',
        fundida_quando = datetime('now') WHERE id = '${sombra.dados.cliente.id}'`);

  /* 1. O NÚMERO ESCRITO À MÃO. É a promessa inteira. */
  const mao = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${numeroAntigo}`, programaId: 'p1' } });
  certo(mao.estado === 200,
    'o número antigo escrito à mão continua a carimbar',
    `${mao.estado} ${JSON.stringify(mao.dados).slice(0, 100)}`);

  const ondeFoi = linhas(`SELECT cliente_id FROM cartoes WHERE id = '${mao.dados?.cartao?.id}'`);
  certo(ondeFoi[0]?.cliente_id === viva.dados.cliente.id,
    'E O CARIMBO VAI PARAR À CONTA QUE FICOU, não à sombra',
    `${ondeFoi[0]?.cliente_id} vs ${viva.dados.cliente.id}`);

  /* 2. O CÓDIGO DO ECRÃ NÃO SOBREVIVE, e é isso que fecha o telemóvel que
        ficou de fora da fusão. Não foi preciso escrever nada para isto: o
        segredo que se deriva passa a ser o da conta que ficou, e a assinatura
        antiga foi feita com o da sombra sobre o número antigo. */
  const ecra = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(numeroAntigo, segredoAntigo), programaId: 'p1' } });
  certo(ecra.estado === 403,
    'mas o código do ECRÃ da sombra já não carimba — o telemóvel que ficou de fora fecha-se',
    `${ecra.estado} ${JSON.stringify(ecra.dados)}`);

  /* 3. UMA SESSÃO NUMA SOMBRA NÃO ABRE NADA, e não se segue o ponteiro. Numa
        absorção de conta anónima as sessões dela morrem; uma que sobreviva só
        pode ser uma que devia ter morrido, e dar-lhe a conta de destino era
        dar-lhe a conta inteira de outra pessoa. */
  const comSessao = await pedir('/v1/cliente/cartoes', { sessao: sombra.dados.sessao });
  certo(comSessao.estado === 401,
    'a sessão da sombra deixa de abrir — seguir o ponteiro aqui era entregar a conta de outra pessoa',
    String(comSessao.estado));
  certo(linhas(`SELECT 1 FROM sessoes WHERE sujeito = 'cliente:${sombra.dados.cliente.id}'`).length === 0,
    'e a sessão é apagada em vez de ficar a bater à porta todos os dias');

  /* 4. UM CICLO NÃO PENDURA O WORKER. Isto é aberto a qualquer pessoa: são
        seis caracteres escritos ao balcão. Sem tecto de saltos, duas linhas a
        apontar uma para a outra punham a invocação a rodar até ser morta. */
  const a = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const b = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  sql(`UPDATE clientes SET fundida_em = '${b.dados.cliente.id}' WHERE id = '${a.dados.cliente.id}'`);
  sql(`UPDATE clientes SET fundida_em = '${a.dados.cliente.id}' WHERE id = '${b.dados.cliente.id}'`);
  const emCiclo = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${a.dados.cliente.publico}`, programaId: 'p1' } });
  certo(emCiclo.estado === 404,
    'um ciclo de fusões responde «desconhecido» em vez de pendurar o Worker',
    `${emCiclo.estado} ${JSON.stringify(emCiclo.dados)}`);

  /* 5. UMA CADEIA CURTA ATRAVESSA-SE. A fusão achata, mas o resolvedor não
        pode depender disso para dar a resposta certa. */
  const x = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const y = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const z = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  sql(`UPDATE clientes SET fundida_em = '${y.dados.cliente.id}' WHERE id = '${x.dados.cliente.id}'`);
  sql(`UPDATE clientes SET fundida_em = '${z.dados.cliente.id}' WHERE id = '${y.dados.cliente.id}'`);
  const emCadeia = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${x.dados.cliente.publico}`, programaId: 'p1' } });
  certo(emCadeia.estado === 200, 'uma cadeia de duas fusões chega ao fim',
    `${emCadeia.estado} ${JSON.stringify(emCadeia.dados).slice(0, 90)}`);
  certo(linhas(`SELECT cliente_id FROM cartoes WHERE id = '${emCadeia.dados?.cartao?.id}'`)[0]?.cliente_id
        === z.dados.cliente.id,
    'e o carimbo vai para o fim da cadeia', String(z.dados.cliente.id));

  /* 6. UMA SOMBRA A APONTAR PARA O VAZIO diz «desconhecido», e não carimba no
        ar. Acontece se o destino for apagado. */
  const orfa = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  sql(`UPDATE clientes SET fundida_em = 'nao-existe-esta-conta' WHERE id = '${orfa.dados.cliente.id}'`);
  const perdida = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${orfa.dados.cliente.publico}`, programaId: 'p1' } });
  certo(perdida.estado === 404, 'uma sombra a apontar para o vazio é «desconhecido»',
    `${perdida.estado} ${JSON.stringify(perdida.dados)}`);

  /* 7. APAGAR A CONTA LEVA AS SOMBRAS. Senão ficavam a ocupar números de
        cartão que nunca mais podiam voltar a sair. */
  const destino = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const dela = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  sql(`UPDATE clientes SET fundida_em = '${destino.dados.cliente.id}' WHERE id = '${dela.dados.cliente.id}'`);
  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: destino.dados.sessao });
  certo(linhas(`SELECT 1 FROM clientes WHERE id = '${dela.dados.cliente.id}'`).length === 0,
    'apagar a conta apaga as sombras que apontavam para ela');

  sql(`DELETE FROM clientes WHERE id IN ('${[sombra, viva, a, b, x, y, z, orfa]
    .map((r) => r.dados.cliente.id).join("','")}')`);
}

grupo('Contas-sombra: a limpeza da madrugada não lhes toca');
{
  /* Uma sombra está parada POR DEFINIÇÃO: não tem cartões e o `visto_em` nunca
     mais mexe. A limpeza apagava-a ao fim de dois anos, e isso não parece
     grave até se perceber o que apaga — a única coisa para que ela existe. O
     número antigo deixava de carimbar em silêncio, dois anos depois de uma
     fusão de que ninguém se lembra. */
  const limpeza = () => pedir('/__scheduled?cron=17+4+*+*+*');
  const haMuito = (() => { const d = new Date(); d.setMonth(d.getMonth() - 40); return d.toISOString(); })();

  const destino = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const velha = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const parada = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });

  sql(`UPDATE clientes SET criado_em = '${haMuito}', visto_em = '${haMuito}',
        fundida_em = '${destino.dados.cliente.id}', fundida_quando = '${haMuito}'
        WHERE id = '${velha.dados.cliente.id}'`);
  /* A testemunha: igual em tudo, menos em ser sombra. Sem ela, esta secção
     passava na mesma se a limpeza tivesse deixado de apagar seja o que for. */
  sql(`UPDATE clientes SET criado_em = '${haMuito}', visto_em = '${haMuito}'
        WHERE id = '${parada.dados.cliente.id}'`);

  await limpeza();

  certo(linhas(`SELECT 1 FROM clientes WHERE id = '${parada.dados.cliente.id}'`).length === 0,
    'a limpeza apaga mesmo uma conta parada de há 40 meses (a testemunha, senão isto não prova nada)');
  certo(linhas(`SELECT 1 FROM clientes WHERE id = '${velha.dados.cliente.id}'`).length === 1,
    'MAS NÃO APAGA A SOMBRA, por muito parada que esteja — é o número antigo que ela guarda');

  sql(`DELETE FROM clientes WHERE id IN ('${destino.dados.cliente.id}','${velha.dados.cliente.id}')`);
}

grupo('Fundir duas contas');
{
  /* A operação mais perigosa do produto, e o perigo não é técnico: quase tudo
     o que corre mal aqui corre mal em SILÊNCIO. Ninguém repara que perdeu um
     cartão que tinha há dois anos — repara daí a meio ano, ao balcão, e já não
     há como saber o que aconteceu. Por isso cada afirmação aqui conta linhas,
     em vez de acreditar num 200. */
  sql(`UPDATE programas SET arrefecimento = 0, maximo_diario = 0 WHERE id = 'p1'`);
  const prog2 = (() => {
    const há = linhas(`SELECT id FROM programas WHERE id = 'pfusao'`);
    if (!há.length) {
      sql(`INSERT INTO programas (id, negocio_id, nome, premio, objetivo, arrefecimento,
             maximo_diario, criado_em)
           VALUES ('pfusao', 'n1', 'Segundo programa', 'Bolo', 10, 0, 0, datetime('now'))`);
    }
    return 'pfusao';
  })();

  const criar = async () => {
    const r = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
    return { id: r.dados.cliente.id, publico: r.dados.cliente.publico,
             sessao: r.dados.sessao, segredo: r.dados.segredo };
  };
  const carimbar = (c, programaId, quantas = 1) => (async () => {
    for (let i = 0; i < quantas; i++) {
      await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
        corpo: { codigo: `M1.${c.publico}`, programaId } });
    }
  })();

  /* --- o caso comum: o telemóvel tinha cartões, a conta do email tinha outros */
  const local = await criar();       /* a conta anónima que a app cria ao abrir */
  const doEmail = await criar();     /* a conta em que a pessoa entra */
  await carimbar(local, 'p1', 3);
  await carimbar(local, prog2, 2);
  await carimbar(doEmail, 'p1', 7);
  /* Uma identidade no destino, para o modo ser dedutível. */
  sql(`INSERT INTO identidades (id, cliente_id, provedor, sujeito, email, relay, criada_em, verificada_em)
       VALUES ('${randomBytes(16).toString('hex')}', '${doEmail.id}', 'email',
               'fusao@exemplo.pt', 'fusao@exemplo.pt', 0, datetime('now'), datetime('now'))`);

  const antesLocal = linhas(`SELECT programa_id, carimbos, total_carimbos FROM cartoes
                               WHERE cliente_id = '${local.id}' ORDER BY programa_id`);
  const antesEmail = linhas(`SELECT programa_id, carimbos, total_carimbos FROM cartoes
                               WHERE cliente_id = '${doEmail.id}'`);
  certo(antesLocal.length === 2 && antesEmail.length === 1,
    'o cenário montou-se: dois cartões de um lado, um do outro (senão o resto não prova nada)',
    `${antesLocal.length} e ${antesEmail.length}`);

  const fundiu = await pedir('/v1/cliente/fundir', { metodo: 'POST',
    sessao: doEmail.sessao, corpo: { sessaoOrigem: local.sessao } });
  certo(fundiu.estado === 200, 'as duas contas juntam-se',
    `${fundiu.estado} ${JSON.stringify(fundiu.dados)}`);
  certo(fundiu.dados?.modo === 'absorcao',
    'e o modo DEDUZ-SE: a conta local nunca teve identidade, logo é uma absorção',
    String(fundiu.dados?.modo));

  const depois = linhas(`SELECT programa_id, carimbos, total_carimbos, premios_ganhos
                           FROM cartoes WHERE cliente_id = '${doEmail.id}' ORDER BY programa_id`);
  certo(depois.length === 2, 'a conta que fica passa a ter os dois programas',
    JSON.stringify(depois));
  certo(linhas(`SELECT 1 FROM cartoes WHERE cliente_id = '${local.id}'`).length === 0,
    'e a que sai não fica com nenhum');

  const p1Depois = depois.find((c) => c.programa_id === 'p1');
  certo(p1Depois?.carimbos === 7,
    'O CICLO FICA PELO MAIOR, NUNCA PELA SOMA — somar era pagar a quem andasse com dois números no mesmo café',
    `${p1Depois?.carimbos} (era 3 e 7)`);
  certo(p1Depois?.total_carimbos === 10,
    'mas o total histórico soma-se, que esse não dá prémio nenhum: é memória',
    String(p1Depois?.total_carimbos));

  /* O histórico do cartão que morreu tem de ter mudado de cartão ANTES de a
     linha desaparecer — senão o ON DELETE CASCADE leva anos de visitas à
     frente, e nada o diz. */
  const cartaoP1 = linhas(`SELECT id FROM cartoes
                             WHERE cliente_id = '${doEmail.id}' AND programa_id = 'p1'`)[0]?.id;
  const movimentos = linhas(`SELECT COUNT(*) AS n FROM movimentos
                               WHERE cartao_id = '${cartaoP1}'`)[0]?.n;
  /* NO CARTÃO QUE SOBREVIVEU, e não «na conta»: a primeira versão desta
     afirmação contava os movimentos de TODOS os cartões do destino, e o cartão
     do segundo programa trazia três que chegavam para o total passar o limiar.
     Com o reparenteamento desfeito de propósito, ela continuava verde. São
     4 do cartão que morreu (adesão + 3 carimbos) e 8 do que ficou. */
  certo(movimentos === 12,
    'e o HISTÓRICO do cartão que morreu foi junto, em vez de ser levado pela cascata',
    `${movimentos} movimentos, esperados 12`);

  /* A sombra e a travessia, que é o que a fase 2 deixou pronto. */
  const sombra = linhas(`SELECT fundida_em, chave_versao, email FROM clientes WHERE id = '${local.id}'`)[0];
  certo(sombra?.fundida_em === doEmail.id, 'a conta que sai fica como sombra a apontar para a que fica',
    JSON.stringify(sombra));
  certo(sombra?.chave_versao === 2,
    'e o segredo dela deixa de valer — a subida da versão é a dívida 3.1 a servir para o que foi feita',
    String(sombra?.chave_versao));

  const velho = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(local.publico, local.segredo), programaId: 'p1' } });
  certo(velho.estado === 403, 'o código do ecrã da conta que saiu já não carimba',
    `${velho.estado} ${JSON.stringify(velho.dados)}`);

  const aMao = await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${local.publico}`, programaId: 'p1' } });
  certo(aMao.estado === 200,
    'MAS O NÚMERO ANTIGO ESCRITO À MÃO CONTINUA A CARIMBAR — é a promessa do guardanapo',
    String(aMao.estado));
  certo(linhas(`SELECT cliente_id FROM cartoes WHERE programa_id = 'p1'
                  AND cliente_id = '${doEmail.id}'`).length === 1,
    'e vai parar à conta que ficou');

  /* Numa ABSORÇÃO as sessões da conta que sai MORREM. */
  const sessaoMorta = await pedir('/v1/cliente/cartoes', { sessao: local.sessao });
  certo(sessaoMorta.estado === 401,
    'numa absorção a sessão da conta que sai morre — ela nunca foi provada por ninguém',
    String(sessaoMorta.estado));

  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: doEmail.sessao });
}

grupo('Fundir: o que NÃO pode acontecer');
{
  const criar = async () => {
    const r = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
    return { id: r.dados.cliente.id, publico: r.dados.cliente.publico, sessao: r.dados.sessao };
  };

  /* 1. UMA FUSÃO PROVADA REAPONTA AS SESSÕES, em vez de as matar: as duas
        contas autenticaram-se, e a pessoa continua a andar onde andava. */
  const a = await criar(); const b = await criar();
  for (const [c, morada] of [[a, 'prova-a@exemplo.pt'], [b, 'prova-b@exemplo.pt']]) {
    sql(`DELETE FROM identidades WHERE sujeito = '${morada}'`);
    sql(`INSERT INTO identidades (id, cliente_id, provedor, sujeito, email, relay, criada_em, verificada_em)
         VALUES ('${randomBytes(16).toString('hex')}', '${c.id}', 'email', '${morada}',
                 '${morada}', 0, datetime('now'), datetime('now'))`);
  }
  const provada = await pedir('/v1/cliente/fundir', { metodo: 'POST',
    sessao: b.sessao, corpo: { sessaoOrigem: a.sessao } });
  certo(provada.dados?.modo === 'provada',
    'duas contas com identidade dão uma fusão PROVADA', String(provada.dados?.modo));
  const aindaAnda = await pedir('/v1/cliente/eu', { sessao: a.sessao });
  certo(aindaAnda.estado === 200 && aindaAnda.dados?.cliente?.id === b.id,
    'e a sessão da que saiu passa a abrir a que ficou, em vez de morrer',
    `${aindaAnda.estado} ${aindaAnda.dados?.cliente?.id}`);
  certo(linhas(`SELECT cliente_id FROM identidades WHERE sujeito = 'prova-a@exemplo.pt'`)[0]
        ?.cliente_id === b.id,
    'as formas de entrar mudam de dono — senão entrar pelo email antigo dava uma conta vazia');

  /* 2. OS PRÉMIOS POR LEVANTAR PASSAM, E NÃO SE PERDEM PELO CAMINHO.
        Esteve aqui uma trava — a fusão era recusada se houvesse prémios — e o
        dono decidiu ao contrário: um prémio por levantar é uma dívida do café a
        quem JÁ fez as visitas, e recusar a fusão não a apagava, só obrigava a
        pessoa a ir levantá-lo antes.

        O caminho perigoso é o do cartão que MORRE numa colisão: os prémios
        pendem do cartão, e sem os mudar de cartão antes de a linha
        desaparecer, o ON DELETE CASCADE levava-os à frente — a pessoa perdia
        um café grátis que tinha ganho, sem que nada o dissesse. É isso que
        estas afirmações provam, e por isso os dois lados têm prémio. */
  const c1 = await criar(); const c2 = await criar();
  for (const c of [c1, c2]) {
    await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
      corpo: { codigo: `M1.${c.publico}`, programaId: 'p1' } });
    const cartao = linhas(`SELECT id FROM cartoes WHERE cliente_id = '${c.id}'`)[0].id;
    sql(`INSERT INTO premios (id, cartao_id, descricao, ganho_em)
         VALUES ('${randomBytes(16).toString('hex')}', '${cartao}',
                 'Café grátis de ${c.publico}', datetime('now'))`);
  }
  const comPremios = await pedir('/v1/cliente/fundir', { metodo: 'POST',
    sessao: c2.sessao, corpo: { sessaoOrigem: c1.sessao } });
  certo(comPremios.estado === 200,
    'a fusão já não é travada por haver prémios à espera',
    `${comPremios.estado} ${JSON.stringify(comPremios.dados)}`);

  const premios = linhas(`SELECT pr.descricao FROM premios pr
                            JOIN cartoes k ON k.id = pr.cartao_id
                           WHERE k.cliente_id = '${c2.id}' AND pr.resgatado_em IS NULL`);
  certo(premios.length === 2,
    'OS DOIS PRÉMIOS SOBREVIVEM — o do cartão que morreu mudou de cartão antes de a linha cair',
    JSON.stringify(premios));
  certo(premios.some((p) => p.descricao.includes(c1.publico))
        && premios.some((p) => p.descricao.includes(c2.publico)),
    'e são os dois certos, um de cada lado', JSON.stringify(premios));

  const cartaoFinal = linhas(`SELECT id, premios_ganhos FROM cartoes
                                WHERE cliente_id = '${c2.id}' AND programa_id = 'p1'`);
  certo(cartaoFinal.length === 1,
    'os dois cartões do mesmo programa ficaram um só', JSON.stringify(cartaoFinal));

  /* E o prémio continua a poder ser levantado ao balcão: passar não serve de
     nada se o que passa não funcionar do outro lado. */
  const premioId = linhas(`SELECT pr.id FROM premios pr
                             JOIN cartoes k ON k.id = pr.cartao_id
                            WHERE k.cliente_id = '${c2.id}' AND pr.resgatado_em IS NULL
                            LIMIT 1`)[0].id;
  const resgate = await pedir('/v1/balcao/resgatar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${c2.publico}`, programaId: 'p1', premioId } });
  certo(resgate.estado === 200,
    'e um prémio herdado levanta-se ao balcão como qualquer outro',
    `${resgate.estado} ${JSON.stringify(resgate.dados).slice(0, 110)}`);

  /* 3. Sem a sessão da outra conta não há fusão nenhuma. */
  const d = await criar();
  const semOrigem = await pedir('/v1/cliente/fundir', { metodo: 'POST',
    sessao: d.sessao, corpo: {} });
  certo(semOrigem.estado === 400, 'sem a sessão da outra conta não se funde nada',
    String(semOrigem.estado));
  const inventada = await pedir('/v1/cliente/fundir', { metodo: 'POST',
    sessao: d.sessao, corpo: { sessaoOrigem: 'isto-nao-e-uma-sessao' } });
  certo(inventada.estado === 401,
    'e uma sessão inventada não serve — a prova são as DUAS sessões',
    String(inventada.estado));
  const aSiPropria = await pedir('/v1/cliente/fundir', { metodo: 'POST',
    sessao: d.sessao, corpo: { sessaoOrigem: d.sessao } });
  certo(aSiPropria.estado === 400, 'uma conta não se funde a si própria', String(aSiPropria.estado));

  /* 4. Uma sombra não se volta a fundir: era escrever cadeias de propósito. */
  const e = await criar(); const f = await criar();
  await pedir('/v1/cliente/fundir', { metodo: 'POST', sessao: f.sessao,
    corpo: { sessaoOrigem: e.sessao } });
  const g = await criar();
  /* APAGA-SE ANTES DE INSERIR. O resumo é FIXO — vem da palavra «ressuscitada»
     — e a linha não tem chave estrangeira que a leve quando a conta é apagada.
     Uma segunda corrida sem `--limpo` batia no índice único e o ficheiro
     inteiro morria à entrada, antes de um único teste. */
  sql(`DELETE FROM sessoes WHERE resumo = '${createHash('sha256').update('ressuscitada').digest('hex')}'`);
  sql(`INSERT INTO sessoes (resumo, sujeito, criada_em, expira_em)
       VALUES ('${createHash('sha256').update('ressuscitada').digest('hex')}',
               'cliente:${e.id}', datetime('now'),
               '${new Date(Date.now() + 86400000).toISOString()}')`);
  const outraVez = await pedir('/v1/cliente/fundir', { metodo: 'POST', sessao: g.sessao,
    corpo: { sessaoOrigem: 'ressuscitada' } });
  certo(outraVez.estado === 409 && outraVez.dados?.codigo === 'fusao-sombra',
    'uma sombra não se volta a fundir — era escrever cadeias de propósito',
    `${outraVez.estado} ${JSON.stringify(outraVez.dados)}`);

  /* 5. A CADEIA ACHATA-SE. Se uma sombra apontava para E e o E foi fundido no
        H, a sombra passa a apontar para o H — não para o E. Sem isto cada
        fusão acrescentava um elo, e ao oitavo o número antigo deixava de
        carimbar sem nada que o explicasse. */
  const antiga = await criar();
  sql(`UPDATE clientes SET fundida_em = '${f.id}' WHERE id = '${antiga.id}'`);
  const h = await criar();
  await pedir('/v1/cliente/fundir', { metodo: 'POST', sessao: h.sessao,
    corpo: { sessaoOrigem: f.sessao } });
  certo(linhas(`SELECT fundida_em FROM clientes WHERE id = '${antiga.id}'`)[0]?.fundida_em === h.id,
    'a cadeia achata-se: a sombra antiga passa a apontar para o destino final',
    String(linhas(`SELECT fundida_em FROM clientes WHERE id = '${antiga.id}'`)[0]?.fundida_em));

  sql(`DELETE FROM clientes WHERE id IN ('${[a, b, c1, c2, d, e, f, g, h, antiga]
    .map((r) => r.id).join("','")}')`);
  sql(`DELETE FROM identidades WHERE sujeito LIKE 'prova-%@exemplo.pt'`);
}

grupo('Um prazo ilegível não é um prazo eterno');
{
  /* FALHAVA ABERTO, e descobriu-se por acidente: a preparar um teste contra a
     produção, uma inserção minha escreveu o `expira_em` vazio e a sessão de
     balcão foi aceite na mesma. A razão é que `new Date('')` é `Invalid Date`
     e QUALQUER comparação com ele é falsa — o `expira_em < agora` dava `false`
     e a linha passava por válida. Um prazo que não se lê tornava a credencial
     ETERNA, que é o contrário do que ele existe para fazer.

     O produto escreve sempre um ISO bem formado, por isso não havia nada
     partido no ar. Mas uma guarda que só funciona enquanto os dados estão bons
     não é uma guarda — e as três formas abaixo são as que um dedo trocado numa
     migração, um `datetime()` do SQLite ou um valor em falta produzem. */
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const cid = c.dados.cliente.id;

  for (const [nome, valor] of [
    ['vazio', ''],
    ['texto que não é data', 'para sempre'],
    ['data impossível', '2026-13-45T99:99:99Z'],
  ]) {
    const testemunho = `prazo-${randomBytes(6).toString('hex')}`;
    const r = createHash('sha256').update(testemunho).digest('hex');
    sql(`INSERT INTO sessoes (resumo, sujeito, criada_em, expira_em)
         VALUES ('${r}', 'cliente:${cid}', datetime('now'), '${valor}')`);
    const usou = await pedir('/v1/cliente/eu', { sessao: testemunho });
    certo(usou.estado === 401,
      `uma sessão com prazo ${nome} é recusada — na dúvida, está expirada`,
      `${usou.estado}`);
    sql(`DELETE FROM sessoes WHERE resumo = '${r}'`);
  }

  /* --- A SESSÃO DESLIZA ------------------------------------------------
     Contava 180 dias a partir do dia em que nasceu, e usá-la não a esticava:
     um balcão aberto todos os dias sem falhar um era posto fora ao fim de seis
     meses, a meio de um turno, sem aviso. Não é o que alguém espera de um
     aparelho que vive em cima de um balcão.

     Mede-se com uma sessão a dez dias do fim: um pedido qualquer tem de a
     empurrar outra vez para os 180. */
  const aCaducar = `quase-${randomBytes(6).toString('hex')}`;
  const rc = createHash('sha256').update(aCaducar).digest('hex');
  const dezDias = new Date(Date.now() + 10 * 86400000).toISOString();
  sql(`INSERT INTO sessoes (resumo, sujeito, criada_em, expira_em)
       VALUES ('${rc}', 'cliente:${cid}', datetime('now'), '${dezDias}')`);

  const usou = await pedir('/v1/cliente/eu', { sessao: aCaducar });
  certo(usou.estado === 200, 'a sessão quase a caducar ainda abre', String(usou.estado));

  const depois = linhas(`SELECT expira_em FROM sessoes WHERE resumo = '${rc}'`)[0]?.expira_em;
  const diasQueFaltam = (new Date(depois) - Date.now()) / 86400000;
  certo(diasQueFaltam > 170,
    'USAR A SESSÃO EMPURRA O PRAZO — quem abre o balcão todos os dias não é posto fora ao fim de seis meses',
    `faltavam 10 dias, passaram a faltar ${diasQueFaltam.toFixed(0)}`);

  /* E NÃO ESCREVE A CADA PEDIDO. A renovação custa uma escrita no D1, que tem
     tecto diário e é partilhado com tudo o resto; a condição está dentro do
     UPDATE para só mexer uma vez em cada 24 horas. Um segundo pedido logo a
     seguir não pode mexer em nada. */
  await pedir('/v1/cliente/eu', { sessao: aCaducar });
  const outraVez = linhas(`SELECT expira_em FROM sessoes WHERE resumo = '${rc}'`)[0]?.expira_em;
  certo(outraVez === depois,
    'e o segundo pedido do mesmo dia NÃO volta a escrever — o D1 tem tecto diário',
    `${depois} vs ${outraVez}`);
  sql(`DELETE FROM sessoes WHERE resumo = '${rc}'`);

  /* E a testemunha: um prazo BOM continua a valer. Sem ela, esta secção
     passava na mesma se a guarda tivesse passado a recusar tudo. */
  const bom = `prazo-bom-${randomBytes(6).toString('hex')}`;
  const rb = createHash('sha256').update(bom).digest('hex');
  sql(`INSERT INTO sessoes (resumo, sujeito, criada_em, expira_em)
       VALUES ('${rb}', 'cliente:${cid}', datetime('now'),
               '${new Date(Date.now() + 86400000).toISOString()}')`);
  const valida = await pedir('/v1/cliente/eu', { sessao: bom });
  certo(valida.estado === 200,
    'e uma com prazo bom continua a abrir (senão isto não provava nada)',
    String(valida.estado));

  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: c.dados.sessao });
}

grupo('A alcunha: quem é o UTUEVN?');
{
  /* O PROBLEMA A SÉRIO: o balcão olha para seis caracteres e não faz ideia de
     quem é. A saída fácil era pedir o nome e o telemóvel ao cliente — e essa
     obrigava a consentimento com data guardada, a acordo de responsabilidade
     conjunta com cada café, e a deitar fora a frase «não pedimos nome,
     telefone nem morada», que está publicada em dois sítios.

     A alcunha é escrita pelo CAFÉ e nunca se pede nada a ninguém. O que estas
     afirmações provam é o que a torna aceitável: fica no cartão daquele café e
     não sai de lá, o cliente vê-a, e o cliente pode apagá-la. */
  sql(`UPDATE programas SET arrefecimento = 0, maximo_diario = 0 WHERE id = 'p1'`);
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${c.dados.cliente.publico}`, programaId: 'p1' } });
  const lista = await pedir('/v1/balcao/clientes', { sessao: sessaoBalcao });
  const meu = lista.dados.find((x) => x.publico === c.dados.cliente.publico);
  certo(!!meu?.id,
    'a lista do balcão passa a trazer o id do CARTÃO — sem ele não há por onde escrever nada',
    JSON.stringify(meu)?.slice(0, 90));
  certo(meu?.alcunha === null, 'e a alcunha começa vazia');

  const posta = await pedir(`/v1/balcao/cartoes/${meu.id}/alcunha`, {
    metodo: 'PUT', sessao: sessaoBalcao, corpo: { alcunha: 'a Joana da manhã' } });
  certo(posta.estado === 200 && posta.dados?.alcunha === 'a Joana da manhã',
    'o balcão escreve como trata este cliente', JSON.stringify(posta.dados));

  const outraVez = await pedir('/v1/balcao/clientes', { sessao: sessaoBalcao });
  certo(outraVez.dados.find((x) => x.id === meu.id)?.alcunha === 'a Joana da manhã',
    'e passa a vê-la na lista — é isto que responde a «quem é o UTUEVN?»');

  /* O CLIENTE VÊ-A. Uma nota sobre uma pessoa que ela não pode ler é o
     contrário do que este produto diz ser, e o art. 15.º não é opcional. */
  const meus = await pedir('/v1/cliente/cartoes', { sessao: c.dados.sessao });
  certo(meus.dados[0]?.alcunha === 'a Joana da manhã',
    'O CLIENTE VÊ a alcunha que lhe puseram — sem isso era uma nota às escondidas',
    JSON.stringify(meus.dados[0]?.alcunha));

  const dados = await pedir('/v1/cliente/dados', { sessao: c.dados.sessao });
  certo(JSON.stringify(dados.dados).includes('a Joana da manhã'),
    'e ela sai na exportação do artigo 20.º, como todo o resto');

  /* E PODE APAGÁ-LA, sem apagar mais nada. */
  const tirou = await pedir(`/v1/cliente/cartoes/${meu.id}/alcunha`, {
    metodo: 'DELETE', sessao: c.dados.sessao });
  certo(tirou.estado === 200, 'o cliente pode tirá-la', String(tirou.estado));
  const depois = await pedir('/v1/cliente/cartoes', { sessao: c.dados.sessao });
  certo(depois.dados[0]?.alcunha === null, 'e ela desaparece');
  certo(depois.dados[0]?.carimbos === 1,
    'e MAIS NADA se mexe — o carimbo continua lá', String(depois.dados[0]?.carimbos));

  /* UM CAFÉ NÃO ESCREVE NO CARTÃO DE OUTRO. É o `negocio_id` na condição que o
     impede, e sem ele bastava adivinhar um identificador.

     O CARTÃO ALHEIO CONSTRÓI-SE AQUI, e não se procura na base. A primeira
     versão fazia `SELECT ... WHERE negocio_id != 'n1' LIMIT 1` e punha as duas
     afirmações dentro de um `if`: numa base limpa não há segundo negócio, o
     `if` não corria, e as duas afirmações DESAPARECIAM em silêncio — sem um
     ✗, sem um aviso, e sem ninguém dar por isso. Apanhou-se a provar a
     vermelho: quebrei o `negocio_id` das duas rotas de propósito e estas duas
     continuaram verdes. São as afirmações de segurança do grupo; eram as duas
     que não estavam a correr. */
  sql(`INSERT OR IGNORE INTO negocios (id, slug, nome, cor, localidade, criado_em)
       VALUES ('n-alheio', 'outro-cafe', 'Café Alheio', '#333333', 'Aveiro', datetime('now'))`);
  sql(`INSERT OR IGNORE INTO programas (id, negocio_id, nome, premio, objetivo, criado_em)
       VALUES ('p-alheio', 'n-alheio', 'Cartão alheio', 'Um bolo', 10, datetime('now'))`);
  const idAlheio = randomBytes(16).toString('hex');
  sql(`INSERT INTO cartoes (id, cliente_id, programa_id, negocio_id, aderiu_em)
       VALUES ('${idAlheio}', '${c.dados.cliente.id}', 'p-alheio', 'n-alheio', datetime('now'))`);

  const intruso = await pedir(`/v1/balcao/cartoes/${idAlheio}/alcunha`, {
    metodo: 'PUT', sessao: sessaoBalcao, corpo: { alcunha: 'não devia entrar' } });
  certo(intruso.estado === 404,
    'UM BALCÃO NÃO ESCREVE no cartão de outro café', String(intruso.estado));
  certo(linhas(`SELECT alcunha FROM cartoes WHERE id = '${idAlheio}'`)[0]?.alcunha === null,
    'e o cartão alheio fica intacto');

  const espreitar = await pedir(`/v1/balcao/cartoes/${idAlheio}/historico`, { sessao: sessaoBalcao });
  certo(espreitar.estado === 404,
    'UM BALCÃO NÃO VÊ o histórico de um cartão de outro café', String(espreitar.estado));

  /* SESSENTA CARACTERES, e não uma ficha de cliente. */
  await pedir(`/v1/balcao/cartoes/${meu.id}/alcunha`, { metodo: 'PUT', sessao: sessaoBalcao,
    corpo: { alcunha: 'x'.repeat(300) } });
  const cortada = linhas(`SELECT alcunha FROM cartoes WHERE id = '${meu.id}'`)[0]?.alcunha;
  certo(cortada?.length === 60,
    'a alcunha é cortada aos 60 — chega para «a Joana da manhã» e não para uma ficha clínica',
    `${cortada?.length} caracteres`);

  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: c.dados.sessao });
}

grupo('O histórico do cartão, visto pelo balcão');
{
  /* O único dos três pedidos que não recolhe nada de novo: são os movimentos
     do programa do próprio café, sobre o cartão dele. */
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  for (let i = 0; i < 3; i++) {
    await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
      corpo: { codigo: `M1.${c.dados.cliente.publico}`, programaId: 'p1' } });
  }
  const lista = await pedir('/v1/balcao/clientes', { sessao: sessaoBalcao });
  const cartaoId = lista.dados.find((x) => x.publico === c.dados.cliente.publico)?.id;

  const h = await pedir(`/v1/balcao/cartoes/${cartaoId}/historico`, { sessao: sessaoBalcao });
  certo(h.estado === 200, 'o balcão vê o histórico do cartão', String(h.estado));
  certo(h.dados?.cartao?.publico === c.dados.cliente.publico,
    'com o cartão certo', String(h.dados?.cartao?.publico));
  certo(h.dados?.movimentos?.length >= 4,
    'e os movimentos todos — a adesão e os três carimbos',
    `${h.dados?.movimentos?.length} movimentos`);
  certo(h.dados.movimentos.every((m) => 'manual' in m && 'operador' in m),
    'com o `manual` e o `operador`, que estão gravados desde sempre e nunca foram mostrados',
    JSON.stringify(h.dados.movimentos[0]));
  certo(h.dados.movimentos[0].manual === true,
    'e o `manual` diz a verdade: estes entraram pelo número escrito à mão',
    JSON.stringify(h.dados.movimentos[0]));

  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: c.dados.sessao });
}

grupo('Sair de um café, tirar o email, expulsar um balcão');
{
  /* TRÊS BURACOS QUE A ALCUNHA TORNOU URGENTES. Enquanto a lista do balcão era
     anónima quase não mordiam; com o nome por que o café trata cada pessoa lá
     dentro, mordem. */
  sql(`UPDATE programas SET arrefecimento = 0, maximo_diario = 0 WHERE id = 'p1'`);

  /* --- 1. SAIR DE UM CAFÉ, sem apagar a conta ------------------------- */
  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  await pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: `M1.${c.dados.cliente.publico}`, programaId: 'p1' } });
  /* Um segundo cartão, noutro café: é ele que prova que sair de um não leva o
     outro à frente — que era exactamente o preço que a única rota DELETE
     cobrava. */
  sql(`INSERT OR IGNORE INTO negocios (id, slug, nome, cor, localidade, criado_em)
       VALUES ('n-vizinho', 'padaria', 'Padaria ao Lado', '#884400', 'Ovar', datetime('now'))`);
  sql(`INSERT OR IGNORE INTO programas (id, negocio_id, nome, premio, objetivo, criado_em)
       VALUES ('p-vizinho', 'n-vizinho', 'Cartão da padaria', 'Um pão', 10, datetime('now'))`);
  const outroId = randomBytes(16).toString('hex');
  sql(`INSERT INTO cartoes (id, cliente_id, programa_id, negocio_id, carimbos, aderiu_em)
       VALUES ('${outroId}', '${c.dados.cliente.id}', 'p-vizinho', 'n-vizinho', 9, datetime('now'))`);

  const meus = await pedir('/v1/cliente/cartoes', { sessao: c.dados.sessao });
  certo(meus.dados.length === 2, 'a pessoa tem dois cartões, em dois cafés',
    `${meus.dados.length}`);
  const doCafe = meus.dados.find((x) => x.negocio.id === 'n1');

  const largou = await pedir(`/v1/cliente/cartoes/${doCafe.id}`, {
    metodo: 'DELETE', sessao: c.dados.sessao });
  certo(largou.estado === 200, 'sai-se de UM café', String(largou.estado));

  const sobra = await pedir('/v1/cliente/cartoes', { sessao: c.dados.sessao });
  certo(sobra.dados.length === 1 && sobra.dados[0].id === outroId,
    'E OS OUTROS CARTÕES FICAM — era este o preço que a rota única cobrava',
    JSON.stringify(sobra.dados.map((x) => x.negocio.nome)));
  certo(sobra.dados[0].carimbos === 9,
    'com os carimbos intactos', String(sobra.dados[0].carimbos));

  const naLista = await pedir('/v1/balcao/clientes', { sessao: sessaoBalcao });
  certo(!naLista.dados.some((x) => x.publico === c.dados.cliente.publico),
    'e o café deixa de a ver na lista, que é o que ela foi lá fazer');
  certo(linhas(`SELECT 1 FROM movimentos WHERE cartao_id = '${doCafe.id}'`).length === 0,
    'o histórico daquele cartão vai com ele — o café perde-o, e os dados eram dela');

  const alheio = await pedir(`/v1/cliente/cartoes/${outroId}`, {
    metodo: 'DELETE', sessao: (await pedir('/v1/cliente/registar',
      { metodo: 'POST', corpo: {} })).dados.sessao });
  certo(alheio.estado === 404,
    'e NÃO se larga o cartão de outra pessoa', String(alheio.estado));

  /* --- 2. TIRAR O EMAIL, e mais nada ---------------------------------- */
  const correio = 'sair-do-email@exemplo.pt';
  sql(`DELETE FROM entradas`); sql(`DELETE FROM envios`);
  sql(`DELETE FROM identidades WHERE sujeito = '${correio}'`);
  sql(`UPDATE clientes SET email = NULL, email_verificado = 0 WHERE email = '${correio}'`);
  const r = createHash('sha256').update(`${correio}|111111`).digest('hex');
  sql(`INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em)
       VALUES ('${r}', 'cliente:${c.dados.cliente.id}', '${correio}', datetime('now'),
               '${new Date(Date.now() + 600000).toISOString()}')`);
  await pedir('/v1/cliente/entrar', { metodo: 'POST', corpo: { email: correio, codigo: '111111' } });

  certo(linhas(`SELECT 1 FROM identidades WHERE sujeito = '${correio}'`).length === 1,
    'a morada está guardada (o teste é válido)');

  const tirou = await pedir('/v1/cliente/email', { metodo: 'DELETE', sessao: c.dados.sessao });
  certo(tirou.estado === 200, 'TIRA-SE O EMAIL sozinho', String(tirou.estado));
  certo(linhas(`SELECT 1 FROM identidades WHERE sujeito = '${correio}'`).length === 0,
    'sai da identidade, que é quem manda desde a migração 009');
  const espelho = linhas(`SELECT email, email_verificado FROM clientes
                            WHERE id = '${c.dados.cliente.id}'`)[0];
  certo(espelho?.email === null && espelho?.email_verificado === 0,
    'e do espelho, que a app nos telemóveis ainda lê', JSON.stringify(espelho));
  const aindaLa = await pedir('/v1/cliente/cartoes', { sessao: c.dados.sessao });
  certo(aindaLa.dados.length === 1,
    'E OS CARTÕES FICAM — dar era um código de seis algarismos, tirar não pode custar a conta');

  /* E a morada fica livre para outra conta, que é a prova de que saiu mesmo. */
  const novo = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  sql(`DELETE FROM entradas`);
  const r2 = createHash('sha256').update(`${correio}|222222`).digest('hex');
  sql(`INSERT INTO entradas (resumo, alvo, email, criada_em, expira_em)
       VALUES ('${r2}', 'cliente:${novo.dados.cliente.id}', '${correio}', datetime('now'),
               '${new Date(Date.now() + 600000).toISOString()}')`);
  const outraPessoa = await pedir('/v1/cliente/entrar',
    { metodo: 'POST', corpo: { email: correio, codigo: '222222' } });
  certo(outraPessoa.estado === 200 && outraPessoa.dados.cliente.id === novo.dados.cliente.id,
    'e a morada fica mesmo livre — não ficou presa a uma conta que já não a quer');

  /* --- 3. EXPULSAR UM BALCÃO PERDIDO ---------------------------------- */
  /* Uma segunda sessão do mesmo operador, como a de um telemóvel esquecido. */
  const perdida = `balcao-perdido-${randomBytes(6).toString('hex')}`;
  const rp = createHash('sha256').update(perdida).digest('hex');
  sql(`INSERT INTO sessoes (resumo, sujeito, criada_em, expira_em)
       VALUES ('${rp}', 'operador:o1', datetime('now'),
               '${new Date(Date.now() + 86400000).toISOString()}')`);
  const antes = await pedir('/v1/balcao/resumo', { sessao: perdida });
  certo(antes.estado === 200, 'o balcão perdido abre (o teste é válido)', String(antes.estado));

  const expulsou = await pedir('/v1/balcao/sair-dos-outros', { metodo: 'POST', sessao: sessaoBalcao });
  certo(expulsou.estado === 200, 'o balcão manda expulsar os outros aparelhos',
    JSON.stringify(expulsou.dados));

  const depois = await pedir('/v1/balcao/resumo', { sessao: perdida });
  certo(depois.estado === 401,
    'O BALCÃO PERDIDO FECHA-SE — com a alcunha lá dentro, isto deixou de ser um pormenor',
    String(depois.estado));
  const eu = await pedir('/v1/balcao/resumo', { sessao: sessaoBalcao });
  certo(eu.estado === 200,
    'e quem carregou no botão NÃO se expulsa a si próprio', String(eu.estado));
  certo(linhas(`SELECT 1 FROM entradas WHERE alvo LIKE 'operador:%'`).length === 0,
    'e os códigos de entrada por usar morrem com ele — eram uma segunda chave deixada para trás');

  sql(`DELETE FROM clientes WHERE id IN ('${c.dados.cliente.id}','${novo.dados.cliente.id}')`);
}

grupo('Entrar com a Google');
{
  /* Isto corre contra uma Google DE MENTIRA (`scripts/google-de-mentira.mjs`),
     que serve o ecrã de consentimento e troca o código por um `id_token`. O
     que ela NÃO prova é a assinatura desse token — e isso é de propósito: o
     Worker também não a verifica, porque o token vem por TLS directamente do
     endereço de troca e o OIDC Core §3.1.3.7 permite trocar uma validação pela
     outra. Fica dito em vez de fingido.

     A ORIGEM VAI EM TODOS OS PEDIDOS. O `comecar` constrói o endereço de volta
     a partir dela e recusa quem não a mande — com a lista de origens vazia, que
     é o que o desenvolvimento tem, só o localhost passa. */
  const GOOGLE = 'http://localhost:8799';
  const ORIGEM = { origin: 'http://localhost:4321', 'cf-connecting-ip': '198.51.100.77' };
  const criados = [];

  /* A trava das idas conta na mesma tabela dos registos, noutro espaço. Limpa-se
     para o tecto de 30/hora não apanhar esta bateria pelo caminho. */
  sql(`DELETE FROM registos`);

  const comecar = (sessao) => pedir('/v1/cliente/google/comecar',
    { metodo: 'POST', corpo: {}, sessao, cabecalhos: ORIGEM });
  const voltar = (corpo) => pedir('/v1/cliente/google/volta',
    { metodo: 'POST', corpo, cabecalhos: ORIGEM });
  const levantar = (bilhete) => pedir('/v1/cliente/google/estado',
    { metodo: 'POST', corpo: { bilhete }, cabecalhos: ORIGEM });

  /** Faz o papel do browser: abre o consentimento, escolhe a conta, e volta. */
  async function passarPelaGoogle(url, email) {
    const pagina = await fetch(url);
    const html = await pagina.text();
    const codigo = html.match(/name="redireccao" value="([^"]+)"/)[1];
    const estadoForm = html.match(/name="estado" value="([^"]+)"/)[1];
    const r = await fetch(`${GOOGLE}/o/oauth2/v2/aprovar`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ redireccao: codigo, estado: estadoForm, decisao: 'sim', email }),
    });
    const destino = new URL(r.headers.get('location'));
    return { codigo: destino.searchParams.get('code'), estado: destino.searchParams.get('state') };
  }

  const ultimaLigacao = () => linhas(
    `SELECT id, nonce, erro, concluida_em, cliente_id, pista, entregues
       FROM ligacoes ORDER BY criada_em DESC, rowid DESC LIMIT 1`)[0];

  /* --- 1. A PORTA ANUNCIA-SE ------------------------------------------- */
  const portas = await pedir('/v1/portas', { cabecalhos: ORIGEM });
  certo(portas.estado === 200 && portas.dados.google === true,
    'o servidor diz que a porta da Google está aberta — um botão não se adivinha',
    JSON.stringify(portas.dados));
  certo(typeof portas.dados.apple === 'boolean',
    'e responde também pela da Apple, em vez de calar o campo',
    String(portas.dados.apple));

  /* --- 2. A IDA LEVA O QUE TEM DE LEVAR --------------------------------- */
  const ida = await comecar();
  certo(ida.estado === 200 && ida.dados.url && ida.dados.bilhete,
    'a ida devolve o endereço da Google e um bilhete', JSON.stringify(ida.dados).slice(0, 120));
  const url = new URL(ida.dados.url);
  certo(url.searchParams.get('scope') === 'openid email',
    'o âmbito é `openid email` e mais nada — sem `profile` não vem nome nenhum',
    url.searchParams.get('scope'));
  certo(url.searchParams.get('code_challenge_method') === 'S256'
    && (url.searchParams.get('code_challenge') || '').length > 20,
    'vai com PKCE (RFC 7636)');
  certo(url.searchParams.get('prompt') === 'select_account',
    'pergunta sempre qual é a conta — entrar na errada é uma conta duplicada');
  certo(url.searchParams.get('redirect_uri') === 'http://localhost:4321/app/',
    'a volta aterra DENTRO do âmbito da app: fora dele, um iPhone abre o Safari e não volta',
    url.searchParams.get('redirect_uri'));
  certo(!url.searchParams.has('access_type'),
    'e não pede acesso em diferido — um `refresh_token` era uma credencial de longa duração à toa');

  /* --- 3. O ATAQUE DO LINK, que é o que o bilhete existe para fechar ---- */
  const volta1 = await passarPelaGoogle(ida.dados.url, 'pessoa.a@gmail.com');
  const semBilhete = await voltar({ estado: volta1.estado, codigo: volta1.codigo });
  certo(semBilhete.estado === 403,
    'SEM BILHETE NÃO SE CONCLUI — senão, quem me mandasse o endereço da ida levava a minha conta',
    String(semBilhete.estado));

  const outraIda = await comecar();
  const trocado = await voltar({
    estado: volta1.estado, codigo: volta1.codigo, bilhete: outraIda.dados.bilhete });
  certo(trocado.estado === 403,
    'e o bilhete de OUTRA ligação também não serve — é o bilhete daquela ida ou nenhum',
    String(trocado.estado));

  /* --- 4. O CAMINHO NORMAL --------------------------------------------- */
  const feito = await voltar({ ...volta1, bilhete: ida.dados.bilhete });
  certo(feito.estado === 200 && feito.dados.ok === true,
    'com o bilhete certo, a volta conclui', JSON.stringify(feito.dados));
  certo(!('sessao' in (feito.dados || {})) && !('segredo' in (feito.dados || {})),
    'e NÃO devolve credencial nenhuma — quem levanta é o bilhete, na rota seguinte');

  const repetida = await voltar({ ...volta1, bilhete: ida.dados.bilhete });
  certo(repetida.estado === 409,
    'o mesmo estado não serve duas vezes — um recarregar da página não dá duas trocas',
    String(repetida.estado));

  const levantado = await levantar(ida.dados.bilhete);
  certo(levantado.dados.situacao === 'pronta', 'o bilhete levanta a entrada feita',
    JSON.stringify(levantado.dados).slice(0, 120));
  certo(Boolean(levantado.dados.sessao && levantado.dados.segredo
    && levantado.dados.cliente?.publico),
    'e traz sessão, segredo e número de cartão — a mesma forma que `/v1/cliente/entrar`');
  const contaA = levantado.dados.cliente.id;
  const sessaoA = levantado.dados.sessao;
  criados.push(contaA);

  const outraVez = await levantar(ida.dados.bilhete);
  certo(outraVez.dados.situacao === 'expirada',
    'O BILHETE SERVE UMA VEZ. Cada levantamento cunha uma sessão de 180 dias; três davam três');

  const identidade = linhas(
    `SELECT provedor, sujeito, email FROM identidades WHERE cliente_id = '${contaA}'`);
  certo(identidade.length === 1 && identidade[0].provedor === 'google',
    'ficou uma identidade `google` colada à conta');
  certo(identidade[0].sujeito !== 'pessoa.a@gmail.com' && identidade[0].sujeito.startsWith('sub-'),
    'e o que decide é o `sub`, NUNCA a morada', identidade[0].sujeito);
  certo(identidade[0].email === 'pessoa.a@gmail.com',
    'a morada fica como pista, para lhe podermos escrever');
  certo(linhas(`SELECT email FROM clientes WHERE id = '${contaA}'`)[0].email === null,
    'e o espelho `clientes.email` fica a NULL — uma morada da Google não decide de quem é a conta');

  /* --- 5. O PKCE FOI MESMO USADO --------------------------------------- */
  {
    const visto = await (await fetch(`${GOOGLE}/__visto`)).json();
    const troca = visto.filter((v) => v.caminho === '/token' && /authorization_code/.test(v.bruto || '')).pop();
    certo(Boolean(troca && /code_verifier=/.test(troca.bruto)),
      'a troca do código levou o `code_verifier` — o PKCE está ligado e não só escrito no endereço');
    certo(Boolean(troca && /client_secret=/.test(troca.bruto)),
      'e levou o segredo do cliente, que é o que faz este caminho ser servidor-a-servidor');
  }

  /* --- 6. A MESMA PESSOA, OUTRO APARELHO ------------------------------- */
  const ida2 = await comecar();
  const volta2 = await passarPelaGoogle(ida2.dados.url, 'pessoa.a@gmail.com');
  await voltar({ ...volta2, bilhete: ida2.dados.bilhete });
  const lev2 = await levantar(ida2.dados.bilhete);
  certo(lev2.dados.cliente.id === contaA,
    'a mesma conta Google entra sempre na mesma conta nossa, venha de onde vier');

  /* --- 7. COM SESSÃO, A IDENTIDADE COLA-SE À CONTA QUE JÁ EXISTE -------- */
  const local = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {}, cabecalhos: ORIGEM });
  criados.push(local.dados.cliente.id);
  const ida3 = await comecar(local.dados.sessao);
  const volta3 = await passarPelaGoogle(ida3.dados.url, 'pessoa.b@gmail.com');
  await voltar({ ...volta3, bilhete: ida3.dados.bilhete });
  const lev3 = await levantar(ida3.dados.bilhete);
  certo(lev3.dados.cliente.id === local.dados.cliente.id,
    'com sessão provada, a identidade nova cola-se à conta que pediu — não nasce outra');
  certo(lev3.dados.recuperada === false, 'e não é recuperação nenhuma');

  /* --- 8. COM SESSÃO, MAS O `sub` JÁ É DE OUTRA CONTA ------------------ */
  const local2 = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {}, cabecalhos: ORIGEM });
  criados.push(local2.dados.cliente.id);
  const ida4 = await comecar(local2.dados.sessao);
  const volta4 = await passarPelaGoogle(ida4.dados.url, 'pessoa.a@gmail.com');
  await voltar({ ...volta4, bilhete: ida4.dados.bilhete });
  const lev4 = await levantar(ida4.dados.bilhete);
  certo(lev4.dados.cliente.id === contaA,
    'quando o `sub` já é de outra conta, entra-se NESSA — e não se junta nada sozinho');
  certo(lev4.dados.recuperada === true,
    'e diz-se que é recuperação, para a app poder oferecer juntar as duas');
  certo(linhas(`SELECT COUNT(*) AS n FROM cartoes WHERE cliente_id = '${local2.dados.cliente.id}'`)[0].n === 0
    && linhas(`SELECT COUNT(*) AS n FROM clientes WHERE id = '${local2.dados.cliente.id}'`)[0].n === 1,
    'a conta que ficou para trás NÃO se apaga — os cartões dela continuam a existir para serem juntados');

  /* --- 9. UMA SESSÃO DE BALCÃO NÃO É UMA CONTA DE CLIENTE --------------- */
  {
    const doBalcao = `balcao-na-google-${randomBytes(6).toString('hex')}`;
    const rb = createHash('sha256').update(doBalcao).digest('hex');
    sql(`INSERT INTO sessoes (resumo, sujeito, criada_em, expira_em)
         VALUES ('${rb}', 'operador:o1', datetime('now'),
                 '${new Date(Date.now() + 86400000).toISOString()}')`);
    const ida5 = await comecar(doBalcao);
    const volta5 = await passarPelaGoogle(ida5.dados.url, 'pessoa.c@gmail.com');
    await voltar({ ...volta5, bilhete: ida5.dados.bilhete });
    const lev5 = await levantar(ida5.dados.bilhete);
    certo(lev5.dados.situacao === 'pronta' && lev5.dados.cliente.id !== 'o1',
      'uma sessão de balcão vale por «sem sessão»: nasce conta de cliente, e nada se cola ao operador');
    criados.push(lev5.dados.cliente.id);
    sql(`DELETE FROM sessoes WHERE resumo = '${rb}'`);
  }

  /* --- 10. A PESSOA CARREGA EM CANCELAR -------------------------------- */
  {
    const ida6 = await comecar();
    const r = await voltar({ estado: (new URL(ida6.dados.url)).searchParams.get('state'),
      bilhete: ida6.dados.bilhete, erro: 'access_denied' });
    certo(r.estado === 200 && r.dados.ok === false && r.dados.codigo === 'porta-recusou',
      'cancelar na Google é um caminho normal e chega cá', JSON.stringify(r.dados));
    const lev = await levantar(ida6.dados.bilhete);
    certo(lev.dados.situacao === 'erro' && lev.dados.codigo === 'porta-recusou',
      'e a app fica a saber porquê, em vez de sondar para sempre', JSON.stringify(lev.dados));
  }

  /* --- 11. A GOOGLE TEM UM MAU DIA ------------------------------------- */
  {
    const contasAntes = linhas(`SELECT COUNT(*) AS n FROM clientes`)[0].n;
    const ida7 = await comecar();
    const volta7 = await passarPelaGoogle(ida7.dados.url, 'pessoa.d@gmail.com');
    await fetch(`${GOOGLE}/__avariar?n=1`, { method: 'POST' });
    const r = await voltar({ ...volta7, bilhete: ida7.dados.bilhete });
    certo(r.estado === 502 && r.dados.codigo === 'porta-falhou',
      'a Google a responder 500 dá um erro que se explica, e não um 500 nosso',
      JSON.stringify(r.dados));
    const lev = await levantar(ida7.dados.bilhete);
    certo(lev.dados.situacao === 'erro',
      'e fica anotado na ligação, para a app não ficar à espera do que não vem');
    certo(linhas(`SELECT COUNT(*) AS n FROM clientes`)[0].n === contasAntes,
      'e NÃO nasceu conta nenhuma — um mau dia deles não deixa contas-fantasma cá');
  }

  /* --- 12. O `id_token` TEM DE SER PARA NÓS E PARA ESTA IDA ------------- */
  {
    /* O destinatário errado. Muda-se o `client_id` no endereço: a Google de
       mentira devolve um token para outro, e esse não serve aqui. */
    const ida8 = await comecar();
    const torto = new URL(ida8.dados.url);
    torto.searchParams.set('client_id', 'de-outra-pessoa.apps.googleusercontent.com');
    const volta8 = await passarPelaGoogle(torto.toString(), 'pessoa.e@gmail.com');
    const r = await voltar({ ...volta8, bilhete: ida8.dados.bilhete });
    certo(r.estado === 502 && r.dados.codigo === 'porta-falhou',
      'um `id_token` emitido para outro destinatário é recusado', JSON.stringify(r.dados));
  }
  {
    /* O `nonce` errado. Troca-se o que está guardado: o token vem com o da ida
       e deixa de bater certo. Sem esta verificação, um token legítimo obtido
       noutro sítio servia aqui. */
    const ida9 = await comecar();
    const volta9 = await passarPelaGoogle(ida9.dados.url, 'pessoa.f@gmail.com');
    sql(`UPDATE ligacoes SET nonce = 'outro-qualquer' WHERE id = '${ultimaLigacao().id}'`);
    const r = await voltar({ ...volta9, bilhete: ida9.dados.bilhete });
    certo(r.estado === 502 && r.dados.codigo === 'porta-falhou',
      'um `id_token` que responde a outra ida é recusado (o `nonce`)', JSON.stringify(r.dados));
  }

  /* --- 13. PRAZOS ------------------------------------------------------ */
  {
    const ida10 = await comecar();
    const volta10 = await passarPelaGoogle(ida10.dados.url, 'pessoa.g@gmail.com');
    sql(`UPDATE ligacoes SET expira_em = '2020-01-01T00:00:00.000Z' WHERE id = '${ultimaLigacao().id}'`);
    const r = await voltar({ ...volta10, bilhete: ida10.dados.bilhete });
    certo(r.estado === 410 && r.dados.codigo === 'ligacao-expirada',
      'uma ida que passou do prazo não se conclui', JSON.stringify(r.dados));
  }
  {
    const r = await levantar('um-bilhete-que-nunca-existiu');
    certo(r.estado === 200 && r.dados.situacao === 'expirada',
      'um bilhete desconhecido é «expirada» e não um erro — não há aqui oráculo nenhum',
      JSON.stringify(r.dados));
  }

  /* --- 14. A PISTA DA MORADA IGUAL ------------------------------------- */
  {
    /* Uma conta que já provou a morada pela porta do email. */
    const doEmail = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {}, cabecalhos: ORIGEM });
    criados.push(doEmail.dados.cliente.id);
    sql(`INSERT INTO identidades (id, cliente_id, provedor, sujeito, email, relay, criada_em, verificada_em)
         VALUES ('${randomBytes(8).toString('hex')}', '${doEmail.dados.cliente.id}', 'email',
                 'mesma.morada@gmail.com', 'mesma.morada@gmail.com', 0,
                 datetime('now'), datetime('now'))`);
    const ida11 = await comecar();
    const volta11 = await passarPelaGoogle(ida11.dados.url, 'mesma.morada@gmail.com');
    await voltar({ ...volta11, bilhete: ida11.dados.bilhete });
    const lev = await levantar(ida11.dados.bilhete);
    certo(lev.dados.cliente.id !== doEmail.dados.cliente.id,
      'a mesma morada por outra porta NÃO dá a mesma conta — é o pré-registo que isto impede');
    certo(lev.dados.pista === 'mesma-morada',
      'mas diz-se, senão a pessoa lê uma conta vazia como «perdi os cartões»',
      JSON.stringify(lev.dados.pista));
    criados.push(lev.dados.cliente.id);
  }

  /* --- 15. A LIMPEZA DA MADRUGADA -------------------------------------- */
  {
    const viva = await comecar();
    const idViva = ultimaLigacao().id;
    sql(`INSERT INTO ligacoes (id, provedor, estado_resumo, bilhete_resumo, verificador, nonce,
                               redireccao, criada_em, expira_em)
         VALUES ('velha-de-teste', 'google', 'r-velha', 'b-velha', 'v', 'n',
                 'http://localhost:4321/app/', '2020-01-01T00:00:00.000Z',
                 '2020-01-01T00:10:00.000Z')`);
    await pedir('/__scheduled?cron=17+4+*+*+*');
    certo(linhas(`SELECT COUNT(*) AS n FROM ligacoes WHERE id = 'velha-de-teste'`)[0].n === 0,
      'a limpeza da madrugada leva as idas que passaram do prazo');
    certo(linhas(`SELECT COUNT(*) AS n FROM ligacoes WHERE id = '${idViva}'`)[0].n === 1,
      'e NÃO toca numa que esteja a decorrer — cortava o chão a quem está a entrar');
    certo(Boolean(viva.dados.bilhete), 'a ida viva existiu mesmo (o teste é válido)');
  }

  /* --- 16. DESLIGAR, E APAGAR ------------------------------------------ */
  {
    const eu = await pedir('/v1/cliente/eu', { sessao: sessaoA, cabecalhos: ORIGEM });
    certo(eu.dados.identidades.some((i) => i.provedor === 'google'),
      'o `/v1/cliente/eu` mostra por onde é que se entrou');
    certo(!JSON.stringify(eu.dados.identidades).includes('sub-'),
      'e NÃO mostra o `sub` — não serve para nada do lado do ecrã');

    const fora = await pedir('/v1/cliente/identidades/google',
      { metodo: 'DELETE', sessao: sessaoA, cabecalhos: ORIGEM });
    certo(fora.estado === 200 && !fora.dados.identidades.some((i) => i.provedor === 'google'),
      'desligar a conta Google é um toque, como ligá-la foi (art. 7.º/3 do RGPD)',
      JSON.stringify(fora.dados));
    certo(linhas(`SELECT COUNT(*) AS n FROM identidades
                   WHERE cliente_id = '${contaA}' AND provedor = 'google'`)[0].n === 0,
      'e a identidade sai mesmo da base de dados');
  }
  {
    /* Apagar a conta leva as idas a meio que lhe pertenciam. Sem chave
       estrangeira ninguém as levava atrás: a linha nasce antes de se saber de
       que conta é. */
    const aApagar = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {}, cabecalhos: ORIGEM });
    const idaX = await comecar(aApagar.dados.sessao);
    const voltaX = await passarPelaGoogle(idaX.dados.url, 'a.apagar@gmail.com');
    await voltar({ ...voltaX, bilhete: idaX.dados.bilhete });
    await levantar(idaX.dados.bilhete);
    const quantas = linhas(
      `SELECT COUNT(*) AS n FROM ligacoes WHERE cliente_id = '${aApagar.dados.cliente.id}'`)[0].n;
    certo(quantas >= 1, 'a ida ficou ligada à conta (o teste é válido)', String(quantas));
    await pedir('/v1/cliente', { metodo: 'DELETE', sessao: aApagar.dados.sessao, cabecalhos: ORIGEM });
    certo(linhas(
      `SELECT COUNT(*) AS n FROM ligacoes WHERE cliente_id = '${aApagar.dados.cliente.id}'`)[0].n === 0,
      'apagar a conta leva as idas a meio — são dados de quem pediu para desaparecer');
    certo(linhas(
      `SELECT COUNT(*) AS n FROM identidades WHERE sujeito LIKE 'sub-%'
        AND cliente_id = '${aApagar.dados.cliente.id}'`)[0].n === 0,
      'e a identidade também, libertando o `sub` para uma conta nova');
  }

  /* --- 17. A TRAVA, E O QUE ELA CONTA EM IPv6 -------------------------- */
  {
    sql(`DELETE FROM registos`);
    /* Dois endereços do MESMO /64 — que é o que uma casa recebe inteiro, e o
       que um telemóvel troca a cada pedido por causa das extensões de
       privacidade. Contar o /128 era escrever uma trava que não trava. */
    const casa1 = { origin: 'http://localhost:4321', 'cf-connecting-ip': '2001:db8:abcd:1234::1' };
    const casa2 = { origin: 'http://localhost:4321', 'cf-connecting-ip': '2001:db8:abcd:1234:aaaa:bbbb:cccc:dddd' };
    const vizinho = { origin: 'http://localhost:4321', 'cf-connecting-ip': '2001:db8:abcd:9999::1' };
    await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {}, cabecalhos: casa1 });
    await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {}, cabecalhos: casa2 });
    await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {}, cabecalhos: vizinho });
    const origens = linhas(`SELECT DISTINCT origem FROM registos`);
    certo(origens.length === 2,
      'em IPv6 conta-se o /64: dois endereços da mesma casa são UMA origem, e o vizinho é outra',
      `${origens.length} origens`);
    for (const l of linhas(`SELECT id FROM clientes WHERE email IS NULL
                             AND NOT EXISTS (SELECT 1 FROM cartoes k WHERE k.cliente_id = clientes.id)
                             AND criado_em > datetime('now', '-2 minutes')`)) {
      criados.push(l.id);
    }
    sql(`DELETE FROM registos`);
  }

  /* --- limpeza ---------------------------------------------------------- */
  const lista = [...new Set(criados)].filter(Boolean).map((x) => `'${x}'`).join(',');
  if (lista) sql(`DELETE FROM clientes WHERE id IN (${lista})`);
  sql(`DELETE FROM ligacoes`);
  await fetch(`${GOOGLE}/__limpar`, { method: 'POST' });
}

grupo('Entrar com a Apple');
{
  /* Contra uma Apple DE MENTIRA (`scripts/apple-de-mentira.mjs`), que é menos
     generosa do que a Google de propósito: não manda morada nenhuma, porque a
     Apple a sério também não manda sem âmbito — e sem POST na volta não há
     âmbito. Um teste contra uma imitação mais simpática do que o original não
     prova nada. */
  const APPLE = 'http://localhost:8797';
  const ORIGEM = { origin: 'http://localhost:4321', 'cf-connecting-ip': '198.51.100.91' };
  const criados = [];
  sql(`DELETE FROM registos`);

  const comecar = (sessao) => pedir('/v1/cliente/apple/comecar',
    { metodo: 'POST', corpo: {}, sessao, cabecalhos: ORIGEM });
  const voltar = (corpo) => pedir('/v1/cliente/entrada/volta',
    { metodo: 'POST', corpo, cabecalhos: ORIGEM });
  const levantar = (bilhete) => pedir('/v1/cliente/entrada/estado',
    { metodo: 'POST', corpo: { bilhete }, cabecalhos: ORIGEM });

  async function passarPelaApple(url, quem) {
    const pagina = await fetch(url);
    const html = await pagina.text();
    const codigo = html.match(/name="codigo" value="([^"]+)"/)[1];
    const estadoForm = html.match(/name="estado" value="([^"]+)"/)[1];
    const r = await fetch(`${APPLE}/auth/aprovar`, {
      method: 'POST', redirect: 'manual',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ codigo, estado: estadoForm, decisao: 'sim', quem }),
    });
    const destino = new URL(r.headers.get('location'));
    return { codigo: destino.searchParams.get('code'), estado: destino.searchParams.get('state') };
  }

  const portas = await pedir('/v1/portas', { cabecalhos: ORIGEM });
  certo(portas.dados.apple === true,
    'o servidor diz que a porta da Apple está aberta', JSON.stringify(portas.dados));

  const ida = await comecar();
  certo(ida.estado === 200 && ida.dados.url && ida.dados.bilhete,
    'a ida devolve o endereço da Apple e um bilhete');
  const url = new URL(ida.dados.url);
  certo(url.pathname === '/auth/authorize', 'e bate ao endereço certo', url.pathname);
  certo(url.searchParams.get('response_mode') === 'query',
    'a volta é por QUERY — é a única que uma página do GitHub Pages consegue receber',
    url.searchParams.get('response_mode'));
  certo(!url.searchParams.has('scope'),
    'e vai SEM âmbito: com âmbito a Apple obriga a POST, e a nossa volta é um GET');
  certo(!url.searchParams.has('code_challenge'),
    'e sem PKCE, que a Apple não documenta para a web — o que protege é o segredo de cliente');
  certo(url.searchParams.get('redirect_uri') === 'http://localhost:4321/app/',
    'e aterra dentro do âmbito da app', url.searchParams.get('redirect_uri'));

  const volta1 = await passarPelaApple(ida.dados.url, 'pessoa@icloud.com');
  const semBilhete = await voltar({ estado: volta1.estado, codigo: volta1.codigo });
  certo(semBilhete.estado === 403,
    'sem bilhete não se conclui — a mesma trava da Google, e pelo mesmo motivo');

  const feito = await voltar({ ...volta1, bilhete: ida.dados.bilhete });
  certo(feito.estado === 200 && feito.dados.ok === true && feito.dados.provedor === 'apple',
    'com o bilhete certo conclui, e diz de que porta foi', JSON.stringify(feito.dados));

  const lev = await levantar(ida.dados.bilhete);
  certo(lev.dados.situacao === 'pronta' && Boolean(lev.dados.sessao),
    'o bilhete levanta a entrada feita', JSON.stringify(lev.dados).slice(0, 100));
  const contaA = lev.dados.cliente.id;
  criados.push(contaA);

  const identidade = linhas(
    `SELECT provedor, sujeito, email FROM identidades WHERE cliente_id = '${contaA}'`);
  certo(identidade.length === 1 && identidade[0].provedor === 'apple',
    'ficou uma identidade `apple` colada à conta');
  certo(identidade[0].email === null,
    'e SEM morada — a Apple não a manda, e não se inventa uma', String(identidade[0].email));
  certo(linhas(`SELECT email FROM clientes WHERE id = '${contaA}'`)[0].email === null,
    'o espelho também fica vazio: quem entra só pela Apple não nos deixa por onde escrever');

  /* --- o segredo de cliente, que é onde estão os três enganos ----------- */
  {
    const visto = await (await fetch(`${APPLE}/__visto`)).json();
    const troca = visto.filter((v) => v.caminho === '/auth/token').pop();
    const forma = new URLSearchParams(troca.bruto);
    const segredo = forma.get('client_secret');
    const [cab, corpo] = segredo.split('.').slice(0, 2)
      .map((x) => JSON.parse(Buffer.from(x, 'base64url').toString()));
    certo(cab.alg === 'ES256', 'o segredo de cliente é assinado em ES256', cab.alg);
    certo(cab.kid === 'KIDDEMENTIR',
      'e leva o `kid` da chave — sem ele a Apple responde `invalid_client`', cab.kid);
    certo(corpo.iss === 'DEMENTIRA1', 'o `iss` é o Team ID', corpo.iss);
    certo(corpo.sub === 'pt.carimbodigital.dementira',
      'e o `sub` é o SERVICES ID, que é o engano mais comum deste caminho', corpo.sub);
    certo(corpo.aud === 'https://appleid.apple.com', 'e o `aud` é a Apple', corpo.aud);
    certo(corpo.exp > corpo.iat && corpo.exp - corpo.iat <= 15777000,
      'com prazo dentro dos seis meses que a Apple aceita');
  }

  /* --- a mesma pessoa outra vez, e o cancelar --------------------------- */
  const ida2 = await comecar();
  const volta2 = await passarPelaApple(ida2.dados.url, 'pessoa@icloud.com');
  await voltar({ ...volta2, bilhete: ida2.dados.bilhete });
  const lev2 = await levantar(ida2.dados.bilhete);
  certo(lev2.dados.cliente.id === contaA, 'a mesma conta Apple entra sempre na mesma conta nossa');

  {
    const ida3 = await comecar();
    const r = await voltar({ estado: (new URL(ida3.dados.url)).searchParams.get('state'),
      bilhete: ida3.dados.bilhete, erro: 'user_cancelled_authorize' });
    certo(r.estado === 200 && r.dados.ok === false,
      'cancelar na Apple chega cá como um caminho normal', JSON.stringify(r.dados));
  }

  /* --- e as duas portas na mesma conta ---------------------------------- */
  {
    const ida4 = await comecar(lev.dados.sessao);
    const volta4 = await passarPelaApple(ida4.dados.url, 'outra.pessoa@icloud.com');
    await voltar({ ...volta4, bilhete: ida4.dados.bilhete });
    const lev4 = await levantar(ida4.dados.bilhete);
    certo(lev4.dados.cliente.id === contaA,
      'uma identidade Apple nova cola-se à conta que pediu, com sessão provada');
    certo(linhas(`SELECT COUNT(*) AS n FROM identidades
                   WHERE cliente_id = '${contaA}' AND provedor = 'apple'`)[0].n === 2,
      'e ficam as duas — a mesma conta pode entrar por dois IDs Apple');
  }

  const lista = [...new Set(criados)].filter(Boolean).map((x) => `'${x}'`).join(',');
  if (lista) sql(`DELETE FROM clientes WHERE id IN (${lista})`);
  sql(`DELETE FROM ligacoes`);
  await fetch(`${APPLE}/__limpar`, { method: 'POST' });
}

grupo('Avisar quando o cartão fica cheio');
{
  /* A cifra do Web Push prova-se AQUI, decifrando: geram-se as chaves como um
     browser as geraria, subscreve-se, carimba-se até ao prémio, e abre-se o
     envelope que chegou ao serviço de push de mentira. Uma cifra provada só de
     um lado não está provada. */
  const GOOGLE = 'http://localhost:8799';
  const ORIGEM = { origin: 'http://localhost:4321', 'cf-connecting-ip': '198.51.100.92' };
  await fetch(`${GOOGLE}/__limpar`, { method: 'POST' });

  const b64 = (b) => Buffer.from(b).toString('base64url');
  const juntar = (...p) => {
    const t = p.reduce((n, x) => n + x.length, 0);
    const s = new Uint8Array(t); let i = 0;
    for (const x of p) { s.set(x, i); i += x.length; }
    return s;
  };
  const hkdf = async (ikm, sal, info, bytes) => {
    const k = await crypto.subtle.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
    return new Uint8Array(await crypto.subtle.deriveBits(
      { name: 'HKDF', hash: 'SHA-256', salt: sal, info }, k, bytes * 8));
  };

  /* O «browser» gera o par e o segredo, exactamente como o `pushManager`. */
  const par = await crypto.subtle.generateKey(
    { name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const uaPublica = new Uint8Array(await crypto.subtle.exportKey('raw', par.publicKey));
  const auth = crypto.getRandomValues(new Uint8Array(16));
  const idDoAparelho = randomBytes(8).toString('hex');
  const subscricao = {
    endereco: `${GOOGLE}/wp/${idDoAparelho}`,
    p256dh: b64(uaPublica),
    auth: b64(auth),
  };

  const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {}, cabecalhos: ORIGEM });
  const sessao = c.dados.sessao;
  const clienteId = c.dados.cliente.id;
  const meuSegredo = c.dados.segredo;
  /* Dois carimbos seguidos no mesmo cartão, e é isso que este grupo precisa. */
  sql(`UPDATE programas SET arrefecimento = 0 WHERE id = 'p1'`);

  const mau = await pedir('/v1/cliente/push', {
    metodo: 'POST', sessao, cabecalhos: ORIGEM,
    corpo: { endereco: 'https://exemplo.pt/x', p256dh: 'curta', auth: b64(auth) } });
  certo(mau.estado === 400 && mau.dados.codigo === 'push-chaves',
    'uma subscrição com chaves do tamanho errado é recusada antes de entrar na base',
    JSON.stringify(mau.dados));

  const sub = await pedir('/v1/cliente/push', { metodo: 'POST', sessao, cabecalhos: ORIGEM, corpo: subscricao });
  certo(sub.estado === 200, 'a subscrição entra', JSON.stringify(sub.dados));
  certo(linhas(`SELECT COUNT(*) AS n FROM subscricoes WHERE cliente_id = '${clienteId}'`)[0].n === 1,
    'e fica uma linha');

  await pedir('/v1/cliente/push', { metodo: 'POST', sessao, cabecalhos: ORIGEM, corpo: subscricao });
  certo(linhas(`SELECT COUNT(*) AS n FROM subscricoes WHERE cliente_id = '${clienteId}'`)[0].n === 1,
    'subscrever duas vezes com o mesmo endereço NÃO duplica — seriam dois avisos iguais no mesmo ecrã');

  /* --- carimbar até fechar o cartão ------------------------------------- */
  const cartao = await pedir('/v1/cliente/aderir',
    { metodo: 'POST', sessao, cabecalhos: ORIGEM, corpo: { programaId: 'p1' } });
  certo(cartao.estado === 200, 'aderiu a um programa (o teste é válido)', JSON.stringify(cartao.dados).slice(0, 80));

  /* Põe-se o cartão a um carimbo do fim, e dá-se o último — que é o único que
     manda aviso. */
  const objetivo = linhas(`SELECT objetivo FROM programas WHERE id = 'p1'`)[0].objetivo;
  sql(`UPDATE cartoes SET carimbos = ${objetivo - 1}, ultimo_em = NULL
        WHERE cliente_id = '${clienteId}' AND programa_id = 'p1'`);

  const carimbo = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao, cabecalhos: ORIGEM,
    corpo: { codigo: codigoPara(c.dados.cliente.publico, meuSegredo), programaId: 'p1' } });
  certo(carimbo.estado === 200 && carimbo.dados.ganhos && carimbo.dados.ganhos.length === 1,
    'o carimbo fecha o cartão e ganha um prémio', JSON.stringify(carimbo.dados).slice(0, 120));

  /* O envio vai num `waitUntil`, depois da resposta. Dá-se-lhe tempo. */
  let entregues = [];
  for (let i = 0; i < 20 && !entregues.length; i++) {
    await dormir(250);
    entregues = await (await fetch(`${GOOGLE}/__entregues`)).json();
  }
  certo(entregues.length === 1, 'chegou UM aviso ao serviço de push', String(entregues.length));

  const chegou = entregues[0];
  certo(chegou.codificacao === 'aes128gcm',
    'com a codificação que a norma manda', chegou.codificacao);
  certo(/^vapid t=[\w-]+\.[\w-]+\.[\w-]+, k=[\w-]+$/.test(chegou.autorizacao),
    'e um cabeçalho VAPID com a forma certa', chegou.autorizacao.slice(0, 40));
  {
    const [, jwt] = chegou.autorizacao.match(/t=([^,]+)/);
    const reivindicacoes = JSON.parse(Buffer.from(jwt.split('.')[1], 'base64url').toString());
    certo(reivindicacoes.aud === 'http://localhost:8799',
      'cujo `aud` é a ORIGEM do endereço e não o endereço todo — é aqui que a Mozilla dá 401',
      reivindicacoes.aud);
    certo(String(reivindicacoes.sub).startsWith('mailto:'), 'e diz a quem reclamar');
  }

  /* --- e agora abre-se o envelope --------------------------------------- */
  const corpoCifrado = new Uint8Array(Buffer.from(chegou.corpo, 'base64'));
  const sal = corpoCifrado.slice(0, 16);
  const idlen = corpoCifrado[20];
  const asPublica = corpoCifrado.slice(21, 21 + idlen);
  const cifrado = corpoCifrado.slice(21 + idlen);
  const doServidor = await crypto.subtle.importKey(
    'raw', asPublica, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const partilhado = new Uint8Array(await crypto.subtle.deriveBits(
    { name: 'ECDH', public: doServidor }, par.privateKey, 256));
  const ikm = await hkdf(partilhado, auth,
    juntar(new TextEncoder().encode('WebPush: info\0'), uaPublica, asPublica), 32);
  const cek = await hkdf(ikm, sal, new TextEncoder().encode('Content-Encoding: aes128gcm\0'), 16);
  const nonce = await hkdf(ikm, sal, new TextEncoder().encode('Content-Encoding: nonce\0'), 12);
  const chaveAES = await crypto.subtle.importKey('raw', cek, 'AES-GCM', false, ['decrypt']);
  const claro = new Uint8Array(await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, chaveAES, cifrado));
  const texto = JSON.parse(new TextDecoder().decode(claro.slice(0, -1)));

  certo(/prémio/i.test(texto.titulo), 'e o que vai lá dentro é o prémio', JSON.stringify(texto));
  certo(texto.corpo.includes('Café'), 'com o nome do sítio onde se ganhou', texto.corpo);

  /* --- uma subscrição que morreu apaga-se ------------------------------- */
  await fetch(`${GOOGLE}/__matar?id=${idDoAparelho}`, { method: 'POST' });
  sql(`UPDATE cartoes SET carimbos = ${objetivo - 1}, ultimo_em = NULL,
        premios_ganhos = 0 WHERE cliente_id = '${clienteId}' AND programa_id = 'p1'`);
  /* OUTRA JANELA. O mesmo código QR não serve duas vezes — é a defesa contra a
     fotografia do ecrã de um amigo — e dois carimbos no mesmo minuto usariam o
     mesmo. O `deslocamento` pede o da janela seguinte, que continua dentro da
     tolerância de relógio. */
  const segundo = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao, cabecalhos: ORIGEM,
    corpo: { codigo: codigoPara(c.dados.cliente.publico, meuSegredo, 1), programaId: 'p1' } });
  certo(segundo.estado === 200 && segundo.dados.ganhos && segundo.dados.ganhos.length === 1,
    'o segundo carimbo também fecha o cartão (o teste do 410 depende disso)',
    JSON.stringify(segundo.dados).slice(0, 140));
  let restam = 1;
  for (let i = 0; i < 20 && restam; i++) {
    await dormir(250);
    restam = linhas(`SELECT COUNT(*) AS n FROM subscricoes WHERE cliente_id = '${clienteId}'`)[0].n;
  }
  certo(restam === 0,
    'um 410 do serviço de push apaga a subscrição — o aparelho já não existe e insistir é gastar contra uma parede',
    String(restam));

  /* --- desligar, e apagar a conta --------------------------------------- */
  await pedir('/v1/cliente/push', { metodo: 'POST', sessao, cabecalhos: ORIGEM, corpo: subscricao });
  const fora = await pedir('/v1/cliente/push', { metodo: 'DELETE', sessao, cabecalhos: ORIGEM, corpo: {} });
  certo(fora.estado === 200
    && linhas(`SELECT COUNT(*) AS n FROM subscricoes WHERE cliente_id = '${clienteId}'`)[0].n === 0,
    'desligar sem endereço desliga todos os aparelhos desta conta');

  await pedir('/v1/cliente/push', { metodo: 'POST', sessao, cabecalhos: ORIGEM, corpo: subscricao });
  await pedir('/v1/cliente', { metodo: 'DELETE', sessao, cabecalhos: ORIGEM });
  certo(linhas(`SELECT COUNT(*) AS n FROM subscricoes WHERE cliente_id = '${clienteId}'`)[0].n === 0,
    'e apagar a conta leva os aparelhos — mandar um aviso a quem pediu para desaparecer seria o pior fim');

  await fetch(`${GOOGLE}/__limpar`, { method: 'POST' });
}

grupo('Quem está ao balcão');
{
  /* Um café com três turnos tem três pessoas a carimbar, e o dono quer saber
     quem atendeu. O que aqui se persegue não é «a lista aparece» — é o que
     esta funcionalidade tem de caro:

     · dois nomes iguais e activos matam o histórico, que guarda o NOME;
     · quem carimba não pode tirar o dono do próprio café;
     · e tirar alguém tem de FECHAR A PORTA no mesmo gesto, senão a sessão que
       ficou viva é a pessoa a continuar a carimbar depois de sair. */

  /* O estado de que este grupo depende é dele. O `o1` do semear é o dono. */
  sql(`DELETE FROM operadores WHERE negocio_id = 'n1' AND id != 'o1'`);
  sql(`UPDATE operadores SET papel = 'dono', ativo = 1, nome = 'Balcão' WHERE id = 'o1'`);

  const lista = await pedir('/v1/balcao/operadores', { sessao: sessaoBalcao });
  certo(lista.estado === 200 && lista.dados.operadores.length === 1,
    'o balcão começa com uma pessoa — quem o fundou',
    JSON.stringify(lista.dados).slice(0, 140));
  certo(lista.dados.sou === 'dono' && lista.dados.operadores[0].papel === 'dono',
    'e ela é o dono');
  certo(lista.dados.operadores[0].email === 'muda-me@exemplo.pt',
    'ao dono mostra-se a morada — é por ela que ele tira quem saiu');

  /* --- juntar --------------------------------------------------------- */
  const juntar = (corpo) => pedir('/v1/balcao/operadores',
    { metodo: 'POST', sessao: sessaoBalcao, corpo });

  const nova = await juntar({ nome: 'Marta', email: 'marta@exemplo.pt' });
  certo(nova.estado === 200 && nova.dados.operador.papel === 'balcao',
    'juntar um colega dá um operador de balcão, não um dono',
    JSON.stringify(nova.dados).slice(0, 140));
  certo(nova.dados.operador.visto === null,
    'e ele nasce por entrar — «ainda não entrou» é diferente de «anda cá todos os dias»');
  certo(nova.dados.avisado === false,
    'sem canal de correio nestes testes, o convite não sai — e diz-se, em vez de fingir');
  certo(linhas(`SELECT COUNT(*) AS n FROM operadores WHERE negocio_id = 'n1' AND ativo = 1`)[0].n === 2,
    'e a linha ficou mesmo na base');

  const semNome = await juntar({ nome: '   ', email: 'x@exemplo.pt' });
  certo(semNome.estado === 400 && semNome.dados.codigo === 'sem-nome',
    'sem nome não entra — o histórico ficaria com um espaço em branco a carimbar');
  const semEmail = await juntar({ nome: 'Rui', email: 'rui' });
  certo(semEmail.estado === 400 && semEmail.dados.codigo === 'email-mau',
    'e sem morada válida também não: é por ela que ele entra');

  /* --- o nome repetido, que é o que isto existe para impedir ----------- */
  const igual = await juntar({ nome: 'marta  ', email: 'outra@exemplo.pt' });
  certo(igual.estado === 409 && igual.dados.codigo === 'nome-repetido',
    'dois «Marta» activos são recusados — sem maiúsculas e sem espaços, que é como se lê',
    JSON.stringify(igual.dados).slice(0, 120));
  certo(String(igual.dados.erro).includes('histórico'),
    'e diz PORQUÊ, em vez de mandar a pessoa adivinhar', String(igual.dados.erro));

  const mesmaMorada = await juntar({ nome: 'Outra pessoa', email: 'marta@exemplo.pt' });
  certo(mesmaMorada.estado === 409 && mesmaMorada.dados.codigo === 'email-repetido',
    'e a mesma morada duas vezes também — entrar é pela morada');

  /* --- só o dono mexe -------------------------------------------------- */
  const sessaoMarta = await sessaoDeOperador(nova.dados.operador.id, 'marta@exemplo.pt');
  const martaVe = await pedir('/v1/balcao/operadores', { sessao: sessaoMarta });
  certo(martaVe.estado === 200 && martaVe.dados.operadores.length === 2,
    'quem carimba VÊ com quem trabalha — não é segredo dentro do balcão');
  certo(martaVe.dados.operadores.every((o) => o.email === undefined),
    'mas não vê as moradas dos colegas — não faz falta para carimbar',
    JSON.stringify(martaVe.dados.operadores));

  const martaJunta = await pedir('/v1/balcao/operadores',
    { metodo: 'POST', sessao: sessaoMarta, corpo: { nome: 'Zé', email: 'ze@exemplo.pt' } });
  certo(martaJunta.estado === 403 && martaJunta.dados.codigo === 'so-o-dono',
    'e não junta ninguém — senão o primeiro colega enche o balcão');
  const martaTira = await pedir('/v1/balcao/operadores/o1',
    { metodo: 'DELETE', sessao: sessaoMarta });
  certo(martaTira.estado === 403 && martaTira.dados.codigo === 'so-o-dono',
    'nem tira o dono do próprio café, que era o pior que podia fazer');

  /* --- o dono não se tira a si ---------------------------------------- */
  const euNao = await pedir('/v1/balcao/operadores/o1',
    { metodo: 'DELETE', sessao: sessaoBalcao });
  certo(euNao.estado === 409 && euNao.dados.codigo === 'eu-nao',
    'o dono não se tira a si próprio — ficava de fora do balcão dele');
  const ultimoDono = await pedir(`/v1/balcao/operadores/o1`,
    { metodo: 'PATCH', sessao: sessaoBalcao, corpo: { papel: 'balcao' } });
  certo(ultimoDono.estado === 409 && ultimoDono.dados.codigo === 'ultimo-dono',
    'nem se despromove sendo o último — um balcão sem dono não se volta a arrumar');

  /* --- mudar o nome ---------------------------------------------------- */
  const renomear = await pedir(`/v1/balcao/operadores/${nova.dados.operador.id}`,
    { metodo: 'PATCH', sessao: sessaoBalcao, corpo: { nome: 'Marta da tarde' } });
  certo(renomear.estado === 200 && renomear.dados.operador.nome === 'Marta da tarde',
    'o dono muda o nome de quem lá está — é o que resolve os dois «Marta»');
  const nomeDoDono = await pedir(`/v1/balcao/operadores/${nova.dados.operador.id}`,
    { metodo: 'PATCH', sessao: sessaoBalcao, corpo: { nome: 'balcão' } });
  certo(nomeDoDono.estado === 409 && nomeDoDono.dados.codigo === 'nome-repetido',
    'e não lhe pode dar o nome de outro que lá esteja');

  /* --- promover, e só então tirar o dono ------------------------------- */
  const promover = await pedir(`/v1/balcao/operadores/${nova.dados.operador.id}`,
    { metodo: 'PATCH', sessao: sessaoBalcao, corpo: { papel: 'dono' } });
  certo(promover.estado === 200 && promover.dados.operador.papel === 'dono',
    'um café pode ter dois donos — são dois sócios, e isso existe');

  /* --- tirar fecha a porta --------------------------------------------- */
  /* A Marta é agora dona e tem sessão. O `o1` tira-a, e a sessão dela tem de
     morrer NO MESMO GESTO: uma sessão viva depois de alguém sair do balcão é
     a pessoa a continuar a carimbar. */
  const antesDeSair = await pedir('/v1/balcao/resumo', { sessao: sessaoMarta });
  certo(antesDeSair.estado === 200, 'a sessão dela funcionava (o teste é válido)');

  const tirou = await pedir(`/v1/balcao/operadores/${nova.dados.operador.id}`,
    { metodo: 'DELETE', sessao: sessaoBalcao });
  certo(tirou.estado === 200, 'o dono tira quem saiu', JSON.stringify(tirou.dados));
  certo(linhas(`SELECT ativo FROM operadores WHERE id = '${nova.dados.operador.id}'`)[0].ativo === 0,
    'e a linha fica DESACTIVADA, não apagada — o histórico guarda o nome, e a linha guarda o resto');
  const depoisDeSair = await pedir('/v1/balcao/resumo', { sessao: sessaoMarta });
  certo(depoisDeSair.estado !== 200,
    'e a sessão dela morre no mesmo gesto — senão continuava a carimbar depois de sair',
    String(depoisDeSair.estado));

  /* --- e o nome fica livre outra vez ----------------------------------- */
  const outraMarta = await juntar({ nome: 'Marta da tarde', email: 'marta2@exemplo.pt' });
  certo(outraMarta.estado === 200,
    'quem sai liberta o nome — o índice é parcial de propósito',
    JSON.stringify(outraMarta.dados).slice(0, 120));
  const mesmaMoradaOutraVez = await juntar({ nome: 'Marta de novo', email: 'marta@exemplo.pt' });
  certo(mesmaMoradaOutraVez.estado === 200,
    'e liberta a morada — quem saiu pode voltar');

  /* --- o tecto ---------------------------------------------------------- */
  sql(`DELETE FROM operadores WHERE negocio_id = 'n1' AND id != 'o1'`);
  for (let i = 0; i < 9; i++) {
    await juntar({ nome: `Turno ${i}`, email: `turno${i}@exemplo.pt` });
  }
  const cheio = await juntar({ nome: 'Um a mais', email: 'amais@exemplo.pt' });
  certo(cheio.estado === 409 && cheio.dados.codigo === 'cheio',
    'ao décimo o balcão está cheio — um balcão não é uma lista de correio',
    `${cheio.estado} ${cheio.dados.codigo}`);

  sql(`DELETE FROM operadores WHERE negocio_id = 'n1' AND id != 'o1'`);
}

grupo('Onde fica o estabelecimento');
{
  /* O par de números que põe o negócio no mapa. O que aqui se persegue não é
     «grava e lê» — é o que esta coluna tem de caro:

     · A TROCA. Escrever a longitude no campo da latitude é o engano mais comum
       de quem mexe nisto à mão, e em Portugal o resultado cai no Golfo da
       Guiné. Um mapa com um café no meio do Atlântico não se lê como um erro
       de dados: lê-se como uma app avariada.
     · A MORADA A ENVELHECER. O dono muda de porta, grava a morada nova, e a
       coordenada fica a apontar para a anterior — calada, plausível, errada.
     · E APAGAR. Está prometido por escrito na página de privacidade. */

  sql(`UPDATE negocios SET latitude = NULL, longitude = NULL, geo_fonte = NULL,
       geo_em = NULL, geo_morada = NULL, morada = 'Rua das Provas 1' WHERE id = 'n1'`);

  const por = (corpo) => pedir('/v1/balcao/negocio',
    { metodo: 'PUT', sessao: sessaoBalcao, corpo });

  /* --- o que se recusa, e porquê ---------------------------------------- */
  const trocada = await por({ latitude: -8.49, longitude: 40.88 });
  certo(trocada.estado === 400 && trocada.dados.codigo === 'geo-trocada',
    'a latitude e a longitude trocadas são recusadas — e a mensagem diz que é isso',
    JSON.stringify(trocada.dados));

  const nula = await por({ latitude: 0, longitude: 0 });
  certo(nula.estado === 400 && nula.dados.codigo === 'geo-nulo',
    '(0, 0) é recusado em separado: é o que fica quando não se sabe onde é');

  const fora = await por({ latitude: 48.85, longitude: 2.35 });
  certo(fora.estado === 400 && fora.dados.codigo === 'geo-fora',
    'e Paris também — este mapa é de Portugal');

  const lixo = await por({ latitude: 'aqui', longitude: 'ali' });
  certo(lixo.estado === 400 && lixo.dados.codigo === 'geo-numeros',
    'e texto não é uma coordenada');

  certo(linhas(`SELECT latitude FROM negocios WHERE id = 'n1'`)[0].latitude === null,
    'e nenhuma das recusas deixou nada gravado');

  /* --- o que se aceita --------------------------------------------------- */
  const bom = await por({ latitude: 40.8594412345, longitude: -8.6252787654, geoFonte: 'gps' });
  certo(bom.estado === 200, 'um ponto em Ovar entra', JSON.stringify(bom.dados).slice(0, 120));
  const gravado = linhas(`SELECT latitude, longitude, geo_fonte, geo_morada FROM negocios WHERE id = 'n1'`)[0];
  certo(gravado.latitude === 40.85944 && gravado.longitude === -8.62528,
    'ARREDONDADO A CINCO CASAS — a 40° de latitude vale 1,11 m, e o telemóvel '
    + 'devolve mais casas do que sabe',
    `${gravado.latitude}, ${gravado.longitude}`);
  certo(gravado.geo_fonte === 'gps', 'e a fonte fica registada');
  certo(gravado.geo_morada === 'Rua das Provas 1',
    'e a morada que gerou o ponto fica agarrada a ele', String(gravado.geo_morada));

  const inventada = await por({ latitude: 40.86, longitude: -8.62, geoFonte: 'adivinhei' });
  certo(inventada.estado === 200
    && linhas(`SELECT geo_fonte FROM negocios WHERE id = 'n1'`)[0].geo_fonte === 'mao',
    'uma fonte que não existe cai em «mao» — é a mais modesta das três, e não '
    + 'se inventa precisão que não se tem');

  /* --- a morada a envelhecer --------------------------------------------- */
  const mudou = await por({ morada: 'Avenida Outra Qualquer 99' });
  certo(mudou.estado === 200 && mudou.dados.moradaMudou === true,
    'mudar a morada com o ponto marcado devolve um aviso',
    JSON.stringify(mudou.dados.moradaMudou));
  certo(linhas(`SELECT latitude FROM negocios WHERE id = 'n1'`)[0].latitude === 40.86,
    'E NÃO APAGA O PONTO. Pode ter sido uma gralha corrigida com o alfinete já '
    + 'certo, e apagar o trabalho por causa de um acento era pior do que o problema');

  /* E AGORA A COMPARAÇÃO A SÉRIO. Marca-se o ponto outra vez, o que prende o
     ponto à morada ACTUAL, e escreve-se a mesma morada com outra caixa e
     outros espaços. Um aviso a disparar por causa de uma maiúscula seria um
     aviso que se aprende a ignorar — e um aviso ignorado não é um aviso.

     (A primeira versão deste teste afirmava isto sem voltar a marcar o ponto,
     e falhava com razão: a `geo_morada` ainda era a de três linhas acima.) */
  await por({ latitude: 40.86, longitude: -8.62, geoFonte: 'mao' });
  const mesmaMorada = await por({ morada: '  avenida   OUTRA qualquer 99 ' });
  certo(mesmaMorada.dados.moradaMudou === false,
    'a mesma morada escrita com outra caixa e outros espaços não é uma morada nova',
    JSON.stringify({ morada: mesmaMorada.dados.morada, geo: mesmaMorada.dados.geo_morada }));

  /* O AVISO TEM DE SOBREVIVER A FECHAR A APP. Só na resposta ao PUT, ele
     aparecia uma vez e desaparecia à primeira recarga — e um aviso que não
     sobrevive a fechar a app é um aviso que ninguém chega a ler. */
  const aoAbrir = await pedir('/v1/balcao/negocio', { sessao: sessaoBalcao });
  certo(aoAbrir.dados.moradaMudou === false,
    'o ecrã do balcão também traz o aviso da morada, e agora diz que não há nada',
    JSON.stringify(aoAbrir.dados.moradaMudou));
  await por({ morada: 'Rua de Outra Coisa 7' });
  const comAviso = await pedir('/v1/balcao/negocio', { sessao: sessaoBalcao });
  certo(comAviso.dados.moradaMudou === true,
    'e depois de a morada mudar, o aviso está lá a cada abertura do ecrã — não '
    + 'só na resposta a quem gravou', JSON.stringify(comAviso.dados.moradaMudou));

  /* --- e apagar ----------------------------------------------------------- */
  const apagou = await por({ apagarPonto: true });
  const vazio = linhas(`SELECT latitude, longitude, geo_fonte, geo_em, geo_morada FROM negocios WHERE id = 'n1'`)[0];
  certo(apagou.estado === 200 && vazio.latitude === null && vazio.longitude === null
    && vazio.geo_fonte === null && vazio.geo_em === null && vazio.geo_morada === null,
    'tirar do mapa leva as cinco colunas — está prometido na privacidade',
    JSON.stringify(vazio));

  /* --- e o que o «Descobrir» mostra --------------------------------------- */
  await por({ latitude: 40.85944, longitude: -8.62528, geoFonte: 'gps' });
  const lista = await pedir('/v1/descobrir');
  const meu = lista.dados.find((n) => n.id === 'n1');
  certo(meu && meu.latitude === 40.85944 && meu.longitude === -8.62528 && meu.geoFonte === 'gps',
    'o «Descobrir» leva o ponto — sem um pedido novo por abertura da app',
    JSON.stringify(meu && { lat: meu.latitude, lon: meu.longitude, f: meu.geoFonte }));

  sql(`UPDATE negocios SET latitude = NULL, longitude = NULL, geo_fonte = NULL WHERE id = 'n1'`);
  const semPonto = await pedir('/v1/descobrir');
  const agoraSem = semPonto.dados.find((n) => n.id === 'n1');
  certo(agoraSem && agoraSem.latitude === null && agoraSem.geoFonte === null,
    'e um negócio sem ponto continua na lista, com os campos a null — nunca em (0, 0)',
    JSON.stringify(agoraSem && { lat: agoraSem.latitude, f: agoraSem.geoFonte }));
}

grupo('Traz um amigo');
{
  /* «Cada cliente traz outro, e ganham os dois.» O que aqui se persegue não é
     «o convite funciona» — é o que ele tem de recusar, porque um programa de
     fidelização que se deixa vigarizar custa dinheiro ao café todos os dias:

     · a RECOMPENSA SÓ NO PRIMEIRO CARIMBO A SÉRIO. Aderir não dá nada. É esta
       a regra que impede uma máquina de fazer carimbos a partir de um
       telemóvel e paciência;
     · o CONVITE VAI ASSINADO — um número público é dito em voz alta ao balcão
       todos os dias, e sem assinatura bastava sabê-lo;
     · NINGUÉM SE CONVIDA A SI PRÓPRIO, nem convida quem já é cliente;
     · e há um TECTO por programa. */

  sql(`DELETE FROM amigos`);
  sql(`UPDATE programas SET amigo_convidador = 2, amigo_convidado = 1, amigo_max = 2,
       arrefecimento = 0 WHERE id = 'p1'`);

  /* Quem convida: uma conta com o cartão e já carimbada. */
  const anfitriao = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const anf = { id: anfitriao.dados.cliente.id, publico: anfitriao.dados.cliente.publico,
                sessao: anfitriao.dados.sessao, segredo: anfitriao.dados.segredo };
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: anf.sessao, corpo: { programaId: 'p1' } });

  const meu = await pedir('/v1/cliente/amigo',
    { metodo: 'POST', sessao: anf.sessao, corpo: { programaId: 'p1' } });
  certo(meu.estado === 200 && meu.dados.codigo.startsWith(`${anf.publico}.`),
    'o convite leva o número público de quem convida',
    JSON.stringify(meu.dados).slice(0, 120));
  certo(meu.dados.codigo.split('.')[1].length === 16,
    'e uma assinatura — sem ela, bastava saber um número público para atribuir '
    + 'convites a quem nunca convidou ninguém', meu.dados.codigo);
  certo(meu.dados.convidador === 2 && meu.dados.convidado === 1,
    'e diz quanto é que cada lado ganha', JSON.stringify(meu.dados));

  /* --- o que se recusa --------------------------------------------------- */
  const forjado = `${anf.publico}.aaaaaaaaaaaaaaaa`;
  const vitima = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: vitima.dados.sessao,
    corpo: { programaId: 'p1', amigo: forjado } });
  certo(linhas(`SELECT COUNT(*) AS n FROM amigos`)[0].n === 0,
    'uma assinatura forjada não regista convite nenhum — e a adesão acontece na '
    + 'mesma, que é o que a pessoa foi ali fazer');
  certo(linhas(`SELECT COUNT(*) AS n FROM cartoes WHERE cliente_id = '${vitima.dados.cliente.id}'`)[0].n === 1,
    'e o cartão ficou junto, apesar de o convite não prestar');

  const euMesmo = await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: anf.sessao,
    corpo: { programaId: 'p1', amigo: meu.dados.codigo } });
  certo(euMesmo.estado === 200 && linhas(`SELECT COUNT(*) AS n FROM amigos`)[0].n === 0,
    'ninguém se convida a si próprio — dois telemóveis e a mesma conta é o '
    + 'primeiro sítio onde alguém vai bater');

  /* --- e o que se aceita -------------------------------------------------- */
  const amigo = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
  const am = { id: amigo.dados.cliente.id, publico: amigo.dados.cliente.publico,
               sessao: amigo.dados.sessao, segredo: amigo.dados.segredo };
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: am.sessao,
    corpo: { programaId: 'p1', amigo: meu.dados.codigo } });
  const registado = linhas(`SELECT convidador, convidado, premiado_em FROM amigos`);
  certo(registado.length === 1 && registado[0].convidador === anf.id
    && registado[0].convidado === am.id,
    'um convite bom fica registado', JSON.stringify(registado));
  certo(registado[0].premiado_em === null,
    'E ADERIR NÃO PAGA NADA. É esta a regra que impede uma máquina de fazer '
    + 'carimbos a partir de um telemóvel e paciência');
  certo(linhas(`SELECT carimbos FROM cartoes WHERE cliente_id = '${anf.id}'`)[0].carimbos === 0,
    'quem convidou continua a zero carimbos');

  /* Aderir OUTRA VEZ pelo mesmo link não duplica. */
  await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: am.sessao,
    corpo: { programaId: 'p1', amigo: meu.dados.codigo } });
  certo(linhas(`SELECT COUNT(*) AS n FROM amigos`)[0].n === 1,
    'e aderir outra vez pelo mesmo link não duplica o convite');

  /* --- o primeiro carimbo, que é onde tudo acontece ---------------------- */
  const carimbo = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(am.publico, am.segredo), programaId: 'p1' } });
  certo(carimbo.estado === 200 && carimbo.dados.amigo,
    'o primeiro carimbo do convidado paga o convite',
    JSON.stringify(carimbo.dados.amigo));
  certo(carimbo.dados.amigo.convidado === 1 && carimbo.dados.amigo.convidador === 2,
    'e diz ao balcão quanto foi para cada lado — senão o cartão salta dois '
    + 'carimbos e parece um erro da app', JSON.stringify(carimbo.dados.amigo));
  certo(carimbo.dados.cartao.carimbos === 2,
    'o convidado fica com o carimbo do balcão mais o do convite',
    String(carimbo.dados.cartao.carimbos));
  certo(linhas(`SELECT carimbos FROM cartoes WHERE cliente_id = '${anf.id}'`)[0].carimbos === 2,
    'e quem convidou ganha os dele, sem ter de lá estar');
  certo(linhas(`SELECT premiado_em FROM amigos`)[0].premiado_em !== null,
    'e o convite fica marcado como pago');

  /* --- e não se paga duas vezes ------------------------------------------ */
  const segundo = await pedir('/v1/balcao/carimbar', {
    metodo: 'POST', sessao: sessaoBalcao,
    corpo: { codigo: codigoPara(am.publico, am.segredo, 1), programaId: 'p1' } });
  certo(segundo.estado === 200 && segundo.dados.amigo === null,
    'o segundo carimbo já não paga nada — é uma vez, e uma vez só',
    JSON.stringify(segundo.dados.amigo));
  certo(linhas(`SELECT carimbos FROM cartoes WHERE cliente_id = '${anf.id}'`)[0].carimbos === 2,
    'e quem convidou continua com os mesmos dois');

  /* --- o tecto ------------------------------------------------------------ */
  /* O `amigo_max` é 2. Já houve um convite premiado; falta um. */
  const traz = async () => {
    const c = await pedir('/v1/cliente/registar', { metodo: 'POST', corpo: {} });
    await pedir('/v1/cliente/aderir', { metodo: 'POST', sessao: c.dados.sessao,
      corpo: { programaId: 'p1', amigo: meu.dados.codigo } });
    return pedir('/v1/balcao/carimbar', { metodo: 'POST', sessao: sessaoBalcao,
      corpo: { codigo: codigoPara(c.dados.cliente.publico, c.dados.segredo), programaId: 'p1' } });
  };
  const segundoAmigo = await traz();
  certo(segundoAmigo.dados.amigo && segundoAmigo.dados.amigo.convidador === 2,
    'o segundo convite ainda paga a quem convidou',
    JSON.stringify(segundoAmigo.dados.amigo));

  const terceiroAmigo = await traz();
  certo(terceiroAmigo.dados.amigo && terceiroAmigo.dados.amigo.convidador === 0
    && terceiroAmigo.dados.amigo.tectoCheio === true,
    'ao terceiro, o tecto do programa trava quem convida',
    JSON.stringify(terceiroAmigo.dados.amigo));
  certo(terceiroAmigo.dados.amigo.convidado === 1,
    'MAS QUEM CHEGA GANHA SEMPRE — não é ele que tem tecto nenhum, e castigá-lo '
    + 'pelo amigo que convidou muita gente seria castigar a pessoa errada');
  certo(linhas(`SELECT carimbos FROM cartoes WHERE cliente_id = '${anf.id}'`)[0].carimbos === 4,
    'e quem convidou fica nos quatro carimbos dos dois convites premiados',
    String(linhas(`SELECT carimbos FROM cartoes WHERE cliente_id = '${anf.id}'`)[0].carimbos));

  /* --- desligado é desligado ---------------------------------------------- */
  sql(`UPDATE programas SET amigo_convidador = 0, amigo_convidado = 0 WHERE id = 'p1'`);
  const desligado = await pedir('/v1/cliente/amigo',
    { metodo: 'POST', sessao: anf.sessao, corpo: { programaId: 'p1' } });
  certo(desligado.estado === 404 && desligado.dados.codigo === 'amigo-desligado',
    'com a oferta a zero não há convite nenhum a dar — um botão que promete '
    + 'carimbos num sítio que não os dá é uma promessa que ninguém fez');

  /* --- e apagar a conta leva os convites ---------------------------------- */
  sql(`UPDATE programas SET amigo_convidador = 2, amigo_convidado = 1 WHERE id = 'p1'`);
  const antesDeApagar = linhas(`SELECT COUNT(*) AS n FROM amigos WHERE convidador = '${anf.id}'`)[0].n;
  certo(antesDeApagar > 0, 'o anfitrião tem convites registados (o teste é válido)');
  await pedir('/v1/cliente', { metodo: 'DELETE', sessao: anf.sessao });
  certo(linhas(`SELECT COUNT(*) AS n FROM amigos WHERE convidador = '${anf.id}'`)[0].n === 0,
    'e apagar a conta leva os convites dos dois lados — são dados de quem pediu '
    + 'para desaparecer');

  sql(`UPDATE programas SET amigo_convidador = 0, amigo_convidado = 0, amigo_max = 5,
       arrefecimento = 3600 WHERE id = 'p1'`);
  sql(`DELETE FROM amigos`);
}

/* --------------------------------------------------------------------- */

console.log(`\n${passou} passaram, ${falhou} falharam.`);
if (falhou) {
  console.log('\nFalhas:');
  for (const f of falhas) console.log(`  · ${f}`);
  process.exit(1);
}
