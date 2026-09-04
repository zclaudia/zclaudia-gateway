# @zclaudia/gateway-client

Client SDK for the zclaudia gateway (Protocol v4): control connection,
per-channel data connections (dedicated WebSocket each), topic subscribe with
retained payloads, exponential-backoff reconnect with subscription recovery.

Built against the WHATWG WebSocket API — works in Node ≥22 and WebViews alike;
a custom `socketFactory` can be injected for anything else.

```ts
import { GatewayClient } from '@zclaudia/gateway-client';

const client = new GatewayClient({
  url: 'https://gateway.example.com',
  credential: 'zgd_...',
  namespace: 'myapp',
  identity: { deviceId: 'dev-1', instanceId: 'inst-1' },
});
await client.connect();
await client.subscribeTopic(backendId, 'resources', (payload) => { /* ... */ });
const channel = await client.openChannel(backendId, 'myapp');
```

Gateway server and protocol spec: [zclaudia/zclaudia-gateway](https://github.com/zclaudia/zclaudia-gateway).
