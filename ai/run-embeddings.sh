#!/bin/bash
cd /opt/licitacoes-monitor/ai
export 
/opt/licitacoes-monitor/ai/venv/bin/python3 embeddings.py >> /var/log/licitacoes-embeddings.log 2>&1
echo "---$(date)---" >> /var/log/licitacoes-embeddings.log
