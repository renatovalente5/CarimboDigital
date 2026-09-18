/* =========================================================================
   Bateria · 19 — Mudei de telemóvel

   O ecrã que ninguém procura até precisar dele, e aí é o único que interessa:
   a pessoa trocou de telemóvel e quer os cartões de volta. Não tinha uma
   única afirmação — era a metade por provar da entrada, e a que custa mais
   caro se estiver partida, porque quem lá chega já não tem por onde voltar.

   O que se persegue:

   · CHEGA-SE LÁ. O «Já tenho conta noutro telemóvel» tem de abrir alguma
     coisa. Durante muito tempo deu um aviso e mais nada, e um aviso não
     devolve cartões a ninguém.

   · O PAINEL NÃO É O DE GUARDAR. Chamar-lhe «Guardar a conta» a quem já tem
     conta é dizer-lhe que está a criar outra — e quem acabou de perder os
     cartões lê isso como «perdi-os de vez».

   · NOMEIA AS PORTAS QUE EXISTEM, e só essas. O texto de cima dizia «duas
     formas» e nomeava a Google; ficou a mentir no dia em que entrou a Apple.
     Agora sai das portas que o servidor diz estarem abertas, e prova-se que
     cada nome que ele diz tem mesmo um botão por baixo.

   · E DIZ QUE É UMA DEMONSTRAÇÃO. Aqui não há conta noutro telemóvel nenhuma
     para ir buscar. Mostra-se o caminho todo e diz-se isso por escrito, em
     vez de deixar alguém sair daqui a pensar que recuperou alguma coisa.

   Corre em modo de demonstração — é onde o caminho todo acontece sem sair do
   site. A troca a sério com cada provedor prova-se no `worker/testes.mjs`.
   ========================================================================= */

export const nome = '19 · Mudei de telemóvel';

const SALTAR = '#bv-saltar';

export async function correr(palco, certo) {
  await palco.ir('/app/?demo=1');

  /* --- 1. O BOTÃO ESTÁ NAS BOAS-VINDAS, E LÊ-SE ------------------------ */
  await palco.esperar(SALTAR);
  const rotulo = await palco.texto(SALTAR);
  certo(/conta/i.test(rotulo) && /telem[óo]vel/i.test(rotulo),
    'as boas-vindas têm um caminho para quem já tem conta noutro telemóvel', rotulo);
  certo(await palco.visivel(SALTAR),
    'e ele está mesmo visível, não só no HTML');

  /* --- 2. ABRE UM PAINEL, E NÃO UM AVISO ------------------------------- */
  /* Isto reprovava: na demonstração o botão dava uma mensagem e ficava tudo
     como estava. O ecrã que mais falta faz ver antes de se precisar dele era
     precisamente o que não se via. */
  await palco.clicar(SALTAR);
  await palco.esperar('#painel');
  certo(await palco.visivel('#painel'),
    'e carregar nele abre o painel — não um aviso que desaparece sozinho');

  const titulo = await palco.texto('#painel h2, #painel .painel-titulo');
  certo(/recuperar/i.test(titulo),
    'o painel chama-se «Recuperar os cartões» e não «Guardar a conta» — '
    + 'quem já tem conta não está a criar outra', titulo);

  /* --- 3. AS BOAS-VINDAS NÃO VOLTAM ------------------------------------ */
  /* Quem passou por aqui já escolheu; mostrar-lhe os quatro passos outra vez
     por cima do painel seria pô-la a começar do princípio. */
  certo(!(await palco.visivel('#boas-vindas')),
    'e as boas-vindas ficam para trás — não voltam por cima do painel');

  /* --- 4. DIZ QUE É UMA DEMONSTRAÇÃO, ANTES DOS BOTÕES ----------------- */
  const texto = await palco.texto('#painel');
  certo(texto.includes('não há conta noutro telemóvel'),
    'e diz, por escrito, que aqui não há nada de verdade para ir buscar', texto.slice(0, 200));

  /* --- 5. O TEXTO DE CIMA NOMEIA AS PORTAS QUE EXISTEM ----------------- */
  /* Cada nome que ele diz tem de ter um botão por baixo. É a afirmação que
     apanha o parágrafo escrito à mão a envelhecer: dizia «duas formas» com
     três portas abertas. */
  await palco.esperar('#painel .btn-google, #painel #campo-email');
  const intro = await palco.texto('#painel .subtexto');
  certo(intro.length > 0, 'o painel tem uma frase a explicar o que fazer', intro);

  const promete = {
    'com a Google': '#painel .btn-google',
    'com a Apple': '#painel .btn-apple',
    'com um email': '#painel #campo-email',
  };
  let ditas = 0, semBotao = [];
  for (const [nomePorta, seletor] of Object.entries(promete)) {
    if (!intro.includes(nomePorta)) continue;
    ditas++;
    if (!(await palco.ver(seletor))) semBotao.push(nomePorta);
  }
  certo(ditas >= 2,
    `a frase nomeia as portas abertas (${ditas} nomeadas)`, intro);
  certo(semBotao.length === 0,
    'e cada porta que ela nomeia tem mesmo um botão por baixo',
    semBotao.join(', ') || 'nenhuma em falta');

  /* E o contrário: uma porta com botão tem de estar nomeada. Senão a frase
     esconde uma forma de entrar a quem está a tentar todas. */
  const porNomear = [];
  for (const [nomePorta, seletor] of Object.entries(promete)) {
    if ((await palco.ver(seletor)) && !intro.includes(nomePorta)) porNomear.push(nomePorta);
  }
  certo(porNomear.length === 0,
    'e nenhuma porta fica por nomear — a frase não esconde caminhos',
    porNomear.join(', ') || 'nenhuma por nomear');

  /* --- 6. O «OU» SEPARA, E ESTÁ NO SÍTIO ------------------------------- */
  const ou = await palco.medir('#painel .ou');
  const google = await palco.medir('#painel .btn-google');
  const campo = await palco.medir('#painel #campo-email');
  certo(Boolean(ou) && Boolean(google) && Boolean(campo),
    'com portas de provedor e email há os três: botões, «ou», e o campo');
  if (ou && google && campo) {
    certo(ou.y > google.y && ou.y < campo.y,
      'e o «ou» fica entre os botões e o campo — é o que ele separa',
      `ou=${Math.round(ou.y)} google=${Math.round(google.y)} campo=${Math.round(campo.y)}`);
  }

  /* --- 7. ENTRA-SE POR ALI MESMO --------------------------------------- */
  /* O caminho até ao fim: carregar na porta, o painel fecha-se, a app pinta-se
     e a conta fica guardada. É o que a pessoa veio cá fazer. */
  await palco.clicar('#painel .btn-google');
  await palco.sumir('#painel', 8000);
  await palco.esperar('#barra .barra-item');
  certo(await palco.contar('#barra .barra-item') === 5,
    'entrando por uma das portas, a app abre inteira — os cinco separadores',
    String(await palco.contar('#barra .barra-item')));
  certo((await palco.textoTodo()).includes('não há Google a sério'),
    'e diz outra vez que na demonstração não foi a Google a sério');

  /* --- 8. E O PERFIL DEIXA DE PEDIR PARA GUARDAR ----------------------- */
  await palco.clicar('.barra-item:nth-child(5)');
  await palco.esperar('#principal .linha-perigo');
  const conta = await palco.texto('#principal section:first-of-type .lista .linha:first-child');
  certo(conta.includes('A conta está guardada'),
    'e o perfil deixa de pedir para guardar uma conta que já está guardada', conta);
  certo(conta.includes('@'),
    'e mostra a morada por onde se entrou, em vez de só dizer que sim', conta);
}
