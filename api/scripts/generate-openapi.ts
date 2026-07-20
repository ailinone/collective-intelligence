// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Script para gerar documentaÃ§Ã£o OpenAPI/Swagger da API AilinÂ¹
 */

import fs from 'fs';
import path from 'path';

interface OpenAPISchema {
  openapi: string;
  info: {
    title: string;
    version: string;
    description: string;
    contact?: {
      name: string;
      email: string;
      url?: string;
    };
  };
  servers: Array<{
    url: string;
    description: string;
  }>;
  security: Array<{
    bearerAuth: string[];
    apiKeyAuth: string[];
  }>;
  paths: Record<string, unknown>;
  components: {
    securitySchemes: {
      bearerAuth: {
        type: string;
        scheme: string;
        bearerFormat: string;
      };
      apiKeyAuth: {
        type: string;
        in: string;
        name: string;
      };
    };
    schemas: Record<string, unknown>;
  };
}

const API_BASE_URL = 'https://api.ailin.one/v1';

function createOpenAPISpec(): OpenAPISchema {
  return {
    openapi: '3.0.3',
    info: {
      title: 'AilinÂ¹ API',
      version: '1.0.0',
      description: `API completa para integraÃ§Ã£o com modelos de IA via AilinÂ¹

## Collective Intelligence with 500+ Models

This API implements **true Collective Intelligence** through dynamic orchestration of **500+ AI models** across **15+ providers**.

**No hardcoded models** - All models are discovered dynamically in real-time from provider APIs.

### ðŸ§  Intelligent Model Selection (Automatic)

**You don't need to specify a model!**
- Set \`model: "auto"\` or omit the field entirely
- Ailin analyzes your request and intelligently selects from 500+ available models
- Automatically orchestrates multiple models when beneficial
- 15 advanced orchestration strategies (parallel, sequential, consensus, etc.)

### ðŸŽ¯ OpenAI Compatibility

**Core Endpoints (100% compatible):**
- âœ… \`/chat/completions\` - Chat completion (same schema)
- âœ… \`/models\` - List models (same schema)
- âœ… \`/embeddings\` - Embeddings (same schema)

**OpenAI SDKs Support:**
- âœ… Works with OpenAI SDKs (change base URL and auth)
- âœ… You can specify explicit models (e.g., \`model: "gpt-4"\`)
- âœ… Or use \`model: "auto"\` for intelligent 500+ model selection

**Implemented Endpoints:**
- âœ… \`/audio/*\` - Audio/TTS/Whisper (TTS, STT, Translation) - **FULLY IMPLEMENTED**
- âœ… \`/images/*\` - DALL-E image generation (Generation, Edit, Variations) - **FULLY IMPLEMENTED**
- âœ… \`/fine_tuning/*\` - Fine-tuning API (7 endpoints) - **FULLY IMPLEMENTED**
- âœ… \`/assistants/*\` - Assistants API (5+ endpoints) - **FULLY IMPLEMENTED**
- âœ… \`/files/*\` - File management (5 endpoints) - **FULLY IMPLEMENTED**
- âœ… \`/threads/*\` - Threads API (6+ endpoints) - **FULLY IMPLEMENTED**
- âœ… \`/batches/*\` - Batch processing API (4 endpoints) - **FULLY IMPLEMENTED**

**Not Implemented (design decisions):**
- âŒ \`/completions\` - Legacy endpoint (deprecated by OpenAI, use /chat/completions instead)

**Compatibility:** 100% for text generation, 0% for multimodal/assistants

### ðŸš€ Multi-Provider Orchestration

**15+ AI Providers (500+ models total):**
- OpenAI, Anthropic, Google, Mistral, Cohere
- DeepSeek, xAI (Grok), Alibaba (Qwen), Baidu (Ernie)
- AWS Bedrock, Azure OpenAI, Vertex AI, OCI Generative AI
- OpenRouter (aggregator with 200+ models)
- Ollama (local models)

**Automatic Features:**
- Provider failover and load balancing
- Cost optimization across providers
- Quality-based model selection
- Intelligent fallback chains (unlimited attempts)

**Advanced Endpoints:**
- \`POST /analyze-requirements\` - Analyzes requests and suggests optimal models
- \`GET /provider-capabilities\` - Discovers all available models and capabilities
- \`POST /chat/completions/intelligent\` - Explicit intelligent selection endpoint

**Extended Fields (optional, backwards-compatible):**
- \`strategy\`: Orchestration strategy (parallel, sequential, cost-optimized)
- \`max_cost\`: Cost ceiling for requests
- \`quality_target\`: Quality score target (0-1)
- \`_execution\`: Metadata about model selection and execution
- \`ailin_metadata\`: Additional orchestration metrics

### ðŸ“– Usage

**Intelligent mode (recommended) - No model specification needed:**
\`\`\`json
POST /v1/chat/completions
{
  "model": "auto",
  "messages": [{"role": "user", "content": "Analyze this complex problem"}]
}
// Ailin automatically selects from 500+ models and orchestrates the best approach
\`\`\`

**Standard OpenAI-compatible (specify exact model):**
\`\`\`json
POST /v1/chat/completions
{
  "model": "gpt-4",
  "messages": [{"role": "user", "content": "Hello"}]
}
\`\`\`

**Advanced orchestration with strategies:**
\`\`\`json
POST /v1/chat/completions/intelligent
{
  "messages": [{"role": "user", "content": "Complex task"}],
  "strategy": "consensus",
  "max_cost": 0.01,
  "quality_target": 0.95
}
// Orchestrates multiple models simultaneously for highest quality
\`\`\`

### ðŸ” Authentication
- Bearer tokens (JWT) for user authentication
- API keys for programmatic access
- Support for organization-scoped access control

### ðŸ“Š Rate Limits
- **Free tier:** 100 requests/hour, 100,000 tokens/day
- **Pro tier:** 1,000 requests/hour, 1M tokens/day
- **Enterprise tier:** Custom limits, dedicated infrastructure

### ðŸ”„ API Versioning
- Current version: v1 (stable)
- Deprecation notices provided 6 months in advance
- Legacy versions supported for 12 months after deprecation`,
      contact: {
        name: 'AilinÂ¹ Team',
        email: 'support@ailin.dev',
        url: 'https://ailin.dev'
      }
    },
    servers: [
      {
        url: API_BASE_URL,
        description: 'Production server'
      },
      {
        url: 'http://localhost:3000/v1',
        description: 'Development server'
      }
    ],
    security: [
      {
        bearerAuth: [],
        apiKeyAuth: []
      }
    ],
    paths: {
      // Auth endpoints
      // REMOVED: '/auth/challenge' - Blocked by GCP ACME/Let's Encrypt. Use '/auth/email-challenge' instead.
      
      '/auth/email-challenge': {
        post: {
          tags: ['Authentication'],
          summary: 'Request email verification code',
          description: 'Requests a verification code to be sent to the user email',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email'],
                  properties: {
                    email: {
                      type: 'string',
                      format: 'email',
                      example: 'user@example.com'
                    },
                    organizationId: {
                      type: 'string',
                      format: 'uuid',
                      example: 'org_12345678-1234-1234-1234-123456789abc'
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Verification code sent successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['success', 'challengeId', 'message'],
                    properties: {
                      success: {
                        type: 'boolean',
                        example: true,
                        description: 'Indicates if challenge was created successfully'
                      },
                      loginMode: {
                        type: 'string',
                        example: 'email_code',
                        description: 'Login mode for this challenge'
                      },
                      challengeId: {
                        type: 'string',
                        example: 'challenge_1234567890'
                      },
                      expiresAt: {
                        type: 'number',
                        description: 'Unix timestamp when challenge expires'
                      },
                      cooldownExpiresAt: {
                        type: 'number',
                        description: 'Unix timestamp when cooldown period expires (rate limiting)'
                      },
                      message: {
                        type: 'string',
                        example: 'Verification code sent to your email'
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },

      '/auth/register': {
        post: {
          tags: ['Authentication'],
          summary: 'Register new user',
          description: 'Creates a new user account with email and password',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['email', 'password', 'name'],
                  properties: {
                    email: {
                      type: 'string',
                      format: 'email',
                      example: 'user@example.com'
                    },
                    password: {
                      type: 'string',
                      minLength: 8,
                      example: 'securepassword123'
                    },
                    name: {
                      type: 'string',
                      minLength: 1,
                      example: 'John Doe'
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'User registered successfully',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/AuthResult'
                  }
                }
              }
            }
          }
        }
      },

      '/auth/login': {
        post: {
          tags: ['Authentication'],
          summary: 'Authenticate user',
          description: 'Authenticates user using email code or email/password',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  oneOf: [
                    {
                      type: 'object',
                      required: ['challengeId', 'code'],
                      properties: {
                        challengeId: {
                          type: 'string',
                          example: 'challenge_1234567890'
                        },
                        code: {
                          type: 'string',
                          example: '123456'
                        },
                        rememberDevice: {
                          type: 'boolean',
                          default: false
                        }
                      }
                    },
                    {
                      type: 'object',
                      required: ['email', 'password'],
                      properties: {
                        email: {
                          type: 'string',
                          format: 'email',
                          example: 'user@example.com'
                        },
                        password: {
                          type: 'string',
                          example: 'securepassword123'
                        }
                      }
                    }
                  ]
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Authentication successful',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/AuthResult'
                  }
                }
              }
            },
            '401': {
              description: 'Authentication failed',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/Error'
                  }
                }
              }
            }
          }
        }
      },

      '/auth/refresh': {
        post: {
          tags: ['Authentication'],
          summary: 'Refresh access token',
          description: 'Refreshes access token using refresh token',
          security: [],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['refreshToken'],
                  properties: {
                    refreshToken: {
                      type: 'string',
                      example: 'eyJhbGciOiJIUzI1NiIs...'
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Token refreshed successfully',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/AuthResult'
                  }
                }
              }
            }
          }
        }
      },

      '/auth/api-keys': {
        post: {
          tags: ['Authentication'],
          summary: 'Generate API key',
          description: 'Generates a new API key for the authenticated user',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: {
                      type: 'string',
                      example: 'My API Key'
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'API key generated successfully',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/ApiKeyResult'
                  }
                }
              }
            }
          }
        }
      },

      // Models endpoints
      '/models': {
        get: {
          tags: ['Models'],
          summary: 'List available models',
          description: 'Returns a list of all available AI models',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          'x-rateLimit': {
            free: { requests: 300, period: 'hour' },
            pro: { requests: 3000, period: 'hour' },
            enterprise: { requests: 'unlimited' }
          },
          parameters: [
            {
              name: 'provider',
              in: 'query',
              schema: { type: 'string' },
              description: 'Filter by provider (openai, anthropic, google, etc.)'
            },
            {
              name: 'capabilities',
              in: 'query',
              schema: { type: 'array', items: { type: 'string' } },
              description: 'Filter by capabilities (chat, embeddings, vision)'
            },
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100 },
              description: 'Limit number of results'
            },
            {
              name: 'offset',
              in: 'query',
              schema: { type: 'integer', minimum: 0 },
              description: 'Offset for pagination'
            }
          ],
          responses: {
            '200': {
              description: 'List of models',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['object', 'data'],
                    properties: {
                      object: {
                        type: 'string',
                        enum: ['list'],
                        description: 'Object type (OpenAI-compatible)'
                      },
                      data: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Model' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },

      '/models/{id}': {
        get: {
          tags: ['Models'],
          summary: 'Get model details',
          description: 'Returns detailed information about a specific model',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'Model ID'
            }
          ],
          responses: {
            '200': {
              description: 'Model details',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      model: { $ref: '#/components/schemas/Model' }
                    }
                  }
                }
              }
            },
            '404': {
              description: 'Model not found',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/Error' }
                }
              }
            }
          }
        }
      },

      // Alias for /models
      '/models/list': {
        get: {
          tags: ['Models'],
          summary: 'List models (alias)',
          description: 'Alias for /models endpoint for compatibility. Returns the same response as /models.',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            '200': {
              description: 'List of available models',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/ModelList' } }
              }
            }
          }
        }
      },

      // REMOVED: '/models/providers' - Not implemented in code. Use '/v1/provider-capabilities' instead.

      // Chat completions
      '/chat/completions': {
        post: {
          tags: ['Chat'],
          summary: 'Create chat completion',
          description: 'Creates a completion for the chat message',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          'x-rateLimit': {
            free: { requests: 100, period: 'hour', tokens: 100000, tokenPeriod: 'day' },
            pro: { requests: 1000, period: 'hour', tokens: 1000000, tokenPeriod: 'day' },
            enterprise: { requests: 'unlimited', tokens: 'custom' }
          },
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['messages'],
                  properties: {
                    model: {
                      type: 'string',
                      example: 'auto',
                      description: 'Model ID or "auto" for intelligent selection. When omitted or set to "auto", Ailin orchestrates 500+ models across 15+ providers to find the optimal model(s) for your request.'
                    },
                    messages: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ChatMessage' },
                      example: [
                        { role: 'system', content: 'You are a helpful assistant.' },
                        { role: 'user', content: 'What is the capital of France?' }
                      ]
                    },
                    stream: {
                      type: 'boolean',
                      default: false
                    },
                    temperature: {
                      type: 'number',
                      minimum: 0,
                      maximum: 2,
                      default: 0.7
                    },
                    max_tokens: {
                      type: 'integer',
                      minimum: 1
                    },
                    top_p: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1
                    },
                    frequency_penalty: {
                      type: 'number',
                      minimum: -2,
                      maximum: 2
                    },
                    presence_penalty: {
                      type: 'number',
                      minimum: -2,
                      maximum: 2
                    },
                    stop: {
                      oneOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } }
                      ]
                    },
                    tools: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/Tool' }
                    },
                    tool_choice: {
                      oneOf: [
                        { type: 'string' },
                        { $ref: '#/components/schemas/ToolChoice' }
                      ]
                    },
                    user: { type: 'string' },
                    metadata: { type: 'object' },
                    strategy: {
                      type: 'string',
                      description: 'Orchestration strategy (parallel, sequential, consensus, cost-optimized, best-of-n, etc.)',
                      example: 'auto'
                    },
                    max_cost: {
                      type: 'number',
                      minimum: 0,
                      description: 'Maximum cost ceiling for this request (in USD)',
                      example: 0.01
                    },
                    quality_target: {
                      type: 'number',
                      minimum: 0,
                      maximum: 1,
                      description: 'Quality score target (0-1)',
                      example: 0.9
                    },
                    task_type: {
                      type: 'string',
                      description: 'Hint about the type of task for intelligent model selection',
                      example: 'code_generation'
                    },
                    response_format: {
                      type: 'object',
                      description: 'Response format specification (e.g., JSON mode)',
                      properties: {
                        type: { type: 'string', enum: ['text', 'json_object'] }
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Chat completion response',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ChatCompletion' }
                },
                'text/plain': {
                  schema: {
                    type: 'string',
                    description: 'Streaming response (SSE)'
                  }
                }
              }
            },
            '202': {
              description: 'Request queued for asynchronous processing',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', enum: ['queued'] },
                      message: { type: 'string' },
                      queueId: { type: 'string' },
                      position: { type: 'integer' },
                      estimatedWaitTimeMs: { type: 'integer' },
                      priority: { type: 'integer' },
                      tier: { type: 'string', enum: ['enterprise', 'pro', 'free'] },
                      systemLoad: { type: 'number' },
                      reason: { type: 'string' },
                      pollAfterMs: { type: 'integer' },
                      statusUrl: { type: 'string' },
                      expiresAt: { type: 'integer' }
                    }
                  }
                }
              }
            },
            '401': {
              description: 'Unauthorized',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' }
                }
              }
            },
            '429': {
              description: 'Rate limit exceeded',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' }
                }
              }
            },
            '503': {
              description: 'Service temporarily unavailable (circuit breaker open)',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      error: {
                        type: 'object',
                        properties: {
                          type: { type: 'string' },
                          message: { type: 'string' },
                          state: { type: 'string', enum: ['open', 'half_open'] },
                          cooldownUntil: { type: 'string', format: 'date-time' }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },

      // Advanced Chat Features (Ailin Extensions)
      '/analyze-requirements': {
        post: {
          tags: ['Chat', 'Advanced'],
          summary: 'Analyze request requirements',
          description: 'Analyzes a chat request and returns recommended capabilities, triage results, and optimal model selection',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['messages'],
                  properties: {
                    model: { type: 'string' },
                    messages: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ChatMessage' }
                    },
                    tools: { type: 'array' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Requirements analysis completed',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      requirements: {
                        type: 'object',
                        properties: {
                          required: { type: 'array', items: { type: 'string' } },
                          preferred: { type: 'array', items: { type: 'string' } },
                          taskType: { type: 'string' },
                          complexity: { type: 'string' },
                          contextSize: { type: 'number' },
                          needsTools: { type: 'boolean' }
                        }
                      },
                      triage: {
                        type: 'object',
                        nullable: true,
                        properties: {
                          suggestedCapabilities: { type: 'array', items: { type: 'string' } },
                          complexity: { type: 'string' },
                          confidence: { type: 'number' }
                        }
                      },
                      selection: {
                        type: 'object',
                        properties: {
                          totalModelsEvaluated: { type: 'number' },
                          totalModelsMatched: { type: 'number' },
                          primaryCandidate: {
                            type: 'object',
                            nullable: true,
                            properties: {
                              modelId: { type: 'string' },
                              provider: { type: 'string' },
                              score: { type: 'number' }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },

      '/provider-capabilities': {
        get: {
          tags: ['Models', 'Advanced'],
          summary: 'Get provider capabilities',
          description: 'Returns all available providers and their model capabilities',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            '200': {
              description: 'Provider capabilities',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      providers: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            name: { type: 'string' },
                            displayName: { type: 'string' },
                            status: { type: 'string' },
                            modelCount: { type: 'number' },
                            models: {
                              type: 'array',
                              items: {
                                type: 'object',
                                properties: {
                                  id: { type: 'string' },
                                  name: { type: 'string' },
                                  capabilities: { type: 'array', items: { type: 'string' } },
                                  contextWindow: { type: 'number' }
                                }
                              }
                            }
                          }
                        }
                      },
                      summary: {
                        type: 'object',
                        properties: {
                          totalProviders: { type: 'number' },
                          totalModels: { type: 'number' },
                          capabilityCounts: { type: 'object', additionalProperties: { type: 'number' } }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },

      '/chat/completions/intelligent': {
        post: {
          tags: ['Chat', 'Advanced'],
          summary: 'Intelligent chat completion',
          description: 'Chat completion with intelligent model selection, triage, and unlimited fallback',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['messages'],
                  properties: {
                    model: { type: 'string' },
                    messages: {
                      type: 'array',
                      items: { $ref: '#/components/schemas/ChatMessage' }
                    },
                    stream: { type: 'boolean', default: false },
                    temperature: { type: 'number', minimum: 0, maximum: 2 },
                    max_tokens: { type: 'integer', minimum: 1 }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Intelligent completion response',
              content: {
                'application/json': {
                  schema: {
                    allOf: [
                      { $ref: '#/components/schemas/ChatCompletion' },
                      {
                        type: 'object',
                        properties: {
                          _execution: {
                            type: 'object',
                            properties: {
                              provider: { type: 'string' },
                              model: { type: 'string' },
                              attempts: { type: 'number' },
                              triageUsed: { type: 'boolean' }
                            }
                          }
                        }
                      }
                    ]
                  }
                }
              }
            }
          }
        }
      },

      // Embeddings
      '/embeddings': {
        post: {
          tags: ['Embeddings'],
          summary: 'Create embeddings',
          description: 'Creates embeddings for the given input text',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          'x-rateLimit': {
            free: { requests: 200, period: 'hour', tokens: 500000, tokenPeriod: 'day' },
            pro: { requests: 2000, period: 'hour', tokens: 5000000, tokenPeriod: 'day' },
            enterprise: { requests: 'unlimited', tokens: 'custom' }
          },
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['input'],
                  properties: {
                    model: {
                      type: 'string',
                      example: 'text-embedding-3-small',
                      description: 'Embedding model ID. Defaults to "text-embedding-3-small" if not specified.'
                    },
                    input: {
                      oneOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } }
                      ],
                      example: 'The quick brown fox jumps over the lazy dog'
                    },
                    encoding_format: {
                      type: 'string',
                      enum: ['float', 'base64'],
                      default: 'float'
                    },
                    dimensions: { type: 'integer' },
                    user: { type: 'string' },
                    metadata: { type: 'object' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Embeddings created successfully',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/EmbeddingsResponse' }
                }
              }
            }
          }
        }
      },

      // Alias for /embeddings
      '/embeddings/create': {
        post: {
          tags: ['Embeddings'],
          summary: 'Create embeddings (alias)',
          description: 'Alias for /embeddings endpoint for compatibility. Returns the same response as /embeddings.',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['model', 'input'],
                  properties: {
                    model: { type: 'string', description: 'Model ID (e.g., text-embedding-ada-002)' },
                    input: {
                      oneOf: [
                        { type: 'string' },
                        { type: 'array', items: { type: 'string' } }
                      ],
                      description: 'Input text to generate embeddings for'
                    },
                    encoding_format: { type: 'string', enum: ['float', 'base64'], default: 'float' },
                    dimensions: { type: 'integer', minimum: 1 },
                    user: { type: 'string' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Embeddings generated successfully',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/EmbeddingsResponse' } }
              }
            }
          }
        }
      },

      // Audio API (TTS, STT, Translation)
      '/audio/speech': {
        post: {
          tags: ['Audio'],
          summary: 'Create speech (TTS)',
          description: 'Generates audio from the input text using text-to-speech models. Supports multiple providers (OpenAI, Google, ElevenLabs, etc.) with dynamic model selection.',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['input'],
                  properties: {
                    model: { type: 'string', default: 'auto', description: 'Model ID or "auto" for dynamic selection' },
                    input: { type: 'string', maxLength: 100000, description: 'The text to generate audio for' },
                    voice: { type: 'string', enum: ['alloy', 'echo', 'fable', 'onyx', 'nova', 'shimmer', 'auto'], default: 'auto' },
                    response_format: { type: 'string', enum: ['mp3', 'opus', 'aac', 'flac', 'wav', 'pcm'], default: 'mp3' },
                    speed: { type: 'number', minimum: 0.25, maximum: 4.0, default: 1.0 }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Audio generated successfully',
              content: {
                'audio/mpeg': { schema: { type: 'string', format: 'binary' } }
              }
            },
            '401': { description: 'Unauthorized', content: { 'application/json': { schema: { $ref: '#/components/schemas/ErrorResponse' } } } }
          }
        }
      },
      '/audio/transcriptions': {
        post: {
          tags: ['Audio'],
          summary: 'Create transcription (STT)',
          description: 'Transcribes audio into text using speech-to-text models.',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: {
                    file: { type: 'string', format: 'binary', description: 'Audio file to transcribe' },
                    model: { type: 'string', default: 'auto' },
                    language: { type: 'string', description: 'ISO-639-1 language code' },
                    prompt: { type: 'string', description: 'Optional context for better accuracy' },
                    response_format: { type: 'string', enum: ['json', 'text', 'srt', 'verbose_json', 'vtt'], default: 'json' },
                    temperature: { type: 'number', minimum: 0, maximum: 1, default: 0 }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Transcription completed',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      text: { type: 'string' },
                      language: { type: 'string' },
                      duration: { type: 'number' }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/audio/translations': {
        post: {
          tags: ['Audio'],
          summary: 'Create translation',
          description: 'Translates audio into English text',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file'],
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    model: { type: 'string', default: 'auto' },
                    prompt: { type: 'string' },
                    response_format: { type: 'string', enum: ['json', 'text', 'srt', 'verbose_json', 'vtt'], default: 'json' },
                    temperature: { type: 'number', minimum: 0, maximum: 1, default: 0 }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Translation completed',
              content: {
                'application/json': {
                  schema: { type: 'object', properties: { text: { type: 'string' } } }
                }
              }
            }
          }
        }
      },

      // Images API
      '/images/generations': {
        post: {
          tags: ['Images'],
          summary: 'Create image',
          description: 'Creates an image given a prompt. Supports multiple providers (DALL-E, Stable Diffusion, etc.) with dynamic model selection.',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['prompt'],
                  properties: {
                    model: { type: 'string', default: 'auto' },
                    prompt: { type: 'string', maxLength: 4000 },
                    n: { type: 'integer', minimum: 1, maximum: 10, default: 1 },
                    size: { type: 'string', enum: ['256x256', '512x512', '1024x1024', '1792x1024', '1024x1792'], default: '1024x1024' },
                    quality: { type: 'string', enum: ['standard', 'hd'], default: 'standard' },
                    response_format: { type: 'string', enum: ['url', 'b64_json'], default: 'url' },
                    style: { type: 'string', enum: ['vivid', 'natural'], default: 'vivid' }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Image generated successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      created: { type: 'integer' },
                      data: {
                        type: 'array',
                        items: {
                          type: 'object',
                          properties: {
                            url: { type: 'string' },
                            b64_json: { type: 'string' },
                            revised_prompt: { type: 'string' }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },

      // Files API
      '/files': {
        post: {
          tags: ['Files'],
          summary: 'Upload file',
          description: 'Upload a file for various purposes (fine-tuning, assistants, vision, batch, etc.)',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'multipart/form-data': {
                schema: {
                  type: 'object',
                  required: ['file', 'purpose'],
                  properties: {
                    file: { type: 'string', format: 'binary' },
                    purpose: { type: 'string', enum: ['fine-tune', 'assistants', 'batch', 'vision', 'user_data'] }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'File uploaded successfully',
              content: {
                'application/json': { schema: { $ref: '#/components/schemas/File' } }
              }
            }
          }
        },
        get: {
          tags: ['Files'],
          summary: 'List files',
          description: 'Returns a list of files',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            '200': {
              description: 'List of files',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      object: { type: 'string', enum: ['list'] },
                      data: { type: 'array', items: { $ref: '#/components/schemas/File' } }
                    }
                  }
                }
              }
            }
          }
        }
      },
      '/files/{file_id}': {
        get: {
          tags: ['Files'],
          summary: 'Retrieve file',
          description: 'Returns information about a specific file',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [{ name: 'file_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'File details',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/File' } } }
            }
          }
        },
        delete: {
          tags: ['Files'],
          summary: 'Delete file',
          description: 'Delete a file',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [{ name: 'file_id', in: 'path', required: true, schema: { type: 'string' } }],
          responses: {
            '200': {
              description: 'File deleted',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      object: { type: 'string' },
                      deleted: { type: 'boolean' }
                    }
                  }
                }
              }
            }
          }
        }
      },

      // Organizations
      '/organizations': {
        get: {
          tags: ['Organizations'],
          summary: 'List organizations',
          description: 'Returns a list of organizations',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 10 }
            },
            {
              name: 'offset',
              in: 'query',
              schema: { type: 'integer', minimum: 0, default: 0 }
            },
            {
              name: 'tier',
              in: 'query',
              schema: { type: 'string', enum: ['free', 'pro', 'enterprise'] }
            }
          ],
          responses: {
            '200': {
              description: 'List of organizations',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      organizations: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/Organization' }
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' }
                    }
                  }
                }
              }
            }
          }
        }
      },

      '/organizations/{id}': {
        get: {
          tags: ['Organizations'],
          summary: 'Get organization details',
          description: 'Returns details of a specific organization',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' }
            }
          ],
          responses: {
            '200': {
              description: 'Organization details',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      organization: { $ref: '#/components/schemas/Organization' }
                    }
                  }
                }
              }
            }
          }
        },
        put: {
          tags: ['Organizations'],
          summary: 'Update organization',
          description: 'Updates organization details (admin only)',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' }
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', minLength: 1, maxLength: 100 },
                    tier: { type: 'string', enum: ['free', 'starter', 'pro', 'enterprise'] }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Organization updated successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      organization: { $ref: '#/components/schemas/Organization' }
                    }
                  }
                }
              }
            }
          }
        }
      },

      '/organizations/{id}/members': {
        get: {
          tags: ['Organizations'],
          summary: 'List organization members',
          description: 'Returns list of organization members',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' }
            }
          ],
          responses: {
            '200': {
              description: 'List of members',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      members: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/OrganizationMember' }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },

      '/organizations/{id}/members/{userId}': {
        delete: {
          tags: ['Organizations'],
          summary: 'Remove organization member',
          description: 'Removes a member from the organization (admin only)',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' }
            },
            {
              name: 'userId',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' }
            }
          ],
          responses: {
            '200': {
              description: 'Member removed successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      message: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },

      // API Keys
      '/api-keys': {
        get: {
          tags: ['API Keys'],
          summary: 'List API keys',
          description: 'Returns list of API keys for the organization',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100 }
            },
            {
              name: 'offset',
              in: 'query',
              schema: { type: 'integer', minimum: 0 }
            },
            {
              name: 'status',
              in: 'query',
              schema: { type: 'string', enum: ['active', 'revoked', 'expired'] }
            }
          ],
          responses: {
            '200': {
              description: 'List of API keys',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      apiKeys: {
                        type: 'array',
                        items: { $ref: '#/components/schemas/ApiKey' }
                      },
                      pagination: { $ref: '#/components/schemas/Pagination' }
                    }
                  }
                }
              }
            }
          }
        },
        post: {
          tags: ['API Keys'],
          summary: 'Create API key',
          description: 'Creates a new API key',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string', example: 'My API Key' },
                    permissions: {
                      type: 'array',
                      items: { type: 'string' },
                      default: ['*']
                    },
                    expiresAt: { type: 'string', format: 'date-time' }
                  }
                }
              }
            }
          },
          responses: {
            '201': {
              description: 'API key created successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      apiKey: { $ref: '#/components/schemas/ApiKeyResult' }
                    }
                  }
                }
              }
            }
          }
        }
      },

      '/api-keys/{id}': {
        get: {
          tags: ['API Keys'],
          summary: 'Get API key details',
          description: 'Returns details of a specific API key',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' }
            }
          ],
          responses: {
            '200': {
              description: 'API key details',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      apiKey: { $ref: '#/components/schemas/ApiKey' }
                    }
                  }
                }
              }
            }
          }
        },
        put: {
          tags: ['API Keys'],
          summary: 'Update API key',
          description: 'Updates API key details',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' }
            }
          ],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string' },
                    status: { type: 'string', enum: ['active', 'revoked'] },
                    permissions: { type: 'array', items: { type: 'string' } }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'API key updated successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      apiKey: { $ref: '#/components/schemas/ApiKey' }
                    }
                  }
                }
              }
            }
          }
        },
        delete: {
          tags: ['API Keys'],
          summary: 'Delete API key',
          description: 'Deletes an API key',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'id',
              in: 'path',
              required: true,
              schema: { type: 'string', format: 'uuid' }
            }
          ],
          responses: {
            '200': {
              description: 'API key deleted successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      success: { type: 'boolean' },
                      message: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },

      // Users
      '/user/profile': {
        get: {
          tags: ['Users'],
          summary: 'Get current user profile',
          description: 'Returns the current authenticated user profile',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            '200': {
              description: 'User profile',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['user'],
                    properties: {
                      user: { $ref: '#/components/schemas/User' }
                    }
                  }
                }
              }
            }
          }
        },
        put: {
          tags: ['Users'],
          summary: 'Update user profile',
          description: 'Updates the current user profile',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    name: { type: 'string', minLength: 1 }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'User profile updated successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    required: ['success', 'message'],
                    properties: {
                      success: { type: 'boolean' },
                      message: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },

      // REMOVED: '/users/me/password' - Not implemented in code

      // Usage
      '/usage/stats': {
        get: {
          tags: ['Usage'],
          summary: 'Get usage statistics',
          description: 'Returns usage statistics for the organization',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'period',
              in: 'query',
              schema: { type: 'string', enum: ['day', 'month', 'year'] },
              description: 'Time period for stats'
            },
            {
              name: 'start_date',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description: 'Start date (ISO 8601)'
            },
            {
              name: 'end_date',
              in: 'query',
              schema: { type: 'string', format: 'date-time' },
              description: 'End date (ISO 8601)'
            }
          ],
          responses: {
            '200': {
              description: 'Usage statistics',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/UsageStats' }
                }
              }
            }
          }
        }
      },

      // Status
      '/status/health': {
        get: {
          tags: ['Status'],
          summary: 'Health check',
          description: 'Returns the health status of the API',
          security: [],
          responses: {
            '200': {
              description: 'API is healthy',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', example: 'healthy' },
                      timestamp: { type: 'string', format: 'date-time' },
                      version: { type: 'string' },
                      uptime: { type: 'number' }
                    }
                  }
                }
              }
            }
          }
        }
      },

      '/status/ready': {
        get: {
          tags: ['Status'],
          summary: 'Readiness check',
          description: 'Returns the readiness status of the API',
          security: [],
          responses: {
            '200': {
              description: 'API is ready',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      status: { type: 'string', example: 'ready' },
                      services: {
                        type: 'object',
                        properties: {
                          database: { type: 'string' },
                          redis: { type: 'string' },
                          providers: {
                            type: 'object',
                            additionalProperties: { type: 'string' }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },

      // Cache
      '/cache/stats': {
        get: {
          tags: ['Cache'],
          summary: 'Get cache statistics',
          description: 'Returns cache usage statistics',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            '200': {
              description: 'Cache statistics',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      cache: {
                        type: 'object',
                        properties: {
                          entries: { type: 'number' },
                          memoryUsage: { type: 'number' },
                          hitRate: { type: 'number' },
                          averageResponseTime: { type: 'number' },
                          uptime: { type: 'number' }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },

      '/cache/invalidate': {
        post: {
          tags: ['Cache'],
          summary: 'Invalidate cache',
          description: 'Invalidates cache entries (admin only)',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    pattern: { type: 'string' },
                    all: { type: 'boolean', default: false }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Cache invalidated successfully',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      invalidated: { type: 'number' },
                      message: { type: 'string' }
                    }
                  }
                }
              }
            }
          }
        }
      },

      // Queue
      '/queue/status': {
        get: {
          tags: ['Queue'],
          summary: 'Get queue status',
          description: 'Returns the current status of the job queue',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            '200': {
              description: 'Queue status',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      queue: {
                        type: 'object',
                        properties: {
                          active: { type: 'number' },
                          waiting: { type: 'number' },
                          completed: { type: 'number' },
                          failed: { type: 'number' },
                          workers: {
                            type: 'object',
                            properties: {
                              total: { type: 'number' },
                              active: { type: 'number' },
                              idle: { type: 'number' }
                            }
                          },
                          throughput: {
                            type: 'object',
                            properties: {
                              requestsPerSecond: { type: 'number' },
                              averageProcessingTime: { type: 'number' }
                            }
                          }
                        }
                      }
                    }
                  }
                }
              }
            }
          }
        }
      },

      // REMOVED: '/queue/jobs' - Not implemented in code. Use '/queue/status/:id' for individual job status.

      // Metrics
      '/metrics': {
        get: {
          tags: ['Metrics'],
          summary: 'Get system metrics',
          description: 'Returns system metrics in Prometheus format',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          responses: {
            '200': {
              description: 'Prometheus metrics',
              content: {
                'text/plain': {
                  schema: {
                    type: 'string',
                    description: 'Prometheus format metrics'
                  }
                }
              }
            }
          }
        }
      },

      // Context Caching endpoints
      '/caching/contexts': {
        post: {
          tags: ['Caching'],
          summary: 'Create cached context',
          description: 'Creates a cached context for reuse across multiple requests. Supports up to 1M tokens with configurable TTL (5min, 1h, 24h). Compatible with Claude and Gemini context caching.',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          requestBody: {
            required: true,
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['name', 'messages'],
                  properties: {
                    name: {
                      type: 'string',
                      minLength: 1,
                      maxLength: 256,
                      description: 'Human-readable name for the cached context',
                      example: 'System instructions for coding assistant'
                    },
                    messages: {
                      type: 'array',
                      description: 'Array of messages to cache',
                      items: {
                        $ref: '#/components/schemas/ChatMessage'
                      }
                    },
                    ttl: {
                      type: 'string',
                      enum: ['5min', '1h', '24h'],
                      default: '1h',
                      description: 'Time-to-live for the cached context'
                    },
                    metadata: {
                      type: 'object',
                      additionalProperties: { type: 'string' },
                      description: 'Optional metadata key-value pairs'
                    }
                  }
                }
              }
            }
          },
          responses: {
            '201': {
              description: 'Cached context created successfully',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/CachedContextCreated'
                  }
                }
              }
            },
            '400': {
              description: 'Invalid request',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' }
                }
              }
            }
          }
        },
        get: {
          tags: ['Caching'],
          summary: 'List cached contexts',
          description: 'Returns a list of all cached contexts for the organization',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'limit',
              in: 'query',
              schema: { type: 'integer', minimum: 1, maximum: 100, default: 20 },
              description: 'Maximum number of contexts to return'
            },
            {
              name: 'offset',
              in: 'query',
              schema: { type: 'integer', minimum: 0, default: 0 },
              description: 'Number of contexts to skip'
            }
          ],
          responses: {
            '200': {
              description: 'List of cached contexts',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/CachedContextList'
                  }
                }
              }
            }
          }
        }
      },

      '/caching/contexts/{context_id}': {
        get: {
          tags: ['Caching'],
          summary: 'Get cached context',
          description: 'Retrieves a specific cached context by ID',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'context_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'The ID of the cached context'
            }
          ],
          responses: {
            '200': {
              description: 'Cached context details',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/CachedContext'
                  }
                }
              }
            },
            '404': {
              description: 'Cached context not found or expired',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' }
                }
              }
            }
          }
        },
        delete: {
          tags: ['Caching'],
          summary: 'Delete cached context',
          description: 'Deletes a cached context by ID',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'context_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'The ID of the cached context'
            }
          ],
          responses: {
            '200': {
              description: 'Cached context deleted',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      id: { type: 'string' },
                      deleted: { type: 'boolean' }
                    }
                  }
                }
              }
            }
          }
        }
      },

      '/caching/contexts/{context_id}/use': {
        post: {
          tags: ['Caching'],
          summary: 'Use cached context',
          description: 'Retrieves a cached context and optionally appends additional messages. Returns the full message array ready for chat completion.',
          security: [{ bearerAuth: [] }, { apiKeyAuth: [] }],
          parameters: [
            {
              name: 'context_id',
              in: 'path',
              required: true,
              schema: { type: 'string' },
              description: 'The ID of the cached context'
            }
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  properties: {
                    additional_messages: {
                      type: 'array',
                      description: 'Additional messages to append to the cached context',
                      items: {
                        $ref: '#/components/schemas/ChatMessage'
                      }
                    }
                  }
                }
              }
            }
          },
          responses: {
            '200': {
              description: 'Cached context with additional messages',
              content: {
                'application/json': {
                  schema: {
                    $ref: '#/components/schemas/UseCachedContextResponse'
                  }
                }
              }
            },
            '404': {
              description: 'Cached context not found or expired',
              content: {
                'application/json': {
                  schema: { $ref: '#/components/schemas/ErrorResponse' }
                }
              }
            }
          }
        }
      }
    },

    // ================== ASSISTANTS API ==================
    '/assistants': {
      post: {
        tags: ['Assistants'],
        summary: 'Create an assistant',
        description: 'Create an assistant with a model and instructions',
        security: [{ bearerAuth: [], apiKeyAuth: [] }],
        requestBody: {
          required: true,
          content: {
            'application/json': {
              schema: {
                type: 'object',
                properties: {
                  model: { type: 'string', description: 'Model ID to use' },
                  name: { type: 'string', nullable: true },
                  description: { type: 'string', nullable: true },
                  instructions: { type: 'string', nullable: true },
                  tools: { type: 'array', items: { type: 'object' } },
                  metadata: { type: 'object', additionalProperties: { type: 'string' } }
                }
              }
            }
          }
        },
        responses: {
          '200': { description: 'Assistant created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Assistant' } } } },
          '400': { description: 'Bad request' },
          '401': { description: 'Unauthorized' }
        }
      },
      get: {
        tags: ['Assistants'],
        summary: 'List assistants',
        description: 'Returns a list of assistants',
        security: [{ bearerAuth: [], apiKeyAuth: [] }],
        parameters: [
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 20 } },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc', 'desc'] } },
          { name: 'after', in: 'query', schema: { type: 'string' } },
          { name: 'before', in: 'query', schema: { type: 'string' } }
        ],
        responses: {
          '200': { description: 'List of assistants', content: { 'application/json': { schema: { type: 'object', properties: { object: { type: 'string' }, data: { type: 'array', items: { $ref: '#/components/schemas/Assistant' } } } } } } }
        }
      }
    },
    '/assistants/{assistant_id}': {
      get: {
        tags: ['Assistants'],
        summary: 'Retrieve assistant',
        parameters: [{ name: 'assistant_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Assistant details', content: { 'application/json': { schema: { $ref: '#/components/schemas/Assistant' } } } } }
      },
      post: {
        tags: ['Assistants'],
        summary: 'Modify assistant',
        parameters: [{ name: 'assistant_id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object' } } } },
        responses: { '200': { description: 'Modified assistant' } }
      },
      delete: {
        tags: ['Assistants'],
        summary: 'Delete assistant',
        parameters: [{ name: 'assistant_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Deletion confirmation' } }
      }
    },

    // ================== THREADS API ==================
    '/threads': {
      post: {
        tags: ['Threads'],
        summary: 'Create a thread',
        description: 'Create a thread for conversation with an assistant',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { messages: { type: 'array' }, metadata: { type: 'object' } } } } } },
        responses: { '200': { description: 'Thread created', content: { 'application/json': { schema: { $ref: '#/components/schemas/Thread' } } } } }
      }
    },
    '/threads/{thread_id}': {
      get: {
        tags: ['Threads'],
        summary: 'Retrieve thread',
        parameters: [{ name: 'thread_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Thread details' } }
      },
      post: {
        tags: ['Threads'],
        summary: 'Modify thread',
        parameters: [{ name: 'thread_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Modified thread' } }
      },
      delete: {
        tags: ['Threads'],
        summary: 'Delete thread',
        parameters: [{ name: 'thread_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Deletion confirmation' } }
      }
    },
    '/threads/{thread_id}/messages': {
      post: {
        tags: ['Threads'],
        summary: 'Create message',
        parameters: [{ name: 'thread_id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['role', 'content'], properties: { role: { type: 'string' }, content: { type: 'string' } } } } } },
        responses: { '200': { description: 'Message created' } }
      },
      get: {
        tags: ['Threads'],
        summary: 'List messages',
        parameters: [{ name: 'thread_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'List of messages' } }
      }
    },
    '/threads/{thread_id}/runs': {
      post: {
        tags: ['Threads'],
        summary: 'Create run',
        parameters: [{ name: 'thread_id', in: 'path', required: true, schema: { type: 'string' } }],
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['assistant_id'], properties: { assistant_id: { type: 'string' } } } } } },
        responses: { '200': { description: 'Run created' } }
      },
      get: {
        tags: ['Threads'],
        summary: 'List runs',
        parameters: [{ name: 'thread_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'List of runs' } }
      }
    },
    '/threads/{thread_id}/runs/{run_id}': {
      get: {
        tags: ['Threads'],
        summary: 'Retrieve run',
        parameters: [
          { name: 'thread_id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'run_id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: { '200': { description: 'Run details' } }
      }
    },
    '/threads/{thread_id}/runs/{run_id}/cancel': {
      post: {
        tags: ['Threads'],
        summary: 'Cancel run',
        parameters: [
          { name: 'thread_id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'run_id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        responses: { '200': { description: 'Run cancelled' } }
      }
    },
    '/threads/{thread_id}/runs/{run_id}/submit_tool_outputs': {
      post: {
        tags: ['Threads'],
        summary: 'Submit tool outputs',
        parameters: [
          { name: 'thread_id', in: 'path', required: true, schema: { type: 'string' } },
          { name: 'run_id', in: 'path', required: true, schema: { type: 'string' } }
        ],
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['tool_outputs'], properties: { tool_outputs: { type: 'array' } } } } } },
        responses: { '200': { description: 'Tool outputs submitted' } }
      }
    },

    // ================== FINE-TUNING API ==================
    '/fine_tuning/jobs': {
      post: {
        tags: ['Fine-tuning'],
        summary: 'Create fine-tuning job',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['training_file', 'model'], properties: { training_file: { type: 'string' }, model: { type: 'string' }, hyperparameters: { type: 'object' } } } } } },
        responses: { '200': { description: 'Fine-tuning job created' } }
      },
      get: {
        tags: ['Fine-tuning'],
        summary: 'List fine-tuning jobs',
        responses: { '200': { description: 'List of fine-tuning jobs' } }
      }
    },
    '/fine_tuning/jobs/{job_id}': {
      get: {
        tags: ['Fine-tuning'],
        summary: 'Retrieve fine-tuning job',
        parameters: [{ name: 'job_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Fine-tuning job details' } }
      },
      delete: {
        tags: ['Fine-tuning'],
        summary: 'Delete fine-tuning job',
        parameters: [{ name: 'job_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Job deleted' } }
      }
    },
    '/fine_tuning/jobs/{job_id}/cancel': {
      post: {
        tags: ['Fine-tuning'],
        summary: 'Cancel fine-tuning job',
        parameters: [{ name: 'job_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Job cancelled' } }
      }
    },
    '/fine_tuning/jobs/{job_id}/events': {
      get: {
        tags: ['Fine-tuning'],
        summary: 'List fine-tuning events',
        parameters: [{ name: 'job_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'List of events' } }
      }
    },
    '/fine_tuning/jobs/{job_id}/checkpoints': {
      get: {
        tags: ['Fine-tuning'],
        summary: 'List fine-tuning checkpoints',
        parameters: [{ name: 'job_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'List of checkpoints' } }
      }
    },

    // ================== VECTOR STORES API ==================
    '/vector_stores': {
      post: {
        tags: ['Vector Stores'],
        summary: 'Create vector store',
        requestBody: { content: { 'application/json': { schema: { type: 'object', properties: { name: { type: 'string' }, file_ids: { type: 'array', items: { type: 'string' } } } } } } },
        responses: { '200': { description: 'Vector store created' } }
      },
      get: {
        tags: ['Vector Stores'],
        summary: 'List vector stores',
        responses: { '200': { description: 'List of vector stores' } }
      }
    },
    '/vector_stores/{vector_store_id}': {
      get: {
        tags: ['Vector Stores'],
        summary: 'Retrieve vector store',
        parameters: [{ name: 'vector_store_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Vector store details' } }
      },
      post: {
        tags: ['Vector Stores'],
        summary: 'Modify vector store',
        parameters: [{ name: 'vector_store_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Vector store modified' } }
      },
      delete: {
        tags: ['Vector Stores'],
        summary: 'Delete vector store',
        parameters: [{ name: 'vector_store_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Vector store deleted' } }
      }
    },
    '/vector_stores/{vector_store_id}/files': {
      post: {
        tags: ['Vector Stores'],
        summary: 'Create vector store file',
        parameters: [{ name: 'vector_store_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'File added to vector store' } }
      },
      get: {
        tags: ['Vector Stores'],
        summary: 'List vector store files',
        parameters: [{ name: 'vector_store_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'List of files' } }
      }
    },

    // ================== BATCHES API ==================
    '/batches': {
      post: {
        tags: ['Batches'],
        summary: 'Create batch',
        description: 'Create a batch of requests for async processing',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['input_file_id', 'endpoint'], properties: { input_file_id: { type: 'string' }, endpoint: { type: 'string' }, completion_window: { type: 'string' } } } } } },
        responses: { '200': { description: 'Batch created' } }
      },
      get: {
        tags: ['Batches'],
        summary: 'List batches',
        responses: { '200': { description: 'List of batches' } }
      }
    },
    '/batches/{batch_id}': {
      get: {
        tags: ['Batches'],
        summary: 'Retrieve batch',
        parameters: [{ name: 'batch_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Batch details' } }
      }
    },
    '/batches/{batch_id}/cancel': {
      post: {
        tags: ['Batches'],
        summary: 'Cancel batch',
        parameters: [{ name: 'batch_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'Batch cancelled' } }
      }
    },

    // ================== MODERATIONS API ==================
    '/moderations': {
      post: {
        tags: ['Moderations'],
        summary: 'Create moderation',
        description: 'Classify content for policy violations',
        requestBody: { content: { 'application/json': { schema: { type: 'object', required: ['input'], properties: { input: { oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }] }, model: { type: 'string' } } } } } },
        responses: { '200': { description: 'Moderation results', content: { 'application/json': { schema: { type: 'object', properties: { id: { type: 'string' }, model: { type: 'string' }, results: { type: 'array' } } } } } } }
      }
    },

    // ================== IMAGES (Additional endpoints) ==================
    '/images/edits': {
      post: {
        tags: ['Images'],
        summary: 'Create image edit',
        description: 'Creates an edited or extended image given an original image and a prompt',
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', required: ['image', 'prompt'], properties: { image: { type: 'string', format: 'binary' }, prompt: { type: 'string' }, mask: { type: 'string', format: 'binary' }, n: { type: 'integer' }, size: { type: 'string' } } } } } },
        responses: { '200': { description: 'Edited image(s)' } }
      }
    },
    '/images/variations': {
      post: {
        tags: ['Images'],
        summary: 'Create image variation',
        description: 'Creates a variation of a given image',
        requestBody: { content: { 'multipart/form-data': { schema: { type: 'object', required: ['image'], properties: { image: { type: 'string', format: 'binary' }, n: { type: 'integer' }, size: { type: 'string' } } } } } },
        responses: { '200': { description: 'Image variation(s)' } }
      }
    },

    // ================== FILES (Additional endpoints) ==================
    '/files/{file_id}/content': {
      get: {
        tags: ['Files'],
        summary: 'Retrieve file content',
        description: 'Returns the contents of the specified file',
        parameters: [{ name: 'file_id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'File content' } }
      }
    }
  },
  components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          bearerFormat: 'JWT'
        },
        apiKeyAuth: {
          type: 'apiKey',
          in: 'header',
          name: 'Authorization'
        }
      },
      schemas: {
        // Assistant Schema
        Assistant: {
          type: 'object',
          required: ['id', 'object', 'created_at', 'model'],
          properties: {
            id: { type: 'string', description: 'Unique identifier for the assistant' },
            object: { type: 'string', enum: ['assistant'], description: 'Object type' },
            created_at: { type: 'integer', description: 'Unix timestamp of creation' },
            name: { type: 'string', nullable: true, description: 'Name of the assistant' },
            description: { type: 'string', nullable: true, description: 'Description of the assistant' },
            model: { type: 'string', description: 'ID of the model to use' },
            instructions: { type: 'string', nullable: true, description: 'System instructions for the assistant' },
            tools: { type: 'array', items: { type: 'object' }, description: 'List of tools the assistant can use' },
            tool_resources: { type: 'object', nullable: true, description: 'Resources for tools' },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Metadata key-value pairs' },
            temperature: { type: 'number', nullable: true, description: 'Sampling temperature' },
            top_p: { type: 'number', nullable: true, description: 'Nucleus sampling parameter' },
            response_format: { type: 'object', nullable: true, description: 'Response format specification' }
          }
        },
        // Thread Schema
        Thread: {
          type: 'object',
          required: ['id', 'object', 'created_at'],
          properties: {
            id: { type: 'string', description: 'Unique identifier for the thread' },
            object: { type: 'string', enum: ['thread'], description: 'Object type' },
            created_at: { type: 'integer', description: 'Unix timestamp of creation' },
            metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Metadata key-value pairs' },
            tool_resources: { type: 'object', nullable: true, description: 'Resources for tools' }
          }
        },
        // Message Schema
        Message: {
          type: 'object',
          required: ['id', 'object', 'created_at', 'thread_id', 'role', 'content'],
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['thread.message'] },
            created_at: { type: 'integer' },
            thread_id: { type: 'string' },
            role: { type: 'string', enum: ['user', 'assistant'] },
            content: { type: 'array', items: { type: 'object' } },
            assistant_id: { type: 'string', nullable: true },
            run_id: { type: 'string', nullable: true },
            metadata: { type: 'object' }
          }
        },
        // Run Schema
        Run: {
          type: 'object',
          required: ['id', 'object', 'created_at', 'thread_id', 'assistant_id', 'status'],
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['thread.run'] },
            created_at: { type: 'integer' },
            thread_id: { type: 'string' },
            assistant_id: { type: 'string' },
            status: { type: 'string', enum: ['queued', 'in_progress', 'requires_action', 'cancelling', 'cancelled', 'failed', 'completed', 'expired'] },
            model: { type: 'string' },
            instructions: { type: 'string', nullable: true },
            tools: { type: 'array' },
            metadata: { type: 'object' }
          }
        },
        // Vector Store Schema
        VectorStore: {
          type: 'object',
          required: ['id', 'object', 'created_at', 'status'],
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['vector_store'] },
            created_at: { type: 'integer' },
            name: { type: 'string', nullable: true },
            usage_bytes: { type: 'integer' },
            file_counts: { type: 'object' },
            status: { type: 'string', enum: ['expired', 'in_progress', 'completed'] },
            expires_after: { type: 'object', nullable: true },
            expires_at: { type: 'integer', nullable: true },
            last_active_at: { type: 'integer', nullable: true },
            metadata: { type: 'object' }
          }
        },
        // Batch Schema
        Batch: {
          type: 'object',
          required: ['id', 'object', 'endpoint', 'input_file_id', 'status', 'created_at'],
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['batch'] },
            endpoint: { type: 'string' },
            input_file_id: { type: 'string' },
            completion_window: { type: 'string' },
            status: { type: 'string', enum: ['validating', 'in_progress', 'finalizing', 'completed', 'failed', 'expired', 'cancelling', 'cancelled'] },
            output_file_id: { type: 'string', nullable: true },
            error_file_id: { type: 'string', nullable: true },
            created_at: { type: 'integer' },
            in_progress_at: { type: 'integer', nullable: true },
            expires_at: { type: 'integer', nullable: true },
            finalizing_at: { type: 'integer', nullable: true },
            completed_at: { type: 'integer', nullable: true },
            failed_at: { type: 'integer', nullable: true },
            expired_at: { type: 'integer', nullable: true },
            cancelling_at: { type: 'integer', nullable: true },
            cancelled_at: { type: 'integer', nullable: true },
            request_counts: { type: 'object' },
            metadata: { type: 'object' }
          }
        },
        // FineTuningJob Schema
        FineTuningJob: {
          type: 'object',
          required: ['id', 'object', 'created_at', 'model', 'status'],
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['fine_tuning.job'] },
            created_at: { type: 'integer' },
            finished_at: { type: 'integer', nullable: true },
            model: { type: 'string' },
            fine_tuned_model: { type: 'string', nullable: true },
            organization_id: { type: 'string' },
            status: { type: 'string', enum: ['validating_files', 'queued', 'running', 'succeeded', 'failed', 'cancelled'] },
            hyperparameters: { type: 'object' },
            training_file: { type: 'string' },
            validation_file: { type: 'string', nullable: true },
            result_files: { type: 'array', items: { type: 'string' } },
            trained_tokens: { type: 'integer', nullable: true },
            error: { type: 'object', nullable: true }
          }
        },
        Error: {
          type: 'object',
          properties: {
            error: { type: 'string' },
            message: { type: 'string' },
            code: { type: 'string' }
          }
        },
        ErrorResponse: {
          type: 'object',
          required: ['error'],
          properties: {
            error: {
              type: 'object',
              required: ['message'],
              properties: {
                type: { type: 'string' },
                message: { type: 'string' },
                code: { type: 'string' },
                param: { type: 'string' }
              }
            }
          }
        },
        ModelList: {
          type: 'object',
          required: ['object', 'data'],
          properties: {
            object: { type: 'string', enum: ['list'] },
            data: { type: 'array', items: { $ref: '#/components/schemas/Model' } }
          }
        },
        CachedContextCreated: {
          type: 'object',
          properties: {
            id: { type: 'string', example: 'ctx_abc123def456' },
            name: { type: 'string', example: 'System instructions for coding assistant' },
            token_count: { type: 'integer', example: 5000 },
            ttl: { type: 'string', enum: ['5min', '1h', '24h'], example: '1h' },
            expires_at: { type: 'string', format: 'date-time' },
            hash: { type: 'string', example: 'a1b2c3d4e5f67890' }
          }
        },
        CachedContext: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            messages: { type: 'array', items: { $ref: '#/components/schemas/ChatMessage' } },
            token_count: { type: 'integer' },
            ttl: { type: 'string', enum: ['5min', '1h', '24h'] },
            created_at: { type: 'string', format: 'date-time' },
            expires_at: { type: 'string', format: 'date-time' },
            last_accessed_at: { type: 'string', format: 'date-time' },
            access_count: { type: 'integer' },
            metadata: { type: 'object', additionalProperties: { type: 'string' } }
          }
        },
        CachedContextList: {
          type: 'object',
          properties: {
            object: { type: 'string', enum: ['list'] },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  id: { type: 'string' },
                  name: { type: 'string' },
                  token_count: { type: 'integer' },
                  ttl: { type: 'string' },
                  created_at: { type: 'string', format: 'date-time' },
                  expires_at: { type: 'string', format: 'date-time' },
                  last_accessed_at: { type: 'string', format: 'date-time' },
                  access_count: { type: 'integer' }
                }
              }
            },
            total: { type: 'integer' },
            has_more: { type: 'boolean' }
          }
        },
        UseCachedContextResponse: {
          type: 'object',
          properties: {
            messages: { type: 'array', items: { $ref: '#/components/schemas/ChatMessage' } },
            cached_token_count: { type: 'integer' },
            total_token_count: { type: 'integer' },
            cache_hit: { type: 'boolean' }
          }
        },
        File: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', enum: ['file'] },
            bytes: { type: 'integer' },
            created_at: { type: 'integer' },
            filename: { type: 'string' },
            purpose: { type: 'string', enum: ['fine-tune', 'assistants', 'batch', 'vision', 'user_data'] },
            status: { type: 'string', enum: ['uploaded', 'processed', 'error'] }
          }
        },
        Pagination: {
          type: 'object',
          properties: {
            total: { type: 'integer' },
            limit: { type: 'integer' },
            offset: { type: 'integer' }
          }
        },
        AuthResult: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            user: {
              type: 'object',
              properties: {
                id: { type: 'string' },
                email: { type: 'string' },
                name: { type: 'string' },
                organizationId: { type: 'string' },
                roles: { type: 'array', items: { type: 'string' } }
              }
            },
            tokens: {
              type: 'object',
              properties: {
                accessToken: { type: 'string' },
                refreshToken: { type: 'string' }
              }
            },
            loginMode: { type: 'string' },
            error: { type: 'string' }
          }
        },
        ApiKeyResult: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            key: { type: 'string' },
            keyPrefix: { type: 'string' },
            permissions: { type: 'array', items: { type: 'string' } },
            status: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            expiresAt: { type: 'string', format: 'date-time' }
          }
        },
        Model: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            displayName: { type: 'string' },
            provider: { type: 'string' },
            capabilities: { type: 'array', items: { type: 'string' } },
            contextWindow: { type: 'integer' },
            maxTokens: { type: 'integer' },
            pricing: {
              type: 'object',
              properties: {
                input: { type: 'number' },
                output: { type: 'number' }
              }
            },
            status: { type: 'string' },
            description: { type: 'string' },
            releaseDate: { type: 'string' },
            trainingData: { type: 'string' }
          }
        },
        Provider: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            displayName: { type: 'string' },
            status: { type: 'string' },
            models: { type: 'array', items: { type: 'string' } },
            pricing: {
              type: 'object',
              properties: {
                input: { type: 'number' },
                output: { type: 'number' }
              }
            },
            rateLimits: {
              type: 'object',
              properties: {
                requestsPerMinute: { type: 'integer' },
                tokensPerMinute: { type: 'integer' }
              }
            }
          }
        },
        ChatMessage: {
          type: 'object',
          required: ['role', 'content'],
          properties: {
            role: { type: 'string', enum: ['system', 'user', 'assistant', 'function', 'tool'] },
            content: {
              oneOf: [
                { type: 'string' },
                { type: 'array', items: { type: 'object' } }
              ]
            },
            name: { type: 'string' },
            tool_calls: { type: 'array', items: { type: 'object' } },
            tool_call_id: { type: 'string' }
          }
        },
        Tool: {
          type: 'object',
          required: ['type', 'function'],
          properties: {
            type: { type: 'string', enum: ['function'] },
            function: {
              type: 'object',
              required: ['name', 'description', 'parameters'],
              properties: {
                name: { type: 'string' },
                description: { type: 'string' },
                parameters: { type: 'object' }
              }
            }
          }
        },
        ToolChoice: {
          oneOf: [
            { type: 'string', enum: ['none', 'auto'] },
            {
              type: 'object',
              required: ['type', 'function'],
              properties: {
                type: { type: 'string', enum: ['function'] },
                function: {
                  type: 'object',
                  required: ['name'],
                  properties: {
                    name: { type: 'string' }
                  }
                }
              }
            }
          ]
        },
        ChatCompletion: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            object: { type: 'string', example: 'chat.completion' },
            created: { type: 'integer' },
            model: { type: 'string' },
            choices: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  index: { type: 'integer' },
                  message: { $ref: '#/components/schemas/ChatMessage' },
                  finish_reason: { type: 'string', enum: ['stop', 'length', 'function_call', 'content_filter'] }
                }
              }
            },
            usage: {
              type: 'object',
              properties: {
                prompt_tokens: { type: 'integer' },
                completion_tokens: { type: 'integer' },
                total_tokens: { type: 'integer' }
              }
            },
            metadata: { type: 'object' }
          }
        },
        EmbeddingsResponse: {
          type: 'object',
          properties: {
            object: { type: 'string', example: 'list' },
            data: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  object: { type: 'string', example: 'embedding' },
                  embedding: { type: 'array', items: { type: 'number' } },
                  index: { type: 'integer' }
                }
              }
            },
            model: { type: 'string' },
            usage: {
              type: 'object',
              properties: {
                prompt_tokens: { type: 'integer' },
                total_tokens: { type: 'integer' }
              }
            },
            metadata: { type: 'object' }
          }
        },
        Organization: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            tier: { type: 'string' },
            status: { type: 'string' },
            memberCount: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        OrganizationMember: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            name: { type: 'string' },
            role: { type: 'string' },
            status: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        ApiKey: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            name: { type: 'string' },
            keyPrefix: { type: 'string' },
            status: { type: 'string' },
            permissions: { type: 'array', items: { type: 'string' } },
            lastUsedAt: { type: 'string', format: 'date-time' },
            requestCount: { type: 'integer' },
            createdAt: { type: 'string', format: 'date-time' },
            expiresAt: { type: 'string', format: 'date-time' }
          }
        },
        User: {
          type: 'object',
          properties: {
            id: { type: 'string' },
            email: { type: 'string' },
            name: { type: 'string' },
            organizationId: { type: 'string' },
            status: { type: 'string' },
            createdAt: { type: 'string', format: 'date-time' },
            updatedAt: { type: 'string', format: 'date-time' }
          }
        },
        UsageStats: {
          type: 'object',
          properties: {
            usage: {
              type: 'object',
              properties: {
                totalRequests: { type: 'integer' },
                totalTokens: { type: 'integer' },
                totalCost: { type: 'number' },
                requestsByModel: { type: 'object', additionalProperties: { type: 'integer' } },
                tokensByModel: { type: 'object', additionalProperties: { type: 'integer' } },
                costByModel: { type: 'object', additionalProperties: { type: 'number' } },
                dailyUsage: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      date: { type: 'string', format: 'date' },
                      requests: { type: 'integer' },
                      tokens: { type: 'integer' },
                      cost: { type: 'number' }
                    }
                  }
                }
              }
            },
            period: {
              type: 'object',
              properties: {
                startDate: { type: 'string', format: 'date-time' },
                endDate: { type: 'string', format: 'date-time' }
              }
            }
          }
        }
      }
    }
  };
}

// FunÃ§Ã£o para gerar e salvar a documentaÃ§Ã£o OpenAPI
function generateOpenAPIDocs(): void {
  console.log('ðŸš€ Gerando documentaÃ§Ã£o OpenAPI...');

  const spec = createOpenAPISpec();

  // Salvar como JSON
  const jsonPath = path.join(__dirname, '..', '..', 'openapi-spec.json');
  fs.writeFileSync(jsonPath, JSON.stringify(spec, null, 2));
  console.log(`âœ… DocumentaÃ§Ã£o OpenAPI salva em: ${jsonPath}`);

  // Salvar como YAML (se disponÃ­vel)
  try {
    // Verificar se yaml estÃ¡ disponÃ­vel
    require('yaml');
    const yamlPath = path.join(__dirname, '..', '..', 'openapi-spec.yaml');
    const yaml = require('yaml');
    fs.writeFileSync(yamlPath, yaml.stringify(spec));
    console.log(`âœ… DocumentaÃ§Ã£o OpenAPI YAML salva em: ${yamlPath}`);
  } catch {
    console.log('âš ï¸  YAML nÃ£o disponÃ­vel, pulando geraÃ§Ã£o do arquivo YAML');
  }

  console.log('\nðŸ“Š ESTATÃSTICAS DA DOCUMENTAÃ‡ÃƒO:');
  console.log(`   â€¢ VersÃ£o OpenAPI: ${spec.openapi}`);
  console.log(`   â€¢ TÃ­tulo: ${spec.info.title}`);
  console.log(`   â€¢ VersÃ£o da API: ${spec.info.version}`);
  console.log(`   â€¢ Endpoints documentados: ${Object.keys(spec.paths).length}`);
  console.log(`   â€¢ Schemas definidos: ${Object.keys(spec.components.schemas).length}`);

  console.log('\nðŸŽ¯ ENDPOINTS POR CATEGORIA:');
  const categories = {
    'ðŸ” AutenticaÃ§Ã£o': ['/auth'],
    'ðŸ¤– Modelos': ['/models'],
    'ðŸ’¬ Chat': ['/chat'],
    'ðŸ“Š Embeddings': ['/embeddings'],
    'ðŸ¢ OrganizaÃ§Ãµes': ['/organizations'],
    'ðŸ”‘ API Keys': ['/api-keys'],
    'ðŸ‘¤ UsuÃ¡rios': ['/users'],
    'ðŸ“ˆ Uso': ['/usage'],
    'ðŸ¥ Status': ['/status'],
    'ðŸ—„ï¸ Cache': ['/cache'],
    'ðŸ“‹ Queue': ['/queue'],
    'ðŸ“Š MÃ©tricas': ['/metrics'],
    'ðŸ’¾ Context Caching': ['/caching']
  };

  Object.entries(categories).forEach(([category, prefixes]) => {
    const endpoints = Object.keys(spec.paths).filter(path =>
      prefixes.some(prefix => path.startsWith(prefix))
    );
    console.log(`   â€¢ ${category}: ${endpoints.length} endpoints`);
  });

  console.log('\nâœ… DocumentaÃ§Ã£o OpenAPI gerada com sucesso!');
  console.log('\nðŸ’¡ PRÃ“XIMOS PASSOS:');
  console.log('   1. Use a documentaÃ§Ã£o JSON/YAML em ferramentas como Swagger UI');
  console.log('   2. Importe para Postman ou Insomnia');
  console.log('   3. Use para gerar clientes SDK automaticamente');
}

// Executar se for chamado diretamente
if (require.main === module) {
  generateOpenAPIDocs();
}

export { generateOpenAPIDocs, createOpenAPISpec };

