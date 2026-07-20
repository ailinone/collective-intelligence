// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

import { OpenAIRealtimeClient } from '../src/providers/openai/realtime-client';
import dotenv from 'dotenv';

// Load environment variables
dotenv.config({ path: './.env' });

async function debugRealtimeEndpoints() {
  console.log('🔍 DEBUG DETALHADO DOS ENDPOINTS FALHADOS');
  console.log('=============================================');

  const client = new OpenAIRealtimeClient(process.env.OPENAI_API_KEY!);

  console.log('\n1. TESTANDO CREATE CALL COM DIFERENTES PARÂMETROS...');
  console.log('─'.repeat(60));

  // Tentativa 1: Parâmetros mínimos
  console.log('Tentativa 1: Parâmetros mínimos...');
  try {
    const callId = await client.createCall({ to: 'test@example.com' });
    console.log('✅ SUCESSO:', callId);
    return callId;
  } catch (e: any) {
    console.log('❌ FALHA:', e.message);
  }

  // Tentativa 2: Sem telefone
  console.log('Tentativa 2: Sem telefone...');
  try {
    const callId = await client.createCall({ metadata: { test: true } });
    console.log('✅ SUCESSO:', callId);
    return callId;
  } catch (e: any) {
    console.log('❌ FALHA:', e.message);
  }

  // Tentativa 3: Verificar se endpoint existe
  console.log('Tentativa 3: Verificar se endpoint existe...');
  try {
    const response = await fetch('https://api.openai.com/v1/realtime/calls', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY!}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({})
    });
    console.log('Status:', response.status, response.statusText);
    const text = await response.text();
    console.log('Response:', text.substring(0, 200));
  } catch (e: any) {
    console.log('❌ Fetch direto falhou:', e.message);
  }

  console.log('\n2. TESTANDO LIST CALLS...');
  console.log('─'.repeat(60));

  try {
    const calls = await client.listCalls();
    console.log('✅ SUCESSO:', calls);
  } catch (e: any) {
    console.log('❌ FALHA:', e.message);
  }

  console.log('\n3. TESTANDO TRANSCRIPTION SESSIONS...');
  console.log('─'.repeat(60));

  // Tentativa 1: Parâmetros mínimos
  console.log('Tentativa 1: Parâmetros mínimos...');
  try {
    const sessionId = await client.createTranscriptionSession({
      model: 'whisper-1'
    });
    console.log('✅ SUCESSO:', sessionId);
  } catch (e: any) {
    console.log('❌ FALHA:', e.message);
  }

  // Tentativa 2: Verificar endpoint diretamente
  console.log('Tentativa 2: Endpoint direto...');
  try {
    const response = await fetch('https://api.openai.com/v1/realtime/transcription_sessions', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${process.env.OPENAI_API_KEY!}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model: 'whisper-1',
        language: 'en'
      })
    });
    console.log('Status:', response.status, response.statusText);
    const text = await response.text();
    console.log('Response:', text.substring(0, 200));
  } catch (e: any) {
    console.log('❌ Fetch direto falhou:', e.message);
  }

  console.log('\n4. VERIFICANDO DOCUMENTAÇÃO DA API...');
  console.log('─'.repeat(60));

  // Verificar se os endpoints realmente existem
  const endpointsToCheck = [
    'https://api.openai.com/v1/realtime/calls',
    'https://api.openai.com/v1/realtime/client_secrets',
    'https://api.openai.com/v1/realtime/sessions',
    'https://api.openai.com/v1/realtime/transcription_sessions'
  ];

  for (const endpoint of endpointsToCheck) {
    try {
      console.log(`Testando OPTIONS ${endpoint}...`);
      const response = await fetch(endpoint, {
        method: 'OPTIONS',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY!}`,
        }
      });
      console.log(`  Status: ${response.status} ${response.statusText}`);
    } catch (e: any) {
      console.log(`  ❌ Erro: ${e.message}`);
    }
  }
}

debugRealtimeEndpoints().catch(console.error);
