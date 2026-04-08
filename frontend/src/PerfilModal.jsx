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
                <option value="Medio">Medio</option>
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
            <label>Areas de Atuacao</label>
            <input
              value={(perfil.areas_atuacao || []).join(", ")}
              onChange={(e) => handleArrayField("areas_atuacao", e.target.value)}
              placeholder="desenvolvimento web, BI, mobile, suporte"
            />
            <small>Separe por virgula</small>
          </div>

          <div className="perfil-field">
            <label>Capacidades Tecnicas</label>
            <input
              value={(perfil.capacidades_tecnicas || []).join(", ")}
              onChange={(e) => handleArrayField("capacidades_tecnicas", e.target.value)}
              placeholder="React, Node.js, Python, PostgreSQL, AWS"
            />
            <small>Separe por virgula</small>
          </div>

          <div className="perfil-field">
            <label>Certificacoes</label>
            <input
              value={(perfil.certificacoes || []).join(", ")}
              onChange={(e) => handleArrayField("certificacoes", e.target.value)}
              placeholder="ISO 9001, CMMI, MPS.BR"
            />
            <small>Separe por virgula</small>
          </div>

          <div className="perfil-field">
            <label>Atestados de Capacidade Tecnica</label>
            <textarea
              value={(perfil.atestados_descricao || []).join("\n")}
              onChange={(e) => setPerfil((p) => ({ ...p, atestados_descricao: e.target.value.split("\n").filter(Boolean) }))}
              placeholder={"Sistema web para Prefeitura de X, R$500k\nApp mobile para Tribunal Y, R$200k"}
              rows={3}
            />
            <small>Um por linha</small>
          </div>

          <div className="perfil-row">
            <div className="perfil-field">
              <label>Valor Minimo (R$)</label>
              <input
                type="number"
                value={perfil.valor_min || ""}
                onChange={(e) => setPerfil((p) => ({ ...p, valor_min: Number(e.target.value) || 0 }))}
                placeholder="0"
              />
            </div>
            <div className="perfil-field">
              <label>Valor Maximo (R$)</label>
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
            <small>4=Concorrencia, 6=Pregao Eletronico, 8=Dispensa, 9=Inexigibilidade, 12=Credenciamento</small>
          </div>

          <div className="perfil-field">
            <label>Descricao Livre</label>
            <textarea
              value={perfil.descricao_livre}
              onChange={(e) => setPerfil((p) => ({ ...p, descricao_livre: e.target.value }))}
              placeholder="Informacoes adicionais sobre a empresa que a IA deve considerar..."
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
