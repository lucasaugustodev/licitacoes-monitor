# IA Chat para Licitações Monitor

**Data:** 2026-04-08
**Status:** Aprovado
**Stack:** smolagents (Python) + Llama 4 Scout (OpenRouter) + pgvector

## Contexto

O Licitações Monitor já roda em produção em `licitacoes.somosahub.us` com:
- Backend Node.js (Express) + PostgreSQL/pgvector na porta 3001
- Frontend React (Vite) servido via Nginx
- Sync automático do PNCP a cada 30 min
- Coluna `embedding vector(1536)` na tabela `licitacoes` (ainda não populada)

## Objetivo

Adicionar um chat com IA ao lado da listagem de licitações. O chat:
- Está sincronizado com as licitações visíveis na tela
- Permite definir perfil detalhado da empresa
- Analisa editais contra o perfil, recomendando participar ou não
- Usa smolagents como framework de agentes
- Llama 4 Scout via OpenRouter como LLM

Uso interno (equipe), não multi-tenant.

## Arquitetura

```
Frontend React (layout split: listagem | chat)
        │
        ▼
Node.js API (porta 3001)
├── /api/licitacoes, /api/sync, etc (existente)
├── /api/chat                → proxy HTTP para Python
├── /api/perfil              → CRUD perfil da empresa
└── /api/embeddings/status   → status do pipeline de embeddings
        │
        ▼
Python smolagents (porta 5001, localhost only)
├── Agente com Llama 4 Scout via OpenRouter
└── Tools:
    ├── buscar_licitacoes
    ├── buscar_semantico
    ├── ler_edital
    ├── analisar_fit
    ├── get_perfil
    └── get_contexto_tela
        │
        ▼
PostgreSQL + pgvector
├── licitacoes          (existente, com embedding)
├── perfil_empresa      (novo)
└── chat_historico      (novo)
```

## Banco de Dados — Novas Tabelas

### perfil_empresa

Uma linha só (uso interno). Campos:

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | SERIAL PK | |
| nome_empresa | TEXT | Nome da empresa |
| cnpj | TEXT | CNPJ |
| areas_atuacao | TEXT[] | ("desenvolvimento web", "BI", "mobile") |
| capacidades_tecnicas | TEXT[] | ("React", "Node.js", "Python", "PostgreSQL") |
| certificacoes | TEXT[] | ("ISO 9001", "CMMI") |
| atestados_descricao | TEXT[] | ("Sistema web para prefeitura de X, R$500k") |
| porte | TEXT | "ME", "EPP", "Medio", "Grande" |
| ufs_interesse | TEXT[] | ("SP", "RJ", "MG") |
| valor_min | NUMERIC | Valor mínimo de interesse |
| valor_max | NUMERIC | Valor máximo de interesse |
| modalidades_interesse | INT[] | (6, 8, 9) |
| descricao_livre | TEXT | Texto aberto para contexto adicional |
| embedding | vector(1536) | Embedding do perfil para match semântico |
| updated_at | TIMESTAMPTZ | |

### chat_historico

Conversa única, histórico persistente.

| Coluna | Tipo | Descrição |
|--------|------|-----------|
| id | SERIAL PK | |
| role | TEXT | "user", "assistant", "tool" |
| content | TEXT | Conteúdo da mensagem |
| metadata | JSONB | Licitações referenciadas, tool calls, ações para frontend |
| created_at | TIMESTAMPTZ | |

## Tools do smolagents

### 1. buscar_licitacoes

```
Params: texto, uf, modalidade, valor_min, valor_max, ordenacao
Action: GET http://localhost:3001/api/licitacoes?params
Returns: Lista de licitações formatada
Use: "busca licitações de software em SP"
```

### 2. buscar_semantico

```
Params: query_texto
Action: Gera embedding do texto via OpenRouter, query pgvector
Returns: Licitações mais similares com score de similaridade
Use: "algo parecido com aquele projeto de BI que fizemos"
```

### 3. ler_edital

```
Params: cnpj, ano, sequencial
Action: Baixa PDF(s) do PNCP via API de arquivos, extrai texto com pymupdf
Returns: Texto do edital (truncado se >10k chars, com resumo)
Use: "lê o edital dessa licitação" / "quais os requisitos técnicos?"
```

### 4. analisar_fit

```
Params: licitacao_id
Action: Carrega perfil + licitação + texto do edital
        Monta prompt pedindo análise estruturada
Returns: {
  aderencia: 0-100%,
  requisitos_atendidos: [...],
  requisitos_faltantes: [...],
  pontos_atencao: [...],
  recomendacao: "participar" | "avaliar melhor" | "descartar"
}
Use: "analisa se a gente se encaixa nessa"
```

### 5. get_perfil

```
Params: nenhum
Action: Lê perfil da empresa do banco
Returns: Objeto com todos os campos do perfil
Use: Contexto implícito para o agente em análises
```

### 6. get_contexto_tela

```
Params: nenhum (recebe via contexto da mensagem)
Action: Retorna licitações visíveis na tela do usuário
Returns: Lista com id, orgao, objeto, valor, uf, encerramento
Use: "dessas que tô vendo, qual combina mais?"
```

## Frontend — Layout e Comportamento

### Layout split

```
┌─────────────────────────────────────┬──────────────────────┐
│  Filtros + Listagem de licitações   │  Chat com IA         │
│  (componente existente, adaptado)   │                      │
│                                     │  [mensagens]         │
│  ┌──────────┐ ┌──────────┐         │                      │
│  │ Card     │ │ Card     │         │                      │
│  │ licit.1  │ │ licit.2  │         │  ┌─────────────────┐ │
│  └──────────┘ └──────────┘         │  │ input + enviar  │ │
│  ┌──────────┐ ┌──────────┐         │  └─────────────────┘ │
│  │ Card     │ │ Card     │         │                      │
│  └──────────┘ └──────────┘         │  [Meu Perfil]  btn   │
└─────────────────────────────────────┴──────────────────────┘
```

### Sincronização chat ↔ listagem

O frontend envia com cada mensagem do chat:

```json
{
  "message": "qual dessas vale mais a pena?",
  "licitacoesVisiveis": [
    {"id": "xxx", "orgao": "...", "objeto": "...", "valorEstimado": 100000, "uf": "SP"},
    ...
  ],
  "filtrosAtivos": {"uf": "SP", "texto": "software"}
}
```

O agente pode retornar ações no metadata da resposta:

```json
{
  "content": "Recomendo a licitação do Tribunal...",
  "acoes": {
    "filtrar": {"uf": "SP", "texto": "sistema"},
    "destacar": ["id1", "id2"],
    "abrir_edital": "https://pncp.gov.br/..."
  }
}
```

O frontend aplica essas ações automaticamente (highlight de cards, aplicar filtros, abrir links).

### Tela de Perfil

Modal/drawer acessível por botão "Meu Perfil" no chat. Formulário com:
- Campos de texto para nome, CNPJ, porte
- Campos de tags (chips) para áreas, capacidades, certificações, atestados
- Selects para UFs de interesse e modalidades
- Range para valor min/max
- Textarea para descrição livre
- Botão salvar (gera embedding automaticamente)

## Pipeline de Embeddings

Script Python (cron a cada 15 min):

1. `SELECT id, objeto, orgao, municipio, uf, modalidade FROM licitacoes WHERE embedding IS NULL LIMIT 100`
2. Para cada licitação, concatena campos em texto
3. Gera embedding via OpenRouter: `openai/text-embedding-3-small` ($0.02/M tokens)
4. `UPDATE licitacoes SET embedding = $1 WHERE id = $2`

Também gera embedding do perfil quando salvo via `/api/perfil`.

## Serviço Python — smolagents

Estrutura:

```
/opt/licitacoes-monitor/ai/
├── requirements.txt        (smolagents, pymupdf, httpx, pg8000)
├── agent.py                (agente principal + tools)
├── server.py               (FastAPI, porta 5001)
├── embeddings.py           (pipeline de embeddings batch)
└── .env                    (OPENROUTER_API_KEY, DATABASE_URL)
```

### Systemd service

`licitacoes-ai.service` — roda o FastAPI na porta 5001, localhost only.

### Cron embeddings

`*/15 * * * *` — roda `embeddings.py` para popular embeddings de novas licitações.

## Config Nginx

Sem mudança — o Node.js já é proxy, e o `/api/chat` no Node faz proxy local para `localhost:5001`.

## Modelo LLM

- **Chat/Agent:** `meta-llama/llama-4-scout` via OpenRouter
- **Embeddings:** `openai/text-embedding-3-small` via OpenRouter (pgvector usa 1536 dims)
- API Key: já configurada no `.env` do backend

## Fluxo de Exemplo

1. Usuário abre a página, listagem mostra licitações abertas
2. No chat: "quais dessas licitações combinam mais com a gente?"
3. Agente chama `get_perfil()` + `get_contexto_tela()`
4. Cruza perfil com as licitações visíveis
5. Responde: "Das 15 visíveis, 3 se encaixam bem: [lista com justificativa]"
6. Retorna `acoes.destacar: ["id1", "id2", "id3"]` → frontend destaca os cards
7. Usuário: "lê o edital da primeira"
8. Agente chama `ler_edital(cnpj, ano, seq)`
9. Responde com resumo do edital + análise de fit
