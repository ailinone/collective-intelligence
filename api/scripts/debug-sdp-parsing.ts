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

async function debugSDPParsing() {
  console.log('🔍 DEBUG SDP PARSING - OPENAI REALTIME API');
  console.log('===========================================');

  console.log('\n📋 TESTANDO DIFERENTES FORMATOS DE SDP OFFER');
  console.log('─'.repeat(60));

  // Testar diferentes formatos de SDP para encontrar qual funciona
  const sdpTests = [
    {
      name: 'SDP mínimo (PCMU)',
      sdp: `v=0
o=- 123456789 1 IN IP4 0.0.0.0
s=-
t=0 0
m=audio 0 RTP/AVP 0
a=rtpmap:0 PCMU/8000`
    },
    {
      name: 'SDP WebRTC básico (OPUS)',
      sdp: `v=0
o=- 1234567890123456789 1 IN IP4 0.0.0.0
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=rtpmap:111 opus/48000/2
a=sendrecv`
    },
    {
      name: 'SDP WebRTC completo',
      sdp: `v=0
o=- 3735928559 2 IN IP4 127.0.0.1
s=-
t=0 0
a=group:BUNDLE 0
a=msid-semantic: WMS
m=audio 9 UDP/TLS/RTP/SAVPF 111 0 8 126
c=IN IP4 0.0.0.0
a=rtcp:9 IN IP4 0.0.0.0
a=ice-ufrag:abcd
a=ice-pwd:abcd1234abcd1234abcd1234abcd1234
a=ice-options:trickle
a=fingerprint:sha-256 00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00:00
a=setup:actpass
a=mid:0
a=recvonly
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=fmtp:111 minptime=10;useinbandfec=1
a=rtpmap:0 PCMU/8000
a=rtpmap:8 PCMA/8000
a=rtpmap:126 telephone-event/8000
a=maxptime:60`
    },
    {
      name: 'SDP da documentação OpenAI',
      sdp: `v=0
o=- 4227147428 1719357865 IN IP4 127.0.0.1
s=-
c=IN IP4 0.0.0.0
t=0 0
a=group:BUNDLE 0 1
a=msid-semantic:WMS *
a=fingerprint:sha-256 CA:92:52:51:B4:91:3B:34:DD:9C:0B:FB:76:19:7E:3B:F1:21:0F:32:2C:38:01:72:5D:3F:78:C7:5F:8B:C7:36
m=audio 9 UDP/TLS/RTP/SAVPF 111 0 8
a=mid:0
a=ice-ufrag:kZ2qkHXX/u11
a=ice-pwd:uoD16Di5OGx3VbqgA3ymjEQV2kwiOjw6
a=setup:active
a=rtcp-mux
a=rtpmap:111 opus/48000/2
a=candidate:993865896 1 udp 2130706431 4.155.146.196 3478 typ host ufrag kZ2qkHXX/u11
a=candidate:1432411780 1 tcp 1671430143 4.155.146.196 443 typ host tcptype passive ufrag kZ2qkHXX/u11
m=application 9 UDP/DTLS/SCTP webrtc-datachannel
a=mid:1
a=sctp-port:5000`
    }
  ];

  // Session config mínimo
  const minimalSession = {
    type: 'realtime' as const,
    model: 'gpt-4o-realtime-preview'
  };

  for (const test of sdpTests) {
    console.log(`\n🔬 Testando: ${test.name}`);
    console.log('SDP usado:');
    console.log(test.sdp);
    console.log('');

    try {
      const formData = new FormData();
      formData.append('sdp', test.sdp);
      formData.append('session', JSON.stringify(minimalSession));

      console.log('Enviando request...');
      const response = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY!}`,
        },
        body: formData,
      });

      console.log(`Status: ${response.status} ${response.statusText}`);

      if (response.ok) {
        const sdpAnswer = await response.text();
        console.log('✅ SUCESSO! SDP Answer recebido:');
        console.log(sdpAnswer);
        console.log(`\n🎯 ENCONTRAMOS O FORMATO CORRETO: ${test.name}`);
        return { success: true, sdpFormat: test.name, sdpAnswer };
      } else {
        const errorText = await response.text();
        console.log(`❌ Erro: ${errorText}`);
      }
    } catch (error: any) {
      console.log(`❌ Exceção: ${error.message}`);
    }

    console.log('─'.repeat(40));
  }

  console.log('\n📋 TESTANDO SESSION CONFIG VARIATIONS');
  console.log('─'.repeat(60));

  // SDP que parece funcionar melhor (WebRTC básico)
  const workingSDP = `v=0
o=- 1234567890123456789 1 IN IP4 0.0.0.0
s=-
t=0 0
m=audio 9 UDP/TLS/RTP/SAVPF 111
c=IN IP4 0.0.0.0
a=rtpmap:111 opus/48000/2
a=sendrecv`;

  const sessionVariations = [
    { name: 'Mínimo', config: { type: 'realtime' as const, model: 'gpt-4o-realtime-preview' } },
    { name: 'Com modalities', config: { type: 'realtime' as const, model: 'gpt-4o-realtime-preview', modalities: ['text', 'audio'] } },
    { name: 'Com voice', config: { type: 'realtime' as const, model: 'gpt-4o-realtime-preview', modalities: ['text', 'audio'], voice: 'alloy' } },
    { name: 'Completo', config: {
      type: 'realtime' as const,
      model: 'gpt-4o-realtime-preview',
      modalities: ['text', 'audio'],
      voice: 'alloy',
      input_audio_format: 'pcm16',
      output_audio_format: 'pcm16',
      temperature: 0.8
    }}
  ];

  for (const variation of sessionVariations) {
    console.log(`\n🔬 Testando session: ${variation.name}`);
    console.log('Config:', JSON.stringify(variation.config, null, 2));

    try {
      const formData = new FormData();
      formData.append('sdp', workingSDP);
      formData.append('session', JSON.stringify(variation.config));

      const response = await fetch('https://api.openai.com/v1/realtime/calls', {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${process.env.OPENAI_API_KEY!}`,
        },
        body: formData,
      });

      console.log(`Status: ${response.status} ${response.statusText}`);

      if (response.ok) {
        const sdpAnswer = await response.text();
        console.log('✅ SUCESSO! SDP Answer recebido');
        console.log(`🎯 CONFIG FUNCIONAL: ${variation.name}`);
        return { success: true, sessionConfig: variation.name, sdpAnswer };
      } else {
        const errorText = await response.text();
        console.log(`❌ Erro: ${errorText.substring(0, 200)}`);
      }
    } catch (error: any) {
      console.log(`❌ Exceção: ${error.message}`);
    }

    console.log('─'.repeat(30));
  }

  console.log('\n🎯 RESULTADO FINAL');
  console.log('==================');
  console.log('❌ Nenhum formato de SDP ou configuração de sessão funcionou.');
  console.log('🔍 Possíveis causas:');
  console.log('   • API ainda em beta/development');
  console.log('   • Endpoint não está ativo para todas as contas');
  console.log('   • Formato SDP específico necessário');
  console.log('   • Problema na implementação do lado da OpenAI');

  return { success: false, message: 'Nenhum formato funcionou' };
}

debugSDPParsing().catch(console.error);
