/**
 * Gateway Internal State Management
 *
 * Implements §16 (Gateway State Responsibilities) of the Gateway Sync Protocol.
 * All in-memory state for peer sessions, registry, leases, and topics.
 */

import type {
  BackendPresence,
  BackendId,
  Epoch,
  PeerSessionId,
} from '@zclaudia/protocol/gateway';
import type { WebSocket } from 'ws';

// ============================================================================
// Peer Session State
// ============================================================================

export interface PeerSession {
  peerSessionId: PeerSessionId;
  ws: WebSocket;
  /** Negotiated protocol version for this session (v3 and v4 coexist). */
  protocolVersion: 3 | 4;
  peerType: 'client-only' | 'client+backend';
  /**
   * Isolation domain. Currently taken from peer_hello (self-declared);
   * will be derived from server-side credentials once the Phase 1
   * credential split lands. All registry/subscription visibility is
   * scoped to this value.
   */
  namespace: string;
  /** Set when the peer authenticated with an issued credential (not the legacy shared secret). */
  credentialId?: string;
  deviceId: string;
  instanceId: string;
  channel: string;
  name: string;
  recoveryToken: string;
  isAlive: boolean;

  /** If peerType === 'client+backend', the registered backend info. */
  backendId?: BackendId;
  epoch?: Epoch;

  /** Backend IDs this peer is subscribed to (as client). */
}

// ============================================================================
// Registry State
// ============================================================================

export interface RegistryState {
  /** Online backends. */
  items: Map<BackendId, BackendPresence>;
}

// ============================================================================
// Backend Lease State
// ============================================================================

export interface BackendLease {
  backendId: BackendId;
  epoch: Epoch;
  peerSessionId: PeerSessionId;
  leaseTtlMs: number;
  lastHeartbeatAt: number;
  leaseTimer: ReturnType<typeof setTimeout> | null;
}

// ============================================================================
// Stream Demand State (per-backend)
// ============================================================================


// ============================================================================
// Gateway V2 State Manager
// ============================================================================

export interface GatewayStateConfig {
  /** Default lease TTL in ms. Default: 30000. */
  defaultLeaseTtlMs?: number;
}

export class GatewayState {
  // --- Peer sessions ---
  readonly peers = new Map<PeerSessionId, PeerSession>();
  readonly wsToPeer = new Map<WebSocket, PeerSession>();

  // --- Registry ---
  readonly registry: RegistryState;

  // --- Backend leases ---
  readonly leases = new Map<BackendId, BackendLease>();

  // --- Config ---
  readonly config: Required<GatewayStateConfig>;

  constructor(config: GatewayStateConfig = {}) {
    this.config = {
      defaultLeaseTtlMs: config.defaultLeaseTtlMs ?? 30_000,
    };

    this.registry = {
      items: new Map(),
    };
  }

  // ==========================================================================
  // Peer Session Management
  // ==========================================================================

  addPeer(peer: PeerSession): void {
    this.peers.set(peer.peerSessionId, peer);
    this.wsToPeer.set(peer.ws, peer);
  }

  removePeer(peerSessionId: PeerSessionId): PeerSession | undefined {
    const peer = this.peers.get(peerSessionId);
    if (!peer) return undefined;

    this.wsToPeer.delete(peer.ws);
    this.peers.delete(peerSessionId);
    return peer;
  }

  getPeerByWs(ws: WebSocket): PeerSession | undefined {
    return this.wsToPeer.get(ws);
  }

  // ==========================================================================
  // Registry Management
  // ==========================================================================

  /** Register or update a backend in the registry. */
  registryUpsert(item: BackendPresence): void {
    this.registry.items.set(item.backendId, item);
  }

  /** Remove a backend from the registry. */
  registryRemove(backendId: BackendId): void {
    this.registry.items.delete(backendId);
  }

  /**
   * Get the current registry snapshot as an array, scoped to a namespace.
   * Namespaces are isolation domains: a peer must never see backends
   * outside its own namespace.
   */
  getRegistrySnapshot(namespace: string): BackendPresence[] {
    return Array.from(this.registry.items.values()).filter(
      (item) => item.namespace === namespace,
    );
  }

  // ==========================================================================
  // Backend Lease Management
  // ==========================================================================

  addLease(lease: BackendLease): void {
    this.leases.set(lease.backendId, lease);
  }

  removeLease(backendId: BackendId): void {
    const lease = this.leases.get(backendId);
    if (lease?.leaseTimer) {
      clearTimeout(lease.leaseTimer);
    }
    this.leases.delete(backendId);
  }

  /** Remove a backend completely: lease (registry removal is done
   *  separately — the caller decides when to broadcast). */
  removeBackend(backendId: BackendId): void {
    this.removeLease(backendId);
  }

  // ==========================================================================
  // Cleanup
  // ==========================================================================

  /** Clear all timers. Call on shutdown. */
  destroy(): void {
    for (const lease of this.leases.values()) {
      if (lease.leaseTimer) {
        clearTimeout(lease.leaseTimer);
      }
    }
    this.leases.clear();
    this.peers.clear();
    this.wsToPeer.clear();
    this.registry.items.clear();
  }
}
