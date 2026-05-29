#!/bin/bash

# Test script for Gateway
# This script starts the gateway and tests basic functionality

echo "🚀 Starting Gateway test..."

# Set environment variables
export GATEWAY_SECRET="test-secret-123"
export GATEWAY_PORT=3200

# Start gateway in background
echo "📡 Starting Gateway on port $GATEWAY_PORT..."
cd "$(dirname "$0")"
pnpm dev &
GATEWAY_PID=$!

# Wait for gateway to start
sleep 2

# Check health endpoint
echo "🔍 Checking health endpoint..."
curl -s http://localhost:$GATEWAY_PORT/health | jq .

# Cleanup
echo "🛑 Stopping Gateway..."
kill $GATEWAY_PID 2>/dev/null

echo "✅ Gateway test completed"
