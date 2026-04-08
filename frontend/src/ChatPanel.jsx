import { useState, useEffect, useRef, useCallback } from "react";
import "./ChatPanel.css";

const API_URL = "/api";

export default function ChatPanel({ licitacoesVisiveis, filtrosAtivos, onAcoes }) {
  const [messages, setMessages] = useState([]);
  const [input, setInput] = useState("");
  const [loading, setLoading] = useState(false);
  const messagesEndRef = useRef(null);
  const textareaRef = useRef(null);

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
            Pergunte sobre as licitacoes visiveis, peca analises de fit, ou busque oportunidades.
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
          placeholder="Pergunte sobre licitacoes..."
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
