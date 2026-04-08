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
    context_parts = [req.message]
    if req.licitacoesVisiveis:
        context_parts.append(
            f"\n\n[CONTEXTO: O usuario esta vendo estas licitacoes na tela: "
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
        acoes = {}
        if '{"acoes"' in result_str:
            try:
                json_start = result_str.rfind('{"acoes"')
                json_str = result_str[json_start:]
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
