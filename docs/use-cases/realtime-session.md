<!--
Copyright (C) 2026 Ailin One, Inc.

This file is part of Collective Intelligence Engine (ci).
Licensed under the GNU Affero General Public License v3.0 or later.
See LICENSE in the repository root, or <https://www.gnu.org/licenses/>.

SPDX-License-Identifier: AGPL-3.0-or-later
Source: https://github.com/ailinone/collective-intelligence
-->

# Use Case: Realtime Session

## Scenario

Open websocket-compatible realtime session with model selection hints.

```bash
curl "https://api.ailin.one/v1/realtime?model=ailin-auto" \
  -H "Authorization: Bearer $AILIN_TOKEN"
```

```ts
const url = "wss://api.ailin.one/v1/realtime?model=ailin-auto";
const socket = new WebSocket(url, {
  headers: { Authorization: `Bearer ${process.env.AILIN_TOKEN}` },
});
socket.onmessage = (event) => console.log(event.data);
```

```python
import os
import websocket

headers = [f"Authorization: Bearer {os.environ.get('AILIN_TOKEN', '')}"]
ws = websocket.WebSocket()
ws.connect("wss://api.ailin.one/v1/realtime?model=ailin-auto", header=headers)
print(ws.recv())
ws.close()
```
