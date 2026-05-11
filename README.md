# MesaClienteWorker
Worker CloudFlare para Mesa Cliente 

# Mesa Cliente Worker

Worker responsável pelo processamento de tabelas do Mesa Cliente.

## Objetivo

Receber tabelas/PDF/texto, extrair ou normalizar os dados e retornar uma estrutura utilizável pelo Mesa Cliente no FECH.AI.

## Estrutura

- `src/index.js`: código principal do Worker
- `wrangler.jsonc`: configuração Cloudflare Worker
- `package.json`: scripts e dependências do projeto

## Rotas esperadas

- `GET /health`
- `POST /parse`
- `POST /extract-text`
- `POST /normalize-table`

## Observação importante

Não salvar tokens, senhas, chaves de API ou secrets neste repositório.
