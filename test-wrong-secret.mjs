import WebSocket from 'ws';

const GATEWAY_URL = 'ws://localhost:3200/ws';
const WRONG_SECRET = 'wrong-secret-123';

console.log('🧪 Testing Gateway with wrong secret...\n');

const client = new WebSocket(GATEWAY_URL);

client.on('open', () => {
  console.log('✅ WebSocket connected');

  const authMsg = {
    type: 'gateway_auth',
    gatewaySecret: WRONG_SECRET
  };
  console.log('📤 Sending auth with wrong secret');
  client.send(JSON.stringify(authMsg));
});

client.on('message', (data) => {
  const message = JSON.parse(data.toString());
  console.log('📨 Received:', message);

  if (message.type === 'gateway_auth_result') {
    if (!message.success) {
      console.log('✅ Authentication correctly rejected:', message.error);
      console.log('\n🎉 Security test passed!');
    } else {
      console.log('❌ Security issue: wrong secret was accepted!');
    }
  }
});

client.on('close', () => {
  console.log('🔌 Connection closed (expected)');
  process.exit(0);
});

client.on('error', (error) => {
  console.error('Error:', error.message);
});

setTimeout(() => {
  console.log('⏱️  Timeout');
  process.exit(1);
}, 3000);
