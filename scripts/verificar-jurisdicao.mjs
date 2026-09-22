#!/usr/bin/env node
/* PERGUNTA À CLOUDFLARE SE A PROMESSA DA PRIVACIDADE É VERDADE.
   ========================================================================
   A secção 5 da privacidade diz que a base de dados está presa à jurisdição
   europeia. Isso é uma afirmação sobre a INFRAESTRUTURA, e nenhuma varredura
   ao repositório a consegue confirmar: o `wrangler.toml` não guarda a
   jurisdição — ela é uma propriedade da base, definida na criação, e o
   ficheiro só sabe o `database_id`.

   Foi assim que a frase errada sobreviveu meses. Dizia «numa região da União
   Europeia (D1 e Workers, weur)» e havia três erros numa linha:

     · `weur` é uma DICA. A documentação da Cloudflare diz, à letra, que uma
       location hint «does not ensure your preferred placement».
     · «Europa Ocidental» não é a União Europeia.
     · os Workers nunca estiveram restringidos a região nenhuma — o código
       corre ao pé de quem abre a app, e é isso que o torna rápido.

   Isto NÃO corre no CI, e de propósito: o CI não tem credenciais da
   Cloudflare, e uma guarda que se salta em silêncio é pior do que nenhuma —
   fica toda a gente a achar que alguém verificou. Corre-se à mão, aqui:

       node scripts/verificar-jurisdicao.mjs

   e corre-se sempre que se mexer na secção 5 da privacidade ou na base.
   ======================================================================== */
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..');
const WORKER = join(RAIZ, 'worker');
/* DE FORA DA PASTA DO WORKER, E PELO ID. À primeira escrevi isto a correr
   dentro de `worker/` e a passar o NOME da base — e o wrangler respondeu a
   partir do `wrangler.toml` que lá está, sem chegar a perguntar à Cloudflare.
   Prova: com o nome novo e o `database_id` antigo no ficheiro, devolveu a base
   antiga e disse «jurisdição: nenhuma» para um nome que tem `eu`; e a linha
   que comparava os dois ids passava sempre, porque comparava o ficheiro
   consigo próprio. Longe de qualquer configuração, e pelo id, a resposta é da
   Cloudflare. */
const NEUTRO = tmpdir();

let erros = 0;
const falhar = (m) => { console.error(`  ✗ ${m}`); erros++; };
const bem = (m) => console.log(`  ✓ ${m}`);

/* O nome da base sai do wrangler.toml, e não daqui: escrevê-lo à mão era
   voltar a ter dois sítios a responder à mesma pergunta. */
const toml = readFileSync(join(WORKER, 'wrangler.toml'), 'utf8');
const bloco = toml.slice(toml.indexOf('[[d1_databases]]'));
const nome = (bloco.match(/database_name\s*=\s*"([^"]+)"/) || [])[1];
const id = (bloco.match(/database_id\s*=\s*"([^"]+)"/) || [])[1];
if (!nome || !id) {
  console.error('não encontrei database_name/database_id no wrangler.toml');
  process.exit(1);
}

console.log(`\nA base que o Worker usa: ${nome} (${id})\n`);

let info;
try {
  const bruto = execFileSync('npx', ['--yes', 'wrangler', 'd1', 'info', id, '--json'],
    { cwd: NEUTRO, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  info = JSON.parse(bruto.slice(bruto.indexOf('{')));
} catch (erro) {
  console.error('  ✗ não consegui perguntar à Cloudflare. Estás autenticado?'
    + `\n    ${String(erro.message).split('\n')[0]}`);
  process.exit(1);
}

/* O id é o que liga mesmo; o nome é só para as pessoas. Se os dois
   discordarem, alguém mexeu num e esqueceu o outro — e a partir daí todos os
   comandos escritos com o nome vão para outro sítio. */
if (info.name !== nome) {
  falhar(`o wrangler.toml chama-lhe «${nome}», mas ${id} é a base «${info.name}»`);
} else bem(`o nome e o id do wrangler.toml são da mesma base`);

if (info.jurisdiction !== 'eu') {
  falhar(`jurisdição: ${info.jurisdiction || 'nenhuma'} — a privacidade promete a europeia,`
    + ' e uma dica de localização não a cumpre. A jurisdição só se define ao criar a base:'
    + ' é preciso criar outra e copiar os dados.');
} else bem(`jurisdição «eu»: a Cloudflare obriga-se a correr e guardar só na União Europeia`);

/* E a página tem de continuar a dizer isto. Uma promessa que se apaga do
   texto deixa de estar coberta, mas também deixa de estar prometida — por
   isso isto é um aviso e não um erro. */
const pagina = readFileSync(join(RAIZ, '_fonte', 'paginas', 'privacidade.html'), 'utf8');
if (!/jurisdi[çc][ãa]o\s*(<[^>]*>)*\s*<code>eu<\/code>/i.test(pagina)) {
  console.warn('  ! a privacidade já não fala da jurisdição «eu» — confirma que é de propósito');
}

console.log(`\n${erros ? '✗' : '✓'} ${erros} erros.\n`);
process.exit(erros ? 1 : 0);
