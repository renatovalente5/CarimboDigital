/* =========================================================================
   Bateria · 01 — arranque das duas apps

   O teste mais aborrecido e o mais importante: a app abre? Se este falhar,
   nenhum dos outros quer dizer nada.

   Corre em modo de demonstração (`?demo=1`), que não é uma maqueta: é a
   mesma interface com as mesmas regras, guardadas no localStorage em vez de
   irem ao Worker. Serve para provar a interface sem depender da rede.
   ========================================================================= */

export const nome = '01 · Arranque das duas apps';

/**
 * ENTRA NA APP. Era «passar as boas-vindas», e mudou de nome porque mudou de
 * trabalho.
 *
 * O passeio deixou de dar acesso a nada: ele mostra o que a app faz e no fim
 * abre a PORTA. A conta é obrigatória, e uma conta só nasce no fim de uma
 * entrada — por isso um teste que queira ver a carteira tem de entrar, como
 * qualquer pessoa. Entra-se pelo email, que é o caminho que não depende de
 * provedor nenhum estar configurado; na demonstração o código é sempre
 * `000000` e está escrito no ecrã.
 *
 * O NOME MUDOU DE PROPÓSITO. Um `passarBoasVindas` que por dentro cria uma
 * conta é uma mentira ao próximo que o ler — e oito módulos chamam-no.
 */
/* A PORTA POR OMISSÃO É A DA GOOGLE, e a escolha não é de gosto.
 *
 * Entrar por email deixa a conta JÁ com uma morada ligada — e meia dúzia de
 * módulos provam justamente o caminho de juntar um email a uma conta que ainda
 * não tem nenhum. Com o email à entrada, o que eles encontravam era o painel
 * de gerir portas em vez do campo, e morriam todos no mesmo sítio por uma
 * razão que nada tinha a ver com o que estavam a provar.
 *
 * A porta do email prova-se onde ela é o assunto: no módulo do arranque e no
 * de mudar de telemóvel. */
export async function entrarNaApp(palco, { email = 'bateria@exemplo.pt', porta = 'google' } = {}) {
  /* ESPERA-SE QUE O ARRANQUE DECIDA, e só depois se pergunta o que ele decidiu.
   *
   * Perguntar «o passeio está à vista?» no instante a seguir a navegar é
   * perguntar antes de haver resposta: o arranque vai ao armazenamento, ao
   * cofre e — quando há volta de um provedor — à rede, e só então mostra a
   * porta ou a app. A resposta «não está à vista» chegava antes de o passeio
   * nascer, o ajudante dava a entrada por feita, e quem chamava ficava doze
   * segundos à espera de uma barra que ninguém ia pintar. */
  const pronto = await palco.js(`
    for (let i = 0; i < 120; i++) {
      const bv = document.querySelector('#boas-vindas');
      if (bv && !bv.hidden && bv.getBoundingClientRect().height > 0) return 'porta';
      if (document.querySelector('#barra .barra-item')) return 'dentro';
      await new Promise((r) => setTimeout(r, 100));
    }
    return 'nada';`);
  if (pronto !== 'porta') return false;

  /* Salta-se o passeio: quem o quiser provar prova-o à parte, e três cliques
     por módulo são três cliques que nada acrescentam. */
  await palco.clicar('#bv-saltar');

  /* PELA PORTA QUE SE PEDIR. A do email é a que não depende de provedor
     nenhum estar configurado, e é a omissão — mas quem entra por ela fica com
     uma conta que JÁ tem email, e um módulo que queira provar o caminho de
     juntar um email precisa de entrar por outro lado. */
  if (porta !== 'email') {
    const marca = porta === 'apple' ? 'Apple' : 'Google';
    await palco.esperar(`#painel button[data-porta="${porta}"]`, 10000);
    await palco.clicar(`#painel button[data-porta="${porta}"]`);
    await palco.esperar('#barra .barra-item', 12000);
    return true;
  }
  /* ESPERA-SE PELO BOTÃO E NÃO PELO CAMPO.
   *
   * O painel pinta-se em dois tempos: primeiro o texto, e só depois de o
   * servidor dizer que portas estão abertas é que nasce a oferta — campo,
   * botão e tudo. Esperar pelo CAMPO apanhava-o no instante entre as duas
   * pinturas: o `esperar` dava-o por encontrado e o `escrever`, logo a seguir,
   * já não o achava. O botão é o último a nascer, por isso é ele o sinal de
   * que o painel está feito. */
  await palco.esperar('#botao-enviar', 10000);
  await palco.escrever('#campo-email', email);
  await palco.clicar('#botao-enviar');
  await palco.esperar('#campo-codigo', 8000);
  await palco.escrever('#campo-codigo', '000000');
  /* O BOTÃO PODE JÁ NÃO LÁ ESTAR, e não é defeito: o campo do código confirma
     sozinho ao sexto algarismo — é o que poupa um toque a quem está ao balcão.
     Clica-se se ele existir, e segue-se se não existir; o que decide é o que
     vem a seguir, não este clique. */
  await palco.js(`
    const b = [...document.querySelectorAll('button')]
      .find((x) => x.textContent.trim() === 'Confirmar');
    if (b) b.click();
    return Boolean(b);`);

  /* A ENTRADA RECARREGA A PÁGINA, de propósito: a app levanta-se com a sessão
     nova em vez de remendar meio estado. Espera-se pelo que só existe do outro
     lado do recarregar. */
  await palco.esperar('#barra .barra-item', 12000);
  return true;
}

/** O nome antigo, para não partir o que ainda não foi lido. */
export const passarBoasVindas = entrarNaApp;

/* =========================================================================
   O MAÇO DA CARTEIRA — dois gestos que todos os módulos precisam

   Os cartões da carteira estão empilhados como na carteira do telemóvel: vê-se
   a faixa de cada um e mais nada. Tudo o resto — a grelha, o trilho, o rodapé,
   o botão de ir ao cartão todo — vive num painel que só existe quando aquele
   cartão está aberto, e só um está aberto de cada vez.

   Isto vive aqui, ao lado do `passarBoasVindas`, porque são onze os sítios que
   precisam do mesmo gesto. Escrito onze vezes, bastava um deles esquecer-se de
   esperar pela abertura para medir o painel a meio do desvanecimento.
   ========================================================================= */

/** O selector de um cartão do maço, pela ordem em que está na carteira. */
export const CARTAO_DO_MACO = (n) => `#principal .pilha > .cartao:nth-of-type(${n})`;

/**
 * Abre um cartão do maço e espera que ele acabe de abrir.
 *
 * `qual` é o número de ordem (1 é o primeiro) ou o nome do café.
 *
 * ESPERAR NÃO É CORTESIA. O painel entra com um desvanecimento, e uma medição
 * feita a meio lê o texto a 11% de opacidade — a varredura do contraste chegou
 * a acusar quatro pares ilegíveis que ninguém vê. Espera-se só pelas animações
 * que ACABAM: uma infinita nunca cumpre a promessa e deixava isto pendurado.
 */
export async function abrirNoMaco(palco, qual) {
  const escolha = typeof qual === 'number'
    ? `cartoes[${qual - 1}]`
    : `cartoes.find((n) => n.querySelector('.cartao-nome')?.textContent.trim()
        === ${JSON.stringify(String(qual))})`;
  return palco.js(`
    const cartoes = [...document.querySelectorAll('#principal .pilha > .cartao')];
    const alvo = ${escolha};
    if (!alvo) return false;
    const aba = alvo.querySelector('.cartao-aba');
    if (aba.getAttribute('aria-expanded') !== 'true') aba.click();
    await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
    await Promise.all(alvo.getAnimations({ subtree: true })
      .filter((a) => a.effect && a.effect.getTiming().iterations !== Infinity)
      .map((a) => a.finished.catch(() => {})));
    return true;`);
}

/**
 * Abre o cartão no maço e entra no ecrã do cartão todo.
 *
 * Eram dois gestos que andavam sempre juntos, e separá-los só servia para
 * alguém se esquecer do primeiro e ficar a olhar para um botão escondido.
 */
export async function abrirOCartaoTodo(palco, qual) {
  const havia = await abrirNoMaco(palco, qual);
  /* REBENTA À CLARA em vez de devolver `false` em silêncio. Um `false` deixava
     o teste no ecrã errado e a falha aparecia oito segundos depois, como «não
     apareceu o cartão grande» — a apontar para o produto quando o defeito era
     um índice errado no próprio teste. */
  if (!havia) throw new Error(`não há no maço o cartão «${qual}»`);
  await palco.clicar('#principal .cartao[data-aberto="sim"] .btn-cartao');
  await palco.esperar('#principal .cartao-grande', 8000);
  return true;
}

export async function correr(palco, certo) {
  /* --- app do cliente --------------------------------------------------- */
  await palco.ir('/app/?demo=1');

  certo(await palco.ver('#aplicacao'), 'app do cliente: o esqueleto existe');
  certo(await palco.ver('#boas-vindas'), 'app do cliente: as boas-vindas aparecem à primeira');

  /* A BARRA DA DEMONSTRAÇÃO TEM DE SE VER AQUI, no primeiro ecrã de todos.

     Nasceu com `z-index: 60`, o mesmo do ecrã de boas-vindas — e como o ecrã
     de boas-vindas vem depois no documento, ganhava o empate. O aviso de que
     aquilo é uma demonstração estava lá, com 60 px de altura, completamente
     tapado, precisamente no ecrã de quem acabou de entrar. Não se via no
     código: viu-se a olhar para o site publicado.

     Não chega perguntar se a barra existe nem se está «visível» — os dois
     diziam que sim. A pergunta é quem é que o browser encontra no ponto onde
     ela está. */
  const noTopo = await palco.js(`
    const b = document.querySelector('#barra-demo');
    if (!b) return { erro: 'não há barra' };
    const c = b.getBoundingClientRect();
    if (c.height < 10) return { erro: 'a barra não tem altura', altura: c.height };
    const emCima = document.elementFromPoint(Math.round(c.width / 2), Math.round(c.height / 2));
    return {
      altura: Math.round(c.height),
      daBarra: !!(emCima && emCima.closest('#barra-demo')),
      quemTapa: emCima ? (emCima.id || emCima.className || emCima.tagName) : 'ninguém',
    };
  `);
  certo(noTopo && noTopo.daBarra,
    'a barra da demonstração está à frente das boas-vindas, e não atrás delas',
    `no ponto dela está «${noTopo?.quemTapa ?? noTopo?.erro}»`);

  /* O PASSEIO JÁ NÃO ACABA NA APP: acaba na porta, e é a entrada que acaba na
     app. A pergunta passa a ser a que interessa — de um telemóvel limpo,
     consegue-se entrar? */
  const entrou = await entrarNaApp(palco);
  certo(entrou === true,
    'app do cliente: de um telemóvel limpo, entra-se e chega-se à app',
    `entrarNaApp devolveu ${JSON.stringify(entrou)}`);

  await palco.esperar('#barra .barra-item');
  const separadores = await palco.textos('.barra-item');
  certo(separadores.length === 3,
    `app do cliente: a barra tem 3 separadores`, `tem ${separadores.length}: ${separadores}`);
  certo(separadores.join('|') === 'Carteira|Código|Perfil',
    'app do cliente: os separadores são os esperados', separadores.join('|'));

  /* Um título vazio é o sinal mais barato de que a pintura não aconteceu. */
  const titulo = await palco.texto('#topo-titulo');
  certo(!!titulo, 'app do cliente: o topo tem título', String(titulo));

  const corpo = await palco.texto('#principal');
  certo(corpo && corpo.length > 10,
    'app do cliente: o conteúdo principal não está vazio',
    `tem ${corpo ? corpo.length : 0} caracteres`);

  await palco.captura('01-app-carteira');

  /* --- balcão ----------------------------------------------------------- */
  await palco.ir('/balcao/?demo=1');
  certo(await palco.ver('#entrada') || await palco.ver('#barra'),
    'balcão: abre na entrada ou já dentro');

  const textoBalcao = await palco.textoTodo();
  certo(textoBalcao.length > 20, 'balcão: tem conteúdo', `${textoBalcao.length} caracteres`);
  certo(!/undefined|NaN|\[object Object\]/.test(textoBalcao),
    'balcão: nada de «undefined», «NaN» ou «[object Object]» no ecrã');

  await palco.captura('01-balcao-entrada');

  /* --- o site ----------------------------------------------------------- */
  await palco.ir('/');
  certo(await palco.ver('h1'), 'site: a página inicial tem um h1');
  const textoSite = await palco.textoTodo();
  certo(!/\{\{|POR PREENCHER/.test(textoSite),
    'site: nenhum marcador por resolver à vista');
}
