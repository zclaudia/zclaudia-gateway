/**
 * Gateway Internal State Management
 *
 * Implements §16 (Gateway State Responsibilities) of the Gateway Sync Protocol.
 * All in-memory state for peer sessions, registry, subscriptions, and stream demand.
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
  peerType: 'client-only' | 'client+backend';
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
  subscribedBackends: Set<BackendId>;
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

export interface StreamDemandState {
  /** Number of subscribers to this backend. */
  subscriberCount: number;

  /** Current demand state sent to backend. */
  active: boolean;
}

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

  // --- Subscriptions (backendId → set of subscribing peerSessionIds) ---
  readonly subscriptions = new Map<BackendId, Set<PeerSessionId>>();

  // --- Stream demand (per-backend) ---
  readonly streamDemand = new Map<BackendId, StreamDemandState>();

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

    // Clean up subscriptions
    this.removeAllSubscriptions(peerSessionId);

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

  /** Get the current registry snapshot as an array. */
  getRegistrySnapshot(): BackendPresence[] {
    return Array.from(this.registry.items.values());
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

  /** Remove a backend completely: lease, stream demand, registry. */
  removeBackend(backendId: BackendId): void {
    this.removeLease(backendId);
    this.streamDemand.delete(backendId);
    // Registry removal is done separately (caller decides when to broadcast)
  }

  // ==========================================================================
  // Subscription Management
  // ==========================================================================

  /** Add a subscription: peer subscribes to a backend. Returns true if stream demand transitioned 0→1. */
  addSubscription(backendId: BackendId, peerSessionId: PeerSessionId): boolean {
    // Track in subscriptions map
    let subs = this.subscriptions.get(backendId);
    if (!subs) {
      subs = new Set();
      this.subscriptions.set(backendId, subs);
    }
    if (subs.has(peerSessionId)) return false; // already subscribed
    subs.add(peerSessionId);

    // Track on peer
    const peer = this.peers.get(peerSessionId);
    if (peer) {
      peer.subscribedBackends.add(backendId);
    }

    // Update stream demand
    return this.incrementSubscriberCount(backendId);
  }

  /** Remove a subscription. Returns true if stream demand transitioned 1→0. */
  removeSubscription(backendId: BackendId, peerSessionId: PeerSessionId): boolean {
    const subs = this.subscriptions.get(backendId);
    if (!subs || !subs.has(peerSessionId)) return false;
    subs.delete(peerSessionId);
    if (subs.size === 0) this.subscriptions.delete(backendId);

    // Remove from peer
    const peer = this.peers.get(peerSessionId);
    if (peer) {
      peer.subscribedBackends.delete(backendId);
    }

    // Update stream demand
    return this.decrementSubscriberCount(backendId);
  }

  /** Get all peer session IDs subscribed to a backend (returns a snapshot copy). */
  getSubscribers(backendId: BackendId): Set<PeerSessionId> {
    const subs = this.subscriptions.get(backendId);
    return subs ? new Set(subs) : new Set();
  }

  /** Remove all subscriptions for a peer (used on disconnect). */
  removeAllSubscriptions(peerSessionId: PeerSessionId): BackendId[] {
    const peer = this.peers.get(peerSessionId);
    const affectedBackends: BackendId[] = [];
    if (peer) {
      for (const backendId of peer.subscribedBackends) {
        const subs = this.subscriptions.get(backendId);
        if (subs) {
          subs.delete(peerSessionId);
          if (subs.size === 0) this.subscriptions.delete(backendId);
        }
        this.decrementSubscriberCount(backendId);
        affectedBackends.push(backendId);
      }
      peer.subscribedBackends.clear();
    }
    return affectedBackends;
  }

  // ==========================================================================
  // Stream Demand Management
  // ==========================================================================

  /** Get current stream demand for a backend. */
  getStreamDemand(backendId: BackendId): boolean {
    return this.streamDemand.get(backendId)?.active ?? false;
  }

  private incrementSubscriberCount(backendId: BackendId): boolean {
    let demand = this.streamDemand.get(backendId);
    if (!demand) {
      demand = { subscriberCount: 0, active: false };
      this.streamDemand.set(backendId, demand);
    }

    demand.subscriberCount++;

    // 0→1 transition: activate
    if (demand.subscriberCount === 1 && !demand.active) {
      demand.active = true;
      return true; // Caller should send stream_demand { active: true }
    }
    return false;
  }

  private decrementSubscriberCount(backendId: BackendId): boolean {
    const demand = this.streamDemand.get(backendId);
    if (!demand) return false;

    demand.subscriberCount = Math.max(0, demand.subscriberCount - 1);

    // 1→0 transition: deactivate
    if (demand.subscriberCount === 0 && demand.active) {
      demand.active = false;
      return true; // Caller should send stream_demand { active: false }
    }
    return false;
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
    this.subscriptions.clear();
    this.streamDemand.clear();
  }
}
