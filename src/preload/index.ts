import { contextBridge, ipcRenderer } from 'electron';
import type { CerebroEvent } from '../shared/types';

const api = {
  invoke: (channel: string, ...args: unknown[]) => ipcRenderer.invoke(channel, ...args),
  onEvent: (cb: (ev: CerebroEvent) => void) => {
    const listener = (_e: unknown, ev: CerebroEvent) => cb(ev);
    ipcRenderer.on('cerebro:event', listener);
    return () => ipcRenderer.removeListener('cerebro:event', listener);
  }
};

contextBridge.exposeInMainWorld('cerebro', api);
