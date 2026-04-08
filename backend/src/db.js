const { Pool } = require("pg");

const pool = new Pool({
  connectionString: process.env.DATABASE_URL || "postgresql://licitacoes:lic2024secure@localhost:5432/licitacoes_db",
});

// Initialize schema
async function initDB() {
  const client = await pool.connect();
  try {
    await client.query("CREATE EXTENSION IF NOT EXISTS vector");

    await client.query(`
      CREATE TABLE IF NOT EXISTS licitacoes (
        id TEXT PRIMARY KEY,
        orgao TEXT,
        cnpj_orgao TEXT,
        uf TEXT,
        municipio TEXT,
        objeto TEXT,
        valor_estimado DOUBLE PRECISION,
        valor_homologado DOUBLE PRECISION,
        modalidade TEXT,
        modalidade_id INTEGER,
        modo_disputa TEXT,
        situacao TEXT,
        data_abertura TEXT,
        data_encerramento TEXT,
        data_publicacao TEXT,
        srp BOOLEAN DEFAULT FALSE,
        link_sistema TEXT,
        amparo_legal TEXT,
        ano_compra INTEGER,
        sequencial_compra INTEGER,
        keywords TEXT,
        proposta_aberta BOOLEAN DEFAULT FALSE,
        embedding vector(1536),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        updated_at TIMESTAMPTZ DEFAULT NOW()
      )
    `);

    // Indexes
    await client.query("CREATE INDEX IF NOT EXISTS idx_uf ON licitacoes(uf)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_modalidade ON licitacoes(modalidade_id)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_data_encerramento ON licitacoes(data_encerramento)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_data_publicacao ON licitacoes(data_publicacao)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_proposta_aberta ON licitacoes(proposta_aberta)");
    await client.query("CREATE INDEX IF NOT EXISTS idx_valor ON licitacoes(valor_estimado)");
    // Vector similarity index (IVFFlat for performance)
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_embedding ON licitacoes
      USING ivfflat (embedding vector_cosine_ops) WITH (lists = 50)
    `).catch(() => {
      // IVFFlat needs rows to build, will create after data exists
      console.log("[db] IVFFlat index deferred (needs data first), using HNSW instead");
      return client.query(`
        CREATE INDEX IF NOT EXISTS idx_embedding_hnsw ON licitacoes
        USING hnsw (embedding vector_cosine_ops)
      `).catch(() => console.log("[db] HNSW index also deferred"));
    });

    // Full-text search index
    await client.query(`
      CREATE INDEX IF NOT EXISTS idx_objeto_fts ON licitacoes
      USING gin(to_tsvector('portuguese', COALESCE(objeto, '')))
    `);

    await client.query(`
      CREATE TABLE IF NOT EXISTS sync_log (
        id SERIAL PRIMARY KEY,
        started_at TIMESTAMPTZ DEFAULT NOW(),
        finished_at TIMESTAMPTZ,
        status TEXT,
        total_encontrados INTEGER DEFAULT 0,
        novos INTEGER DEFAULT 0,
        atualizados INTEGER DEFAULT 0,
        filtros TEXT
      )
    `);

    console.log("[db] PostgreSQL + pgvector schema initialized");
  } finally {
    client.release();
  }
}

async function upsertMany(items) {
  const client = await pool.connect();
  let novos = 0;
  let atualizados = 0;

  try {
    await client.query("BEGIN");

    for (const item of items) {
      const existing = await client.query("SELECT id FROM licitacoes WHERE id = $1", [item.id]);

      await client.query(`
        INSERT INTO licitacoes (
          id, orgao, cnpj_orgao, uf, municipio, objeto, valor_estimado, valor_homologado,
          modalidade, modalidade_id, modo_disputa, situacao, data_abertura, data_encerramento,
          data_publicacao, srp, link_sistema, amparo_legal, ano_compra, sequencial_compra,
          keywords, proposta_aberta, updated_at
        ) VALUES (
          $1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20, $21, $22, NOW()
        ) ON CONFLICT(id) DO UPDATE SET
          situacao = EXCLUDED.situacao,
          valor_homologado = EXCLUDED.valor_homologado,
          proposta_aberta = EXCLUDED.proposta_aberta,
          updated_at = NOW()
      `, [
        item.id, item.orgao, item.cnpjOrgao, item.uf, item.municipio,
        item.objeto, item.valorEstimado, item.valorHomologado,
        item.modalidade, item.modalidadeId || null, item.modoDisputa,
        item.situacao, item.dataAbertura, item.dataEncerramento,
        item.dataPublicacao, item.srp ? true : false, item.linkSistema,
        item.amparoLegal, item.anoCompra, item.sequencialCompra,
        JSON.stringify(item.keywordsEncontradas || []),
        item.propostaAberta ? true : false,
      ]);

      if (existing.rows.length > 0) atualizados++;
      else novos++;
    }

    await client.query("COMMIT");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }

  return { novos, atualizados };
}

async function buscar({ uf, modalidade, texto, valorMin, valorMax, apenasAbertas = true, ordenacao = "encerramento", limite = 200 } = {}) {
  const where = ["1=1"];
  const params = [];
  let paramIdx = 1;

  if (apenasAbertas) {
    where.push("proposta_aberta = true");
    where.push("(data_encerramento IS NULL OR data_encerramento > NOW()::text)");
  }

  if (uf) {
    where.push(`uf = $${paramIdx++}`);
    params.push(uf);
  }

  if (modalidade) {
    where.push(`modalidade_id = $${paramIdx++}`);
    params.push(Number(modalidade));
  }

  if (texto) {
    // Use full-text search for better Portuguese matching
    where.push(`(
      to_tsvector('portuguese', COALESCE(objeto, '')) @@ plainto_tsquery('portuguese', $${paramIdx})
      OR objeto ILIKE $${paramIdx + 1}
      OR orgao ILIKE $${paramIdx + 1}
      OR municipio ILIKE $${paramIdx + 1}
    )`);
    params.push(texto);
    params.push(`%${texto}%`);
    paramIdx += 2;
  }

  if (valorMin) {
    where.push(`valor_estimado >= $${paramIdx++}`);
    params.push(Number(valorMin));
  }

  if (valorMax) {
    where.push(`valor_estimado <= $${paramIdx++}`);
    params.push(Number(valorMax));
  }

  const orderMap = {
    encerramento: "data_encerramento ASC NULLS LAST",
    publicacao: "data_publicacao DESC",
    "valor-desc": "valor_estimado DESC NULLS LAST",
    "valor-asc": "valor_estimado ASC NULLS LAST",
  };
  const order = orderMap[ordenacao] || "data_encerramento ASC NULLS LAST";

  params.push(limite);
  const sql = `
    SELECT * FROM licitacoes
    WHERE ${where.join(" AND ")}
    ORDER BY ${order}
    LIMIT $${paramIdx}
  `;

  const { rows } = await pool.query(sql, params);

  return rows.map((r) => ({
    id: r.id,
    orgao: r.orgao,
    cnpjOrgao: r.cnpj_orgao,
    uf: r.uf,
    municipio: r.municipio,
    objeto: r.objeto,
    valorEstimado: r.valor_estimado,
    valorHomologado: r.valor_homologado,
    modalidade: r.modalidade,
    modoDisputa: r.modo_disputa,
    situacao: r.situacao,
    dataAbertura: r.data_abertura,
    dataEncerramento: r.data_encerramento,
    dataPublicacao: r.data_publicacao,
    srp: !!r.srp,
    linkSistema: r.link_sistema,
    amparoLegal: r.amparo_legal,
    anoCompra: r.ano_compra,
    sequencialCompra: r.sequencial_compra,
    keywordsEncontradas: JSON.parse(r.keywords || "[]"),
    propostaAberta: !!r.proposta_aberta,
  }));
}

// Semantic search using vector embeddings
async function buscarSemantico(queryEmbedding, { limite = 20, uf, apenasAbertas = true } = {}) {
  const where = ["embedding IS NOT NULL"];
  const params = [`[${queryEmbedding.join(",")}]`];
  let paramIdx = 2;

  if (apenasAbertas) {
    where.push("proposta_aberta = true");
    where.push("(data_encerramento IS NULL OR data_encerramento > NOW()::text)");
  }

  if (uf) {
    where.push(`uf = $${paramIdx++}`);
    params.push(uf);
  }

  params.push(limite);
  const sql = `
    SELECT *, 1 - (embedding <=> $1::vector) as similarity
    FROM licitacoes
    WHERE ${where.join(" AND ")}
    ORDER BY embedding <=> $1::vector
    LIMIT $${paramIdx}
  `;

  const { rows } = await pool.query(sql, params);
  return rows.map((r) => ({
    id: r.id,
    orgao: r.orgao,
    uf: r.uf,
    municipio: r.municipio,
    objeto: r.objeto,
    valorEstimado: r.valor_estimado,
    modalidade: r.modalidade,
    situacao: r.situacao,
    dataEncerramento: r.data_encerramento,
    propostaAberta: !!r.proposta_aberta,
    similarity: r.similarity,
  }));
}

// Update embedding for a licitação
async function updateEmbedding(id, embedding) {
  await pool.query(
    "UPDATE licitacoes SET embedding = $1::vector WHERE id = $2",
    [`[${embedding.join(",")}]`, id]
  );
}

// Get licitações without embeddings (for batch processing)
async function getLicitacoesSemEmbedding(limite = 100) {
  const { rows } = await pool.query(
    "SELECT id, objeto, orgao, municipio, uf FROM licitacoes WHERE embedding IS NULL LIMIT $1",
    [limite]
  );
  return rows;
}

async function registrarSync(status, total, novos, atualizados, filtros) {
  await pool.query(`
    INSERT INTO sync_log (finished_at, status, total_encontrados, novos, atualizados, filtros)
    VALUES (NOW(), $1, $2, $3, $4, $5)
  `, [status, total, novos, atualizados, JSON.stringify(filtros)]);
}

async function ultimoSync() {
  const { rows } = await pool.query("SELECT * FROM sync_log ORDER BY id DESC LIMIT 1");
  return rows[0] || null;
}

async function stats() {
  const totalRes = await pool.query("SELECT COUNT(*) as n FROM licitacoes");
  const abertasRes = await pool.query(
    "SELECT COUNT(*) as n FROM licitacoes WHERE proposta_aberta = true AND (data_encerramento IS NULL OR data_encerramento > NOW()::text)"
  );
  const embeddingsRes = await pool.query("SELECT COUNT(*) as n FROM licitacoes WHERE embedding IS NOT NULL");
  const ultimo = await ultimoSync();
  return {
    total: parseInt(totalRes.rows[0].n),
    abertas: parseInt(abertasRes.rows[0].n),
    comEmbedding: parseInt(embeddingsRes.rows[0].n),
    ultimoSync: ultimo,
  };
}

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
};
