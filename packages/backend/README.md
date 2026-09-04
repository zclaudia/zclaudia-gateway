# @zclaudia/gateway-backend

Backend SDK for the zclaudia gateway (Protocol v4): registration and
heartbeats, channel offers (dial-is-accept), topic publishing with retain,
and `serveHttp` for answering the gateway's streaming HTTP proxy over a
channel. Reconnects with exponential backoff; supports enrollment-credential
exchange (`zgb_` → short-lived access credential).

```ts
import { GatewayBackend } from '@zclaudia/gateway-backend';

const backend = new GatewayBackend({
  url: 'https://gateway.example.com',
  credential: 'zgb_...',
  namespace: 'myapp',
  identity: { deviceId: 'server-1', instanceId: 'inst-1' },
});
await backend.connect();
backend.publishTopic('resources', snapshot, { retain: true });
```

Gateway server and protocol spec: [zclaudia/zclaudia-gateway](https://github.com/zclaudia/zclaudia-gateway).
