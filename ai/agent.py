import os
import json
import httpx
import fitz  # pymupdf
from smolagents import tool, LiteLLMModel, CodeAgent

NODE_API = os.getenv("NODE_API_URL", "http://localhost:3001/api")
OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY", "")
LLM_MODEL = os.getenv("LLM_MODEL", "meta-llama/llama-4-scout")

@tool
def buscar_licitacoes(texto: str = "", uf: str = "", modalidade: str = "", valor_min: str = "", valor_max: str = "", ordenacao: str = "encerramento") -> str:
    """Search licitacoes in the database by text, state, modality, value range.
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
            f"   Encerramento: {it.get('dataEncerramento','N/A')} | Situacao: {it.get('situacao','')}\n"
            f"   ID: {it.get('id','')}"
        )
    return "\n".join(lines)


@tool
def buscar_semantico(query: str, uf: str = "", limite: int = 10) -> str:
    """Semantic search for licitacoes using vector embeddings. Good for finding similar opportunities.
    Args:
        query: Natural language query describing what you are looking for
        uf: Optional state filter (e.g. "SP")
        limite: Max results to return (default 10)
    """
    emb_response = httpx.post(
        "https://openrouter.ai/api/v1/embeddings",
        headers={"Authorization": f"Bearer {OPENROUTER_KEY}"},
        json={"model": "openai/text-embedding-3-small", "input": query},
        timeout=30,
    )
    embedding = emb_response.json()["data"][0]["embedding"]
    r = httpx.post(
        f"{NODE_API}/licitacoes/semantica",
        json={"embedding": embedding, "uf": uf, "limite": limite},
        timeout=30,
    )
    data = r.json()
    items = data.get("resultados", [])
    lines = [f"Busca semantica: {len(items)} resultados para '{query}'\n"]
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
    url = f"https://pncp.gov.br/api/pncp/v1/orgaos/{cnpj}/compras/{ano}/{sequencial}/arquivos"
    r = httpx.get(url, timeout=30, follow_redirects=True)
    if r.status_code != 200:
        return f"Erro ao buscar documentos: HTTP {r.status_code}"
    arquivos = r.json()
    if not arquivos:
        return "Nenhum documento encontrado para esta licitacao."
    all_text = []
    for arq in arquivos[:3]:
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
            if len(text) > 15000:
                text = text[:15000] + "\n\n[...texto truncado, documento muito grande...]"
            all_text.append(f"--- {titulo} ---\n{text}")
        except Exception as e:
            all_text.append(f"--- {titulo}: Erro: {str(e)} ---")
    if not all_text:
        return "Nao foi possivel extrair texto dos documentos."
    return "\n\n".join(all_text)


@tool
def analisar_fit(licitacao_id: str) -> str:
    """Analyze how well a specific licitacao fits the company profile. Returns match data for analysis.
    Args:
        licitacao_id: The PNCP control number (numeroControlePNCP) of the licitacao
    """
    perfil_resp = httpx.get(f"{NODE_API}/perfil", timeout=10)
    perfil = perfil_resp.json()
    lic_resp = httpx.get(f"{NODE_API}/licitacoes", params={"texto": licitacao_id}, timeout=10)
    lics = lic_resp.json().get("resultados", [])
    lic = next((l for l in lics if l.get("id") == licitacao_id), None)
    if not lic:
        return f"Licitacao {licitacao_id} nao encontrada no banco."
    return (
        f"DADOS PARA ANALISE DE FIT:\n\n"
        f"=== PERFIL DA EMPRESA ===\n"
        f"Nome: {perfil.get('nome_empresa','N/A')}\n"
        f"Areas: {', '.join(perfil.get('areas_atuacao',[]))}\n"
        f"Capacidades: {', '.join(perfil.get('capacidades_tecnicas',[]))}\n"
        f"Certificacoes: {', '.join(perfil.get('certificacoes',[]))}\n"
        f"Atestados: {'; '.join(perfil.get('atestados_descricao',[]))}\n"
        f"Porte: {perfil.get('porte','N/A')}\n"
        f"UFs interesse: {', '.join(perfil.get('ufs_interesse',[]))}\n"
        f"Faixa valor: R${perfil.get('valor_min',0):,.0f} - R${perfil.get('valor_max',0):,.0f}\n"
        f"Descricao: {perfil.get('descricao_livre','')}\n\n"
        f"=== LICITACAO ===\n"
        f"Orgao: {lic.get('orgao','')}\n"
        f"UF/Municipio: {lic.get('uf','')}/{lic.get('municipio','')}\n"
        f"Objeto: {lic.get('objeto','')}\n"
        f"Valor: R${lic.get('valorEstimado',0):,.2f}\n"
        f"Modalidade: {lic.get('modalidade','')}\n"
        f"Encerramento: {lic.get('dataEncerramento','N/A')}\n"
        f"Situacao: {lic.get('situacao','')}\n\n"
        f"Analise a aderencia entre o perfil da empresa e esta licitacao. "
        f"Avalie: aderencia tecnica (0-100%), requisitos atendidos, "
        f"requisitos que faltam, pontos de atencao, e recomendacao final "
        f"(participar / avaliar melhor / descartar)."
    )


@tool
def get_perfil() -> str:
    """Get the company profile with capabilities, certifications, and preferences."""
    r = httpx.get(f"{NODE_API}/perfil", timeout=10)
    p = r.json()
    if not p or not p.get("nome_empresa"):
        return "Perfil da empresa ainda nao foi preenchido. Peca ao usuario para preencher o perfil."
    return (
        f"Nome: {p.get('nome_empresa','')}\n"
        f"CNPJ: {p.get('cnpj','')}\n"
        f"Porte: {p.get('porte','')}\n"
        f"Areas de atuacao: {', '.join(p.get('areas_atuacao',[]))}\n"
        f"Capacidades tecnicas: {', '.join(p.get('capacidades_tecnicas',[]))}\n"
        f"Certificacoes: {', '.join(p.get('certificacoes',[]))}\n"
        f"Atestados: {'; '.join(p.get('atestados_descricao',[]))}\n"
        f"UFs de interesse: {', '.join(p.get('ufs_interesse',[]))}\n"
        f"Faixa de valor: R${p.get('valor_min',0):,.0f} - R${p.get('valor_max',0):,.0f}\n"
        f"Modalidades: {p.get('modalidades_interesse',[])}\n"
        f"Descricao: {p.get('descricao_livre','')}"
    )


@tool
def get_contexto_tela(licitacoes_json: str) -> str:
    """Parse and summarize the licitacoes currently visible on the user's screen.
    Args:
        licitacoes_json: JSON string with the visible licitacoes array
    """
    try:
        items = json.loads(licitacoes_json)
    except json.JSONDecodeError:
        return "Nenhuma licitacao visivel na tela."
    if not items:
        return "Nenhuma licitacao visivel na tela."
    lines = [f"{len(items)} licitacoes visiveis na tela:\n"]
    for i, it in enumerate(items, 1):
        lines.append(
            f"{i}. [{it.get('uf','')}/{it.get('municipio','')}] {it.get('orgao','')}\n"
            f"   Objeto: {str(it.get('objeto',''))[:150]}\n"
            f"   Valor: R${it.get('valorEstimado',0):,.2f} | Enc: {it.get('dataEncerramento','N/A')}\n"
            f"   ID: {it.get('id','')}"
        )
    return "\n".join(lines)


SYSTEM_PROMPT = """Voce e um assistente especialista em licitacoes publicas brasileiras.
Voce ajuda a equipe a encontrar e analisar oportunidades de licitacao no portal PNCP.

Comportamento:
- Responda sempre em portugues brasileiro
- Seja direto e pratico
- Quando o usuario perguntar sobre licitacoes na tela, use get_contexto_tela com os dados fornecidos
- Quando pedirem analise de fit, use analisar_fit e depois elabore sua analise
- Quando pedirem para ler um edital, use ler_edital com cnpj, ano e sequencial da licitacao
- Sempre consulte o perfil da empresa com get_perfil quando precisar fazer comparacoes
- Use buscar_semantico quando a busca textual simples nao for suficiente
- Formate valores monetarios em Real brasileiro (R$)
- Identifique prazos urgentes e alerte o usuario

Quando retornar acoes para o frontend, inclua no final da resposta um bloco JSON:
```json
{"acoes": {"filtrar": {...}, "destacar": ["id1"], "abrir_edital": "url"}}
```
So inclua o bloco de acoes quando fizer sentido (ex: quando recomendar licitacoes especificas)."""


def create_agent():
    model = LiteLLMModel(
        model_id=f"openrouter/{LLM_MODEL}",
        api_key=OPENROUTER_KEY,
        api_base="https://openrouter.ai/api/v1",
    )
    agent = CodeAgent(
        tools=[buscar_licitacoes, buscar_semantico, ler_edital, analisar_fit, get_perfil, get_contexto_tela],
        model=model,
        instructions=SYSTEM_PROMPT,
        max_steps=10,
        verbosity_level=1,
    )
    return agent
