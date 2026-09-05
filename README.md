# Sinete

**O cartão de carimbos, sem o papel.**
Todos os cartões de fidelidade num só sítio. O cliente mostra um código, o
balcão aponta a câmara, o carimbo aparece nos dois telemóveis.

> *Sinete* (do latim *signum*) é o anel de selar — o objecto que deixa a
> marca. Daí o nome e daí a marca gráfica: um disco de lacre com a impressão
> gravada.

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
node scripts/servir.mjs    # http://localhost:4321/Sinete/
```

Sem mais nada, a app corre em **modo de demonstração**: implementa as regras
todas dentro do browser (arrefecimento, prémios, movimentos) e guarda no
`localStorage`. Serve para experimentar tudo sem servidor nenhum.

Para correr com a API a sério:

```bash
cd worker
npx wrangler d1 execute sinete --local --file=esquema.sql
npx wrangler d1 execute sinete --local --file=semear.sql
node -e "console.log('CHAVE_MESTRA=' + require('crypto').randomBytes(32).toString('base64url'))" > .dev.vars
npx wrangler dev --local
```

e põe `"api": "http://localhost:8787"` em `_fonte/config.json`.

## Provar

```bash
node scripts/verificar-qr.mjs   # 320 matrizes descodificadas por um leitor independente
node worker/testes.mjs          # 53 casos contra a API (precisa do wrangler a correr)
node scripts/auditar.mjs        # ligações, prefixos, manifestos, dados legais, segredos
```

O CI corre os três. Se algum falhar, não se publica.

## Publicar

### O site (GitHub Pages)

Empurrar para `main` chega. O workflow prova, constrói, audita e publica.

Enquanto não houver domínio próprio, o site vive em `/Sinete/` e o gerador
mete esse prefixo em todos os caminhos sozinho. **Assim que o domínio
existir**, cria um ficheiro `CNAME` na raiz com o domínio lá dentro: o
prefixo desaparece e tudo passa a apontar para a raiz.

> **Compra o domínio antes de dar o link a alguém.** As contas dos clientes
> são guardadas por origem (`localStorage` + `IndexedDB`). Mudar de
> `renatovalente5.github.io/Sinete` para `sinete.pt` apaga todas as contas
> criadas até lá. Com dois utilizadores não custa nada; com duzentos, custa
> os duzentos.

### A API (Cloudflare Worker)

```bash
cd worker
npx wrangler d1 create sinete --location=weur   # ver a nota sobre a Europa
# copia o database_id para o wrangler.toml
npx wrangler d1 execute sinete --remote --file=esquema.sql
npx wrangler secret put CHAVE_MESTRA            # 32 bytes em base64url
npx wrangler secret put RESEND_API_KEY          # opcional, para os emails
npx wrangler deploy
```

Depois põe o endereço em `_fonte/config.json` (`"api"`) e volta a publicar o
site.

**A jurisdição escolhe-se na criação e não se muda depois.** `--location=weur`
põe a base de dados na Europa Ocidental. Para a garantia jurídica de
residência europeia usa-se `npx wrangler d1 create sinete --jurisdiction eu` —
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
- **O `iOS` não lê códigos QR pelo browser.** O `BarcodeDetector` não existe
  no Safari; ao balcão, o iPhone cai na entrada manual do número do cartão.
  Ver o `PLANO.md` para o que falta aqui.
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

## Licença

Sem licença definida. Todos os direitos reservados até haver decisão.
