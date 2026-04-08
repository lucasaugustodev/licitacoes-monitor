import { useState, useEffect, useCallback, useRef } from "react";
import "./App.css";

const API_URL = "http://localhost:3002/api";

function formatCurrency(value) {
  if (!value && value !== 0) return "—";
  return new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" }).format(value);
}

function formatDate(dateStr) {
  if (!dateStr) return "—";
  const d = new Date(dateStr);
  return d.toLocaleDateString("pt-BR", { day: "2-digit", month: "2-digit", year: "numeric", hour: "2-digit", minute: "2-digit" });
}

function diasRestantes(dateStr) {
  if (!dateStr) return null;
  const diff = new Date(dateStr) - new Date();
  return Math.ceil(diff / (1000 * 60 * 60 * 24));
}

function BadgeUrgencia({ dataEncerramento }) {
  const dias = diasRestantes(dataEncerramento);
  if (dias === null) return null;
  if (dias < 0) return <span className="badge badge-expired">Encerrada</span>;
  if (dias <= 3) return <span className="badge badge-urgent">Urgente ({dias}d)</span>;
  if (dias <= 7) return <span className="badge badge-warning">{dias} dias</span>;
  return <span className="badge badge-ok">{dias} dias</span>;
}

function LicitacaoCard({ item }) {
  const linkPncp = item.cnpjOrgao && item.anoCompra && item.sequencialCompra
    ? `https://pncp.gov.br/app/editais/${item.cnpjOrgao}/${item.anoCompra}/${item.sequencialCompra}`
    : null;

  return (
    <div className="card">
      <div className="card-header">
        <div className="card-title-row">
          <h3>{item.orgao || "Orgao nao informado"}</h3>
          <BadgeUrgencia dataEncerramento={item.dataEncerramento} />
        </div>
        <span className="card-location">{item.municipio}{item.municipio && item.uf ? " - " : ""}{item.uf}</span>
      </div>

      <p className="card-objeto">{item.objeto}</p>

      <div className="card-info">
        <div className="info-row">
          <span className="label">Modalidade:</span>
          <span>{item.modalidade || "—"}</span>
        </div>
        <div className="info-row">
          <span className="label">Valor Estimado:</span>
          <span className="valor">{formatCurrency(item.valorEstimado)}</span>
        </div>
        <div className="info-row">
          <span className="label">Abertura:</span>
          <span>{formatDate(item.dataAbertura)}</span>
        </div>
        <div className="info-row">
          <span className="label">Encerramento:</span>
          <span>{formatDate(item.dataEncerramento)}</span>
        </div>
        <div className="info-row">
          <span className="label">Situacao:</span>
          <span>{item.situacao || "—"}</span>
        </div>
        <div className="info-row">
          <span className="label">Amparo Legal:</span>
          <span>{item.amparoLegal || "—"}</span>
        </div>
        {item.keywordsEncontradas?.length > 0 && (
          <div className="info-row keywords-row">
            <span className="label">Keywords:</span>
            <span className="keywords">
              {item.keywordsEncontradas.map((kw, i) => (
                <span key={i} className="keyword-tag">{kw}</span>
              ))}
            </span>
          </div>
        )}
      </div>

      <div className="card-actions">
        {linkPncp && (
          <a href={linkPncp} target="_blank" rel="noopener noreferrer" className="btn btn-primary">
            Ver no PNCP
          </a>
        )}
        {item.linkSistema && (
          <a href={item.linkSistema} target="_blank" rel="noopener noreferrer" className="btn btn-secondary">
            Sistema de Origem
          </a>
        )}
      </div>
    </div>
  );
}

function SyncBar({ dbStats, syncStatus, onSync, onRefresh }) {
  const running = syncStatus?.running;
  const progress = syncStatus?.progress;

  const pct = progress?.totalJobs
    ? Math.round((progress.completedJobs / progress.totalJobs) * 100)
    : 0;

  return (
    <div className="sync-bar">
      <div className="sync-info">
        <span className="sync-stat">
          <strong>{dbStats.total}</strong> no banco
        </span>
        <span className="sync-stat">
          <strong>{dbStats.abertas}</strong> abertas
        </span>
        {dbStats.ultimoSync && (
          <span className="sync-stat sync-time">
            Ultimo sync: {formatDate(dbStats.ultimoSync.finished_at)}
            {dbStats.ultimoSync.novos > 0 && ` (+${dbStats.ultimoSync.novos} novos)`}
          </span>
        )}
      </div>

      {running && progress && (
        <div className="sync-progress">
          <div className="progress-bar">
            <div className="progress-fill" style={{ width: `${pct}%` }} />
          </div>
          <span className="progress-text">
            {progress.completedJobs}/{progress.totalJobs} jobs ({pct}%)
            {progress.novos > 0 && ` | +${progress.novos} novos`}
          </span>
        </div>
      )}

      <div className="sync-actions">
        {!running && (
          <button className="btn btn-sync" onClick={onSync}>
            Sync Completo (60 dias)
          </button>
        )}
        <button className="btn btn-refresh" onClick={onRefresh} disabled={running}>
          Atualizar
        </button>
      </div>
    </div>
  );
}

export default function App() {
  const [licitacoes, setLicitacoes] = useState([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [total, setTotal] = useState(0);
  const [dbStats, setDbStats] = useState({ total: 0, abertas: 0, ultimoSync: null });
  const [syncStatus, setSyncStatus] = useState({ running: false, progress: null });

  const [uf, setUf] = useState("");
  const [modalidade, setModalidade] = useState("");
  const [texto, setTexto] = useState("");
  const [valorMin, setValorMin] = useState("");
  const [valorMax, setValorMax] = useState("");
  const [ordenacao, setOrdenacao] = useState("encerramento");

  const [ufs, setUfs] = useState([]);
  const [modalidades, setModalidades] = useState([]);

  const pollRef = useRef(null);

  const fetchStats = useCallback(() => {
    fetch(`${API_URL}/stats`).then((r) => r.json()).then(setDbStats).catch(() => {});
  }, []);

  const fetchSyncStatus = useCallback(() => {
    fetch(`${API_URL}/sync/status`).then((r) => r.json()).then((data) => {
      setSyncStatus(data);
      if (data.dbStats) setDbStats(data.dbStats);
    }).catch(() => {});
  }, []);

  useEffect(() => {
    fetch(`${API_URL}/ufs`).then((r) => r.json()).then((d) => setUfs(d.ufs)).catch(() => {});
    fetch(`${API_URL}/modalidades`).then((r) => r.json()).then((d) => setModalidades(d.modalidades)).catch(() => {});
    fetchStats();
    fetchSyncStatus();
  }, [fetchStats, fetchSyncStatus]);

  // Poll sync status while running
  useEffect(() => {
    if (syncStatus.running) {
      pollRef.current = setInterval(() => {
        fetchSyncStatus();
      }, 5000);
    } else {
      if (pollRef.current) {
        clearInterval(pollRef.current);
        pollRef.current = null;
      }
    }
    return () => {
      if (pollRef.current) clearInterval(pollRef.current);
    };
  }, [syncStatus.running, fetchSyncStatus]);

  const buscar = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const params = new URLSearchParams();
      if (uf) params.set("uf", uf);
      if (modalidade) params.set("modalidade", modalidade);
      if (texto) params.set("texto", texto);
      if (valorMin) params.set("valorMin", valorMin);
      if (valorMax) params.set("valorMax", valorMax);
      if (ordenacao) params.set("ordenacao", ordenacao);

      const res = await fetch(`${API_URL}/licitacoes?${params}`);
      if (!res.ok) throw new Error(`Erro ${res.status}`);
      const data = await res.json();

      setLicitacoes(data.resultados || []);
      setTotal(data.total || 0);
    } catch (err) {
      setError(err.message);
      setLicitacoes([]);
    } finally {
      setLoading(false);
    }
  }, [uf, modalidade, texto, valorMin, valorMax, ordenacao]);

  useEffect(() => {
    if (dbStats.total > 0) buscar();
  }, [dbStats.total > 0]); // eslint-disable-line

  async function iniciarSync() {
    setError(null);
    try {
      await fetch(`${API_URL}/sync`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ dias: 60 }),
      });
      // Start polling
      fetchSyncStatus();
    } catch (err) {
      setError(err.message);
    }
  }

  function atualizar() {
    fetchStats();
    fetchSyncStatus();
    buscar();
  }

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
          <LicitacaoCard key={item.id || i} item={item} />
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
  );
}
