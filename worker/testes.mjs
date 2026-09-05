#!/usr/bin/env node
/* =========================================================================
   Sinete — bateria do Worker

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

async function pedir(caminho, { metodo = 'GET', corpo, sessao } = {}) {
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
  return execFileSync('npx', ['--yes', 'wrangler', 'd1', 'execute', 'sinete',
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

  const trocado = codigoPara(cliente.publico, segredo).replace(/.$/, 'f');
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

/* --------------------------------------------------------------------- */

console.log(`\n${passou} passaram, ${falhou} falharam.`);
if (falhou) {
  console.log('\nFalhas:');
  for (const f of falhas) console.log(`  · ${f}`);
  process.exit(1);
}
