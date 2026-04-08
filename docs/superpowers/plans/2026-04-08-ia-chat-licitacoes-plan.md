# IA Chat para Licitações Monitor — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add an AI chat panel synced with the licitações listing, powered by smolagents + Llama 4 Scout via OpenRouter, with company profile and edital analysis.

**Architecture:** Python FastAPI service (smolagents agent with 6 tools) running on port 5001, proxied through existing Node.js backend. Frontend split layout with chat panel alongside existing listing. pgvector embeddings pipeline for semantic search.

**Tech Stack:** Python 3.12, smolagents, FastAPI, pymupdf, httpx, pg8000, Node.js/Express, React, PostgreSQL/pgvector, OpenRouter API (Llama 4 Scout + text-embedding-3-small)

**Server:** `root@216.238.118.62` (licitacoes.somosahub.us), deploy via SSH.

**Important paths:**
- Project root: `/opt/licitacoes-monitor`
- Backend: `/opt/licitacoes-monitor/backend/src/`
- Frontend: `/opt/licitacoes-monitor/frontend/src/`
- AI service: `/opt/licitacoes-monitor/ai/` (new)
- Env file: `/opt/licitacoes-monitor/backend/.env`

---

## File Map

### New files

| File | Responsibility |
|------|---------------|
| `ai/requirements.txt` | Python dependencies |
| `ai/server.py` | FastAPI HTTP server, /chat and /embeddings endpoints |
| `ai/agent.py` | smolagents agent definition + 6 tools |
| `ai/embeddings.py` | Batch embedding pipeline script (cron) |
| `ai/.env` | OPENROUTER_API_KEY, DATABASE_URL |
| `backend/src/perfil.js` | CRUD routes for perfil_empresa |
| `frontend/src/ChatPanel.jsx` | Chat UI component |
| `frontend/src/ChatPanel.css` | Chat styles |
| `frontend/src/PerfilModal.jsx` | Company profile modal |
| `frontend/src/PerfilModal.css` | Profile modal styles |

### Modified files

| File | Changes |
|------|---------|
| `backend/src/db.js` | Add perfil_empresa + chat_historico tables, CRUD functions |
| `backend/src/index.js` | Add /api/chat proxy, /api/perfil routes, /api/chat/historico |
| `frontend/src/App.jsx` | Split layout, integrate ChatPanel, sync licitações visíveis |
| `frontend/src/App.css` | Layout grid, responsive adjustments |
| `frontend/vite.config.js` | Proxy /api to backend in dev mode |

---

## Task 1: Database Schema — perfil_empresa + chat_historico

**Files:**
- Modify: `backend/src/db.js`

- [ ] **Step 1: Add new tables to initDB()**

In `backend/src/db.js`, add after the `sync_log` CREATE TABLE inside `initDB()`:

```javascript
    await client.query(`
      CREATE TABLE IF NOT EXISTS perfil_empresa (
        id SERIAL PRIMARY KEY,
        nome_empresa TEXT DEFAULT '',
        cnpj TEXT DEFAULT '',
        areas_atuacao TEXT[] DEFAULT '{}',
        capacidades_tecnicas TEXT[] DEFAULT '{}',
        certificacoes TEXT[] DEFAULT '{}',
        atestados_descricao TEXT[] DEFAULT '{}',
        porte TEXT DEFAULT '',
        ufs_interesse TEXT[] DEFAULT '{}',
        valor_min NUMERIC DEFAULT 0,
        valor_max NUMERIC DEFAULT 0,
        modalidades_interesse INT[] DEFAULT '{}',
        descricao_livre TEXT DEFAULT '',
        embedding vector(1536),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS chat_historico (
        id SERIAL PRIMARY KEY,
        role TEXT NOT NULL,
        content TEXT NOT NULL,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Seed empty profile if none exists
    await client.query(`
      INSERT INTO perfil_empresa (id) VALUES (1) ON CONFLICT DO NOTHING
    `);
```

- [ ] **Step 2: Add perfil CRUD functions**

Add to `backend/src/db.js` before `module.exports`:

```javascript
async function getPerfil() {
  const { rows } = await pool.query("SELECT * FROM perfil_empresa WHERE id = 1");
  return rows[0] || null;
}

async function updatePerfil(data) {
  const { rows } = await pool.query(`
    UPDATE perfil_empresa SET
      nome_empresa = $1,
      cnpj = $2,
      areas_atuacao = $3,
      capacidades_tecnicas = $4,
      certificacoes = $5,
      atestados_descricao = $6,
      porte = $7,
      ufs_interesse = $8,
      valor_min = $9,
      valor_max = $10,
      modalidades_interesse = $11,
      descricao_livre = $12,
      updated_at = NOW()
    WHERE id = 1
    RETURNING *
  `, [
    data.nome_empresa || '',
    data.cnpj || '',
    data.areas_atuacao || [],
    data.capacidades_tecnicas || [],
    data.certificacoes || [],
    data.atestados_descricao || [],
    data.porte || '',
    data.ufs_interesse || [],
    data.valor_min || 0,
    data.valor_max || 0,
    data.modalidades_interesse || [],
    data.descricao_livre || '',
  ]);
  return rows[0];
}

async function updatePerfilEmbedding(embedding) {
  await pool.query(
    "UPDATE perfil_empresa SET embedding = $1::vector WHERE id = 1",
    [`[${embedding.join(",")}]`]
  );
}

async function getChatHistorico(limite = 50) {
  const { rows } = await pool.query(
    "SELECT * FROM chat_historico ORDER BY id DESC LIMIT $1",
    [limite]
  );
  return rows.reverse();
}

async function addChatMessage(role, content, metadata = {}) {
  const { rows } = await pool.query(
    "INSERT INTO chat_historico (role, content, metadata) VALUES ($1, $2, $3) RETURNING *",
    [role, content, JSON.stringify(metadata)]
  );
  return rows[0];
}

async function clearChatHistorico() {
  await pool.query("DELETE FROM chat_historico");
}
```

- [ ] **Step 3: Export new functions**

Update `module.exports` in `backend/src/db.js`:

```javascript
module.exports = {
  pool,
  initDB,
  upsertMany,
  buscar,
  buscarSemantico,
  updateEmbedding,
  getLicitacoesSemEmbedding,
  registrarSync,
  ultimoSync,
  stats,
  getPerfil,
  updatePerfil,
  updatePerfilEmbedding,
  getChatHistorico,
  addChatMessage,
  clearChatHistorico,
};
```

- [ ] **Step 4: Restart backend and verify schema**

```bash
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor/backend && systemctl restart licitacoes-backend && sleep 2 && sudo -u postgres psql -d licitacoes_db -c '\dt'"
```

Expected: Tables `licitacoes`, `sync_log`, `perfil_empresa`, `chat_historico` listed.

- [ ] **Step 5: Commit**

```bash
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor && git add backend/src/db.js && git commit -m 'feat: add perfil_empresa and chat_historico tables + CRUD functions'"
```

---

## Task 2: Backend — Perfil + Chat Proxy Routes

**Files:**
- Modify: `backend/src/index.js`

- [ ] **Step 1: Add imports for new db functions**

At the top of `backend/src/index.js`, update the require:

```javascript
const { initDB, buscar, buscarSemantico, stats, getPerfil, updatePerfil, getChatHistorico, addChatMessage, clearChatHistorico } = require("./db");
```

- [ ] **Step 2: Add perfil routes**

After the `/api/modalidades` route, add:

```javascript
// Perfil da empresa
app.get("/api/perfil", async (_req, res) => {
  try {
    const perfil = await getPerfil();
    res.json(perfil);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.put("/api/perfil", async (req, res) => {
  try {
    const perfil = await updatePerfil(req.body);
    res.json(perfil);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 3: Add chat proxy route**

Add after perfil routes. This proxies to the Python smolagents service:

```javascript
const http = require("http");

// Chat proxy to Python AI service
app.post("/api/chat", async (req, res) => {
  try {
    // Save user message
    await addChatMessage("user", req.body.message, {
      licitacoesVisiveis: req.body.licitacoesVisiveis?.map(l => l.id) || [],
      filtrosAtivos: req.body.filtrosAtivos || {},
    });

    // Proxy to Python service
    const payload = JSON.stringify(req.body);
    const options = {
      hostname: "127.0.0.1",
      port: 5001,
      path: "/chat",
      method: "POST",
      headers: { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) },
      timeout: 120000,
    };

    const proxyReq = http.request(options, (proxyRes) => {
      let data = "";
      proxyRes.on("data", (chunk) => { data += chunk; });
      proxyRes.on("end", async () => {
        try {
          const parsed = JSON.parse(data);
          // Save assistant response
          await addChatMessage("assistant", parsed.content, parsed.acoes || {});
          res.json(parsed);
        } catch (e) {
          res.status(502).json({ error: "Invalid response from AI service", raw: data.substring(0, 500) });
        }
      });
    });

    proxyReq.on("error", (err) => {
      res.status(502).json({ error: "AI service unavailable: " + err.message });
    });

    proxyReq.on("timeout", () => {
      proxyReq.destroy();
      res.status(504).json({ error: "AI service timeout" });
    });

    proxyReq.write(payload);
    proxyReq.end();
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Chat history
app.get("/api/chat/historico", async (req, res) => {
  try {
    const limite = parseInt(req.query.limite) || 50;
    const historico = await getChatHistorico(limite);
    res.json({ historico });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.delete("/api/chat/historico", async (_req, res) => {
  try {
    await clearChatHistorico();
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});
```

- [ ] **Step 4: Upload, restart, verify**

```bash
scp backend/src/index.js root@216.238.118.62:/opt/licitacoes-monitor/backend/src/index.js
ssh root@216.238.118.62 "systemctl restart licitacoes-backend && sleep 2 && curl -s http://localhost:3001/api/perfil"
```

Expected: JSON with empty perfil_empresa row.

- [ ] **Step 5: Commit**

```bash
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor && git add backend/src/index.js && git commit -m 'feat: add perfil CRUD routes and chat proxy to AI service'"
```

---

## Task 3: Python AI Service — smolagents + FastAPI

**Files:**
- Create: `ai/requirements.txt`
- Create: `ai/.env`
- Create: `ai/agent.py`
- Create: `ai/server.py`

- [ ] **Step 1: Create requirements.txt**

```
smolagents[openai]>=1.0.0
fastapi>=0.115.0
uvicorn>=0.34.0
httpx>=0.28.0
pymupdf>=1.25.0
pg8000>=1.31.0
```

- [ ] **Step 2: Create .env**

```
OPENROUTER_API_KEY=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
DATABASE_URL=postgresql://licitacoes:lic2024secure@localhost:5432/licitacoes_db
NODE_API_URL=http://localhost:3001/api
EMBEDDING_MODEL=openai/text-embedding-3-small
LLM_MODEL=meta-llama/llama-4-scout
```

- [ ] **Step 3: Create agent.py with all 6 tools**

```python
import os
import json
import httpx
import fitz  # pymupdf
import pg8000
from smolagents import tool, LiteLLMModel, CodeAgent

NODE_API = os.getenv("NODE_API_URL", "http://localhost:3001/api")
DB_URL = os.getenv("DATABASE_URL", "")
OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "meta-llama/llama-4-scout")

# --- Tools ---

@tool
def buscar_licitacoes(texto: str = "", uf: str = "", modalidade: str = "", valor_min: str = "", valor_max: str = "", ordenacao: str = "encerramento") -> str:
    """Search licitações in the database by text, state, modality, value range.
    Args:
        texto: Search text (e.g. "software", "sistema web")
        uf: State code (e.g. "SP", "RJ"). Empty for all.
        modalidade: Modality code (4=Concorrencia, 6=Pregao Eletronico, 8=Dispensa, 9=Inexigibilidade, 12=Credenciamento). Empty for all.
        valor_min: Minimum estimated value in BRL. Empty for no minimum.
        valor_max: Maximum estimated value in BRL. Empty for no maximum.
        ordenacao: Sort order: "encerramento", "publicacao", "valor-desc", "valor-asc"
    """
    params = {k: v for k, v in {
        "texto": texto, "uf": uf, "modalidade": modalidade,
        "valorMin": valor_min, "valorMax": valor_max, "ordenacao": ordenacao,
    }.items() if v}
    r = httpx.get(f"{NODE_API}/licitacoes", params=params, timeout=30)
    data = r.json()
    items = data.get("resultados", [])[:20]
    lines = [f"Total: {data.get('total', 0)} resultados\n"]
    for i, it in enumerate(items, 1):
        lines.append(
            f"{i}. [{it.get('uf','')}/{it.get('municipio','')}] {it.get('orgao','')}\n"
            f"   Objeto: {it.get('objeto','')[:200]}\n"
            f"   Valor: R${it.get('valorEstimado', 0):,.2f} | Modalidade: {it.get('modalidade','')}\n"
            f"   Encerramento: {it.get('dataEncerramento','N/A')} | Situação: {it.get('situacao','')}\n"
            f"   ID: {it.get('id','')}"
        )
    return "\n".join(lines)


@tool
def buscar_semantico(query: str, uf: str = "", limite: int = 10) -> str:
    """Semantic search for licitações using vector embeddings. Good for finding similar opportunities.
    Args:
        query: Natural language query describing what you're looking for
        uf: Optional state filter (e.g. "SP")
        limite: Max results to return (default 10)
    """
    # Generate embedding for query
    emb_response = httpx.post(
        "https://openrouter.ai/api/v1/embeddings",
        headers={"Authorization": f"Bearer {OPENROUTER_KEY}"},
        json={"model": "openai/text-embedding-3-small", "input": query},
        timeout=30,
    )
    embedding = emb_response.json()["data"][0]["embedding"]

    # Query via Node API
    r = httpx.post(
        f"{NODE_API}/licitacoes/semantica",
        json={"embedding": embedding, "uf": uf, "limite": limite},
        timeout=30,
    )
    data = r.json()
    items = data.get("resultados", [])
    lines = [f"Busca semântica: {len(items)} resultados para '{query}'\n"]
    for i, it in enumerate(items, 1):
        sim = it.get("similarity", 0)
        lines.append(
            f"{i}. [Sim: {sim:.1%}] [{it.get('uf','')}/{it.get('municipio','')}] {it.get('orgao','')}\n"
            f"   Objeto: {it.get('objeto','')[:200]}\n"
            f"   Valor: R${it.get('valorEstimado', 0):,.2f}\n"
            f"   ID: {it.get('id','')}"
        )
    return "\n".join(lines)


@tool
def ler_edital(cnpj: str, ano: int, sequencial: int) -> str:
    """Download and read the edital (bid document) PDF from PNCP portal.
    Args:
        cnpj: CNPJ of the organization (e.g. "00394445000466")
        ano: Year of the procurement (e.g. 2026)
        sequencial: Sequential number of the procurement
    """
    # Get list of documents
    url = f"https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{sequencial}/arquivos"
    r = httpx.get(url, timeout=30, follow_redirects=True)
    if r.status_code != 200:
        return f"Erro ao buscar documentos: HTTP {r.status_code}"

    arquivos = r.json()
    if not arquivos:
        return "Nenhum documento encontrado para esta licitação."

    # Download first PDF
    all_text = []
    for arq in arquivos[:3]:  # max 3 files
        titulo = arq.get("titulo", "Documento")
        download_url = arq.get("url", "")
        if not download_url:
            continue
        try:
            pdf_resp = httpx.get(download_url, timeout=60, follow_redirects=True)
            if pdf_resp.status_code != 200:
                all_text.append(f"--- {titulo}: Erro ao baixar (HTTP {pdf_resp.status_code}) ---")
                continue
            doc = fitz.open(stream=pdf_resp.content, filetype="pdf")
            text = ""
            for page in doc:
                text += page.get_text()
            doc.close()
            # Truncate if too long
            if len(text) > 15000:
                text = text[:15000] + "\n\n[...texto truncado, documento muito grande...]"
            all_text.append(f"--- {titulo} ---\n{text}")
        except Exception as e:
            all_text.append(f"--- {titulo}: Erro: {str(e)} ---")

    if not all_text:
        return "Não foi possível extrair texto dos documentos."
    return "\n\n".join(all_text)


@tool
def analisar_fit(licitacao_id: str) -> str:
    """Analyze how well a specific licitação fits the company profile. Returns match score and detailed analysis.
    Args:
        licitacao_id: The PNCP control number (numeroControlePNCP) of the licitação
    """
    # Get profile
    perfil_resp = httpx.get(f"{NODE_API}/perfil", timeout=10)
    perfil = perfil_resp.json()

    # Get licitação details
    lic_resp = httpx.get(f"{NODE_API}/licitacoes", params={"texto": licitacao_id}, timeout=10)
    lics = lic_resp.json().get("resultados", [])
    lic = next((l for l in lics if l.get("id") == licitacao_id), None)
    if not lic:
        return f"Licitação {licitacao_id} não encontrada no banco."

    return (
        f"DADOS PARA ANÁLISE DE FIT:\n\n"
        f"=== PERFIL DA EMPRESA ===\n"
        f"Nome: {perfil.get('nome_empresa','N/A')}\n"
        f"Áreas: {', '.join(perfil.get('areas_atuacao',[]))}\n"
        f"Capacidades: {', '.join(perfil.get('capacidades_tecnicas',[]))}\n"
        f"Certificações: {', '.join(perfil.get('certificacoes',[]))}\n"
        f"Atestados: {'; '.join(perfil.get('atestados_descricao',[]))}\n"
        f"Porte: {perfil.get('porte','N/A')}\n"
        f"UFs interesse: {', '.join(perfil.get('ufs_interesse',[]))}\n"
        f"Faixa valor: R${perfil.get('valor_min',0):,.0f} - R${perfil.get('valor_max',0):,.0f}\n"
        f"Descrição: {perfil.get('descricao_livre','')}\n\n"
        f"=== LICITAÇÃO ===\n"
        f"Órgão: {lic.get('orgao','')}\n"
        f"UF/Município: {lic.get('uf','')}/{lic.get('municipio','')}\n"
        f"Objeto: {lic.get('objeto','')}\n"
        f"Valor: R${lic.get('valorEstimado',0):,.2f}\n"
        f"Modalidade: {lic.get('modalidade','')}\n"
        f"Encerramento: {lic.get('dataEncerramento','N/A')}\n"
        f"Situação: {lic.get('situacao','')}\n\n"
        f"Analise a aderência entre o perfil da empresa e esta licitação. "
        f"Avalie: aderência técnica (0-100%), requisitos atendidos, "
        f"requisitos que faltam, pontos de atenção, e recomendação final "
        f"(participar / avaliar melhor / descartar)."
    )


@tool
def get_perfil() -> str:
    """Get the company profile with capabilities, certifications, and preferences."""
    r = httpx.get(f"{NODE_API}/perfil", timeout=10)
    p = r.json()
    if not p or not p.get("nome_empresa"):
        return "Perfil da empresa ainda não foi preenchido. Peça ao usuário para preencher o perfil."
    return (
        f"Nome: {p.get('nome_empresa','')}\n"
        f"CNPJ: {p.get('cnpj','')}\n"
        f"Porte: {p.get('porte','')}\n"
        f"Áreas de atuação: {', '.join(p.get('areas_atuacao',[]))}\n"
        f"Capacidades técnicas: {', '.join(p.get('capacidades_tecnicas',[]))}\n"
        f"Certificações: {', '.join(p.get('certificacoes',[]))}\n"
        f"Atestados: {'; '.join(p.get('atestados_descricao',[]))}\n"
        f"UFs de interesse: {', '.join(p.get('ufs_interesse',[]))}\n"
        f"Faixa de valor: R${p.get('valor_min',0):,.0f} - R${p.get('valor_max',0):,.0f}\n"
        f"Modalidades: {p.get('modalidades_interesse',[])}\n"
        f"Descrição: {p.get('descricao_livre','')}"
    )


@tool
def get_contexto_tela(licitacoes_json: str) -> str:
    """Parse and summarize the licitações currently visible on the user's screen.
    Args:
        licitacoes_json: JSON string with the visible licitações array
    """
    try:
        items = json.loads(licitacoes_json)
    except json.JSONDecodeError:
        return "Nenhuma licitação visível na tela."
    if not items:
        return "Nenhuma licitação visível na tela."
    lines = [f"{len(items)} licitações visíveis na tela:\n"]
    for i, it in enumerate(items, 1):
        lines.append(
            f"{i}. [{it.get('uf','')}/{it.get('municipio','')}] {it.get('orgao','')}\n"
            f"   Objeto: {str(it.get('objeto',''))[:150]}\n"
            f"   Valor: R${it.get('valorEstimado',0):,.2f} | Enc: {it.get('dataEncerramento','N/A')}\n"
            f"   ID: {it.get('id','')}"
        )
    return "\n".join(lines)


# --- Agent setup ---

SYSTEM_PROMPT = """Você é um assistente especialista em licitações públicas brasileiras.
Você ajuda a equipe a encontrar e analisar oportunidades de licitação no portal PNCP.

Comportamento:
- Responda sempre em português brasileiro
- Seja direto e prático
- Quando o usuário perguntar sobre licitações na tela, use get_contexto_tela com os dados fornecidos
- Quando pedirem análise de fit, use analisar_fit e depois elabore sua análise
- Quando pedirem para ler um edital, use ler_edital com cnpj, ano e sequencial da licitação
- Sempre consulte o perfil da empresa com get_perfil quando precisar fazer comparações
- Use buscar_semantico quando a busca textual simples não for suficiente
- Formate valores monetários em Real brasileiro (R$)
- Identifique prazos urgentes e alerte o usuário

Quando retornar ações para o frontend, inclua no final da resposta um bloco JSON:
```json
{"acoes": {"filtrar": {...}, "destacar": ["id1"], "abrir_edital": "url"}}
```
Só inclua o bloco de ações quando fizer sentido (ex: quando recomendar licitações específicas)."""


def create_agent():
    model = LiteLLMModel(
        model_id=f"openrouter/{LLM_MODEL}",
        api_key=OPENROUTER_KEY,
        api_base="https://openrouter.ai/api/v1",
    )

    agent = CodeAgent(
        tools=[buscar_licitacoes, buscar_semantico, ler_edital, analisar_fit, get_perfil, get_contexto_tela],
        model=model,
        system_prompt=SYSTEM_PROMPT,
        max_steps=10,
        verbosity_level=1,
    )
    return agent
```

- [ ] **Step 4: Create server.py**

```python
import os
import json
from fastapi import FastAPI
from pydantic import BaseModel
from agent import create_agent

app = FastAPI()
agent = create_agent()


class ChatRequest(BaseModel):
    message: str
    licitacoesVisiveis: list = []
    filtrosAtivos: dict = {}


@app.post("/chat")
async def chat(req: ChatRequest):
    # Build context with visible licitações
    context_parts = [req.message]
    if req.licitacoesVisiveis:
        context_parts.append(
            f"\n\n[CONTEXTO: O usuário está vendo estas licitações na tela: "
            f"{json.dumps(req.licitacoesVisiveis, ensure_ascii=False)}]"
        )
    if req.filtrosAtivos:
        context_parts.append(
            f"\n[FILTROS ATIVOS: {json.dumps(req.filtrosAtivos, ensure_ascii=False)}]"
        )

    full_message = "".join(context_parts)

    try:
        result = agent.run(full_message)
        result_str = str(result)

        # Try to extract actions JSON from response
        acoes = {}
        if '{"acoes"' in result_str:
            try:
                json_start = result_str.rfind('{"acoes"')
                json_str = result_str[json_start:]
                # Find matching closing brace
                depth = 0
                end = 0
                for i, c in enumerate(json_str):
                    if c == '{':
                        depth += 1
                    elif c == '}':
                        depth -= 1
                        if depth == 0:
                            end = i + 1
                            break
                if end > 0:
                    acoes = json.loads(json_str[:end]).get("acoes", {})
                    result_str = result_str[:json_start].rstrip()
            except (json.JSONDecodeError, IndexError):
                pass

        return {"content": result_str, "acoes": acoes}
    except Exception as e:
        return {"content": f"Erro ao processar: {str(e)}", "acoes": {}}


@app.get("/health")
async def health():
    return {"status": "ok"}


if __name__ == "__main__":
    import uvicorn
    port = int(os.getenv("AI_PORT", "5001"))
    uvicorn.run(app, host="127.0.0.1", port=port)
```

- [ ] **Step 5: Upload files to server**

```bash
ssh root@216.238.118.62 "mkdir -p /opt/licitacoes-monitor/ai"
scp ai/requirements.txt ai/.env ai/agent.py ai/server.py root@216.238.118.62:/opt/licitacoes-monitor/ai/
```

- [ ] **Step 6: Install Python deps and test**

```bash
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor/ai && pip3 install -r requirements.txt"
```

- [ ] **Step 7: Create systemd service**

```bash
ssh root@216.238.118.62 'cat > /etc/systemd/system/licitacoes-ai.service << EOF
[Unit]
Description=Licitacoes AI Agent (smolagents)
After=network.target postgresql.service licitacoes-backend.service

[Service]
Type=simple
User=root
WorkingDirectory=/opt/licitacoes-monitor/ai
EnvironmentFile=/opt/licitacoes-monitor/ai/.env
ExecStart=/usr/bin/python3 server.py
Restart=always
RestartSec=5

[Install]
WantedBy=multi-user.target
EOF
systemctl daemon-reload && systemctl enable licitacoes-ai && systemctl start licitacoes-ai && sleep 3 && systemctl status licitacoes-ai --no-pager'
```

Expected: Active (running), listening on 127.0.0.1:5001.

- [ ] **Step 8: Test health endpoint**

```bash
ssh root@216.238.118.62 "curl -s http://localhost:5001/health"
```

Expected: `{"status":"ok"}`

- [ ] **Step 9: Commit**

```bash
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor && git add ai/ && git commit -m 'feat: add Python AI service with smolagents agent and 6 tools'"
```

---

## Task 4: Embeddings Pipeline

**Files:**
- Create: `ai/embeddings.py`

- [ ] **Step 1: Create embeddings.py**

```python
#!/usr/bin/env python3
"""Batch embedding pipeline for licitações and company profile."""
import os
import httpx
import pg8000

OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY", "")
DB_URL = os.getenv("DATABASE_URL", "postgresql://licitacoes:lic2024secure@localhost:5432/licitacoes_db")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "openai/text-embedding-3-small")


def get_connection():
    # Parse DATABASE_URL
    parts = DB_URL.replace("postgresql://", "").split("@")
    user_pass = parts[0].split(":")
    host_db = parts[1].split("/")
    host_port = host_db[0].split(":")
    return pg8000.connect(
        user=user_pass[0],
        password=user_pass[1],
        host=host_port[0],
        port=int(host_port[1]) if len(host_port) > 1 else 5432,
        database=host_db[1],
    )


def generate_embedding(text: str) -> list:
    """Generate embedding via OpenRouter."""
    r = httpx.post(
        "https://openrouter.ai/api/v1/embeddings",
        headers={"Authorization": f"Bearer {OPENROUTER_KEY}"},
        json={"model": EMBEDDING_MODEL, "input": text[:8000]},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["data"][0]["embedding"]


def embed_licitacoes(batch_size=50):
    """Generate embeddings for licitações that don't have one yet."""
    conn = get_connection()
    cur = conn.cursor()

    cur.execute(
        "SELECT id, objeto, orgao, municipio, uf, modalidade FROM licitacoes WHERE embedding IS NULL LIMIT %s",
        (batch_size,),
    )
    rows = cur.fetchall()
    if not rows:
        print("[embeddings] No licitações without embedding.")
        return 0

    print(f"[embeddings] Processing {len(rows)} licitações...")
    count = 0
    for row in rows:
        lid, objeto, orgao, municipio, uf, modalidade = row
        text = f"{objeto or ''} | {orgao or ''} | {municipio or ''}/{uf or ''} | {modalidade or ''}"
        try:
            emb = generate_embedding(text)
            emb_str = "[" + ",".join(str(x) for x in emb) + "]"
            cur.execute(
                "UPDATE licitacoes SET embedding = %s::vector WHERE id = %s",
                (emb_str, lid),
            )
            count += 1
            if count % 10 == 0:
                conn.commit()
                print(f"[embeddings] {count}/{len(rows)} done")
        except Exception as e:
            print(f"[embeddings] Error for {lid}: {e}")
            continue

    conn.commit()
    print(f"[embeddings] Done. {count} embeddings generated.")

    # Also update profile embedding
    embed_perfil(cur, conn)

    cur.close()
    conn.close()
    return count


def embed_perfil(cur=None, conn=None):
    """Generate embedding for company profile."""
    should_close = False
    if not conn:
        conn = get_connection()
        cur = conn.cursor()
        should_close = True

    cur.execute("SELECT nome_empresa, areas_atuacao, capacidades_tecnicas, certificacoes, descricao_livre FROM perfil_empresa WHERE id = 1")
    row = cur.fetchone()
    if not row or not row[0]:
        print("[embeddings] No profile to embed.")
        if should_close:
            cur.close()
            conn.close()
        return

    nome, areas, caps, certs, desc = row
    text = f"{nome} | Áreas: {', '.join(areas or [])} | Capacidades: {', '.join(caps or [])} | Certificações: {', '.join(certs or [])} | {desc or ''}"

    try:
        emb = generate_embedding(text)
        emb_str = "[" + ",".join(str(x) for x in emb) + "]"
        cur.execute("UPDATE perfil_empresa SET embedding = %s::vector WHERE id = 1", (emb_str,))
        conn.commit()
        print("[embeddings] Profile embedding updated.")
    except Exception as e:
        print(f"[embeddings] Error embedding profile: {e}")

    if should_close:
        cur.close()
        conn.close()


if __name__ == "__main__":
    embed_licitacoes(batch_size=100)
```

- [ ] **Step 2: Upload and test**

```bash
scp ai/embeddings.py root@216.238.118.62:/opt/licitacoes-monitor/ai/
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor/ai && source .env && export OPENROUTER_API_KEY DATABASE_URL && python3 embeddings.py"
```

Expected: Should process licitações and print progress.

- [ ] **Step 3: Create cron for embeddings**

```bash
ssh root@216.238.118.62 'cat > /opt/licitacoes-monitor/ai/run-embeddings.sh << "EOF"
#!/bin/bash
cd /opt/licitacoes-monitor/ai
export $(cat .env | grep -v ^# | xargs)
python3 embeddings.py >> /var/log/licitacoes-embeddings.log 2>&1
echo "---$(date)---" >> /var/log/licitacoes-embeddings.log
EOF
chmod +x /opt/licitacoes-monitor/ai/run-embeddings.sh
(crontab -l 2>/dev/null; echo "*/15 * * * * /opt/licitacoes-monitor/ai/run-embeddings.sh") | crontab -'
```

- [ ] **Step 4: Commit**

```bash
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor && git add ai/embeddings.py ai/run-embeddings.sh && git commit -m 'feat: add embeddings batch pipeline with cron every 15min'"
```

---

## Task 5: Frontend — ChatPanel Component

**Files:**
- Create: `frontend/src/ChatPanel.jsx`
- Create: `frontend/src/ChatPanel.css`

- [ ] **Step 1: Create ChatPanel.css**

```css
.chat-panel {
  display: flex;
  flex-direction: column;
  height: calc(100vh - 4rem);
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 12px;
  overflow: hidden;
  position: sticky;
  top: 2rem;
}

.chat-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 0.75rem 1rem;
  border-bottom: 1px solid var(--border);
  flex-shrink: 0;
}

.chat-header h3 {
  font-size: 0.95rem;
  font-weight: 600;
}

.chat-header-actions {
  display: flex;
  gap: 0.5rem;
}

.chat-header-actions button {
  background: none;
  border: 1px solid var(--border);
  color: var(--text-muted);
  padding: 0.25rem 0.5rem;
  border-radius: 6px;
  cursor: pointer;
  font-size: 0.75rem;
}

.chat-header-actions button:hover {
  color: var(--text);
  border-color: var(--text-muted);
}

.chat-messages {
  flex: 1;
  overflow-y: auto;
  padding: 1rem;
  display: flex;
  flex-direction: column;
  gap: 0.75rem;
}

.chat-msg {
  max-width: 90%;
  padding: 0.6rem 0.9rem;
  border-radius: 12px;
  font-size: 0.85rem;
  line-height: 1.5;
  word-break: break-word;
  white-space: pre-wrap;
}

.chat-msg.user {
  align-self: flex-end;
  background: var(--primary);
  color: white;
  border-bottom-right-radius: 4px;
}

.chat-msg.assistant {
  align-self: flex-start;
  background: var(--surface-hover);
  color: var(--text);
  border-bottom-left-radius: 4px;
}

.chat-msg.typing {
  align-self: flex-start;
  background: var(--surface-hover);
  color: var(--text-muted);
  font-style: italic;
}

.chat-input-area {
  display: flex;
  gap: 0.5rem;
  padding: 0.75rem 1rem;
  border-top: 1px solid var(--border);
  flex-shrink: 0;
}

.chat-input-area textarea {
  flex: 1;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  font-size: 0.85rem;
  font-family: inherit;
  resize: none;
  min-height: 38px;
  max-height: 120px;
}

.chat-input-area textarea:focus {
  outline: none;
  border-color: var(--primary);
}

.chat-input-area button {
  background: var(--primary);
  color: white;
  border: none;
  border-radius: 8px;
  padding: 0.5rem 1rem;
  cursor: pointer;
  font-size: 0.85rem;
  font-weight: 600;
  white-space: nowrap;
  align-self: flex-end;
}

.chat-input-area button:hover {
  background: var(--primary-hover);
}

.chat-input-area button:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}

.chat-empty {
  flex: 1;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--text-muted);
  font-size: 0.85rem;
  text-align: center;
  padding: 2rem;
}

.chat-highlighted-ids {
  display: none;
}
```

- [ ] **Step 2: Create ChatPanel.jsx**

```jsx
import { useState, useEffect, useRef, useCallback } from "react";
import "./ChatPanel.css";

const API_URL = "/api";

export default function ChatPanel({ licitacoesVisiveis, filtrosAtivos, onAcoes }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

  // Load history on mount
  useEffect(() => {
    fetch(`${API_URL}/chat/historico`)
      .then((r) => r.json())
      .then((data) => {
        if (data.historico) {
          setMessages(data.historico.map((m) => ({
            role: m.role,
            content: m.content,
            acoes: typeof m.metadata === "string" ? JSON.parse(m.metadata || "{}") : (m.metadata || {}),
          })));
        }
      })
      .catch(() => {});
  }, []);

  // Auto-scroll
  useEffect(() => {
    messagesEndRef.current?.scrollIntoView({ behavior: "smooth" });
  }, [messages]);

  const sendMessage = useCallback(async () => {
    const msg = input.trim();
    if (!msg || loading) return;

    setInput("");
    setMessages((prev) => [...prev, { role: "user", content: msg }]);
    setLoading(true);

    try {
      const res = await fetch(`${API_URL}/chat`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          message: msg,
          licitacoesVisiveis: licitacoesVisiveis.slice(0, 20).map((l) => ({
            id: l.id,
            orgao: l.orgao,
            objeto: l.objeto?.substring(0, 150),
            valorEstimado: l.valorEstimado,
            uf: l.uf,
            municipio: l.municipio,
            dataEncerramento: l.dataEncerramento,
            cnpjOrgao: l.cnpjOrgao,
            anoCompra: l.anoCompra,
            sequencialCompra: l.sequencialCompra,
          })),
          filtrosAtivos,
        }),
      });

      const data = await res.json();
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: data.content || data.error || "Sem resposta",
        acoes: data.acoes || {},
      }]);

      // Apply actions from AI
      if (data.acoes && onAcoes) {
        onAcoes(data.acoes);
      }
    } catch (err) {
      setMessages((prev) => [...prev, {
        role: "assistant",
        content: `Erro: ${err.message}`,
      }]);
    } finally {
      setLoading(false);
    }
  }, [input, loading, licitacoesVisiveis, filtrosAtivos, onAcoes]);

  const handleKeyDown = (e) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      sendMessage();
    }
  };

  const clearChat = async () => {
    try {
      await fetch(`${API_URL}/chat/historico`, { method: "DELETE" });
      setMessages([]);
    } catch (err) {
      console.error("Failed to clear chat:", err);
    }
  };

  return (
    <div className="chat-panel">
      <div className="chat-header">
        <h3>Assistente IA</h3>
        <div className="chat-header-actions">
          <button onClick={clearChat}>Limpar</button>
        </div>
      </div>

      <div className="chat-messages">
        {messages.length === 0 && (
          <div className="chat-empty">
            Pergunte sobre as licitações visíveis, peça análises de fit, ou busque oportunidades.
          </div>
        )}
        {messages.map((msg, i) => (
          <div key={i} className={`chat-msg ${msg.role}`}>
            {msg.content}
          </div>
        ))}
        {loading && (
          <div className="chat-msg typing">Analisando...</div>
        )}
        <div ref={messagesEndRef} />
      </div>

      <div className="chat-input-area">
        <textarea
          ref={textareaRef}
          value={input}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Pergunte sobre licitações..."
          rows={1}
          disabled={loading}
        />
        <button onClick={sendMessage} disabled={loading || !input.trim()}>
          Enviar
        </button>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor && git add frontend/src/ChatPanel.jsx frontend/src/ChatPanel.css && git commit -m 'feat: add ChatPanel component with history, actions, and sync'"
```

---

## Task 6: Frontend — PerfilModal Component

**Files:**
- Create: `frontend/src/PerfilModal.jsx`
- Create: `frontend/src/PerfilModal.css`

- [ ] **Step 1: Create PerfilModal.css**

```css
.perfil-overlay {
  position: fixed;
  inset: 0;
  background: rgba(0, 0, 0, 0.7);
  display: flex;
  align-items: center;
  justify-content: center;
  z-index: 1000;
}

.perfil-modal {
  background: var(--surface);
  border: 1px solid var(--border);
  border-radius: 16px;
  width: 90%;
  max-width: 600px;
  max-height: 85vh;
  overflow-y: auto;
  padding: 1.5rem;
}

.perfil-modal h2 {
  font-size: 1.2rem;
  margin-bottom: 1.25rem;
}

.perfil-form {
  display: flex;
  flex-direction: column;
  gap: 1rem;
}

.perfil-field label {
  display: block;
  font-size: 0.8rem;
  color: var(--text-muted);
  margin-bottom: 0.3rem;
}

.perfil-field input,
.perfil-field textarea,
.perfil-field select {
  width: 100%;
  background: var(--bg);
  border: 1px solid var(--border);
  color: var(--text);
  border-radius: 8px;
  padding: 0.5rem 0.75rem;
  font-size: 0.85rem;
  font-family: inherit;
}

.perfil-field textarea {
  min-height: 60px;
  resize: vertical;
}

.perfil-field input:focus,
.perfil-field textarea:focus {
  outline: none;
  border-color: var(--primary);
}

.perfil-field small {
  color: var(--text-muted);
  font-size: 0.7rem;
}

.perfil-row {
  display: grid;
  grid-template-columns: 1fr 1fr;
  gap: 1rem;
}

.perfil-actions {
  display: flex;
  gap: 0.75rem;
  justify-content: flex-end;
  margin-top: 0.5rem;
}

.perfil-actions button {
  padding: 0.5rem 1.25rem;
  border-radius: 8px;
  font-size: 0.85rem;
  cursor: pointer;
  border: none;
  font-weight: 600;
}

.perfil-actions .btn-save {
  background: var(--primary);
  color: white;
}

.perfil-actions .btn-save:hover {
  background: var(--primary-hover);
}

.perfil-actions .btn-cancel {
  background: var(--surface-hover);
  color: var(--text);
  border: 1px solid var(--border);
}
```

- [ ] **Step 2: Create PerfilModal.jsx**

```jsx
import { useState, useEffect } from "react";
import "./PerfilModal.css";

const API_URL = "/api";

export default function PerfilModal({ open, onClose }) {
  const [perfil, setPerfil] = useState({
    nome_empresa: "",
    cnpj: "",
    areas_atuacao: [],
    capacidades_tecnicas: [],
    certificacoes: [],
    atestados_descricao: [],
    porte: "",
    ufs_interesse: [],
    valor_min: 0,
    valor_max: 0,
    modalidades_interesse: [],
    descricao_livre: "",
  });
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (open) {
      fetch(`${API_URL}/perfil`)
        .then((r) => r.json())
        .then((data) => {
          if (data) setPerfil(data);
        })
        .catch(() => {});
    }
  }, [open]);

  if (!open) return null;

  const handleArrayField = (field, value) => {
    setPerfil((p) => ({
      ...p,
      [field]: value.split(",").map((s) => s.trim()).filter(Boolean),
    }));
  };

  const handleIntArrayField = (field, value) => {
    setPerfil((p) => ({
      ...p,
      [field]: value.split(",").map((s) => parseInt(s.trim())).filter((n) => !isNaN(n)),
    }));
  };

  const save = async () => {
    setSaving(true);
    try {
      await fetch(`${API_URL}/perfil`, {
        method: "PUT",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(perfil),
      });
      onClose();
    } catch (err) {
      alert("Erro ao salvar: " + err.message);
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="perfil-overlay" onClick={onClose}>
      <div className="perfil-modal" onClick={(e) => e.stopPropagation()}>
        <h2>Perfil da Empresa</h2>
        <div className="perfil-form">
          <div className="perfil-row">
            <div className="perfil-field">
              <label>Nome da Empresa</label>
              <input value={perfil.nome_empresa} onChange={(e) => setPerfil((p) => ({ ...p, nome_empresa: e.target.value }))} />
            </div>
            <div className="perfil-field">
              <label>CNPJ</label>
              <input value={perfil.cnpj} onChange={(e) => setPerfil((p) => ({ ...p, cnpj: e.target.value }))} />
            </div>
          </div>

          <div className="perfil-row">
            <div className="perfil-field">
              <label>Porte</label>
              <select value={perfil.porte} onChange={(e) => setPerfil((p) => ({ ...p, porte: e.target.value }))}>
                <option value="">Selecione</option>
                <option value="MEI">MEI</option>
                <option value="ME">ME</option>
                <option value="EPP">EPP</option>
                <option value="Medio">Médio</option>
                <option value="Grande">Grande</option>
              </select>
            </div>
            <div className="perfil-field">
              <label>UFs de Interesse</label>
              <input
                value={(perfil.ufs_interesse || []).join(", ")}
                onChange={(e) => handleArrayField("ufs_interesse", e.target.value)}
                placeholder="SP, RJ, MG"
              />
            </div>
          </div>

          <div className="perfil-field">
            <label>Áreas de Atuação</label>
            <input
              value={(perfil.areas_atuacao || []).join(", ")}
              onChange={(e) => handleArrayField("areas_atuacao", e.target.value)}
              placeholder="desenvolvimento web, BI, mobile, suporte"
            />
            <small>Separe por vírgula</small>
          </div>

          <div className="perfil-field">
            <label>Capacidades Técnicas</label>
            <input
              value={(perfil.capacidades_tecnicas || []).join(", ")}
              onChange={(e) => handleArrayField("capacidades_tecnicas", e.target.value)}
              placeholder="React, Node.js, Python, PostgreSQL, AWS"
            />
            <small>Separe por vírgula</small>
          </div>

          <div className="perfil-field">
            <label>Certificações</label>
            <input
              value={(perfil.certificacoes || []).join(", ")}
              onChange={(e) => handleArrayField("certificacoes", e.target.value)}
              placeholder="ISO 9001, CMMI, MPS.BR"
            />
            <small>Separe por vírgula</small>
          </div>

          <div className="perfil-field">
            <label>Atestados de Capacidade Técnica</label>
            <textarea
              value={(perfil.atestados_descricao || []).join("\n")}
              onChange={(e) => setPerfil((p) => ({ ...p, atestados_descricao: e.target.value.split("\n").filter(Boolean) }))}
              placeholder="Sistema web para Prefeitura de X, R$500k&#10;App mobile para Tribunal Y, R$200k"
              rows={3}
            />
            <small>Um por linha</small>
          </div>

          <div className="perfil-row">
            <div className="perfil-field">
              <label>Valor Mínimo (R$)</label>
              <input
                type="number"
                value={perfil.valor_min || ""}
                onChange={(e) => setPerfil((p) => ({ ...p, valor_min: Number(e.target.value) || 0 }))}
                placeholder="0"
              />
            </div>
            <div className="perfil-field">
              <label>Valor Máximo (R$)</label>
              <input
                type="number"
                value={perfil.valor_max || ""}
                onChange={(e) => setPerfil((p) => ({ ...p, valor_max: Number(e.target.value) || 0 }))}
                placeholder="0 = sem limite"
              />
            </div>
          </div>

          <div className="perfil-field">
            <label>Modalidades de Interesse</label>
            <input
              value={(perfil.modalidades_interesse || []).join(", ")}
              onChange={(e) => handleIntArrayField("modalidades_interesse", e.target.value)}
              placeholder="6, 8, 9"
            />
            <small>4=Concorrência, 6=Pregão Eletrônico, 8=Dispensa, 9=Inexigibilidade, 12=Credenciamento</small>
          </div>

          <div className="perfil-field">
            <label>Descrição Livre</label>
            <textarea
              value={perfil.descricao_livre}
              onChange={(e) => setPerfil((p) => ({ ...p, descricao_livre: e.target.value }))}
              placeholder="Informações adicionais sobre a empresa que a IA deve considerar..."
              rows={3}
            />
          </div>

          <div className="perfil-actions">
            <button className="btn-cancel" onClick={onClose}>Cancelar</button>
            <button className="btn-save" onClick={save} disabled={saving}>
              {saving ? "Salvando..." : "Salvar Perfil"}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}
```

- [ ] **Step 3: Commit**

```bash
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor && git add frontend/src/PerfilModal.jsx frontend/src/PerfilModal.css && git commit -m 'feat: add PerfilModal component for company profile editing'"
```

---

## Task 7: Frontend — Integrate Chat + Split Layout

**Files:**
- Modify: `frontend/src/App.jsx`
- Modify: `frontend/src/App.css`

- [ ] **Step 1: Update App.css — replace `.app` max-width with split layout**

Find and replace in `App.css`:

```css
/* Replace */
.app {
  max-width: 1200px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
}

/* With */
.app {
  display: grid;
  grid-template-columns: 1fr 380px;
  grid-template-rows: auto auto 1fr;
  gap: 0 1.5rem;
  max-width: 1600px;
  margin: 0 auto;
  padding: 2rem 1.5rem;
  min-height: 100vh;
}

.app > header {
  grid-column: 1 / -1;
}

.app > .sync-bar {
  grid-column: 1 / -1;
}

.main-content {
  grid-column: 1;
  grid-row: 3;
  min-width: 0;
}

.chat-column {
  grid-column: 2;
  grid-row: 3;
}

@media (max-width: 900px) {
  .app {
    grid-template-columns: 1fr;
  }
  .chat-column {
    grid-column: 1;
    grid-row: 4;
  }
  .chat-panel {
    height: 400px;
    position: static;
  }
}
```

- [ ] **Step 2: Update App.jsx — add API_URL fix, imports, state, layout**

Replace `const API_URL = "http://localhost:3002/api";` with:

```javascript
const API_URL = "/api";
```

Add imports at top of App.jsx:

```javascript
import ChatPanel from "./ChatPanel";
import PerfilModal from "./PerfilModal";
```

Add state in the `App` component after existing state:

```javascript
  const [perfilOpen, setPerfilOpen] = useState(false);
  const [highlightedIds, setHighlightedIds] = useState([]);
```

Add handler function after `atualizar()`:

```javascript
  function handleAcoes(acoes) {
    if (acoes.filtrar) {
      if (acoes.filtrar.uf) setUf(acoes.filtrar.uf);
      if (acoes.filtrar.texto) setTexto(acoes.filtrar.texto);
      if (acoes.filtrar.modalidade) setModalidade(String(acoes.filtrar.modalidade));
      // Trigger search after state updates
      setTimeout(() => buscar(), 100);
    }
    if (acoes.destacar) {
      setHighlightedIds(acoes.destacar);
      // Clear highlight after 10s
      setTimeout(() => setHighlightedIds([]), 10000);
    }
    if (acoes.abrir_edital) {
      window.open(acoes.abrir_edital, "_blank");
    }
  }
```

Update the `LicitacaoCard` component to accept `highlighted` prop. Find:

```jsx
function LicitacaoCard({ item }) {
```

Replace with:

```jsx
function LicitacaoCard({ item, highlighted }) {
```

Find in `LicitacaoCard`:

```jsx
    <div className="card">
```

Replace with:

```jsx
    <div className={`card ${highlighted ? "card-highlighted" : ""}`}>
```

Update the return JSX of `App`. Replace the entire `return (...)` with:

```jsx
  return (
    <div className="app">
      <header>
        <h1>Licitacoes de Software</h1>
        <p className="subtitle">Monitoramento de oportunidades via PNCP</p>
      </header>

      <SyncBar
        dbStats={dbStats}
        syncStatus={syncStatus}
        onSync={iniciarSync}
        onRefresh={atualizar}
      />

      <div className="main-content">
        <div className="filters">
          <div className="filter-row">
            <div className="filter-group">
              <label>UF</label>
              <select value={uf} onChange={(e) => setUf(e.target.value)}>
                <option value="">Todas</option>
                {ufs.map((u) => (
                  <option key={u} value={u}>{u}</option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label>Modalidade</label>
              <select value={modalidade} onChange={(e) => setModalidade(e.target.value)}>
                <option value="">Todas</option>
                {modalidades.map((m) => (
                  <option key={m.codigo} value={m.codigo}>{m.nome}</option>
                ))}
              </select>
            </div>

            <div className="filter-group">
              <label>Buscar no texto</label>
              <input
                type="text"
                placeholder="software, sistema, TI..."
                value={texto}
                onChange={(e) => setTexto(e.target.value)}
              />
            </div>

            <div className="filter-group">
              <label>Valor min (R$)</label>
              <input
                type="number"
                placeholder="0"
                value={valorMin}
                onChange={(e) => setValorMin(e.target.value)}
              />
            </div>

            <div className="filter-group">
              <label>Valor max (R$)</label>
              <input
                type="number"
                placeholder="Sem limite"
                value={valorMax}
                onChange={(e) => setValorMax(e.target.value)}
              />
            </div>

            <div className="filter-group">
              <label>Ordenar por</label>
              <select value={ordenacao} onChange={(e) => setOrdenacao(e.target.value)}>
                <option value="encerramento">Encerramento (mais proximo)</option>
                <option value="publicacao">Publicacao (mais recente)</option>
                <option value="valor-desc">Maior valor</option>
                <option value="valor-asc">Menor valor</option>
              </select>
            </div>
          </div>

          <button className="btn btn-buscar" onClick={buscar} disabled={loading}>
            {loading ? "Buscando..." : "Filtrar"}
          </button>
        </div>

        {error && <div className="error">Erro: {error}</div>}

        <div className="results-header">
          <span>
            {total} resultado{total !== 1 ? "s" : ""}
          </span>
        </div>

        <div className="results">
          {licitacoes.map((item, i) => (
            <LicitacaoCard
              key={item.id || i}
              item={item}
              highlighted={highlightedIds.includes(item.id)}
            />
          ))}
          {!loading && licitacoes.length === 0 && !error && (
            <div className="empty">
              {dbStats.total === 0
                ? 'Clique em "Sync Completo" para buscar dados do PNCP'
                : "Nenhuma licitacao corresponde aos filtros"}
            </div>
          )}
          {syncStatus.running && (
            <div className="empty">Sincronizando com PNCP... voce pode filtrar enquanto os dados chegam.</div>
          )}
        </div>
      </div>

      <div className="chat-column">
        <ChatPanel
          licitacoesVisiveis={licitacoes}
          filtrosAtivos={{ uf, modalidade, texto, valorMin, valorMax, ordenacao }}
          onAcoes={handleAcoes}
        />
        <button
          className="btn btn-perfil"
          onClick={() => setPerfilOpen(true)}
          style={{ marginTop: "0.5rem", width: "100%", background: "var(--surface)", border: "1px solid var(--border)", color: "var(--text)", padding: "0.5rem", borderRadius: "8px", cursor: "pointer", fontSize: "0.8rem" }}
        >
          Meu Perfil da Empresa
        </button>
      </div>

      <PerfilModal open={perfilOpen} onClose={() => setPerfilOpen(false)} />
    </div>
  );
```

- [ ] **Step 3: Add highlight style to App.css**

Append to `App.css`:

```css
.card-highlighted {
  border-color: var(--primary) !important;
  box-shadow: 0 0 0 2px var(--primary), 0 4px 12px rgba(99, 102, 241, 0.3);
}
```

- [ ] **Step 4: Update vite.config.js for dev proxy**

Replace `frontend/vite.config.js`:

```javascript
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': 'http://localhost:3001',
    },
  },
})
```

- [ ] **Step 5: Upload, build, restart**

```bash
scp frontend/src/App.jsx frontend/src/App.css frontend/src/ChatPanel.jsx frontend/src/ChatPanel.css frontend/src/PerfilModal.jsx frontend/src/PerfilModal.css frontend/vite.config.js root@216.238.118.62:/opt/licitacoes-monitor/frontend/src/
# vite.config goes one level up
ssh root@216.238.118.62 "mv /opt/licitacoes-monitor/frontend/src/vite.config.js /opt/licitacoes-monitor/frontend/vite.config.js"
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor/frontend && npm run build && systemctl restart nginx"
```

- [ ] **Step 6: Verify in browser**

Open `https://licitacoes.somosahub.us` — should show split layout with chat on the right.

- [ ] **Step 7: Commit**

```bash
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor && git add frontend/ && git commit -m 'feat: split layout with chat panel, perfil modal, and AI action handling'"
```

---

## Task 8: End-to-End Test

- [ ] **Step 1: Verify all services running**

```bash
ssh root@216.238.118.62 "systemctl status licitacoes-backend --no-pager && systemctl status licitacoes-ai --no-pager"
```

- [ ] **Step 2: Test chat endpoint**

```bash
curl -s -X POST https://licitacoes.somosahub.us/api/chat \
  -H "Content-Type: application/json" \
  -d '{"message": "quais licitações de software estão abertas em SP?", "licitacoesVisiveis": [], "filtrosAtivos": {}}'
```

Expected: JSON with `content` (AI response) and `acoes` (optional actions).

- [ ] **Step 3: Test perfil save**

```bash
curl -s -X PUT https://licitacoes.somosahub.us/api/perfil \
  -H "Content-Type: application/json" \
  -d '{"nome_empresa": "Teste Corp", "areas_atuacao": ["desenvolvimento web"], "capacidades_tecnicas": ["React", "Node.js"]}'
```

- [ ] **Step 4: Test embeddings**

```bash
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor/ai && source .env && export OPENROUTER_API_KEY DATABASE_URL && python3 embeddings.py"
```

Check: `curl -s https://licitacoes.somosahub.us/api/stats` — `comEmbedding` should be > 0.

- [ ] **Step 5: Push to GitHub**

```bash
ssh root@216.238.118.62 "cd /opt/licitacoes-monitor && git push origin main"
```
