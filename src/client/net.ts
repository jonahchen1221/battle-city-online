// 客户端 WebSocket 封装：仅负责连接、收发 JSON，按 src/net/protocol.ts 的固定契约通信。
// 不含任何 UI / 游戏逻辑；消息处理交由回调（App 层挂载）。

import { ClientMessage, ServerMessage } from '../net/protocol';

// 默认服务器地址（可由构造参数覆盖，便于联调）。
// - 开发（vite 5173 + 独立游戏服 8080）：连同主机的 8080 端口。
// - 生产（单进程同端口托管 dist + WS）：走同源，协议随页面自动选 ws/wss。
export function defaultServerUrl(): string {
  if (import.meta.env.DEV) {
    const host = typeof location !== 'undefined' && location.hostname ? location.hostname : 'localhost';
    return `ws://${host}:8080`;
  }
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  return `${proto}://${location.host}`;
}

export class NetClient {
  private ws: WebSocket | null = null;
  readonly url: string;

  // 事件回调（App 挂载）：均可选，未挂载则静默丢弃。
  onOpen: (() => void) | null = null;
  onMessage: ((msg: ServerMessage) => void) | null = null;
  onClose: (() => void) | null = null;
  onError: (() => void) | null = null;

  constructor(url: string = defaultServerUrl()) {
    this.url = url;
  }

  // 建立连接。重复调用会先关闭旧连接；旧 socket 的迟到事件被忽略（this.ws 已换新）。
  connect(): void {
    this.close();
    const ws = new WebSocket(this.url);
    this.ws = ws;
    ws.addEventListener('open', () => {
      if (this.ws === ws) this.onOpen?.();
    });
    ws.addEventListener('message', (e) => {
      if (this.ws !== ws) return;
      let msg: ServerMessage;
      try {
        msg = JSON.parse(typeof e.data === 'string' ? e.data : '') as ServerMessage;
      } catch {
        return; // 非法 JSON 一律忽略
      }
      this.onMessage?.(msg);
    });
    ws.addEventListener('close', () => {
      if (this.ws === ws) this.onClose?.();
    });
    ws.addEventListener('error', () => {
      if (this.ws === ws) this.onError?.();
    });
  }

  // 发送一条客户端消息（未连接或未就绪时静默丢弃）。
  send(msg: ClientMessage): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(msg));
    }
  }

  get connected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN;
  }

  // 主动关闭连接并解除引用。因先置空 this.ws，close 事件回调（见 connect）会被判定为旧 socket 而跳过，
  // 故主动断开不会触发 onClose（不会误报“连接丢失”）。
  close(): void {
    if (this.ws) {
      const ws = this.ws;
      this.ws = null;
      try {
        ws.close();
      } catch {
        // 忽略关闭异常
      }
    }
  }
}
