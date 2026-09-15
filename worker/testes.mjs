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

let passou = 0, falhou = 0;
const falhas = [];

function certo(condicao, descricao, detalhe = '') {
  if (condicao) { passou++; console.log(`  ✓ ${descricao}`); }
  else { falhou++; falhas.push(descricao); console.log(`  ✗ ${descricao}${detalhe ? ` — ${detalhe}` : ''}`); }
}

function grupo(nome) { console.log(`\n${nome}`); }

const dormir = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Um pedido à API, com uma segunda tentativa quando a ligação cai.
 *
 * Não é indulgência com defeitos: é que `wrangler d1 execute --local` — que
 * é como estes testes preparam o estado — faz o `wrangler dev` reiniciar, e
 * o pedido que apanhar essa janela leva com um ECONNRESET que não tem nada a
 * ver com o código que se está a provar. Uma segunda tentativa distingue as
 * duas coisas: um defeito a sério falha as duas vezes.
 */
async function pedir(caminho, opcoes = {}) {
  try {
    return await pedirUmaVez(caminho, opcoes);
  } catch (erro) {
    if (!/fetch failed|ECONNRESET|ECONNREFUSED/.test(String(erro))) throw erro;
    await dormir(1500);
    return pedirUmaVez(caminho, opcoes);
  }
}

async function pedirUmaVez(caminho, { metodo = 'GET', corpo, sessao } = {}) {
  const r = await fetch(BASE + caminho, {
    method: metodo,
    headers: {
      'content-type': 'application/json',
      ...(sessao ? { authorization: `Bearer ${sessao}` } : {}),
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

const b64url = (b) => b.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
const deB64url = (s) => Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/'), 'base64');

const JANELA = 15;
function codigoPara(publico, segredo, deslocamento = 0) {
  const janela = Math.floor(Date.now() / 1000 / JANELA) + deslocamento;
  const mac = createHmac('sha256', deB64url(segredo)).update(`${publico}.${janela}`).digest('hex').slice(0, 16);
  return `C1.${publico}.${janela}.${mac}`;
}

/* --------------------------------------------------------------------- */

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

grupo('Descobrir');
{
  const r = await pedir('/v1/descobrir');
  certo(r.estado === 200 && r.dados.length >= 1, 'lista os negócios');
  certo(!!r.dados[0].programas?.length, 'com os programas de cada um');
  const p = await pedir('/v1/p/o-meu-cafe');
  certo(p.estado === 200 && p.dados.nome === 'O Meu Café', 'a página pública do negócio existe');
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
  const correio = 'recupera@exemplo.pt';
  sql(`DELETE FROM entradas`); sql(`DELETE FROM envios`);
  sql(`UPDATE clientes SET email = NULL, email_verificado = 0 WHERE email = '${correio}'`);

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
  certo(a.assunto.startsWith('318204'), 'e o assunto começa pelo código');
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
}

/* --------------------------------------------------------------------- */

console.log(`\n${passou} passaram, ${falhou} falharam.`);
if (falhou) {
  console.log('\nFalhas:');
  for (const f of falhas) console.log(`  · ${f}`);
  process.exit(1);
}
