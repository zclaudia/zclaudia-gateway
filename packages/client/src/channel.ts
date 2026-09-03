import { normalizeMessageData, waitForSocketOpen, type SocketFactory, type WebSocketLike } from './socket.js';

export interface ChannelMessage {
  data: string | Uint8Array;
  binary: boolean;
}

/**
 * A live data-plane channel: a dedicated WebSocket relayed verbatim by the
 * gateway (text/binary flags preserved). Closing it closes the whole
 * channel for both ends.
 */
export class GatewayChannel {
  readonly channelId: string;
  readonly kind?: string;
  private readonly socket: WebSocketLike;
  private messageHandlers: Array<(message: ChannelMessage) => void> = [];
  private closeHandlers: Array<() => void> = [];
  private closed = false;

  constructor(channelId: string, socket: WebSocketLike, kind?: string) {
    this.channelId = channelId;
    this.kind = kind;
    this.socket = socket;
    socket.addEventListener('message', (event) => {
      const data = normalizeMessageData(event.data);
      const message: ChannelMessage = typeof data === 'string'
        ? { data, binary: false }
        : { data, binary: true };
      for (const handler of this.messageHandlers) handler(message);
    });
    socket.addEventListener('close', () => {
      if (this.closed) return;
      this.closed = true;
      for (const handler of this.closeHandlers) handler();
    });
  }

  get isOpen(): boolean {
    return !this.closed && this.socket.readyState === 1;
  }

  send(data: string | Uint8Array): void {
    if (typeof data === 'string') this.socket.send(data);
    else this.socket.send(data);
  }

  onMessage(handler: (message: ChannelMessage) => void): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter((h) => h !== handler);
    };
  }

  onClose(handler: () => void): () => void {
    this.closeHandlers.push(handler);
    return () => {
      this.closeHandlers = this.closeHandlers.filter((h) => h !== handler);
    };
  }

  close(): void {
    this.socket.close(1000);
  }
}

/** Dial a channel data socket and wrap it. */
export async function dialChannel(
  wsBase: string,
  dataPath: string,
  ticket: string,
  channelId: string,
  factory: SocketFactory,
  kind?: string,
): Promise<GatewayChannel> {
  const socket = factory(`${wsBase}${dataPath}?ticket=${encodeURIComponent(ticket)}`);
  socket.binaryType = 'arraybuffer';
  await waitForSocketOpen(socket);
  return new GatewayChannel(channelId, socket, kind);
}
