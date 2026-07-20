// Copyright (C) 2026 Ailin One, Inc.
//
// This file is part of Collective Intelligence Engine (ci).
// Licensed under the GNU Affero General Public License v3.0 or later.
// See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.
//
// SPDX-License-Identifier: AGPL-3.0-or-later
// Source: https://github.com/ailinone/collective-intelligence

/**
 * Benchmark Suite
 *
 * 70 representative tasks across 12 categories, covering the full range of
 * CI/API usage patterns. Each task includes evaluation criteria, acceptable
 * strategies, and cost/latency bounds.
 *
 * Design principles:
 * - Tasks are deterministic (same prompt always) for reproducibility
 * - Each task has a clear, measurable evaluation method
 * - Categories cover the real traffic mix of an LLM orchestrator
 * - Difficulty distribution: 30% easy, 40% medium, 30% hard
 */

import type { BenchmarkTask, BenchmarkCategory, BenchmarkDifficulty } from './types';

// ─── CODING: GENERATION (8 tasks) ───────────────────────────────────────────

const codingGenerate: BenchmarkTask[] = [
  {
    id: 'cg-001',
    name: 'TypeScript debounce with generics',
    category: 'coding-generate',
    difficulty: 'medium',
    prompt: 'Write a TypeScript debounce function with generics. Signature: debounce<T extends (...args: unknown[]) => void>(fn: T, ms: number): T. Include proper cleanup.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Correct TypeScript generics, setTimeout/clearTimeout, returns wrapper, handles this context.',
    checklistItems: [
      'Uses setTimeout and clearTimeout',
      'Returns a function with the same signature as input',
      'Handles generic type T correctly',
      'Includes timer cleanup mechanism',
    ],
    strategies: ['single', 'quality-multipass'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.05,
  },
  {
    id: 'cg-002',
    name: 'Python binary search with edge cases',
    category: 'coding-generate',
    difficulty: 'easy',
    prompt: 'Write a Python function binary_search(arr: list[int], target: int) -> int that returns the index of target or -1. Handle empty arrays and single-element arrays.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Correct binary search, handles edge cases, O(log n) complexity.',
    checklistItems: [
      'Implements correct binary search logic (not linear scan)',
      'Returns -1 when target not found',
      'Handles empty array',
      'Handles single-element array',
    ],
    strategies: ['single'],
    maxLatencyMs: 10000,
    maxCostUsd: 0.02,
  },
  {
    id: 'cg-003',
    name: 'React hook with cleanup',
    category: 'coding-generate',
    difficulty: 'medium',
    prompt: 'Write a React custom hook useInterval(callback, delay) that calls callback at delay intervals, handles cleanup on unmount, and pauses when delay is null.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Correct useEffect with cleanup, useRef for callback, handles null delay.',
    checklistItems: [
      'Uses useEffect with proper cleanup (clearInterval)',
      'Uses useRef to store latest callback',
      'Pauses when delay is null',
      'Does not cause stale closure issues',
    ],
    strategies: ['single', 'collaborative'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.05,
  },
  {
    id: 'cg-004',
    name: 'Go concurrent-safe LRU cache',
    category: 'coding-generate',
    difficulty: 'hard',
    prompt: 'Implement a concurrent-safe LRU cache in Go with Get(key) and Put(key, value) operations. Use sync.Mutex and container/list. Include a capacity limit.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Correct LRU eviction, thread-safe with mutex, uses doubly-linked list + hashmap.',
    checklistItems: [
      'Uses sync.Mutex or sync.RWMutex for thread safety',
      'Implements LRU eviction when capacity exceeded',
      'Uses container/list for O(1) reordering',
      'Uses map for O(1) lookup',
      'Get promotes accessed entry to front',
    ],
    strategies: ['single', 'quality-multipass'],
    maxLatencyMs: 20000,
    maxCostUsd: 0.08,
  },
  {
    id: 'cg-005',
    name: 'SQL query with window functions',
    category: 'coding-generate',
    difficulty: 'medium',
    prompt: 'Write a SQL query (PostgreSQL) that returns the top 3 products by revenue per category, with rank, using window functions. Tables: products(id, name, category_id, price), orders(id, product_id, quantity).',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Uses ROW_NUMBER or RANK window function, correct JOIN, filters top 3.',
    checklistItems: [
      'Uses ROW_NUMBER() or RANK() window function',
      'Partitions by category',
      'Orders by revenue (price * quantity sum)',
      'Filters to top 3 per category',
      'JOINs products and orders correctly',
    ],
    strategies: ['single'],
    maxLatencyMs: 10000,
    maxCostUsd: 0.02,
  },
  {
    id: 'cg-006',
    name: 'Rust error handling with Result',
    category: 'coding-generate',
    difficulty: 'hard',
    prompt: 'Write a Rust function that reads a JSON config file, parses it into a Config struct, and validates fields. Use proper error handling with custom error types and the ? operator. Config: { port: u16, host: String, database_url: String }.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Custom error enum, impl From for error conversion, uses ? operator, proper validation.',
    checklistItems: [
      'Defines custom error enum or uses thiserror',
      'Uses ? operator for error propagation',
      'Implements From trait for error conversion',
      'Validates config fields (port range, non-empty strings)',
      'Returns Result<Config, ConfigError>',
    ],
    strategies: ['single', 'quality-multipass'],
    maxLatencyMs: 20000,
    maxCostUsd: 0.08,
  },
  {
    id: 'cg-007',
    name: 'Express middleware chain',
    category: 'coding-generate',
    difficulty: 'easy',
    prompt: 'Write a Node.js Express middleware that: 1) logs request method+path, 2) adds X-Request-Id header from UUID, 3) measures response time and logs it.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Three middleware functions, UUID generation, timing with res.on finish.',
    checklistItems: [
      'Logs HTTP method and path',
      'Generates UUID for X-Request-Id',
      'Measures response time',
      'Calls next() properly',
    ],
    strategies: ['single'],
    maxLatencyMs: 10000,
    maxCostUsd: 0.02,
  },
  {
    id: 'cg-008',
    name: 'TypeScript state machine',
    category: 'coding-generate',
    difficulty: 'hard',
    prompt: 'Implement a type-safe finite state machine in TypeScript for an order lifecycle: created → confirmed → shipped → delivered, with cancel possible from created/confirmed. Use discriminated unions and ensure invalid transitions are compile-time errors.',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Uses discriminated unions or branded types to make invalid transitions impossible at compile time. Covers all valid transitions and prevents invalid ones. Type-safe, no runtime-only checks.',
    strategies: ['single', 'quality-multipass', 'debate'],
    maxLatencyMs: 20000,
    maxCostUsd: 0.10,
  },
];

// ─── CODING: EDIT/REFACTOR (5 tasks) ────────────────────────────────────────

const codingEdit: BenchmarkTask[] = [
  {
    id: 'ce-001',
    name: 'Refactor callback hell to async/await',
    category: 'coding-edit',
    difficulty: 'medium',
    prompt: 'Refactor this callback-based Node.js code to async/await:\n```js\nfs.readFile("config.json", (err, data) => {\n  if (err) { console.error(err); return; }\n  const config = JSON.parse(data);\n  db.connect(config.dbUrl, (err, conn) => {\n    if (err) { console.error(err); return; }\n    conn.query("SELECT * FROM users", (err, rows) => {\n      if (err) { console.error(err); return; }\n      rows.forEach(row => {\n        sendEmail(row.email, "Hello", (err) => {\n          if (err) console.error(err);\n        });\n      });\n    });\n  });\n});\n```\nProvide the refactored version as a unified diff.',
    evaluationMethod: 'composite',
    judgeRubric: 'Uses async/await, proper try/catch, handles all errors, maintains same logic. Provides output as diff format.',
    checklistItems: [
      'Uses async/await syntax',
      'Has try/catch for error handling',
      'Uses fs.promises or util.promisify',
      'Handles sendEmail errors (Promise.allSettled or similar)',
    ],
    strategies: ['single', 'collaborative'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.05,
  },
  {
    id: 'ce-002',
    name: 'Extract function from long method',
    category: 'coding-edit',
    difficulty: 'easy',
    prompt: 'This function is too long. Extract the validation logic into a separate function:\n```python\ndef process_order(order):\n    # Validation\n    if not order.get("items"):\n        raise ValueError("Order must have items")\n    if order["total"] < 0:\n        raise ValueError("Total cannot be negative")\n    if len(order["items"]) > 100:\n        raise ValueError("Too many items")\n    for item in order["items"]:\n        if item["quantity"] < 1:\n            raise ValueError(f"Invalid quantity for {item[\'name\']}")\n        if item["price"] < 0:\n            raise ValueError(f"Invalid price for {item[\'name\']}")\n    # Processing\n    order["status"] = "confirmed"\n    order["confirmed_at"] = datetime.now()\n    db.save(order)\n    notify_warehouse(order)\n    return order\n```',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Extracts validation into validate_order(), keeps process_order clean, preserves all checks.',
    checklistItems: [
      'Creates a separate validate_order function',
      'Moves all validation logic to the new function',
      'Calls validate_order from process_order',
      'Preserves all validation rules',
    ],
    strategies: ['single'],
    maxLatencyMs: 10000,
    maxCostUsd: 0.02,
  },
  {
    id: 'ce-003',
    name: 'Add TypeScript types to untyped JS',
    category: 'coding-edit',
    difficulty: 'medium',
    prompt: 'Add TypeScript types to this JavaScript code. Define interfaces for all data structures:\n```js\nfunction processUsers(users) {\n  return users\n    .filter(u => u.active && u.age >= 18)\n    .map(u => ({\n      fullName: `${u.firstName} ${u.lastName}`,\n      email: u.email,\n      tier: u.purchases > 100 ? "gold" : u.purchases > 50 ? "silver" : "bronze"\n    }))\n    .sort((a, b) => a.fullName.localeCompare(b.fullName));\n}\n```',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Defines User interface, ProcessedUser interface, proper return type, uses string literal union for tier.',
    checklistItems: [
      'Defines User input interface with all fields typed',
      'Defines output interface with fullName, email, tier',
      'Uses string literal union type for tier ("gold" | "silver" | "bronze")',
      'Function has explicit parameter and return types',
    ],
    strategies: ['single'],
    maxLatencyMs: 10000,
    maxCostUsd: 0.03,
  },
  {
    id: 'ce-004',
    name: 'Fix N+1 query in ORM code',
    category: 'coding-edit',
    difficulty: 'hard',
    prompt: 'This Prisma code has an N+1 query problem. Fix it:\n```typescript\nasync function getUsersWithOrders() {\n  const users = await prisma.user.findMany();\n  const result = [];\n  for (const user of users) {\n    const orders = await prisma.order.findMany({ where: { userId: user.id } });\n    const totalSpent = orders.reduce((sum, o) => sum + o.amount, 0);\n    result.push({ ...user, orders, totalSpent });\n  }\n  return result;\n}\n```',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Uses Prisma include or a single query with aggregation. Eliminates the loop of queries.',
    checklistItems: [
      'Eliminates the for loop with individual queries',
      'Uses include/join or a single aggregated query',
      'Preserves the totalSpent calculation',
      'Result format remains compatible',
    ],
    strategies: ['single', 'collaborative'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.05,
  },
  {
    id: 'ce-005',
    name: 'Convert class to functional with hooks',
    category: 'coding-edit',
    difficulty: 'medium',
    prompt: 'Convert this React class component to a functional component with hooks:\n```jsx\nclass Timer extends React.Component {\n  state = { seconds: 0, isRunning: false };\n  intervalId = null;\n  componentWillUnmount() { clearInterval(this.intervalId); }\n  start = () => {\n    this.setState({ isRunning: true });\n    this.intervalId = setInterval(() => this.setState(s => ({ seconds: s.seconds + 1 })), 1000);\n  };\n  stop = () => { clearInterval(this.intervalId); this.setState({ isRunning: false }); };\n  reset = () => { this.stop(); this.setState({ seconds: 0 }); };\n  render() {\n    return (<div><p>{this.state.seconds}s</p>\n      <button onClick={this.start} disabled={this.state.isRunning}>Start</button>\n      <button onClick={this.stop} disabled={!this.state.isRunning}>Stop</button>\n      <button onClick={this.reset}>Reset</button></div>);\n  }\n}\n```',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Uses useState, useEffect for cleanup, useRef for interval, useCallback for handlers.',
    checklistItems: [
      'Uses useState for seconds and isRunning',
      'Uses useEffect with cleanup for interval',
      'Uses useRef for intervalId',
      'Preserves start/stop/reset functionality',
    ],
    strategies: ['single'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.03,
  },
];

// ─── CODING: DEBUG (5 tasks) ────────────────────────────────────────────────

const codingDebug: BenchmarkTask[] = [
  {
    id: 'cd-001',
    name: 'Memory leak in EventEmitter',
    category: 'coding-debug',
    difficulty: 'medium',
    prompt: 'Debug this Node.js memory leak:\n```js\nconst ee = new EventEmitter();\nsetInterval(() => { ee.on("data", (d) => console.log(d)); }, 1000);\n```\nExplain the root cause and provide a fix.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Identifies listener accumulation, explains the mechanism, provides fix.',
    checklistItems: [
      'Identifies that listeners accumulate without removal',
      'Explains that each interval adds a new listener',
      'Provides fix (once, removeListener, or move outside interval)',
    ],
    strategies: ['single', 'collaborative'],
    maxLatencyMs: 10000,
    maxCostUsd: 0.03,
  },
  {
    id: 'cd-002',
    name: 'Race condition in async code',
    category: 'coding-debug',
    difficulty: 'hard',
    prompt: 'This code has a race condition. Find it and fix it:\n```typescript\nlet balance = 100;\nasync function withdraw(amount: number) {\n  if (balance >= amount) {\n    await simulateNetworkDelay();\n    balance -= amount;\n    return { success: true, balance };\n  }\n  return { success: false, balance };\n}\n// Two simultaneous withdrawals of 80\nPromise.all([withdraw(80), withdraw(80)]).then(console.log);\n```',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Identifies TOCTOU race condition, explains interleaving, provides mutex or atomic fix.',
    checklistItems: [
      'Identifies the check-then-act (TOCTOU) race condition',
      'Explains that both checks pass before either deduction',
      'Provides a synchronization fix (mutex, lock, or atomic operation)',
    ],
    strategies: ['single', 'debate'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.05,
  },
  {
    id: 'cd-003',
    name: 'Off-by-one in pagination',
    category: 'coding-debug',
    difficulty: 'easy',
    prompt: 'This pagination has a bug. Users report missing items. Find and fix it:\n```python\ndef get_page(items, page, page_size=10):\n    start = page * page_size\n    end = start + page_size - 1\n    return items[start:end]\n```',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Identifies that slice end is exclusive in Python so -1 drops last item.',
    checklistItems: [
      'Identifies that Python slice end is exclusive',
      'Removes the -1 from end calculation',
      'Explains that items[start:end] already excludes end index',
    ],
    strategies: ['single'],
    maxLatencyMs: 8000,
    maxCostUsd: 0.01,
  },
  {
    id: 'cd-004',
    name: 'SQL injection vulnerability',
    category: 'coding-debug',
    difficulty: 'medium',
    prompt: 'Review this auth code for security vulnerabilities and fix all issues:\n```js\nconst q = `SELECT * FROM users WHERE username = \'${username}\' AND password = \'${password}\'`;\nconst token = jwt.sign({ userId: results[0].id }, \'secret123\');\nres.cookie(\'session\', token);\n```',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Identifies SQL injection, hardcoded secret, missing JWT expiry, plain password comparison, insecure cookie.',
    checklistItems: [
      'Identifies SQL injection vulnerability',
      'Identifies hardcoded JWT secret',
      'Identifies missing JWT expiry',
      'Provides parameterized query fix',
      'Recommends password hashing (bcrypt)',
    ],
    strategies: ['single', 'debate'],
    maxLatencyMs: 12000,
    maxCostUsd: 0.04,
  },
  {
    id: 'cd-005',
    name: 'Infinite re-render in React',
    category: 'coding-debug',
    difficulty: 'medium',
    prompt: 'This React component causes an infinite re-render loop. Find the bug:\n```jsx\nfunction UserProfile({ userId }) {\n  const [user, setUser] = useState(null);\n  useEffect(() => {\n    fetch(`/api/users/${userId}`).then(r => r.json()).then(setUser);\n  });\n  return user ? <div>{user.name}</div> : <div>Loading...</div>;\n}\n```',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Identifies missing dependency array in useEffect.',
    checklistItems: [
      'Identifies missing dependency array in useEffect',
      'Explains the re-render loop mechanism',
      'Provides fix: add [userId] dependency array',
    ],
    strategies: ['single'],
    maxLatencyMs: 8000,
    maxCostUsd: 0.02,
  },
];

// ─── CODING: REVIEW (4 tasks) ───────────────────────────────────────────────

const codingReview: BenchmarkTask[] = [
  {
    id: 'cr-001',
    name: 'Review PR for performance issues',
    category: 'coding-review',
    difficulty: 'hard',
    prompt: 'Review this code for performance issues:\n```python\ndef find_duplicates(items):\n    duplicates = []\n    for i in range(len(items)):\n        for j in range(i + 1, len(items)):\n            if items[i] == items[j] and items[i] not in duplicates:\n                duplicates.append(items[i])\n    return duplicates\n\ndef process_large_dataset(data):\n    results = []\n    for item in data:\n        result = expensive_transform(item)\n        results.append(result)\n    filtered = [r for r in results if r["score"] > 0.5]\n    sorted_results = sorted(filtered, key=lambda x: x["score"], reverse=True)\n    return sorted_results[:10]\n```',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Identifies O(n²) in find_duplicates, suggests set. Identifies eager evaluation in process_large_dataset, suggests generator/early termination.',
    checklistItems: [
      'Identifies O(n²) complexity in find_duplicates',
      'Suggests using a set for O(n) deduplication',
      'Identifies unnecessary full list processing in process_large_dataset',
      'Suggests early termination or generator pattern',
    ],
    strategies: ['single', 'debate'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.05,
  },
  {
    id: 'cr-002',
    name: 'Review error handling patterns',
    category: 'coding-review',
    difficulty: 'medium',
    prompt: 'Review the error handling in this Express route:\n```typescript\napp.post("/api/users", async (req, res) => {\n  try {\n    const user = await db.users.create(req.body);\n    const token = generateToken(user);\n    await sendWelcomeEmail(user.email);\n    res.json({ user, token });\n  } catch (e) {\n    res.status(500).json({ error: e.message });\n  }\n});\n```',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Input validation missing, email failure blocks response, error leaks internal details, no specific HTTP status codes.',
    checklistItems: [
      'Identifies missing input validation',
      'Identifies that email failure blocks the response',
      'Identifies error message leaking internal details',
      'Suggests more specific HTTP status codes',
    ],
    strategies: ['single'],
    maxLatencyMs: 12000,
    maxCostUsd: 0.03,
  },
  {
    id: 'cr-003',
    name: 'Review API design',
    category: 'coding-review',
    difficulty: 'hard',
    prompt: 'Review this REST API design for a task management system:\n```\nPOST /createTask          { title, assignee, dueDate }\nGET  /getTaskById/:id\nPOST /updateTaskStatus    { id, status }\nGET  /getAllTasks?user=X\nPOST /deleteTask          { id }\nGET  /getTasksByStatus/:status\n```\nIdentify design issues and suggest improvements following REST conventions.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Identifies verb-in-URL anti-pattern, wrong HTTP methods, inconsistent naming, missing HATEOAS basics.',
    checklistItems: [
      'Identifies verbs in URLs (createTask, getTaskById, etc.)',
      'Suggests resource-based URLs (/tasks, /tasks/:id)',
      'Identifies wrong HTTP methods (POST for delete)',
      'Suggests proper HTTP methods (PUT/PATCH for update, DELETE for delete)',
    ],
    strategies: ['single'],
    maxLatencyMs: 10000,
    maxCostUsd: 0.03,
  },
  {
    id: 'cr-004',
    name: 'Review TypeScript types for correctness',
    category: 'coding-review',
    difficulty: 'medium',
    // The `data: any` below is INSIDE the benchmark prompt string: it is the planted
    // flaw task cr-004 asks the reviewed model to identify (see judgeRubric).
    // ts-safety-ignore-next-line -- literal 'any' in prompt payload, not a type
    prompt: 'Review these TypeScript types for correctness and safety:\n```typescript\ninterface ApiResponse {\n  data: any;\n  status: number;\n  error: string;\n}\nfunction fetchUser(id: string | number): Promise<ApiResponse> {\n  return fetch(`/api/users/${id}`).then(r => r.json());\n}\nfunction getUserName(response: ApiResponse): string {\n  return response.data.user.name;\n}\n```',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Identifies any type, unsafe property access chain, missing error handling, error should be optional.',
    checklistItems: [
      'Identifies use of any type (should be generic or specific)',
      'Identifies unsafe deep property access without null checks',
      'Identifies that error should be optional (not all responses have errors)',
      'Suggests generic ApiResponse<T> pattern',
    ],
    strategies: ['single'],
    maxLatencyMs: 10000,
    maxCostUsd: 0.03,
  },
];

// ─── ANALYSIS: TECHNICAL (6 tasks) ──────────────────────────────────────────

const analysisTechnical: BenchmarkTask[] = [
  {
    id: 'at-001',
    name: 'Event Sourcing vs CRUD for financial system',
    category: 'analysis-technical',
    difficulty: 'hard',
    prompt: 'Compare Event Sourcing+CQRS vs Traditional CRUD for a financial system: 50k TPS, audit trail required, 90% reads. Recommend with rationale.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Covers TPS implications, audit comparison, read/write ratio, makes concrete recommendation.',
    checklistItems: [
      'Discusses 50k TPS feasibility for each approach',
      'Explains how Event Sourcing provides natural audit trail',
      'Analyzes 90% read ratio impact (CQRS read model advantage)',
      'Makes a concrete recommendation with rationale',
    ],
    strategies: ['single', 'consensus', 'debate'],
    maxLatencyMs: 20000,
    maxCostUsd: 0.10,
  },
  {
    id: 'at-002',
    name: 'Microservices communication patterns',
    category: 'analysis-technical',
    difficulty: 'medium',
    prompt: 'An e-commerce platform has: Order Service, Inventory Service, Payment Service, Notification Service. A user places an order which needs to: (1) check inventory, (2) process payment, (3) reserve inventory, (4) send confirmation. Compare Saga pattern vs Two-Phase Commit for this flow. Which would you recommend and why?',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Explains both patterns, discusses failure modes, latency implications, consistency guarantees. Makes a reasoned recommendation for Saga with compensating transactions.',
    strategies: ['single', 'debate'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.06,
  },
  {
    id: 'at-003',
    name: 'Database sharding strategy',
    category: 'analysis-technical',
    difficulty: 'hard',
    prompt: 'A SaaS platform has 10M users across 5000 organizations. Some organizations have 500K users, most have <100. Design a sharding strategy for the users table. Consider: query patterns (90% queries filter by org_id), cross-org analytics needs, hot-spot prevention.',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Proposes tenant-based sharding with consistent hashing, addresses hot-spot from large orgs, discusses cross-shard queries for analytics, mentions rebalancing strategy.',
    strategies: ['single', 'debate'],
    maxLatencyMs: 20000,
    maxCostUsd: 0.08,
  },
  {
    id: 'at-004',
    name: 'Choose message broker',
    category: 'analysis-technical',
    difficulty: 'medium',
    prompt: 'Compare Kafka vs RabbitMQ vs Redis Streams for a real-time analytics pipeline that processes 100K events/sec, needs at-least-once delivery, 7-day retention, and consumer groups. Recommend one.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Compares throughput, retention, delivery guarantees, consumer groups for each.',
    checklistItems: [
      'Discusses throughput capabilities for 100K events/sec',
      'Compares retention mechanisms (Kafka log vs RabbitMQ TTL vs Redis maxlen)',
      'Compares consumer group support',
      'Makes a concrete recommendation (likely Kafka for this use case)',
    ],
    strategies: ['single'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.05,
  },
  {
    id: 'at-005',
    name: 'Kubernetes autoscaling strategy',
    category: 'analysis-technical',
    difficulty: 'medium',
    prompt: 'Design an autoscaling strategy for a REST API on Kubernetes that handles: baseline 100 req/s, spikes to 10K req/s within 30 seconds, cold-start penalty of 15 seconds per pod. Current setup: 5 pods, 2 CPU each. What scaling approach would you use?',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Discusses HPA with custom metrics, pre-warming, KEDA, buffer capacity, mentions cold-start mitigation strategies.',
    strategies: ['single'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.05,
  },
  {
    id: 'at-006',
    name: 'CAP theorem application',
    category: 'analysis-technical',
    difficulty: 'easy',
    prompt: 'Explain how the CAP theorem applies to designing a global user session store. The system must support users across US, EU, and Asia. Each user session must be accessible from any region. Session data includes: userId, permissions, preferences, lastActive. What trade-offs would you make?',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Correctly states CAP theorem, identifies partition tolerance as non-negotiable, discusses AP vs CP trade-off for sessions, suggests eventual consistency as likely best fit.',
    strategies: ['single'],
    maxLatencyMs: 12000,
    maxCostUsd: 0.04,
  },
];

// ─── ANALYSIS: DATA (4 tasks) ───────────────────────────────────────────────

const analysisData: BenchmarkTask[] = [
  {
    id: 'ad-001',
    name: 'Explain anomaly in metrics',
    category: 'analysis-data',
    difficulty: 'medium',
    prompt: 'Our API metrics show: p50 latency dropped from 200ms to 50ms, but p99 increased from 500ms to 3000ms. Error rate stayed at 0.1%. This happened after deploying a new caching layer. What are the most likely explanations?',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Cache hits explain p50 drop, cache misses now slower (cache check + miss + backend), bimodal distribution.',
    checklistItems: [
      'Identifies cache hits reducing p50 dramatically',
      'Identifies cache misses adding latency overhead',
      'Explains bimodal latency distribution',
    ],
    strategies: ['single'],
    maxLatencyMs: 12000,
    maxCostUsd: 0.04,
  },
  {
    id: 'ad-002',
    name: 'Design A/B test',
    category: 'analysis-data',
    difficulty: 'hard',
    prompt: 'Design an A/B test for changing the checkout flow from 3 pages to 1 page. Current conversion rate: 3.2%. Minimum detectable effect: 0.3pp. Daily checkout starts: 50K. Define: sample size, duration, metrics, guardrail metrics, and analysis plan.',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Calculates sample size (~500K per arm at 80% power), defines primary metric (conversion rate), secondary metrics, guardrail metrics (revenue per visitor), statistical test, and duration.',
    strategies: ['single', 'debate'],
    maxLatencyMs: 20000,
    maxCostUsd: 0.08,
  },
  {
    id: 'ad-003',
    name: 'Interpret confusion matrix',
    category: 'analysis-data',
    difficulty: 'easy',
    prompt: 'A fraud detection model has these results on 10,000 transactions:\n- True Positives: 45\n- False Positives: 150\n- True Negatives: 9,755\n- False Negatives: 50\n\nCalculate precision, recall, F1, and accuracy. Is this model good for production fraud detection? Why or why not?',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Correct calculations, discusses precision vs recall trade-off for fraud, identifies high FN rate as critical issue.',
    checklistItems: [
      'Calculates precision correctly (45/195 ≈ 0.231)',
      'Calculates recall correctly (45/95 ≈ 0.474)',
      'Discusses that high accuracy (98%) is misleading due to class imbalance',
      'Identifies that missing 50 frauds (52.6% miss rate) is problematic for fraud detection',
    ],
    strategies: ['single'],
    maxLatencyMs: 12000,
    maxCostUsd: 0.03,
  },
  {
    id: 'ad-004',
    name: 'Time series anomaly explanation',
    category: 'analysis-data',
    difficulty: 'medium',
    prompt: 'Monthly active users (MAU) for a B2B SaaS: Jan: 10K, Feb: 11K, Mar: 12K, Apr: 15K, May: 14K, Jun: 22K, Jul: 21K, Aug: 20K, Sep: 19K, Oct: 25K, Nov: 23K, Dec: 18K. Identify patterns, explain the Jun spike, and explain the Dec drop. Suggest what data you would need to confirm your hypotheses.',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Identifies general upward trend, Jun spike (possible product launch or marketing), Dec drop (holiday effect for B2B), suggests additional data needed.',
    strategies: ['single'],
    maxLatencyMs: 12000,
    maxCostUsd: 0.04,
  },
];

// ─── ANALYSIS: TEXT (3 tasks) ───────────────────────────────────────────────

const analysisText: BenchmarkTask[] = [
  {
    id: 'ax-001',
    name: 'Summarize technical RFC',
    category: 'analysis-text',
    difficulty: 'medium',
    prompt: 'Summarize the key points of this RFC in 5 bullet points:\n\nRFC: We propose migrating from monolithic PostgreSQL to a distributed architecture using CockroachDB for OLTP and ClickHouse for analytics. The current system handles 5K TPS but is projected to need 50K TPS within 18 months. PostgreSQL read replicas are at 80% capacity. Our analytics queries (dashboards, reports) compete with OLTP for resources, causing p99 latency spikes during business hours. The migration would be phased: Phase 1 (3 months) — set up CockroachDB cluster and migrate core tables. Phase 2 (2 months) — implement CDC pipeline from CockroachDB to ClickHouse. Phase 3 (1 month) — migrate analytics queries. Risks: distributed transactions add 10-20ms overhead, CockroachDB has limited JSON support compared to PostgreSQL, team has no distributed database experience. Cost: $15K/month additional infrastructure, $50K training budget. Expected benefits: linear horizontal scaling, sub-second analytics, eliminated read replica bottleneck.',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Five concise bullet points covering: motivation (5K→50K TPS, resource contention), solution (CockroachDB+ClickHouse), phases (3 phases/6 months), risks (latency, team skill, JSON), cost-benefit.',
    strategies: ['single'],
    maxLatencyMs: 10000,
    maxCostUsd: 0.03,
  },
  {
    id: 'ax-002',
    name: 'Extract requirements from conversation',
    category: 'analysis-text',
    difficulty: 'hard',
    prompt: 'Extract structured requirements from this stakeholder conversation:\n\nPM: "We need the dashboard to update in real-time, like within a second."\nEngineer: "WebSockets or SSE?"\nPM: "Whatever works, but it needs to show 50 concurrent users the same data."\nCTO: "Security is key — only admins should see financial data, regular users see operational metrics only."\nPM: "Oh, and it needs to work on mobile. Our field team uses tablets."\nEngineer: "What about offline support?"\nPM: "Not required now, but nice to have. Phase 2 maybe."\nCTO: "We need this by end of Q2. And it should integrate with our existing Grafana for the ops team."\n\nOutput: Functional requirements, non-functional requirements, constraints, and out-of-scope items.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Structured extraction with FR, NFR, constraints, and out-of-scope clearly separated.',
    checklistItems: [
      'Lists real-time updates (<1s) as functional requirement',
      'Lists RBAC (admin vs regular) as security requirement',
      'Lists mobile/tablet support as non-functional requirement',
      'Lists Grafana integration as constraint',
      'Lists offline support as out-of-scope/Phase 2',
      'Lists Q2 deadline as constraint',
    ],
    strategies: ['single', 'collaborative'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.05,
  },
  {
    id: 'ax-003',
    name: 'Compare two technical approaches',
    category: 'analysis-text',
    difficulty: 'easy',
    prompt: 'Compare GraphQL vs REST for a mobile app with: limited bandwidth, need for nested data (user → orders → items), 20+ screens with different data needs. Which would you recommend and why?',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Discusses over-fetching (REST disadvantage), query flexibility (GraphQL advantage), bandwidth savings, complexity trade-off. Makes concrete recommendation.',
    strategies: ['single'],
    maxLatencyMs: 12000,
    maxCostUsd: 0.04,
  },
];

// ─── FACTUAL QA (8 tasks) ───────────────────────────────────────────────────

const factualQA: BenchmarkTask[] = [
  {
    id: 'fq-001',
    name: 'HTTP status codes',
    category: 'factual-qa',
    difficulty: 'easy',
    prompt: 'What is the difference between HTTP 401 Unauthorized and 403 Forbidden? When should each be used?',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: '401 = not authenticated, 403 = authenticated but not authorized.',
    checklistItems: [
      '401 means the request lacks valid authentication credentials',
      '403 means the server understood the request but refuses to authorize it',
      '401 implies re-authentication might help',
      '403 implies even with valid credentials, access is denied',
    ],
    strategies: ['single'],
    maxLatencyMs: 8000,
    maxCostUsd: 0.01,
  },
  {
    id: 'fq-002',
    name: 'JavaScript event loop',
    category: 'factual-qa',
    difficulty: 'medium',
    prompt: 'Explain the JavaScript event loop. What is the difference between the microtask queue and the macrotask queue? Give an example showing their execution order.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Explains call stack, event loop, microtask queue (Promises), macrotask queue (setTimeout).',
    checklistItems: [
      'Explains the call stack concept',
      'Distinguishes microtask queue (Promises) from macrotask queue (setTimeout)',
      'States that microtasks execute before next macrotask',
      'Provides a code example demonstrating the execution order',
    ],
    strategies: ['single'],
    maxLatencyMs: 10000,
    maxCostUsd: 0.02,
  },
  {
    id: 'fq-003',
    name: 'ACID properties',
    category: 'factual-qa',
    difficulty: 'easy',
    prompt: 'What are the ACID properties in databases? Give a concrete example of each.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Correctly defines Atomicity, Consistency, Isolation, Durability with examples.',
    checklistItems: [
      'Defines Atomicity with example (bank transfer: both or neither)',
      'Defines Consistency with example (constraints, invariants)',
      'Defines Isolation with example (concurrent transactions)',
      'Defines Durability with example (data persists after crash)',
    ],
    strategies: ['single'],
    maxLatencyMs: 8000,
    maxCostUsd: 0.01,
  },
  {
    id: 'fq-004',
    name: 'OAuth2 flows comparison',
    category: 'factual-qa',
    difficulty: 'medium',
    prompt: 'Compare the OAuth2 Authorization Code flow vs Implicit flow vs Client Credentials flow. When should each be used? Which is deprecated and why?',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Correctly describes all three flows, when to use each, identifies Implicit as deprecated, explains PKCE.',
    checklistItems: [
      'Describes Authorization Code flow (server-side apps)',
      'Describes Client Credentials flow (machine-to-machine)',
      'Identifies Implicit flow as deprecated',
      'Mentions PKCE as the replacement for Implicit in SPAs',
    ],
    strategies: ['single'],
    maxLatencyMs: 10000,
    maxCostUsd: 0.02,
  },
  {
    id: 'fq-005',
    name: 'Docker networking modes',
    category: 'factual-qa',
    difficulty: 'easy',
    prompt: 'Explain the difference between Docker bridge, host, and none network modes. When would you use each?',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Correctly explains all three modes with use cases.',
    checklistItems: [
      'Explains bridge mode (default, isolated network)',
      'Explains host mode (shares host network stack)',
      'Explains none mode (no networking)',
      'Provides appropriate use case for each',
    ],
    strategies: ['single'],
    maxLatencyMs: 8000,
    maxCostUsd: 0.01,
  },
  {
    id: 'fq-006',
    name: 'Consensus algorithms comparison',
    category: 'factual-qa',
    difficulty: 'hard',
    prompt: 'Compare Raft vs Paxos vs PBFT consensus algorithms. What are the fault tolerance guarantees of each? Which is used in etcd/Kubernetes?',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Correctly describes all three, fault tolerance (f < n/2 for Raft/Paxos, f < n/3 for PBFT), identifies Raft in etcd.',
    checklistItems: [
      'Describes Raft as leader-based with understandable state machine replication',
      'Describes PBFT as Byzantine fault tolerant',
      'States correct fault tolerance bounds',
      'Identifies Raft as the algorithm used in etcd/Kubernetes',
    ],
    strategies: ['single'],
    maxLatencyMs: 12000,
    maxCostUsd: 0.03,
  },
  {
    id: 'fq-007',
    name: 'TypeScript utility types',
    category: 'factual-qa',
    difficulty: 'easy',
    prompt: 'Explain Pick, Omit, Partial, and Required TypeScript utility types with an example for each.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Correctly defines all four with code examples.',
    checklistItems: [
      'Defines Pick with code example',
      'Defines Omit with code example',
      'Defines Partial with code example',
      'Defines Required with code example',
    ],
    strategies: ['single'],
    maxLatencyMs: 8000,
    maxCostUsd: 0.02,
  },
  {
    id: 'fq-008',
    name: 'Git merge vs rebase',
    category: 'factual-qa',
    difficulty: 'easy',
    prompt: 'Explain the difference between git merge and git rebase. When should you use each? What are the dangers of rebasing?',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Merge preserves history, rebase rewrites, danger of rebasing shared branches.',
    checklistItems: [
      'Explains merge creates a merge commit preserving history',
      'Explains rebase replays commits for linear history',
      'Warns against rebasing shared/pushed branches',
      'Gives appropriate use case for each',
    ],
    strategies: ['single'],
    maxLatencyMs: 8000,
    maxCostUsd: 0.01,
  },
];

// ─── CREATIVE (6 tasks) ─────────────────────────────────────────────────────

const creative: BenchmarkTask[] = [
  {
    id: 'cv-001',
    name: 'Write API documentation',
    category: 'creative',
    difficulty: 'medium',
    prompt: 'Write API documentation for this endpoint:\n```\nPOST /v1/messages\nHeaders: Authorization: Bearer <token>\nBody: { "conversation_id": "string?", "content": "string", "attachments": [{ "type": "image|file", "url": "string" }]? }\nResponse: { "id": "string", "content": "string", "created_at": "ISO8601", "conversation_id": "string" }\nErrors: 400, 401, 413 (payload too large), 429\n```\nInclude description, parameters, examples, and error descriptions.',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Professional API documentation with: endpoint description, parameter table, request example, response example, error code descriptions.',
    strategies: ['single'],
    maxLatencyMs: 12000,
    maxCostUsd: 0.04,
  },
  {
    id: 'cv-002',
    name: 'Write commit messages for changes',
    category: 'creative',
    difficulty: 'easy',
    prompt: 'Write 5 good commit messages for these changes:\n1. Added input validation to user registration endpoint\n2. Fixed race condition in payment processing\n3. Migrated from Express to Fastify\n4. Added Redis caching layer for user sessions\n5. Removed deprecated v1 API endpoints',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Follows conventional commit format, imperative mood, concise but descriptive. Not generic.',
    strategies: ['single'],
    maxLatencyMs: 8000,
    maxCostUsd: 0.02,
  },
  {
    id: 'cv-003',
    name: 'Write error messages for UX',
    category: 'creative',
    difficulty: 'medium',
    prompt: 'Write user-friendly error messages for these technical errors:\n1. ECONNREFUSED (database connection failed)\n2. 413 Payload Too Large (file upload exceeded limit)\n3. JWT expired\n4. Rate limit exceeded (429)\n5. Concurrent modification conflict (optimistic locking failure)\n\nMessages should be helpful, non-technical, and include suggested actions.',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Messages are non-technical, helpful, include action suggestions, not blame-the-user tone.',
    strategies: ['single'],
    maxLatencyMs: 10000,
    maxCostUsd: 0.03,
  },
  {
    id: 'cv-004',
    name: 'Technical blog post outline',
    category: 'creative',
    difficulty: 'medium',
    prompt: 'Write an outline for a technical blog post titled "Why We Migrated from Microservices Back to a Modular Monolith". The audience is senior engineers. Include section titles, key points per section, and a compelling introduction paragraph.',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Structured outline with compelling intro, 4-6 sections, concrete technical points (not vague), contrarian but evidence-based tone.',
    strategies: ['single', 'debate'],
    maxLatencyMs: 12000,
    maxCostUsd: 0.04,
  },
  {
    id: 'cv-005',
    name: 'Incident postmortem',
    category: 'creative',
    difficulty: 'hard',
    prompt: 'Write an incident postmortem for this event:\n- Service: User Authentication API\n- Duration: 2h 15min (14:30 UTC to 16:45 UTC)\n- Impact: 100% of login attempts failed\n- Root cause: Expired TLS certificate on the auth service load balancer\n- Detection: PagerDuty alert from synthetic monitoring\n- Resolution: Certificate renewal + config update\n- Contributing factors: No cert expiry alerting, manual renewal process\n\nFollow the SRE postmortem format.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Standard SRE postmortem format with all required sections.',
    checklistItems: [
      'Includes timeline of events',
      'Clearly states root cause',
      'Lists contributing factors',
      'Includes action items with owners',
      'Includes lessons learned',
      'Blameless tone',
    ],
    strategies: ['single', 'collaborative'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.06,
  },
  {
    id: 'cv-006',
    name: 'Architecture Decision Record',
    category: 'creative',
    difficulty: 'hard',
    prompt: 'Write an ADR (Architecture Decision Record) for: choosing PostgreSQL over MongoDB for a new e-commerce platform. Context: team of 8 developers, 3 have MongoDB experience, complex product catalog with variants/pricing/inventory, ACID requirements for orders.',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Follows ADR format (Title, Status, Context, Decision, Consequences). Considers team experience, ACID needs, catalog complexity. Honest about trade-offs.',
    strategies: ['single', 'debate'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.06,
  },
];

// ─── MULTI-STEP (6 tasks) ───────────────────────────────────────────────────

const multiStep: BenchmarkTask[] = [
  {
    id: 'ms-001',
    name: 'Design → implement → test',
    category: 'multi-step',
    difficulty: 'hard',
    prompt: 'Complete these three steps:\n1. Design a rate limiter interface with token bucket algorithm\n2. Implement it in TypeScript\n3. Write 3 unit tests (using any framework) that verify: initial burst, steady-state, and exhaustion behavior',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'All three steps completed, implementation matches design, tests are runnable.',
    checklistItems: [
      'Provides clear interface/API design first',
      'Implements token bucket with refill logic',
      'Includes test for initial burst (allows burst up to capacity)',
      'Includes test for rate exhaustion (rejects after capacity)',
      'Includes test for refill (allows after waiting)',
    ],
    strategies: ['single', 'quality-multipass', 'collaborative'],
    maxLatencyMs: 25000,
    maxCostUsd: 0.15,
  },
  {
    id: 'ms-002',
    name: 'Analyze → diagnose → fix → verify',
    category: 'multi-step',
    difficulty: 'medium',
    prompt: 'Given this system behavior:\n- API response times: p50=200ms (normal), p99=15s (high)\n- CPU usage: 95% during peak\n- Memory: stable at 60%\n- Database: 500 slow queries/hour (>1s)\n- Cache hit rate: 20% (low)\n\nStep 1: Analyze and identify the top 3 most likely root causes\nStep 2: For each cause, propose a specific fix\nStep 3: For each fix, describe how to verify it worked',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Identifies root causes, proposes concrete fixes, describes verification for each.',
    checklistItems: [
      'Identifies slow database queries as a root cause',
      'Identifies low cache hit rate as contributing factor',
      'Proposes concrete fixes (query optimization, cache tuning)',
      'Describes verification metrics for each fix',
    ],
    strategies: ['single', 'collaborative'],
    maxLatencyMs: 20000,
    maxCostUsd: 0.08,
  },
  {
    id: 'ms-003',
    name: 'Plan migration steps',
    category: 'multi-step',
    difficulty: 'hard',
    prompt: 'Plan a zero-downtime migration from a single PostgreSQL instance to a PostgreSQL cluster with read replicas. Current: 1 primary, 500GB data, 2K TPS. Target: 1 primary + 3 read replicas. Include:\n1. Pre-migration checklist\n2. Step-by-step migration plan\n3. Rollback plan for each step\n4. Verification checklist',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Comprehensive plan with clear steps, each step has rollback, verification at each stage, addresses replication lag.',
    strategies: ['single', 'debate'],
    maxLatencyMs: 25000,
    maxCostUsd: 0.12,
  },
  {
    id: 'ms-004',
    name: 'Decompose and estimate',
    category: 'multi-step',
    difficulty: 'medium',
    prompt: 'A product manager asks: "How long to add real-time notifications to our web app?" Current stack: React frontend, Node.js backend, PostgreSQL. No existing real-time infrastructure.\n\nStep 1: List all required components\nStep 2: Estimate effort for each (in developer-days)\nStep 3: Identify dependencies between components\nStep 4: Propose a schedule for a team of 2 developers',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Lists components (WebSocket server, notification service, frontend integration, database schema, testing), estimates are reasonable, dependencies clear, schedule accounts for parallelism.',
    checklistItems: [
      'Lists WebSocket/SSE server as a component',
      'Lists notification persistence/schema',
      'Lists frontend notification UI',
      'Provides time estimates per component',
      'Shows dependency order (what blocks what)',
      'Proposes schedule with parallel work identified',
    ],
    strategies: ['single', 'collaborative'],
    maxLatencyMs: 18000,
    maxCostUsd: 0.06,
  },
  {
    id: 'ms-005',
    name: 'Code → document → deploy instructions',
    category: 'multi-step',
    difficulty: 'easy',
    prompt: 'Step 1: Write a simple health check endpoint in Express (GET /health that returns { status: "ok", uptime: process.uptime() })\nStep 2: Write the JSDoc documentation for it\nStep 3: Write the Dockerfile to containerize this single-file app',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'All three artifacts produced, Dockerfile is correct, JSDoc is complete.',
    checklistItems: [
      'Health endpoint returns JSON with status and uptime',
      'JSDoc includes endpoint description, method, path, response format',
      'Dockerfile uses Node.js base image',
      'Dockerfile copies files, installs deps, exposes port',
    ],
    strategies: ['single'],
    maxLatencyMs: 12000,
    maxCostUsd: 0.03,
  },
  {
    id: 'ms-006',
    name: 'Threat model → mitigations → implementation',
    category: 'multi-step',
    difficulty: 'hard',
    prompt: 'For a REST API that handles financial transactions:\nStep 1: Perform a STRIDE threat analysis (list at least 1 threat per STRIDE category)\nStep 2: For each threat, propose a specific mitigation\nStep 3: For the top 3 highest-risk mitigations, write pseudocode or configuration snippets showing implementation',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Covers all 6 STRIDE categories, concrete mitigations, implementation snippets for top 3.',
    checklistItems: [
      'Lists threat for Spoofing (e.g., credential theft)',
      'Lists threat for Tampering (e.g., request modification)',
      'Lists threat for Repudiation (e.g., transaction denial)',
      'Lists threat for Information Disclosure (e.g., data leak)',
      'Lists threat for Denial of Service',
      'Lists threat for Elevation of Privilege',
      'Provides implementation snippets for top 3 mitigations',
    ],
    strategies: ['single', 'debate', 'expert-panel'],
    maxLatencyMs: 25000,
    maxCostUsd: 0.12,
  },
];

// ─── REASONING (5 tasks) ────────────────────────────────────────────────────

const reasoning: BenchmarkTask[] = [
  {
    id: 'rs-001',
    name: 'System design trade-off analysis',
    category: 'reasoning',
    difficulty: 'hard',
    prompt: 'You are designing a URL shortener like bit.ly. Requirements: 100M new URLs/month, 10B redirects/month, 99.99% uptime, <50ms redirect latency globally. You must choose between:\nA) Single write-region with global read replicas\nB) Multi-region active-active with conflict resolution\n\nAnalyze each option across: complexity, latency, consistency, cost, and failure modes. Make a recommendation and explain your reasoning step by step.',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Systematic analysis of both options across all dimensions. Identifies key trade-off (write latency vs consistency). Makes reasoned recommendation with explicit reasoning chain.',
    strategies: ['single', 'debate'],
    maxLatencyMs: 20000,
    maxCostUsd: 0.10,
  },
  {
    id: 'rs-002',
    name: 'Logical deduction from constraints',
    category: 'reasoning',
    difficulty: 'medium',
    prompt: 'A company has 5 services: Auth, Users, Orders, Payments, Notifications. Constraints:\n1. Auth must start before Users and Payments\n2. Users must start before Orders\n3. Payments must start before Orders\n4. Orders must start before Notifications\n5. Auth and Payments cannot run on the same server\n6. Users and Orders must run on the same server\n7. There are exactly 3 servers available\n\nAssign services to servers and determine a valid startup order. Show your reasoning.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Valid assignment respecting all constraints, correct startup order, explicit reasoning.',
    checklistItems: [
      'Auth and Payments are on different servers',
      'Users and Orders are on the same server',
      'Startup order respects all dependencies',
      'All 5 services are assigned to exactly 3 servers',
      'Shows step-by-step reasoning',
    ],
    strategies: ['single', 'debate'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.06,
  },
  {
    id: 'rs-003',
    name: 'Cost optimization reasoning',
    category: 'reasoning',
    difficulty: 'medium',
    prompt: 'A startup spends $12K/month on AWS. Breakdown: EC2 $5K (10 m5.xlarge on-demand), RDS $3K (db.r5.2xlarge multi-AZ), S3 $1K (50TB), CloudFront $2K, NAT Gateway $1K. They need to cut to $8K/month without reducing capacity. What would you recommend and why? Show calculations.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Identifies specific savings, shows calculations, total reaches $8K target.',
    checklistItems: [
      'Recommends Reserved Instances or Savings Plans for EC2 (saves ~40%)',
      'Addresses NAT Gateway cost (suggests VPC endpoints or consolidation)',
      'Shows approximate savings calculations per service',
      'Total savings reach at least $4K/month',
    ],
    strategies: ['single'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.05,
  },
  {
    id: 'rs-004',
    name: 'Debugging by elimination',
    category: 'reasoning',
    difficulty: 'hard',
    prompt: 'Users report intermittent 500 errors on our API. Given:\n- Errors occur ~5% of requests\n- Only on POST /api/orders (other endpoints fine)\n- Started 3 days ago\n- No code deployments in last week\n- Errors are not correlated with time of day\n- Error logs show "connection refused" to internal service\n- The internal service health check passes\n- Connection pool shows 50/50 connections used\n\nUse elimination reasoning to identify the most likely root cause. State what you can rule out and why.',
    evaluationMethod: 'rubric-checklist',
    judgeRubric: 'Systematic elimination, identifies connection pool exhaustion as most likely, rules out code changes, time correlation, etc.',
    checklistItems: [
      'Rules out code deployment (no recent deploys)',
      'Rules out service being down (health check passes)',
      'Identifies connection pool exhaustion (50/50 = saturated)',
      'Explains why only POST /api/orders (writes use connections longer)',
      'Suggests connection pool increase or connection leak investigation',
    ],
    strategies: ['single', 'debate'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.06,
  },
  {
    id: 'rs-005',
    name: 'Ethical reasoning about AI',
    category: 'reasoning',
    difficulty: 'medium',
    prompt: 'A healthcare startup wants to use an LLM to pre-screen patient symptoms before doctor appointments. The LLM would ask questions and suggest urgency levels: routine, urgent, or emergency. What are the ethical considerations? What safeguards are needed? Should they proceed?',
    evaluationMethod: 'llm-judge',
    judgeRubric: 'Identifies key ethical concerns (misdiagnosis liability, bias in training data, patient trust, informed consent). Proposes concrete safeguards. Makes nuanced recommendation (not just yes/no).',
    strategies: ['single', 'debate'],
    maxLatencyMs: 15000,
    maxCostUsd: 0.06,
  },
];

// ─── COMPLETE SUITE ─────────────────────────────────────────────────────────

export const BENCHMARK_SUITE: BenchmarkTask[] = [
  ...codingGenerate,
  ...codingEdit,
  ...codingDebug,
  ...codingReview,
  ...analysisTechnical,
  ...analysisData,
  ...analysisText,
  ...factualQA,
  ...creative,
  ...multiStep,
  ...reasoning,
];

/**
 * Get tasks filtered by category
 */
export function getTasksByCategory(category: BenchmarkCategory): BenchmarkTask[] {
  return BENCHMARK_SUITE.filter(t => t.category === category);
}

/**
 * Get tasks filtered by difficulty
 */
export function getTasksByDifficulty(difficulty: BenchmarkDifficulty): BenchmarkTask[] {
  return BENCHMARK_SUITE.filter(t => t.difficulty === difficulty);
}

/**
 * Get a balanced sample of N tasks (proportional to category weights)
 */
export function getBalancedSample(n: number): BenchmarkTask[] {
  if (n >= BENCHMARK_SUITE.length) return [...BENCHMARK_SUITE];

  // Group by category
  const byCategory = new Map<string, BenchmarkTask[]>();
  for (const task of BENCHMARK_SUITE) {
    const existing = byCategory.get(task.category) ?? [];
    existing.push(task);
    byCategory.set(task.category, existing);
  }

  // Proportional sampling
  const sampled: BenchmarkTask[] = [];
  const categories = [...byCategory.entries()];
  const totalTasks = BENCHMARK_SUITE.length;

  for (const [, tasks] of categories) {
    const proportion = tasks.length / totalTasks;
    const count = Math.max(1, Math.round(n * proportion));
    // Shuffle and take
    const shuffled = [...tasks].sort(() => Math.random() - 0.5);
    sampled.push(...shuffled.slice(0, count));
  }

  // Trim or pad to exact n
  if (sampled.length > n) {
    return sampled.sort(() => Math.random() - 0.5).slice(0, n);
  }
  return sampled;
}

/**
 * Suite statistics
 */
export function getSuiteStats(): {
  total: number;
  byCategory: Record<string, number>;
  byDifficulty: Record<string, number>;
  byEvaluationMethod: Record<string, number>;
} {
  const byCategory: Record<string, number> = {};
  const byDifficulty: Record<string, number> = {};
  const byEvaluationMethod: Record<string, number> = {};

  for (const task of BENCHMARK_SUITE) {
    byCategory[task.category] = (byCategory[task.category] || 0) + 1;
    byDifficulty[task.difficulty] = (byDifficulty[task.difficulty] || 0) + 1;
    byEvaluationMethod[task.evaluationMethod] = (byEvaluationMethod[task.evaluationMethod] || 0) + 1;
  }

  return { total: BENCHMARK_SUITE.length, byCategory, byDifficulty, byEvaluationMethod };
}
