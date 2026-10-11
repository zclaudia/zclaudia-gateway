#!/usr/bin/env node
// TypeScript peer for cross-language contract tests: connects to a real
// gateway with @zclaudia/gateway-client and drives the Python backend.
//
// Usage: node peer-client.mjs <client-dist/index.js> <command> --url <httpUrl> --token <credential>
//        --namespace <ns> [command args]
//
// Commands:
//   registry      --backend-id <id>                         assert and print the registry entry
//   channel-echo  --backend-id <id> [--kind echo]           open a channel, round-trip text + binary
//   topic         --backend-id <id> --topic <t> [--count 1] subscribe, print each payload, exit after N
//
// stdout protocol: informational lines, then a final `RESULT <json>` line; exit 0.
// Failures print `ERROR <message>` to stderr and exit 1.
import { pathToFileURL } from 'node:url';
import { resolve } from 'node:path';

const [, , modulePath, command, ...rest] = process.argv;
if (!modulePath || !command) {
  console.error('usage: node peer-client.mjs <client-dist> <command> [--key value ...]');
  process.exit(2);
}

const args = {};
for (let i = 0; i < rest.length; i += 1) {
  if (rest[i].startsWith('--')) {
    args[rest[i].slice(2)] = rest[i + 1];
    i += 1;
  }
}

const { GatewayClient } = await import(pathToFileURL(resolve(modulePath)).href);

const delay = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitUntil(predicate, label, timeoutMs = 8000) {
  const start = Date.now();
  while (!predicate()) {
    if (Date.now() - start > timeoutMs) throw new Error(`timeout waiting for ${label}`);
    await delay(25);
  }
}

function connect() {
  const client = new GatewayClient({
    url: args.url,
    credential: args.token,
    namespace: args.namespace,
    identity: { deviceId: `peer-${command}`, instanceId: `inst-${process.pid}` },
    reconnectMinMs: 100,
  });
  return client;
}

async function main() {
  switch (command) {
    case 'registry': {
      const client = connect();
      await client.connect();
      await waitUntil(
        () => client.registry.some((b) => b.backendId === args['backend-id']),
        'backend in registry',
      );
      const entry = client.registry.find((b) => b.backendId === args['backend-id']);
      client.close();
      return {
        backendId: entry.backendId,
        name: entry.name,
        epoch: entry.epoch,
        namespace: entry.namespace,
        gatewayProtocolVersion: entry.gatewayProtocolVersion,
      };
    }
    case 'channel-echo': {
      const client = connect();
      await client.connect();
      const channel = await client.openChannel(args['backend-id'], args.kind ?? 'echo');
      const received = [];
      channel.onMessage((message) => received.push(message));
      channel.send('hello');
      await waitUntil(() => received.length >= 1, 'text echo');
      const bytes = new Uint8Array([0, 1, 254, 255, 128]);
      channel.send(bytes);
      await waitUntil(() => received.length >= 2, 'binary echo');
      const binary = received[1].binary ? Array.from(received[1].data) : null;
      client.close();
      return { text: received[0].data, binary, binaryFlag: received[1].binary };
    }
    case 'topic': {
      const count = Number(args.count ?? 1);
      const client = connect();
      await client.connect();
      const seen = [];
      let resolveDone;
      const done = new Promise((r) => {
        resolveDone = r;
      });
      await client.subscribeTopic(args['backend-id'], args.topic, (payload) => {
        seen.push(payload);
        console.log(`message ${JSON.stringify(payload)}`);
        if (seen.length >= count) resolveDone();
      });
      console.log('subscribed');
      await Promise.race([done, delay(8000).then(() => Promise.reject(new Error('topic timeout')))]);
      client.close();
      return { count: seen.length, messages: seen };
    }
    default:
      throw new Error(`unknown command: ${command}`);
  }
}

try {
  const result = await main();
  console.log(`RESULT ${JSON.stringify(result)}`);
  process.exit(0);
} catch (error) {
  console.error(`ERROR ${error?.stack ?? error}`);
  process.exit(1);
}
