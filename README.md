# Carimbo Digital

**O cartão de carimbos, sem o papel.**
Todos os cartões de fidelidade num só sítio. O cliente mostra um código, o
balcão aponta a câmara, o carimbo aparece nos dois telemóveis.

> A marca é um pedaço do próprio produto: três casas carimbadas e uma por
> carimbar, com o mesmo tracejado que a app usa nas casas vazias.

**Domínio:** `carimbodigital.pt` (comprado; à espera de atribuição).
**No ar:** https://renatovalente5.github.io/CarimboDigital/
**API:** `https://carimbodigital-api.renato-lima-valente-dcb.workers.dev`

---

## O que é

Três coisas no mesmo repositório:

| | O quê | Onde |
|---|---|---|
| **Site** | Apresentação, páginas legais | `/` |
| **App do cliente** | A carteira de cartões e o código | `/app/` |
| **Balcão** | O leitor de códigos do comerciante | `/balcao/` |
| **API** | Cloudflare Worker + D1 | `worker/` |

Tudo isto corre a **0 €/mês**. O único custo é o domínio.

## Como está feito

- **Sem dependências.** Não há `package.json`, não há `npm install`, não há
  passo de compilação. O gerador é Node puro; o front-end é JavaScript de
  módulos nativos. É o que faz isto continuar a publicar daqui a três anos
  sem ninguém lhe tocar.
- **O gerador de códigos QR é nosso** (`_fonte/js/qr.js`, 6 kB). Modo byte,
  níveis L/M/Q/H, versões 1 a 40, escolha de máscara pela penalização da
  norma. Está provado contra um descodificador independente escrito em
  Python — 320 matrizes, síndromes de Reed-Solomon a zero e o texto a voltar
  igual.
- **Funciona sem rede.** O código do cliente é calculado no telemóvel a
  partir de uma chave que lá vive. Numa cave sem sinal, o cartão aparece na
  mesma.

## Correr em casa

```bash
node scripts/gerar.mjs     # constrói para _site/
node scripts/servir.mjs    # http://localhost:4321/CarimboDigital/
```

O `_fonte/config.json` já aponta para a API publicada, por isso corre contra
o servidor a sério. Para trabalhar sem rede, esvazia o campo `api`.

**Modo de demonstração:** `?demo=1` em qualquer das apps liga uma
implementação completa das regras dentro do browser (arrefecimento, prémios,
movimentos), sem servidor nenhum. `?demo=0` sai. Os dados da demonstração
ficam noutro espaço de chaves, por isso não tocam na conta a sério — serve
para mostrar o produto a um dono de café no próprio telemóvel.

Para correr com a API a sério:

```bash
cd worker
npx wrangler d1 execute carimbodigital --local --file=esquema.sql
npx wrangler d1 execute carimbodigital --local --file=semear.sql
node -e "console.log('CHAVE_MESTRA=' + require('crypto').randomBytes(32).toString('base64url'))" > .dev.vars
npx wrangler dev --local
```

e põe `"api": "http://localhost:8787"` em `_fonte/config.json`.

## Provar

```bash
node scripts/verificar-qr.mjs      # 320 matrizes lidas por um descodificador independente
node scripts/verificar-leitor.mjs  # o leitor, contra códigos tortos e desfocados
node worker/testes.mjs          # 53 casos contra a API (precisa do wrangler a correr)
node scripts/auditar.mjs        # ligações, prefixos, manifestos, dados legais, segredos
```

O CI corre os três. Se algum falhar, não se publica.

## Publicar

### O site (GitHub Pages)

Empurrar para `main` chega. O workflow prova, constrói, audita e publica.

Enquanto não houver domínio próprio, o site vive em `/CarimboDigital/` e o gerador
mete esse prefixo em todos os caminhos sozinho. **Assim que o domínio
existir**, cria um ficheiro `CNAME` na raiz com o domínio lá dentro: o
prefixo desaparece e tudo passa a apontar para a raiz.

> **Compra o domínio antes de dar o link a alguém.** As contas dos clientes
> são guardadas por origem (`localStorage` + `IndexedDB`). Mudar de
> `renatovalente5.github.io/CarimboDigital` para `carimbodigital.pt` apaga todas as contas
> criadas até lá. Com dois utilizadores não custa nada; com duzentos, custa
> os duzentos.

### A API (Cloudflare Worker)

**Já está publicada.** A base de dados D1 vive na Europa Ocidental
(`--location=weur`) e os segredos estão postos. Para voltar a publicar depois
de mexer no `worker/src/index.js`:

```bash
cd worker && npx wrangler deploy
```

Se um dia for preciso recomeçar do zero:

```bash
cd worker
npx wrangler d1 create carimbodigital --location=weur
# copia o database_id para o wrangler.toml
npx wrangler d1 execute carimbodigital --remote --file=esquema.sql
npx wrangler secret put CHAVE_MESTRA      # 32 bytes em base64url
npx wrangler secret put CODIGO_FUNDADOR   # o convite para criar negócios
npx wrangler secret put RESEND_API_KEY    # opcional, para os emails
npx wrangler deploy
```

### Criar um negócio

Enquanto o serviço estiver por convite, um negócio nasce em
**Balcão › Tenho um convite**, com o código que está no segredo
`CODIGO_FUNDADOR` do Worker. Depois disso, quem manda entra pelo email.

O problema do primeiro operador é real e não tem volta a dar: para entrar é
preciso sessão, para ter sessão é preciso um código por email, e para receber
o código é preciso já existir um operador. O convite é quem corta o nó.

### Emails

São duas metades separadas, e é preciso as duas.

**Receber** — o Email Routing da Cloudflare põe `ola@`, `balcao@` e
`privacidade@` a cair na caixa pessoal, mais um apanha-tudo. Gratuito.

**Enviar** — os códigos de recuperação saem pela Resend (100/dia, 3 000/mês
no plano gratuito). Precisa de provar que o domínio é nosso, com registos de
DNS.

Ambas só funcionam **depois de o domínio estar na Cloudflare**, ou seja
depois de os servidores de nomes do registador apontarem para lá. Até esse
dia o serviço funciona à mesma: quem perder o telemóvel é que perde os
cartões, e o balcão entra por convite em vez de por email.

Quando o domínio chegar, por esta ordem:

```bash
# 1. o domínio na Cloudflare (dash.cloudflare.com → Add a domain),
#    e os servidores de nomes que ela dá metidos no registador

# 2. as duas metades, num comando
cd ~/Websites/CarimboDigital
RESEND_API_KEY=re_... node scripts/email.mjs

# 3. a chave no Worker — escrita por ti, para não passar por mais lado nenhum
cd worker
npx wrangler secret put RESEND_API_KEY
npx wrangler deploy
```

O script regista o domínio na Resend, pede-lhe a lista de registos de DNS
(SPF, DKIM e afins) e cria-os na Cloudflare — em vez de os copiar à mão de
uma janela para a outra, que é onde se erra um carácter e se perdem duas
horas. Depois pede a verificação.

Falta sempre uma coisa que nenhum script pode fazer: abrir o email que a
Cloudflare manda para confirmar o destino do reencaminhamento, e clicar.

**Se um envio falhar**, o motivo fica na consola do Worker:

```bash
cd worker && npx wrangler tail
```

A app não finge que enviou: se o email não sair, diz-o e deixa tentar outra
vez, em vez de mandar esperar por um código que nunca vem.

**A jurisdição escolhe-se na criação e não se muda depois.** `--location=weur`
põe a base de dados na Europa Ocidental. Para a garantia jurídica de
residência europeia usa-se `npx wrangler d1 create carimbodigital --jurisdiction eu` —
mas isso é irreversível, por isso decide-se antes.

## Contas grátis

| Serviço | Limite gratuito | Quando é que dói |
|---|---|---|
| GitHub Pages | 100 GB/mês, 10 construções/hora | nunca, para um site destes |
| Cloudflare Workers | 100 000 pedidos/dia | ~30 000 carimbos/dia |
| Cloudflare D1 | 5 GB, 5 M linhas lidas/dia, 100 000 escritas/dia | um carimbo escreve 3 linhas |
| Resend (email) | 100/dia, 3 000/mês | só se usa para recuperar contas |

Desde 1 de setembro de 2026 os limites do D1 são **impostos**: passado o
tecto as consultas falham até à meia-noite UTC, em vez de serem toleradas.

## Aquilo em que se pode tropeçar

- **O segredo do dispositivo nunca sai do telemóvel.** É guardado como
  `CryptoKey` não-extraível no IndexedDB: nem um script injectado nem o dono
  do telemóvel o conseguem copiar para outro aparelho. O servidor não o
  guarda — volta a derivá-lo da `CHAVE_MESTRA`.
- **Mudar a `CHAVE_MESTRA` invalida todos os códigos.** Existe uma coluna
  `chave_versao` na tabela `clientes` para uma futura rotação; enquanto não
  estiver implementada, não se muda a chave.
- **O leitor de códigos também é nosso** (`_fonte/js/qr-leitor.js`), porque o
  `BarcodeDetector` não existe no Safari e sem ele um balcão com iPhone ficava
  sem câmara. Faz binarização por blocos, encontra os olhos pela cadência
  1:1:3:1:1, monta uma transformação de perspectiva pelo padrão de alinhamento
  e corrige erros por Reed-Solomon. Lê o código real em 95% dos fotogramas em
  24 ângulos × 3 inclinações × 2 tamanhos, com desfoque, grão e luz de lado —
  e a 20 ms por fotograma. Onde o `BarcodeDetector` existe, é ele que trabalha.
- **Links de email não funcionam dentro de uma app instalada no iOS.** Por
  isso a recuperação de conta é por **código de seis algarismos**, e não por
  ligação.
- **O `_site/` não vai para o repositório.** É gerado.

## Estrutura

```
_fonte/          o que se edita
  config.json      nome, domínio, endereço da API, dados da entidade
  paginas/         as páginas do site
  parciais/        molde, cabeçalho, rodapé
  app/             a aplicação do cliente
  balcao/          a aplicação do comerciante
  estilos/         nucleo (fichas de design) + app + balcao + site
  js/              nucleo, api, qr
  imagens/         marca e ícones
scripts/         gerar, servir, auditar, icones, verificar-qr
worker/          a API: esquema.sql, src/index.js, testes.mjs
_site/           o que se publica (gerado)
```

## Marca

| | |
|---|---|
| Tinta (primária) | `#5A31E8` |
| Papel (fundo) | `#FBFAF7` |
| Tinta escura (texto) | `#17161C` |
| Logótipo | `_fonte/imagens/marca.svg` |
| Ícones | `node scripts/icones.mjs` (regenera tudo a partir do símbolo) |

O nome escreve-se sempre em duas espessuras: **Carimbo** pesado, *Digital*
leve e mais claro. A classe `.marca-palavra` faz isso. Nunca em maiúsculas
todas, nunca com o símbolo esticado.

## Licença

Sem licença definida. Todos os direitos reservados até haver decisão.
