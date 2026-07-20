<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Endpoints Catalog (OpenAPI)

This page is generated from `ci/openapi-spec.json`.

- Total paths: 207
- Total operations: 240

## Auth Semantics

- OpenAPI `security` array means **OR** between entries.
- Multiple schemes in one security object mean **AND**.
- Canonical API key header is `X-API-Key`.

## Surface Split

- Public operations (`security: []`): 13
- Authenticated operations: 227

## Public API (No Auth Required) (13)

### Advanced (6)

| Method | Path | Summary | Operation ID |
|---|---|---|---|
| POST | `/v1/auth/challenge` | Create or execute auth challenge | `postAuthChallenge` |
| POST | `/v1/auth/email-challenge` | Create or execute auth email challenge | `postAuthEmailchallenge` |
| POST | `/v1/auth/refresh` | Create or execute auth refresh | `postAuthRefresh` |
| POST | `/v1/auth/register` | Create or execute auth register | `postAuthRegister` |
| GET | `/v1/status/health` | Retrieve status health | `getStatusHealth` |
| GET | `/v1/status/ready` | Retrieve status ready | `getStatusReady` |

### Auth (3)

| Method | Path | Summary | Operation ID |
|---|---|---|---|
| GET | `/.well-known/jwks.json` | Get JSON Web Key Set | `getWellknownJwksjson` |
| POST | `/v1/auth/login` | Create or execute auth login | `postAuthLogin` |
| POST | `/v1/auth/login-with-code` | Create or execute auth login with code | `postAuthLoginwithcode` |

### Health (1)

| Method | Path | Summary | Operation ID |
|---|---|---|---|
| GET | `/v1/status` | Service status and capability negotiation endpoint | `getStatus` |

### Models (3)

| Method | Path | Summary | Operation ID |
|---|---|---|---|
| GET | `/v1/models` | Retrieve models | `getModels` |
| GET | `/v1/models/{id}` | Retrieve models id | `getModelsById` |
| GET | `/v1/models/list` | Retrieve models list | `getModelsList` |

## Authenticated API (227)

### Advanced (87)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/admin/api-keys/auto-rotate/enable` | Create or execute admin api keys auto rotate enable | Bearer or API Key | `postAdminApikeysAutorotateEnable2` |
| POST | `/v1/admin/api-keys/rotate/{keyId}` | Create or execute admin api keys rotate keyId | Bearer or API Key | `postAdminApikeysRotateBykeyId` |
| GET | `/v1/admin/api-keys/rotation-logs` | Retrieve admin api keys rotation logs | Bearer or API Key | `getAdminApikeysRotationlogs2` |
| GET | `/v1/admin/api-keys/rotation-status` | Retrieve admin api keys rotation status | Bearer or API Key | `getAdminApikeysRotationstatus2` |
| GET | `/v1/admin/users` | Retrieve admin users | Bearer or API Key | `getAdminUsers2` |
| DELETE | `/v1/admin/users/{id}` | Delete admin users id | Bearer or API Key | `deleteAdminUsersByid` |
| GET | `/v1/auth/api-keys` | Retrieve auth api keys | Bearer or API Key | `getAuthApikeys` |
| POST | `/v1/auth/api-keys` | Create or execute auth api keys | Bearer or API Key | `postAuthApikeys` |
| DELETE | `/v1/auth/api-keys/{id}` | Delete auth api keys id | Bearer or API Key | `deleteAuthApikeysById` |
| POST | `/v1/auth/logout` | Create or execute auth logout | Bearer or API Key | `postAuthLogout` |
| GET | `/v1/ci/dashboard/cache` | Retrieve ci dashboard cache | Bearer or API Key | `getCiDashboardCache2` |
| GET | `/v1/ci/dashboard/health` | Retrieve ci dashboard health | Bearer or API Key | `getCiDashboardHealth2` |
| GET | `/v1/ci/dashboard/learning` | Retrieve ci dashboard learning | Bearer or API Key | `getCiDashboardLearning2` |
| GET | `/v1/ci/dashboard/models` | Retrieve ci dashboard models | Bearer or API Key | `getCiDashboardModels2` |
| GET | `/v1/ci/dashboard/overview` | Retrieve ci dashboard overview | Bearer or API Key | `getCiDashboardOverview2` |
| GET | `/v1/ci/dashboard/strategies` | Retrieve ci dashboard strategies | Bearer or API Key | `getCiDashboardStrategies2` |
| POST | `/v1/code/execute` | Create or execute code execute | Bearer or API Key | `postCodeExecute2` |
| POST | `/v1/codebase/analysis` | Create or execute codebase analysis | Bearer or API Key | `postCodebaseAnalysis2` |
| POST | `/v1/codebase/analysis/sync` | Create or execute codebase analysis sync | Bearer or API Key | `postCodebaseAnalysisSync2` |
| GET | `/v1/codebase/checkpoint` | Retrieve codebase checkpoint | Bearer or API Key | `getCodebaseCheckpoint2` |
| GET | `/v1/codebase/dependencies` | Retrieve codebase dependencies | Bearer or API Key | `getCodebaseDependencies2` |
| GET | `/v1/codebase/files/symbols` | Retrieve codebase files symbols | Bearer or API Key | `getCodebaseFilesSymbols2` |
| GET | `/v1/codebase/references` | Retrieve codebase references | Bearer or API Key | `getCodebaseReferences2` |
| POST | `/v1/codebase/search/semantic` | Create or execute codebase search semantic | Bearer or API Key | `postCodebaseSearchSemantic2` |
| GET | `/v1/codebase/stats` | Retrieve codebase stats | Bearer or API Key | `getCodebaseStats2` |
| GET | `/v1/codebase/symbols` | Retrieve codebase symbols | Bearer or API Key | `getCodebaseSymbols2` |
| GET | `/v1/codebase/symbols/references` | Retrieve codebase symbols references | Bearer or API Key | `getCodebaseSymbolsReferences2` |
| POST | `/v1/codebase/sync` | Create or execute codebase sync | Bearer or API Key | `postCodebaseSync2` |
| GET | `/v1/collective-intelligence/learning-scope` | Retrieve collective intelligence learning scope | Bearer or API Key | `getCollectiveintelligenceLearningscope` |
| GET | `/v1/critique/config` | Retrieve critique config | Bearer or API Key | `getCritiqueConfig2` |
| GET | `/v1/enterprise/billing/config` | Retrieve enterprise billing config | Bearer or API Key | `getEnterpriseBillingConfig2` |
| GET | `/v1/enterprise/billing/invoices` | Retrieve enterprise billing invoices | Bearer or API Key | `getEnterpriseBillingInvoices2` |
| GET | `/v1/enterprise/billing/invoices/{invoiceId}` | Retrieve enterprise billing invoices invoiceId | Bearer or API Key | `getEnterpriseBillingInvoicesByinvoiceId` |
| POST | `/v1/enterprise/billing/invoices/{invoiceId}/pay` | Create or execute enterprise billing invoices invoiceId pay | Bearer or API Key | `postEnterpriseBillingInvoicesByinvoiceIdPay` |
| GET | `/v1/enterprise/billing/payment-methods` | Retrieve enterprise billing payment methods | Bearer or API Key | `getEnterpriseBillingPaymentmethods2` |
| DELETE | `/v1/enterprise/billing/payment-methods/{paymentMethodId}` | Delete enterprise billing payment methods paymentMethodId | Bearer or API Key | `deleteEnterpriseBillingPaymentmethodsBypaymentMethodId` |
| POST | `/v1/enterprise/billing/payment-methods/attach` | Create or execute enterprise billing payment methods attach | Bearer or API Key | `postEnterpriseBillingPaymentmethodsAttach2` |
| POST | `/v1/enterprise/billing/payment-methods/setup-intent` | Create or execute enterprise billing payment methods setup intent | Bearer or API Key | `postEnterpriseBillingPaymentmethodsSetupintent2` |
| GET | `/v1/enterprise/billing/plans` | Retrieve enterprise billing plans | Bearer or API Key | `getEnterpriseBillingPlans2` |
| GET | `/v1/enterprise/billing/subscriptions` | Retrieve enterprise billing subscriptions | Bearer or API Key | `getEnterpriseBillingSubscriptions2` |
| POST | `/v1/enterprise/billing/subscriptions/{subscriptionId}/cancel` | Create or execute enterprise billing subscriptions subscriptionId cancel | Bearer or API Key | `postEnterpriseBillingSubscriptionsBysubscriptionIdCancel` |
| GET | `/v1/enterprise/quotas` | Retrieve enterprise quotas | Bearer or API Key | `getEnterpriseQuotas2` |
| POST | `/v1/enterprise/quotas` | Create or execute enterprise quotas | Bearer or API Key | `postEnterpriseQuotas2` |
| POST | `/v1/enterprise/quotas/check` | Create or execute enterprise quotas check | Bearer or API Key | `postEnterpriseQuotasCheck2` |
| GET | `/v1/enterprise/quotas/current` | Retrieve enterprise quotas current | Bearer or API Key | `getEnterpriseQuotasCurrent2` |
| POST | `/v1/enterprise/quotas/reset` | Create or execute enterprise quotas reset | Bearer or API Key | `postEnterpriseQuotasReset2` |
| POST | `/v1/enterprise/quotas/usage` | Create or execute enterprise quotas usage | Bearer or API Key | `postEnterpriseQuotasUsage2` |
| POST | `/v1/enterprise/usage/events` | Create or execute enterprise usage events | Bearer or API Key | `postEnterpriseUsageEvents2` |
| GET | `/v1/enterprise/usage/metrics` | Retrieve enterprise usage metrics | Bearer or API Key | `getEnterpriseUsageMetrics2` |
| GET | `/v1/fine_tuning/jobs` | Retrieve fine tuning jobs | Bearer or API Key | `getFinetuningJobs` |
| POST | `/v1/fine_tuning/jobs` | Create or execute fine tuning jobs | Bearer or API Key | `postFinetuningJobs` |
| DELETE | `/v1/fine_tuning/jobs/{job_id}` | Delete fine tuning jobs job id | Bearer or API Key | `deleteFinetuningJobsByjobid` |
| GET | `/v1/fine_tuning/jobs/{job_id}` | Retrieve fine tuning jobs job id | Bearer or API Key | `getFinetuningJobsByjobid` |
| POST | `/v1/fine_tuning/jobs/{job_id}/cancel` | Create or execute fine tuning jobs job id cancel | Bearer or API Key | `postFinetuningJobsByjobidCancel` |
| GET | `/v1/fine_tuning/jobs/{job_id}/checkpoints` | Retrieve fine tuning jobs job id checkpoints | Bearer or API Key | `getFinetuningJobsByjobidCheckpoints` |
| GET | `/v1/fine_tuning/jobs/{job_id}/events` | Retrieve fine tuning jobs job id events | Bearer or API Key | `getFinetuningJobsByjobidEvents` |
| POST | `/v1/grounding/extract` | Create or execute grounding extract | Bearer or API Key | `postGroundingExtract2` |
| GET | `/v1/jobs` | Retrieve jobs | Bearer or API Key | `getJobs2` |
| GET | `/v1/jobs/{id}` | Retrieve jobs id | Bearer or API Key | `getJobsByid` |
| POST | `/v1/memory` | Create or execute memory | Bearer or API Key | `postMemory2` |
| DELETE | `/v1/memory/{memoryId}` | Delete memory memoryId | Bearer or API Key | `deleteMemoryBymemoryId` |
| POST | `/v1/memory/search` | Create or execute memory search | Bearer or API Key | `postMemorySearch2` |
| GET | `/v1/memory/stats` | Retrieve memory stats | Bearer or API Key | `getMemoryStats2` |
| GET | `/v1/nonce` | Retrieve nonce | Bearer or API Key | `getNonce2` |
| GET | `/v1/orchestration/strategies` | Retrieve orchestration strategies | Bearer or API Key | `getOrchestrationStrategies2` |
| POST | `/v1/pdf/analyze` | Create or execute pdf analyze | Bearer or API Key | `postPdfAnalyze2` |
| GET | `/v1/reasoning/{requestId}` | Retrieve reasoning requestId | Bearer or API Key | `getReasoningByrequestId` |
| GET | `/v1/reasoning/{requestId}/explain` | Retrieve reasoning requestId explain | Bearer or API Key | `getReasoningByrequestIdExplain` |
| POST | `/v1/search` | Create or execute search | Bearer or API Key | `postSearch2` |
| POST | `/v1/search/codebase` | Create or execute search codebase | Bearer or API Key | `postSearchCodebase2` |
| POST | `/v1/search/semantic` | Create or execute search semantic | Bearer or API Key | `postSearchSemantic2` |
| POST | `/v1/tools/google-maps` | Create or execute tools google maps | Bearer or API Key | `postToolsGooglemaps2` |
| POST | `/v1/tools/google-maps/directions` | Create or execute tools google maps directions | Bearer or API Key | `postToolsGooglemapsDirections2` |
| POST | `/v1/tools/google-maps/geocode` | Create or execute tools google maps geocode | Bearer or API Key | `postToolsGooglemapsGeocode2` |
| POST | `/v1/tools/google-maps/place-details` | Create or execute tools google maps place details | Bearer or API Key | `postToolsGooglemapsPlacedetails2` |
| POST | `/v1/tools/google-maps/reverse-geocode` | Create or execute tools google maps reverse geocode | Bearer or API Key | `postToolsGooglemapsReversegeocode2` |
| POST | `/v1/tools/google-maps/search` | Create or execute tools google maps search | Bearer or API Key | `postToolsGooglemapsSearch2` |
| POST | `/v1/tools/jina/classify` | Create or execute tools jina classify | Bearer or API Key | `postToolsJinaClassify` |
| POST | `/v1/tools/jina/deepsearch` | Create or execute tools jina deepsearch | Bearer or API Key | `postToolsJinaDeepsearch` |
| POST | `/v1/tools/jina/embeddings` | Create or execute tools jina embeddings | Bearer or API Key | `postToolsJinaEmbeddings` |
| POST | `/v1/tools/jina/reader` | Create or execute tools jina reader | Bearer or API Key | `postToolsJinaReader` |
| POST | `/v1/tools/jina/rerank` | Create or execute tools jina rerank | Bearer or API Key | `postToolsJinaRerank` |
| POST | `/v1/tools/jina/search` | Create or execute tools jina search | Bearer or API Key | `postToolsJinaSearch` |
| POST | `/v1/tools/jina/segment` | Create or execute tools jina segment | Bearer or API Key | `postToolsJinaSegment` |
| POST | `/v1/videos/generations` | Create or execute videos generations | Bearer or API Key | `postVideosGenerations` |
| POST | `/v1/workflows/create` | Create or execute workflows create | Bearer or API Key | `postWorkflowsCreate2` |
| POST | `/v1/workflows/execute` | Create or execute workflows execute | Bearer or API Key | `postWorkflowsExecute2` |

### API Keys (2)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| GET | `/v1/api-keys` | Retrieve api keys | Bearer | `getApikeys` |
| POST | `/v1/api-keys/{keyId}/rotate` | Create or execute api keys keyId rotate | Bearer | `postApikeysByKeyIdRotate` |

### Assistants (9)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| GET | `/v1/assistants` | Retrieve assistants | Bearer or API Key | `getAssistants` |
| POST | `/v1/assistants` | Create or execute assistants | Bearer or API Key | `postAssistants` |
| DELETE | `/v1/assistants/{assistant_id}` | Delete assistants assistant id | Bearer or API Key | `deleteAssistantsByassistantid` |
| GET | `/v1/assistants/{assistant_id}` | Retrieve assistants assistant id | Bearer or API Key | `getAssistantsByassistantid` |
| POST | `/v1/assistants/{assistant_id}` | Create or execute assistants assistant id | Bearer or API Key | `postAssistantsByassistantid` |
| GET | `/v1/assistants/{assistant_id}/files` | Retrieve assistants assistant id files | Bearer or API Key | `getAssistantsByassistantidFiles` |
| POST | `/v1/assistants/{assistant_id}/files` | Create or execute assistants assistant id files | Bearer or API Key | `postAssistantsByassistantidFiles` |
| DELETE | `/v1/assistants/{assistant_id}/files/{file_id}` | Delete assistants assistant id files file id | Bearer or API Key | `deleteAssistantsByassistantidFilesByfileid` |
| GET | `/v1/assistants/{assistant_id}/files/{file_id}` | Retrieve assistants assistant id files file id | Bearer or API Key | `getAssistantsByassistantidFilesByfileid` |

### Audio (3)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/audio/speech` | Text-to-Speech (TTS) | Bearer or API Key | `postAudioSpeech` |
| POST | `/v1/audio/transcriptions` | Speech-to-Text (STT) | Bearer or API Key | `postAudioTranscriptions` |
| POST | `/v1/audio/translations` | Audio Translation | Bearer or API Key | `postAudioTranslations` |

### Batches (4)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| GET | `/v1/batches` | Retrieve batches | Bearer or API Key | `getBatches` |
| POST | `/v1/batches` | Create or execute batches | Bearer or API Key | `postBatches` |
| GET | `/v1/batches/{batch_id}` | Retrieve batches batch id | Bearer or API Key | `getBatchesBybatchid` |
| POST | `/v1/batches/{batch_id}/cancel` | Create or execute batches batch id cancel | Bearer or API Key | `postBatchesBybatchidCancel` |

### Cache (5)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/cache/clear` | Create or execute cache clear | Bearer or API Key | `postCacheClear` |
| GET | `/v1/cache/stats` | Retrieve cache stats | Bearer or API Key | `getCacheStats` |
| DELETE | `/v1/cache/value` | Delete cache value | Bearer or API Key | `deleteCacheValue` |
| GET | `/v1/cache/value` | Retrieve cache value | Bearer or API Key | `getCacheValue` |
| POST | `/v1/cache/value` | Create or execute cache value | Bearer or API Key | `postCacheValue` |

### Caching (5)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| GET | `/v1/caching/contexts` | Retrieve caching contexts | Bearer or API Key | `getCachingContexts` |
| POST | `/v1/caching/contexts` | Create or execute caching contexts | Bearer or API Key | `postCachingContexts` |
| DELETE | `/v1/caching/contexts/{context_id}` | Delete caching contexts context id | Bearer or API Key | `deleteCachingContextsBycontextid` |
| GET | `/v1/caching/contexts/{context_id}` | Retrieve caching contexts context id | Bearer or API Key | `getCachingContextsBycontextid` |
| POST | `/v1/caching/contexts/{context_id}/use` | Create or execute caching contexts context id use | Bearer or API Key | `postCachingContextsBycontextidUse` |

### Capabilities (6)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/analyze-requirements` | Create or execute analyze requirements | Bearer or API Key | `postAnalyzerequirements` |
| GET | `/v1/capabilities` | Retrieve capabilities | Bearer or API Key | `getCapabilities` |
| POST | `/v1/capabilities/{capability}/execute` | Create or execute capabilities capability execute | Bearer or API Key | `postCapabilitiesByCapabilityExecute` |
| GET | `/v1/capabilities/{capability}/health` | Retrieve capabilities capability health | Bearer or API Key | `getCapabilitiesByCapabilityHealth` |
| POST | `/v1/capabilities/{capability}/stream` | Create or execute capabilities capability stream | Bearer or API Key | `postCapabilitiesByCapabilityStream` |
| GET | `/v1/provider-capabilities` | Retrieve provider capabilities | Bearer or API Key | `getProvidercapabilities` |

### Chat (4)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/chat/completions` | Create a chat completion | Bearer or API Key | `postChatCompletions` |
| POST | `/v1/chat/completions/extended-thinking` | Create or execute chat completions extended thinking | Bearer or API Key | `postChatCompletionsExtendedthinking2` |
| POST | `/v1/chat/completions/intelligent` | Create chat completion with intelligent selection | Bearer or API Key | `postChatCompletionsIntelligent` |
| POST | `/v1/chat/completions/ultra-thinking` | Create or execute chat completions ultra thinking | Bearer or API Key | `postChatCompletionsUltrathinking2` |

### Embeddings (2)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/embeddings` | Create or execute embeddings | Bearer or API Key | `postEmbeddings` |
| POST | `/v1/embeddings/create` | Create or execute embeddings create | Bearer or API Key | `postEmbeddingsCreate` |

### Files (5)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| GET | `/v1/files` | List files | Bearer or API Key | `getFiles` |
| POST | `/v1/files` | Upload file | Bearer or API Key | `postFiles` |
| DELETE | `/v1/files/{file_id}` | Delete file | Bearer or API Key | `deleteFilesByFileid` |
| GET | `/v1/files/{file_id}` | Retrieve file metadata | Bearer or API Key | `getFilesByFileid` |
| GET | `/v1/files/{file_id}/content` | Retrieve file content | Bearer or API Key | `getFilesByFileidContent` |

### Images (3)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/images/edits` | Edit images with text prompts | Bearer or API Key | `postImagesEdits` |
| POST | `/v1/images/generations` | Generate images from text prompts | Bearer or API Key | `postImagesGenerations` |
| POST | `/v1/images/variations` | Create variations of images | Bearer or API Key | `postImagesVariations` |

### Models (3)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/models/configure` | Create or execute models configure | Bearer or API Key | `postModelsConfigure2` |
| GET | `/v1/providers` | Retrieve providers | Bearer or API Key | `getProviders2` |
| GET | `/v1/providers/{id}` | Retrieve providers id | Bearer or API Key | `getProvidersByid` |

### Moderations (1)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/moderations` | Create or execute moderations | Bearer or API Key | `postModerations` |

### Organizations (6)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| PATCH | `/v1/organization/settings` | Update organization settings | Bearer or API Key | `patchOrganizationSettings2` |
| GET | `/v1/organizations` | Retrieve organizations | Bearer | `getOrganizations` |
| GET | `/v1/organizations/{id}` | Retrieve organizations id | Bearer | `getOrganizationsById` |
| PUT | `/v1/organizations/{id}` | Update organizations id | Bearer | `putOrganizationsById` |
| GET | `/v1/organizations/{id}/members` | Retrieve organizations id members | Bearer | `getOrganizationsByIdMembers` |
| DELETE | `/v1/organizations/{id}/members/{userId}` | Delete organizations id members userId | Bearer | `deleteOrganizationsByIdMembersByUserId` |

### Queue (2)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| DELETE | `/v1/queue/status/{id}` | Delete queue status id | Bearer or API Key | `deleteQueueStatusByid` |
| GET | `/v1/queue/status/{id}` | Retrieve queue status id | Bearer or API Key | `getQueueStatusByid` |

### Realtime (1)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| GET | `/v1/realtime` | Retrieve realtime | Bearer or API Key | `getRealtime` |

### Responses (3)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/responses` | Create a response | Bearer or API Key | `postResponses` |
| DELETE | `/v1/responses/{response_id}` | Delete a response | Bearer or API Key | `deleteResponsesByResponseid` |
| GET | `/v1/responses/{response_id}` | Retrieve a response | Bearer or API Key | `getResponsesByResponseid` |

### Status (2)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| GET | `/v1/health/providers` | Retrieve health providers | Bearer or API Key | `getHealthProviders2` |
| GET | `/v1/health/providers/{providerName}` | Retrieve health providers providerName | Bearer or API Key | `getHealthProvidersByproviderName` |

### Threads (16)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/threads` | Create thread | Bearer or API Key | `postThreads` |
| DELETE | `/v1/threads/{thread_id}` | Delete thread | Bearer or API Key | `deleteThreadsByThreadid` |
| GET | `/v1/threads/{thread_id}` | Retrieve thread | Bearer or API Key | `getThreadsByThreadid` |
| POST | `/v1/threads/{thread_id}` | Modify thread | Bearer or API Key | `postThreadsByThreadid` |
| GET | `/v1/threads/{thread_id}/messages` | List messages | Bearer or API Key | `getThreadsByThreadidMessages` |
| POST | `/v1/threads/{thread_id}/messages` | Create message | Bearer or API Key | `postThreadsByThreadidMessages` |
| DELETE | `/v1/threads/{thread_id}/messages/{message_id}` | Delete message | Bearer or API Key | `deleteThreadsByThreadidMessagesByMessageid` |
| GET | `/v1/threads/{thread_id}/messages/{message_id}` | Get message | Bearer or API Key | `getThreadsByThreadidMessagesByMessageid` |
| POST | `/v1/threads/{thread_id}/messages/{message_id}` | Modify message | Bearer or API Key | `postThreadsByThreadidMessagesByMessageid` |
| GET | `/v1/threads/{thread_id}/runs` | List runs | Bearer or API Key | `getThreadsByThreadidRuns` |
| POST | `/v1/threads/{thread_id}/runs` | Create run | Bearer or API Key | `postThreadsByThreadidRuns` |
| GET | `/v1/threads/{thread_id}/runs/{run_id}` | Get run | Bearer or API Key | `getThreadsByThreadidRunsByRunid` |
| POST | `/v1/threads/{thread_id}/runs/{run_id}/cancel` | Cancel run | Bearer or API Key | `postThreadsByThreadidRunsByRunidCancel` |
| GET | `/v1/threads/{thread_id}/runs/{run_id}/steps` | List run steps | Bearer or API Key | `getThreadsByThreadidRunsByRunidSteps` |
| GET | `/v1/threads/{thread_id}/runs/{run_id}/steps/{step_id}` | Get run step | Bearer or API Key | `getThreadsByThreadidRunsByRunidStepsByStepid` |
| POST | `/v1/threads/{thread_id}/runs/{run_id}/submit_tool_outputs` | Submit tool outputs | Bearer or API Key | `postThreadsByThreadidRunsByRunidSubmittooloutputs` |

### Tools - Batch Operations (2)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/tools/apply-multi-file-changes` | Apply changes to multiple files | Bearer or API Key | `postToolsApplymultifilechanges` |
| POST | `/v1/tools/batch-search-replace` | Batch search and replace | Bearer or API Key | `postToolsBatchsearchreplace` |

### Tools - Code Analysis (6)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/tools/analyze-codebase` | Analyze codebase | Bearer or API Key | `postToolsAnalyzecodebase` |
| POST | `/v1/tools/codebase-search` | Search codebase | Bearer or API Key | `postToolsCodebasesearch` |
| POST | `/v1/tools/dependency-graph` | Get dependency graph | Bearer or API Key | `postToolsDependencygraph` |
| POST | `/v1/tools/explore-codebase` | Explore codebase structure | Bearer or API Key | `postToolsExplorecodebase` |
| POST | `/v1/tools/find-symbol-references` | Find symbol references | Bearer or API Key | `postToolsFindsymbolreferences` |
| POST | `/v1/tools/semantic-search` | Semantic code search | Bearer or API Key | `postToolsSemanticsearch` |

### Tools - File Operations (4)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/tools/file-search` | Search for files by pattern | Bearer or API Key | `postToolsFilesearch` |
| POST | `/v1/tools/grep` | Search for pattern in files | Bearer or API Key | `postToolsGrep` |
| POST | `/v1/tools/list-directory` | List directory contents | Bearer or API Key | `postToolsListdirectory` |
| POST | `/v1/tools/search-replace` | Search and replace in file | Bearer or API Key | `postToolsSearchreplace` |

### Tools - Git (9)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/tools/git/commit` | Create Git commit | Bearer or API Key | `postToolsGitCommit` |
| POST | `/v1/tools/git/create-branch` | Create Git branch | Bearer or API Key | `postToolsGitCreatebranch` |
| POST | `/v1/tools/git/diff` | Get Git diff | Bearer or API Key | `postToolsGitDiff` |
| POST | `/v1/tools/git/merge` | Merge Git branch | Bearer or API Key | `postToolsGitMerge` |
| POST | `/v1/tools/git/pull` | Pull from remote | Bearer or API Key | `postToolsGitPull` |
| POST | `/v1/tools/git/push` | Push to remote | Bearer or API Key | `postToolsGitPush` |
| POST | `/v1/tools/git/rebase` | Rebase Git branch | Bearer or API Key | `postToolsGitRebase` |
| POST | `/v1/tools/git/resolve-conflict` | Resolve Git conflict | Bearer or API Key | `postToolsGitResolveconflict` |
| POST | `/v1/tools/git/status` | Get Git status | Bearer or API Key | `postToolsGitStatus` |

### Tools - Multimodal (3)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/tools/analyze-image` | Analyze image | Bearer or API Key | `postToolsAnalyzeimage` |
| POST | `/v1/tools/compare-images` | Compare images | Bearer or API Key | `postToolsCompareimages` |
| POST | `/v1/tools/extract-code-from-screenshot` | Extract code from screenshot | Bearer or API Key | `postToolsExtractcodefromscreenshot` |

### Tools - Refactoring (4)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/tools/extract-function` | Extract function | Bearer or API Key | `postToolsExtractfunction` |
| POST | `/v1/tools/extract-variable` | Extract variable | Bearer or API Key | `postToolsExtractvariable` |
| POST | `/v1/tools/inline-function` | Inline function | Bearer or API Key | `postToolsInlinefunction` |
| POST | `/v1/tools/rename-symbol` | Rename symbol | Bearer or API Key | `postToolsRenamesymbol` |

### Tools - Task Management (4)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/tools/todos/check` | Mark task as completed | Bearer or API Key | `postToolsTodosCheck` |
| POST | `/v1/tools/todos/create` | Create workspace task | Bearer or API Key | `postToolsTodosCreate` |
| POST | `/v1/tools/todos/list` | List workspace tasks | Bearer or API Key | `postToolsTodosList` |
| POST | `/v1/tools/todos/update` | Update workspace task | Bearer or API Key | `postToolsTodosUpdate` |

### Tools - Testing & Validation (4)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/tools/detect-errors` | Detect code errors | Bearer or API Key | `postToolsDetecterrors` |
| POST | `/v1/tools/generate-tests` | Generate tests | Bearer or API Key | `postToolsGeneratetests` |
| POST | `/v1/tools/heal-file` | Heal file errors | Bearer or API Key | `postToolsHealfile` |
| POST | `/v1/tools/validate-code` | Validate code | Bearer or API Key | `postToolsValidatecode` |

### Tools - Web (1)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| POST | `/v1/tools/web-search` | Search the web | Bearer or API Key | `postToolsWebsearch` |

### Tools - Workflow (3)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| GET | `/v1/tools/workflows` | List workflows | Bearer or API Key | `getToolsWorkflows` |
| POST | `/v1/tools/workflows/execute` | Execute workflow | Bearer or API Key | `postToolsWorkflowsExecute` |
| POST | `/v1/tools/workflows/register` | Register workflow | Bearer or API Key | `postToolsWorkflowsRegister` |

### Usage (1)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| GET | `/v1/usage/stats` | Retrieve usage stats | Bearer or API Key | `getUsageStats` |

### User (2)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| GET | `/v1/user/profile` | Retrieve user profile | Bearer | `getUserProfile` |
| PUT | `/v1/user/profile` | Update user profile | Bearer | `putUserProfile` |

### Users (7)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| GET | `/v1/users` | Retrieve users | Bearer or API Key | `getUsers2` |
| DELETE | `/v1/users/{id}` | Delete users id | Bearer or API Key | `deleteUsersByid` |
| GET | `/v1/users/{id}` | Retrieve users id | Bearer or API Key | `getUsersByid` |
| PATCH | `/v1/users/{id}` | Update users id | Bearer or API Key | `patchUsersByid` |
| PUT | `/v1/users/{id}` | Update users id | Bearer or API Key | `putUsersByid` |
| GET | `/v1/users/{id}/api-keys` | Retrieve users id api keys | Bearer or API Key | `getUsersByidApikeys` |
| POST | `/v1/users/{id}/change-password` | Create or execute users id change password | Bearer or API Key | `postUsersByidChangepassword` |

### Vector Stores (8)

| Method | Path | Summary | Auth | Operation ID |
|---|---|---|---|---|
| GET | `/v1/vector_stores` | List vector stores | Bearer or API Key | `getVectorstores` |
| POST | `/v1/vector_stores` | Create vector store | Bearer or API Key | `postVectorstores` |
| DELETE | `/v1/vector_stores/{vector_store_id}` | Delete vector store | Bearer or API Key | `deleteVectorstoresByVectorstoreid` |
| GET | `/v1/vector_stores/{vector_store_id}` | Get vector store | Bearer or API Key | `getVectorstoresByVectorstoreid` |
| POST | `/v1/vector_stores/{vector_store_id}` | Modify vector store | Bearer or API Key | `postVectorstoresByVectorstoreid` |
| GET | `/v1/vector_stores/{vector_store_id}/files` | List vector store files | Bearer or API Key | `getVectorstoresByVectorstoreidFiles` |
| POST | `/v1/vector_stores/{vector_store_id}/files` | Create vector store file | Bearer or API Key | `postVectorstoresByVectorstoreidFiles` |
| DELETE | `/v1/vector_stores/{vector_store_id}/files/{file_id}` | Delete vector store file | Bearer or API Key | `deleteVectorstoresByVectorstoreidFilesByFileid` |

