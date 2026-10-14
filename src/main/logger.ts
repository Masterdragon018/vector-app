import type { LogEntry } from '../shared/types';

type Level = LogEntry['level'];
type Listener = (entry: LogEntry) => void;

const MAX = 500;

export class Logger {
  private buf: LogEntry[] = [];
  private listeners = new Set<Listener>();
  private nextId = 1;

  log(level: Level, msg: string): void {
    const entry: LogEntry = { id: this.nextId++, ts: Date.now(), level, msg };
    this.buf.push(entry);
    if (this.buf.length > MAX) this.buf.splice(0, this.buf.length - MAX);
    const line = `[${level}] ${msg}`;
    if (level === 'ERR') console.error(line);
    else if (level === 'WARN') console.warn(line);
    else console.log(line);
    for (const l of this.listeners) l(entry);
  }

  info(msg: string) { this.log('INFO', msg); }
  ok(msg: string) { this.log('OK', msg); }
  warn(msg: string) { this.log('WARN', msg); }
  error(msg: string) { this.log('ERR', msg); }
  debug(msg: string) { this.log('DBG', msg); }

  tail(limit = 200): LogEntry[] {
    return this.buf.slice(-limit);
  }

  clear(): void {
    this.buf = [];
  }

  subscribe(l: Listener): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
}
