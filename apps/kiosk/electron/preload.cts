import { contextBridge, ipcRenderer } from 'electron';
import type {
  KioskApi,
  KioskCartLine,
  KioskCloudGoogleSignInInput,
  KioskCloudSignInInput,
  KioskPairInput,
  ScaleReading,
  ScaleStatus,
  UpdateCheckResult,
} from '@shul-store/shared';

const api: KioskApi = {
  getState: () => ipcRenderer.invoke('kiosk:getState'),
  pair: (input: KioskPairInput) => ipcRenderer.invoke('kiosk:pair', input),
  cloudSignIn: (input: KioskCloudSignInInput) =>
    ipcRenderer.invoke('kiosk:cloudSignIn', input),
  cloudSignInWithGoogle: (input: KioskCloudGoogleSignInInput) =>
    ipcRenderer.invoke('kiosk:cloudSignInWithGoogle', input),
  getReaderStatus: () => ipcRenderer.invoke('kiosk:getReaderStatus'),
  saveReaderConfig: (input) =>
    ipcRenderer.invoke('kiosk:saveReaderConfig', input),
  pairUsaepayDevice: (input) =>
    ipcRenderer.invoke('kiosk:pairUsaepayDevice', input),
  checkReader: () => ipcRenderer.invoke('kiosk:checkReader'),
  getExplanationDismissed: (id) =>
    ipcRenderer.invoke('kiosk:getExplanationDismissed', id),
  dismissExplanation: (id) =>
    ipcRenderer.invoke('kiosk:dismissExplanation', id),
  updates: {
    check: () => ipcRenderer.invoke('updates:check'),
    getState: () => ipcRenderer.invoke('updates:getState'),
    subscribe: (listener) => {
      const handler = (
        _event: Electron.IpcRendererEvent,
        state: UpdateCheckResult,
      ) => listener(state);
      ipcRenderer.on('updates:state', handler);
      return () => ipcRenderer.removeListener('updates:state', handler);
    },
  },
  startDiscovery: () => ipcRenderer.invoke('kiosk:startDiscovery'),
  stopDiscovery: () => ipcRenderer.invoke('kiosk:stopDiscovery'),
  refreshCatalog: () => ipcRenderer.invoke('kiosk:refreshCatalog'),
  priceCart: (lines: KioskCartLine[]) =>
    ipcRenderer.invoke('kiosk:priceCart', lines),
  charge: (lines: KioskCartLine[]) => ipcRenderer.invoke('kiosk:charge', lines),
  benefitCharge: (lines: KioskCartLine[], method: 'snap_ebt' | 'wic') =>
    ipcRenderer.invoke('kiosk:benefitCharge', lines, method),
  verifyAdminPin: (pin: string) =>
    ipcRenderer.invoke('kiosk:verifyAdminPin', pin),
  exitKiosk: () => ipcRenderer.invoke('kiosk:exit'),
  restart: () => ipcRenderer.invoke('kiosk:restart'),
  subscribe: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      state: Parameters<typeof listener>[0],
    ) => listener(state);
    ipcRenderer.on('kiosk:state', handler);
    return () => ipcRenderer.removeListener('kiosk:state', handler);
  },
  scaleGetStatus: () => ipcRenderer.invoke('scale:getStatus'),
  scaleReadWeight: () => ipcRenderer.invoke('scale:readWeight'),
  scaleStart: () => ipcRenderer.invoke('scale:start'),
  scaleStop: () => ipcRenderer.invoke('scale:stop'),
  subscribeScale: (listener) => {
    const handler = (
      _event: Electron.IpcRendererEvent,
      reading: ScaleReading,
    ) => listener(reading);
    ipcRenderer.on('scale:reading', handler);
    return () => ipcRenderer.removeListener('scale:reading', handler);
  },
  subscribeScaleStatus: (listener) => {
    const handler = (_event: Electron.IpcRendererEvent, status: ScaleStatus) =>
      listener(status);
    ipcRenderer.on('scale:status', handler);
    return () => ipcRenderer.removeListener('scale:status', handler);
  },
};

contextBridge.exposeInMainWorld('kioskApi', api);
