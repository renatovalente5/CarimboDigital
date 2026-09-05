#!/usr/bin/env node
/* =========================================================================
   Carimbo Digital — o email, as duas metades

   RECEBER: o Email Routing da Cloudflare põe `ola@carimbodigital.pt` a cair
   na caixa pessoal, sem alojamento de email e sem custo.

   ENVIAR: os códigos de recuperação saem pela Resend, que precisa de provar
   que o domínio é nosso — três registos de DNS. Como o DNS já está na
   Cloudflare, este script pede a lista à Resend e cria-os lá, em vez de
   obrigar a copiar valores à mão de uma janela para a outra (que é onde se
   erra um carácter e se perdem duas horas).

   As duas metades só funcionam depois de o domínio estar na Cloudflare — ou
   seja, depois de os servidores de nomes do registador apontarem para lá.
   Antes disso o script diz o que falta em vez de falhar sem explicar.

   Uso:  node scripts/email.mjs
         node scripts/email.mjs --destino outro@email.pt
         RESEND_API_KEY=re_... node scripts/email.mjs     (faz também o envio)

   A autenticação da Cloudflare sai do wrangler (`npx wrangler login`), ou de
   um token em CLOUDFLARE_API_TOKEN com Zone:Read, Zone:Edit (DNS) e
   Email Routing:Edit.

   Corre-se quantas vezes se quiser: não duplica nada.
   ========================================================================= */

import { readFileSync, existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { homedir } from 'node:os';

const AQUI = dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(readFileSync(join(AQUI, '..', '_fonte', 'config.json'), 'utf8'));

const DOMINIO = config.dominio;
const argumentos = process.argv.slice(2);
const iDestino = argumentos.indexOf('--destino');
const DESTINO = iDestino >= 0 ? argumentos[iDestino + 1] : config.entidade?.email;

/* As caixas que interessam. Tudo cai no mesmo sítio, mas com endereços
   separados sabe-se de onde veio cada mensagem — e um dia é fácil mandar o
   `balcao@` para outra pessoa sem mexer no resto. */
const CAIXAS = ['ola', 'balcao', 'privacidade'];

if (!DESTINO) {
  console.error('Falta o destino. Põe `entidade.email` no config.json ou usa --destino.');
  process.exit(1);
}

/* --- autenticação -------------------------------------------------------- */

function token() {
  if (process.env.CLOUDFLARE_API_TOKEN) {
    return { valor: process.env.CLOUDFLARE_API_TOKEN, origem: 'CLOUDFLARE_API_TOKEN' };
  }
  const p = join(homedir(), '.wrangler', 'config', 'default.toml');
  if (existsSync(p)) {
    const m = readFileSync(p, 'utf8').match(/oauth_token\s*=\s*"([^"]+)"/);
    if (m) return { valor: m[1], origem: 'wrangler' };
  }
  return null;
}

const chave = token();
if (!chave) {
  console.error('Sem credenciais. Corre `npx wrangler login` ou define CLOUDFLARE_API_TOKEN.');
  process.exit(1);
}

const API = 'https://api.cloudflare.com/client/v4';

async function cf(caminho, { metodo = 'GET', corpo } = {}) {
  const r = await fetch(API + caminho, {
    method: metodo,
    headers: {
      authorization: `Bearer ${chave.valor}`,
      'content-type': 'application/json',
    },
    body: corpo === undefined ? undefined : JSON.stringify(corpo),
  });
  const d = await r.json().catch(() => ({}));
  return { ok: r.ok && d.success !== false, estado: r.status, dados: d };
}

/* --- 1. a zona ----------------------------------------------------------- */

console.log(`\nEmail Routing para ${DOMINIO} → ${DESTINO}`);
console.log(`(credenciais: ${chave.origem})\n`);

const zonas = await cf(`/zones?name=${encodeURIComponent(DOMINIO)}`);
if (!zonas.ok) {
  console.error('Não deu para consultar as zonas:',
    JSON.stringify(zonas.dados.errors || zonas.dados).slice(0, 300));
  process.exit(1);
}
const zona = zonas.dados.result?.[0];
if (!zona) {
  console.error(`O domínio ${DOMINIO} ainda não está nesta conta Cloudflare.\n`);
  console.error('Primeiro:');
  console.error('  1. dash.cloudflare.com → Add a domain → ' + DOMINIO);
  console.error('  2. a Cloudflare dá dois servidores de nomes;');
  console.error('     mete-os no registador onde compraste o domínio');
  console.error('  3. espera pela propagação (costuma ser menos de uma hora)');
  console.error('  4. volta a correr este script\n');
  process.exit(2);
}
console.log(`✓ zona encontrada (${zona.status})`);
if (zona.status !== 'active') {
  console.log('  ! a zona ainda não está activa — os servidores de nomes podem');
  console.log('    não ter propagado. O resto pode falhar; tenta outra vez daqui a pouco.');
}

/* --- 2. ligar o Email Routing -------------------------------------------- */

const estado = await cf(`/zones/${zona.id}/email/routing`);
if (estado.dados.result?.enabled) {
  console.log('✓ Email Routing já estava ligado');
} else {
  const liga = await cf(`/zones/${zona.id}/email/routing/enable`, { metodo: 'POST', corpo: {} });
  console.log(liga.ok ? '✓ Email Routing ligado'
    : `✗ não deu para ligar: ${JSON.stringify(liga.dados.errors || liga.dados).slice(0, 200)}`);
}

/* --- 3. o destino (precisa de confirmação por email) --------------------- */

const enderecos = await cf(`/zones/${zona.id}/email/routing/addresses`);
const existente = (enderecos.dados.result || []).find((a) => a.email === DESTINO);
if (existente) {
  console.log(existente.verified
    ? `✓ destino ${DESTINO} já confirmado`
    : `! destino ${DESTINO} à espera de confirmação — abre o email da Cloudflare`);
} else {
  const novo = await cf(`/zones/${zona.id}/email/routing/addresses`, {
    metodo: 'POST', corpo: { email: DESTINO },
  });
  console.log(novo.ok
    ? `✓ destino ${DESTINO} adicionado — a Cloudflare enviou-lhe um email de confirmação`
    : `✗ não deu para adicionar o destino: ${JSON.stringify(novo.dados.errors || novo.dados).slice(0, 200)}`);
}

/* --- 4. as regras -------------------------------------------------------- */

const regras = await cf(`/zones/${zona.id}/email/routing/rules`);
const jaExistem = new Set();
for (const r of regras.dados.result || []) {
  for (const m of r.matchers || []) if (m.value) jaExistem.add(m.value);
}

for (const caixa of CAIXAS) {
  const endereco = `${caixa}@${DOMINIO}`;
  if (jaExistem.has(endereco)) { console.log(`✓ ${endereco} já reencaminha`); continue; }
  const r = await cf(`/zones/${zona.id}/email/routing/rules`, {
    metodo: 'POST',
    corpo: {
      name: `${endereco} → ${DESTINO}`,
      enabled: true,
      matchers: [{ type: 'literal', field: 'to', value: endereco }],
      actions: [{ type: 'forward', value: [DESTINO] }],
    },
  });
  console.log(r.ok ? `✓ ${endereco} → ${DESTINO}`
    : `✗ ${endereco}: ${JSON.stringify(r.dados.errors || r.dados).slice(0, 160)}`);
}

/* Apanha-tudo: o que chegar a um endereço que não existe não se perde. */
const apanha = await cf(`/zones/${zona.id}/email/routing/rules/catch_all`);
const jaApanha = apanha.dados.result?.enabled
  && (apanha.dados.result.actions || []).some((a) => (a.value || []).includes(DESTINO));
if (jaApanha) {
  console.log('✓ apanha-tudo já estava a reencaminhar');
} else {
  const r = await cf(`/zones/${zona.id}/email/routing/rules/catch_all`, {
    metodo: 'PUT',
    corpo: {
      name: 'Apanha-tudo',
      enabled: true,
      matchers: [{ type: 'all' }],
      actions: [{ type: 'forward', value: [DESTINO] }],
    },
  });
  console.log(r.ok ? '✓ apanha-tudo a reencaminhar'
    : `✗ apanha-tudo: ${JSON.stringify(r.dados.errors || r.dados).slice(0, 160)}`);
}

/* --- 5. o DNS que isto precisa ------------------------------------------- */
/* Com o domínio na Cloudflare os registos são postos automaticamente. Mostra-
   se a lista para se poder confirmar, e para o caso de o DNS estar noutro
   sítio. */
const dns = await cf(`/zones/${zona.id}/email/routing/dns`);
const necessarios = dns.dados.result?.filter?.((x) => x.required !== false) || dns.dados.result || [];
if (necessarios.length) {
  console.log('\nRegistos que o reencaminhamento precisa:');
  for (const r of necessarios) {
    console.log(`  ${r.type.padEnd(5)} ${(r.name || '@').padEnd(28)} ${r.content}`
      + (r.priority !== undefined ? `  (prioridade ${r.priority})` : ''));
  }
}

/* =========================================================================
   ENVIAR — a Resend
   ========================================================================= */

const RESEND = process.env.RESEND_API_KEY;

if (!RESEND) {
  console.log('\n· Sem RESEND_API_KEY: a parte do envio fica por fazer.');
  console.log('  Cria a chave em resend.com/api-keys e volta a correr com');
  console.log('  RESEND_API_KEY=re_... node scripts/email.mjs');
} else {
  console.log('\nEnvio (Resend)');

  async function resend(caminho, { metodo = 'GET', corpo } = {}) {
    const r = await fetch('https://api.resend.com' + caminho, {
      method: metodo,
      headers: { authorization: `Bearer ${RESEND}`, 'content-type': 'application/json' },
      body: corpo === undefined ? undefined : JSON.stringify(corpo),
    });
    const d = await r.json().catch(() => ({}));
    return { ok: r.ok, estado: r.status, dados: d };
  }

  /* 1. o domínio já lá está? */
  const lista = await resend('/domains');
  if (!lista.ok) {
    console.error(`✗ a Resend recusou a chave (${lista.estado}):`,
      JSON.stringify(lista.dados).slice(0, 200));
    process.exit(1);
  }
  let dominio = (lista.dados.data || []).find((d) => d.name === DOMINIO);

  if (!dominio) {
    /* O domínio de topo, e não um subdomínio.
       A recomendação corrente é usar um subdomínio para isolar a reputação —
       e faz sentido para quem envia campanhas. Aqui só saem códigos de
       entrada, e o endereço que a pessoa vê importa mais do que o
       isolamento: um código que chega de `ola@carimbodigital.pt` reconhece-se,
       um que chega de `naoresponder@envio.carimbodigital.pt` parece burla.
       O caminho de devolução da Resend fica num subdomínio dela à mesma, por
       isso o isolamento que interessa continua a existir.

       `eu-west-1` põe o envio na Irlanda. Atenção: os dados da conta e os
       registos da Resend ficam nos Estados Unidos de qualquer maneira — está
       na documentação deles e tem de constar dos subcontratantes. */
    const criado = await resend('/domains', {
      metodo: 'POST', corpo: { name: DOMINIO, region: 'eu-west-1' },
    });
    if (!criado.ok) {
      console.error('✗ não deu para registar o domínio na Resend:',
        JSON.stringify(criado.dados).slice(0, 250));
      process.exit(1);
    }
    dominio = criado.dados;
    console.log(`✓ domínio registado na Resend (${dominio.region || 'eu-west-1'})`);
  } else {
    console.log(`✓ domínio já estava na Resend (${dominio.status})`);
  }

  /* 2. os registos que ela pede, criados na Cloudflare */
  const detalhe = await resend(`/domains/${dominio.id}`);
  const registos = detalhe.dados.records || dominio.records || [];
  if (!registos.length) {
    console.log('  ! a Resend não devolveu registos — confere em resend.com/domains');
  }

  const existentes = await cf(`/zones/${zona.id}/dns_records?per_page=200`);
  const jaLaEsta = (r) => (existentes.dados.result || []).some((x) =>
    x.type === r.type
    && x.name === (r.name.endsWith(DOMINIO) ? r.name : `${r.name}.${DOMINIO}`).replace(/^@\./, '')
    && String(x.content).replace(/^"|"$/g, '') === String(r.value).replace(/^"|"$/g, ''));

  for (const r of registos) {
    const nome = r.name === '@' || !r.name ? DOMINIO
      : (r.name.endsWith(DOMINIO) ? r.name : `${r.name}.${DOMINIO}`);
    if (jaLaEsta(r)) { console.log(`✓ ${r.type.padEnd(5)} ${nome} já existia`); continue; }
    const criado = await cf(`/zones/${zona.id}/dns_records`, {
      metodo: 'POST',
      corpo: {
        type: r.type, name: nome, content: r.value, ttl: 1,
        ...(r.priority !== undefined && r.priority !== null ? { priority: r.priority } : {}),
        /* Nunca com a nuvem laranja: um CNAME que passe pelo proxy da
           Cloudflare deixa de devolver o valor que a Resend espera e a
           verificação nunca conclui. Os registos de autenticação de email
           são lidos por servidores de correio, não por browsers. */
        ...(r.type === 'CNAME' ? { proxied: false } : {}),
      },
    });
    console.log(criado.ok ? `✓ ${r.type.padEnd(5)} ${nome}`
      : `✗ ${r.type} ${nome}: ${JSON.stringify(criado.dados.errors || criado.dados).slice(0, 160)}`);
  }

  /* Os dois MX não se atropelam, e vale a pena dizê-lo: o do Email Routing
     fica no domínio de topo (a receber) e o da Resend num subdomínio de
     devoluções (a enviar). São registos diferentes em nomes diferentes. */

  /* 3. pedir a verificação */
  const verifica = await resend(`/domains/${dominio.id}/verify`, { metodo: 'POST' });
  console.log(verifica.ok
    ? '✓ verificação pedida — costuma demorar alguns minutos'
    : `! não deu para pedir a verificação: ${JSON.stringify(verifica.dados).slice(0, 160)}`);

  console.log('\n  Depois de a Resend dizer «verified», falta pôr a chave no Worker:');
  console.log('    cd worker && npx wrangler secret put RESEND_API_KEY');
  console.log(`    npx wrangler deploy`);
}

console.log('\nFalta só uma coisa, e não é aqui: abrir o email que a Cloudflare');
console.log(`mandou para ${DESTINO} e clicar no link. Sem isso o reencaminhamento`);
console.log('fica configurado mas não entrega nada.\n');
