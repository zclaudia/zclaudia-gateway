import WebSocket from 'ws';

const GATEWAY_URL = 'ws://localhost:3200/ws';
const GATEWAY_SECRET = 'test-secret-zclaudia-2026';

console.log('🧪 Testing Gateway WebSocket...\n');

const client = new WebSocket(GATEWAY_URL);

client.on('open', () => {
  console.log('✅ WebSocket connected');

  // Send auth message
  const authMsg = {
    type: 'gateway_auth',
    gatewaySecret: GATEWAY_SECRET
  };
  console.log('📤 Sending:', authMsg);
  client.send(JSON.stringify(authMsg));
});

client.on('message', (data) => {
  const message = JSON.parse(data.toString());
  console.log('📨 Received:', message);

  if (message.type === 'gateway_auth_result') {
    if (message.success) {
      console.log('✅ Client authenticated successfully\n');
      
      // List backends
      console.log('📤 Requesting backends list...');
      client.send(JSON.stringify({ type: 'list_backends' }));
    } else {
      console.log('❌ Authentication failed:', message.error);
      client.close();
    }
  }

  if (message.type === 'backends_list') {
    console.log('✅ Backends list received');
    console.log(`   Total backends: ${message.backends.length}`);
    console.log('   Backends:', message.backends);
    console.log('\n🎉 Test completed successfully!');
    client.close();
  }
});

client.on('error', (error) => {
  console.error('❌ Error:', error.message);
});

client.on('close', () => {
  console.log('🔌 Connection closed');
  process.exit(0);
});

// Timeout after 5 seconds
setTimeout(() => {
  console.log('⏱️  Timeout');
  client.close();
}, 5000);
