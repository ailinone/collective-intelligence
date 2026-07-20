<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Load Testing Guide - Ailin Dev API

**Tool:** k6 by Grafana Labs (industry-standard load testing)  
**Purpose:** Verify performance and scalability claims (1M+ req/day)

---

## ðŸŽ¯ Test Suite

### 1. Authentication Load Test
**File:** `auth-load-test.js`  
**Duration:** 5 minutes  
**Peak Load:** 2,000 concurrent users  
**Target:** 10K auth req/sec

**Run:**
```bash
k6 run auth-load-test.js
```

**With custom settings:**
```bash
k6 run auth-load-test.js \
  -e API_URL=https://api.ailin.one \
  -e TEST_API_KEY=ak_live_your_key
```

---

### 2. Chat Completion Load Test
**File:** `chat-completion-load.js`  
**Duration:** 10 minutes  
**Peak Load:** 1,500 concurrent users  
**Target:** 1K concurrent chat requests

**Run:**
```bash
k6 run chat-completion-load.js
```

---

### 3. Phase 1 Scoring Hot-Path Load Test (scale-to-100k acceptance)
**File:** `phase1-scoring-load-test.js`  
**Duration:** ~5 minutes  
**Peak Load:** 1,000 concurrent VUs, no think-time  
**Target:** validate PR #135's ~40-200 to >=1,000 req/s/replica claim

Unlike the other two tests, this one removes think-time and uses a trivial,
fixed payload — it's testing the CPU-bound model-scoring hot path, not
realistic user traffic. See the file header for how to isolate this
measurement from provider latency using `stub-provider-server.js`, and how
to compare before/after the scoring memoization.

**Run (against real providers — measures Phase 1 + Phase 2 combined):**
```bash
k6 run phase1-scoring-load-test.js -e API_URL=https://staging.example.com -e TEST_API_KEY=$TEST_API_KEY
```

**Run (isolated mode — measures Phase 1 only):**
```bash
node stub-provider-server.js &
export OPENAI_BASE_URL=http://localhost:9009/v1   # + any other live provider's *_BASE_URL
# restart the API under test with those env vars set, then:
k6 run phase1-scoring-load-test.js -e API_URL=http://localhost:3000
```

---

## ðŸ“¦ Installation

### Install k6

**macOS:**
```bash
brew install k6
```

**Windows:**
```powershell
choco install k6
```

**Linux:**
```bash
sudo gpg -k
sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
sudo apt-get update
sudo apt-get install k6
```

---

## ðŸŽ¯ Performance Targets (SLAs)

### Authentication
- **p95 latency:** < 100ms
- **p99 latency:** < 500ms
- **Error rate:** < 1%
- **Throughput:** 10K req/sec

### Chat Completions
- **p95 latency:** < 5s
- **p99 latency:** < 10s
- **Error rate:** < 2%
- **Throughput:** 1K concurrent requests

### Database Operations
- **Connection pool exhaustion:** Never
- **Query timeout rate:** < 0.1%
- **Deadlock rate:** 0%

---

## ðŸ“Š Running Load Tests

### Local Testing (Development)

```bash
# Start API locally
cd api
npm run dev

# In another terminal
cd api/tests/load
k6 run auth-load-test.js -e API_URL=http://localhost:3000
```

### Staging Environment

```bash
# Get staging API key
export TEST_API_KEY=$(gcloud secrets versions access latest --secret="ailin-staging-test-key")

# Run against staging
k6 run auth-load-test.js \
  -e API_URL=https://staging.example.com \
  -e TEST_API_KEY=$TEST_API_KEY
```

### Production Load Test (Careful!)

âš ï¸ **Warning:** Only run during low-traffic periods with proper monitoring.

```bash
# Get production test key (read-only)
export TEST_API_KEY=$(gcloud secrets versions access latest --secret="ailin-production-loadtest-key")

# Run with reduced load
k6 run auth-load-test.js \
  -e API_URL=https://api.ailin.one \
  -e TEST_API_KEY=$TEST_API_KEY \
  --vus 100 \
  --duration 2m
```

---

## ðŸ“ˆ Interpreting Results

### Successful Test Output

```
âœ“ api key auth status 200
âœ“ api key auth latency < 100ms

http_req_duration..........: avg=45ms  min=10ms med=40ms max=250ms p(95)=85ms  p(99)=150ms
http_req_failed............: 0.23%
http_reqs..................: 600000 (10000/s)
auth_errors................: 0.15%
successful_auths...........: 599100
```

**Interpretation:** âœ… PASS - All SLAs met

---

### Failed Test Output

```
âœ— api key auth latency < 100ms

http_req_duration..........: avg=850ms  min=100ms med=800ms max=5s  p(95)=1.2s p(99)=2.5s
http_req_failed............: 5.2%
auth_errors................: 4.8%
```

**Interpretation:** âŒ FAIL - Latency and error rate exceeded thresholds

**Actions:**
1. Check database connection pool size
2. Verify Redis cache is working
3. Check for slow queries (enable Prisma query logging)
4. Monitor CPU/Memory on Cloud Run instances

---

## ðŸ”§ Troubleshooting

### High Latency (p99 > 500ms)

**Possible Causes:**
- Database connection pool exhausted
- Slow bcrypt verification (too many rounds)
- Redis cache misses
- Network latency

**Diagnostics:**
```bash
# Check database connections
SELECT count(*) FROM pg_stat_activity WHERE datname = 'ailin_dev';

# Check slow queries
SELECT query, mean_exec_time, calls 
FROM pg_stat_statements 
ORDER BY mean_exec_time DESC 
LIMIT 10;

# Check Redis latency
redis-cli --latency
```

---

### High Error Rate (> 1%)

**Possible Causes:**
- Rate limiting triggered
- API key validation failures
- Database deadlocks
- Provider API failures

**Diagnostics:**
```bash
# Check Cloud Run logs
gcloud logging read "resource.type=cloud_run_revision \
  AND severity>=ERROR \
  AND timestamp>=\"$(date -u -d '5 minutes ago' +%Y-%m-%dT%H:%M:%SZ)\"" \
  --limit 100

# Check error distribution
gcloud logging read "resource.type=cloud_run_revision \
  AND severity>=ERROR" \
  --format="value(jsonPayload.error.code)" \
  | sort | uniq -c | sort -rn
```

---

## ðŸŽ¯ Benchmarking Baselines

### Expected Performance (Single Cloud Run Instance)

| Metric | Value |
|---|---|
| Auth requests/sec | 500-1000 |
| Chat completions/sec | 50-100 |
| p95 auth latency | 30-60ms |
| p99 auth latency | 100-200ms |
| p95 chat latency | 2-4s |
| p99 chat latency | 5-8s |

### Expected Performance (5 Instances, Load Balanced)

| Metric | Value |
|---|---|
| Auth requests/sec | 2500-5000 |
| Chat completions/sec | 250-500 |
| Error rate | < 0.5% |

---

## ðŸ“Š Continuous Load Testing

### CI/CD Integration

Add to GitHub Actions or Cloud Build:

```yaml
# .github/workflows/load-test.yml
name: Weekly Load Test
on:
  schedule:
    - cron: '0 2 * * 0' # Every Sunday at 2 AM UTC
  workflow_dispatch:

jobs:
  load-test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v3
      
      - name: Install k6
        run: |
          sudo gpg -k
          sudo gpg --no-default-keyring --keyring /usr/share/keyrings/k6-archive-keyring.gpg --keyserver hkp://keyserver.ubuntu.com:80 --recv-keys C5AD17C747E3415A3642D57D77C6C491D6AC1D69
          echo "deb [signed-by=/usr/share/keyrings/k6-archive-keyring.gpg] https://dl.k6.io/deb stable main" | sudo tee /etc/apt/sources.list.d/k6.list
          sudo apt-get update
          sudo apt-get install k6
      
      - name: Run load tests
        run: |
          cd api/tests/load
          k6 run auth-load-test.js -e API_URL=${{ secrets.STAGING_API_URL }} -e TEST_API_KEY=${{ secrets.STAGING_TEST_KEY }}
      
      - name: Upload results
        if: always()
        uses: actions/upload-artifact@v3
        with:
          name: load-test-results
          path: api/tests/load/results.json
```

---

## ðŸš€ Scaling Recommendations

Based on load test results:

### If p95 latency > 100ms:
- Increase Cloud Run CPU allocation
- Add more instances (min-instances)
- Optimize database queries

### If error rate > 1%:
- Check rate limiting configuration
- Increase connection pool size
- Add circuit breakers

### If throughput < target:
- Scale horizontally (more instances)
- Use Cloud Run gen2 (better performance)
- Consider caching layer optimization

---

## ðŸ“š Resources

- [k6 Documentation](https://k6.io/docs/)
- [k6 Best Practices](https://k6.io/docs/misc/best-practices/)
- [Grafana Cloud k6](https://grafana.com/products/cloud/k6/) (for advanced metrics)


