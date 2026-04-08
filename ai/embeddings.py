#!/usr/bin/env python3
"""Batch embedding pipeline for licitacoes and company profile."""
import os
import httpx
import pg8000

OPENROUTER_KEY = os.getenv("OPENROUTER_API_KEY", "")
DB_URL = os.getenv("DATABASE_URL", "postgresql://licitacoes:lic2024secure@localhost:5432/licitacoes_db")
EMBEDDING_MODEL = os.getenv("EMBEDDING_MODEL", "openai/text-embedding-3-small")


def get_connection():
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
    r = httpx.post(
        "https://openrouter.ai/api/v1/embeddings",
        headers={"Authorization": f"Bearer {OPENROUTER_KEY}"},
        json={"model": EMBEDDING_MODEL, "input": text[:8000]},
        timeout=30,
    )
    r.raise_for_status()
    return r.json()["data"][0]["embedding"]


def embed_licitacoes(batch_size=50):
    conn = get_connection()
    cur = conn.cursor()
    cur.execute(
        "SELECT id, objeto, orgao, municipio, uf, modalidade FROM licitacoes WHERE embedding IS NULL LIMIT %s",
        (batch_size,),
    )
    rows = cur.fetchall()
    if not rows:
        print("[embeddings] No licitacoes without embedding.")
        return 0
    print(f"[embeddings] Processing {len(rows)} licitacoes...")
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
    embed_perfil(cur, conn)
    cur.close()
    conn.close()
    return count


def embed_perfil(cur=None, conn=None):
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
    text = f"{nome} | Areas: {', '.join(areas or [])} | Capacidades: {', '.join(caps or [])} | Certificacoes: {', '.join(certs or [])} | {desc or ''}"
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
