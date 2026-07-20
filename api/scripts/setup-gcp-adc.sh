#!/bin/bash
# Copyright (C) 2026 Ailin One, Inc.
#
# This file is part of Collective Intelligence Engine (ci).
# Licensed under the GNU Affero General Public License v3.0 or later.
# See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
#
# SPDX-License-Identifier: AGPL-3.0-or-later
# Source: https://github.com/ailinone/collective-intelligence

# Setup GCP Application Default Credentials
# This script configures ADC for local development

set -e

echo "🔧 Configurando Application Default Credentials do GCP..."
echo ""

# Check if gcloud is installed
if ! command -v gcloud &> /dev/null; then
    echo "❌ gcloud CLI não encontrado. Por favor, instale primeiro:"
    echo "   brew install google-cloud-sdk"
    exit 1
fi

# Check if user is authenticated
if ! gcloud auth list --filter=status:ACTIVE --format="value(account)" | head -1 &> /dev/null; then
    echo "❌ Nenhum usuário autenticado. Execute: gcloud auth login"
    exit 1
fi

echo "✅ Usuário autenticado: $(gcloud auth list --filter=status:ACTIVE --format='value(account)' | head -1)"
echo ""

# Check current project
CURRENT_PROJECT=$(gcloud config get-value project 2>/dev/null || echo "")
if [ -z "$CURRENT_PROJECT" ]; then
    echo "❌ Nenhum projeto configurado. Execute: gcloud config set project YOUR_PROJECT_ID"
    exit 1
fi

echo "✅ Projeto atual: $CURRENT_PROJECT"
echo ""

# Setup Application Default Credentials
echo "Configurando Application Default Credentials..."
gcloud auth application-default login --quiet

if [ $? -eq 0 ]; then
    echo ""
    echo "✅ Application Default Credentials configuradas com sucesso!"
    echo ""
    echo "📋 Credenciais salvas em:"
    echo "   ~/.config/gcloud/application_default_credentials.json"
    echo ""
    echo "🧪 Testando acesso ao GCP Secret Manager..."
    
    # Test access
    cd "$(dirname "$0")/.."
    if pnpm tsx test-gcp-secrets.ts 2>&1 | grep -q "✅ Conexão OK"; then
        echo "✅ Teste passou! GCP Secret Manager está funcionando."
    else
        echo "⚠️  Teste falhou. Verifique os logs acima."
    fi
else
    echo "❌ Erro ao configurar Application Default Credentials"
    exit 1
fi

