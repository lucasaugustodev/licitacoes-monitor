const Database = require("better-sqlite3");
const path = require("path");

const DB_PATH = path.join(__dirname, "..", "licitacoes.db");

const db = new Database(DB_PATH);

// Enable WAL mode for better concurrent read performance
db.pragma("journal_mode = WAL");

db.exec(`
  CREATE TABLE IF NOT EXISTS licitacoes (
    id TEXT PRIMARY KEY,
    orgao TEXT,
    cnpj_orgao TEXT,
    uf TEXT,
    municipio TEXT,
    objeto TEXT,
    valor_estimado REAL,
    valor_homologado REAL,
    modalidade TEXT,
    modalidade_id INTEGER,
    modo_disputa TEXT,
    situacao TEXT,
    data_abertura TEXT,
    data_encerramento TEXT,
    data_publicacao TEXT,
    srp INTEGER,
    link_sistema TEXT,
    amparo_legal TEXT,
    ano_compra INTEGER,
    sequencial_compra INTEGER,
    keywords TEXT,
    proposta_aberta INTEGER,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
  );

  CREATE INDEX IF NOT EXISTS idx_uf ON licitacoes(uf);
  CREATE INDEX IF NOT EXISTS idx_modalidade ON licitacoes(modalidade_id);
  CREATE INDEX IF NOT EXISTS idx_data_encerramento ON licitacoes(data_encerramento);
  CREATE INDEX IF NOT EXISTS idx_data_publicacao ON licitacoes(data_publicacao);
  CREATE INDEX IF NOT EXISTS idx_proposta_aberta ON licitacoes(proposta_aberta);
  CREATE INDEX IF NOT EXISTS idx_valor ON licitacoes(valor_estimado);

  CREATE TABLE IF NOT EXISTS sync_log (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    started_at TEXT DEFAULT (datetime('now')),
    finished_at TEXT,
    status TEXT,
    total_encontrados INTEGER DEFAULT 0,
    novos INTEGER DEFAULT 0,
    atualizados INTEGER DEFAULT 0,
    filtros TEXT
  );
`);

const upsertStmt = db.prepare(`
  INSERT INTO licitacoes (
    id, orgao, cnpj_orgao, uf, municipio, objeto, valor_estimado, valor_homologado,
    modalidade, modalidade_id, modo_disputa, situacao, data_abertura, data_encerramento,
    data_publicacao, srp, link_sistema, amparo_legal, ano_compra, sequencial_compra,
    keywords, proposta_aberta, updated_at
  ) VALUES (
    @id, @orgao, @cnpj_orgao, @uf, @municipio, @objeto, @valor_estimado, @valor_homologado,
    @modalidade, @modalidade_id, @modo_disputa, @situacao, @data_abertura, @data_encerramento,
    @data_publicacao, @srp, @link_sistema, @amparo_legal, @ano_compra, @sequencial_compra,
    @keywords, @proposta_aberta, datetime('now')
  ) ON CONFLICT(id) DO UPDATE SET
    situacao = excluded.situacao,
    valor_homologado = excluded.valor_homologado,
    proposta_aberta = excluded.proposta_aberta,
    updated_at = datetime('now')
`);

const upsertMany = db.transaction((items) => {
  let novos = 0;
  let atualizados = 0;
  for (const item of items) {
    const existing = db.prepare("SELECT id FROM licitacoes WHERE id = ?").get(item.id);
    upsertStmt.run({
      id: item.id,
      orgao: item.orgao,
      cnpj_orgao: item.cnpjOrgao,
      uf: item.uf,
      municipio: item.municipio,
      objeto: item.objeto,
      valor_estimado: item.valorEstimado,
      valor_homologado: item.valorHomologado,
      modalidade: item.modalidade,
      modalidade_id: item.modalidadeId || null,
      modo_disputa: item.modoDisputa,
      situacao: item.situacao,
      data_abertura: item.dataAbertura,
      data_encerramento: item.dataEncerramento,
      data_publicacao: item.dataPublicacao,
      srp: item.srp ? 1 : 0,
      link_sistema: item.linkSistema,
      amparo_legal: item.amparoLegal,
      ano_compra: item.anoCompra,
      sequencial_compra: item.sequencialCompra,
      keywords: JSON.stringify(item.keywordsEncontradas || []),
      proposta_aberta: item.propostaAberta ? 1 : 0,
    });
    if (existing) atualizados++;
    else novos++;
  }
  return { novos, atualizados };
});

function buscar({ uf, modalidade, texto, valorMin, valorMax, apenasAbertas = true, ordenacao = "encerramento", limite = 200 } = {}) {
  let where = ["1=1"];
  const params = {};

  if (apenasAbertas) {
    where.push("proposta_aberta = 1");
    where.push("(data_encerramento IS NULL OR data_encerramento > datetime('now'))");
  }

  if (uf) {
    where.push("uf = @uf");
    params.uf = uf;
  }

  if (modalidade) {
    where.push("modalidade_id = @modalidade");
    params.modalidade = Number(modalidade);
  }

  if (texto) {
    where.push("(objeto LIKE @texto OR orgao LIKE @texto OR municipio LIKE @texto)");
    params.texto = `%${texto}%`;
  }

  if (valorMin) {
    where.push("valor_estimado >= @valorMin");
    params.valorMin = Number(valorMin);
  }

  if (valorMax) {
    where.push("valor_estimado <= @valorMax");
    params.valorMax = Number(valorMax);
  }

  const orderMap = {
    encerramento: "data_encerramento ASC",
    publicacao: "data_publicacao DESC",
    "valor-desc": "valor_estimado DESC",
    "valor-asc": "valor_estimado ASC",
  };
  const order = orderMap[ordenacao] || "data_encerramento ASC";

  const sql = `
    SELECT * FROM licitacoes
    WHERE ${where.join(" AND ")}
    ORDER BY ${order}
    LIMIT @limite
  `;
  params.limite = limite;

  const rows = db.prepare(sql).all(params);

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

function registrarSync(status, total, novos, atualizados, filtros) {
  db.prepare(`
    INSERT INTO sync_log (finished_at, status, total_encontrados, novos, atualizados, filtros)
    VALUES (datetime('now'), @status, @total, @novos, @atualizados, @filtros)
  `).run({ status, total, novos, atualizados, filtros: JSON.stringify(filtros) });
}

function ultimoSync() {
  return db.prepare("SELECT * FROM sync_log ORDER BY id DESC LIMIT 1").get() || null;
}

function stats() {
  const total = db.prepare("SELECT COUNT(*) as n FROM licitacoes").get().n;
  const abertas = db.prepare("SELECT COUNT(*) as n FROM licitacoes WHERE proposta_aberta = 1 AND (data_encerramento IS NULL OR data_encerramento > datetime('now'))").get().n;
  const ultimo = ultimoSync();
  return { total, abertas, ultimoSync: ultimo };
}

module.exports = { upsertMany, buscar, registrarSync, ultimoSync, stats, db };
