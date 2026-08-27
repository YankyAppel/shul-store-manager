import { contextBridge, ipcRenderer } from 'electron';
import type {
  KioskApi,
  KioskCartLine,
  KioskCloudSignInInput,
  KioskPairInput,
} from '@shul-store/shared';

const api: KioskApi = {
  getState: () => ipcRenderer.invoke('kiosk:getState'),
  pair: (input: KioskPairInput) => ipcRenderer.invoke('kiosk:pair', input),
  cloudSignIn: (input: KioskCloudSignInInput) =>
    ipcRenderer.invoke('kiosk:cloudSignIn', input),
  cloudSignUp: (input: KioskCloudSignInInput) =>
    ipcRenderer.invoke('kiosk:cloudSignUp', input),
  getReaderStatus: () => ipcRenderer.invoke('kiosk:getReaderStatus'),
  saveReaderConfig: (input) =>
    ipcRenderer.invoke('kiosk:saveReaderConfig', input),
  checkReader: () => ipcRenderer.invoke('kiosk:checkReader'),
  getExplanationDismissed: (id) =>
    ipcRenderer.invoke('kiosk:getExplanationDismissed', id),
  dismissExplanation: (id) =>
    ipcRenderer.invoke('kiosk:dismissExplanation', id),
  startDiscovery: () => ipcRenderer.invoke('kiosk:startDiscovery'),
  stopDiscovery: () => ipcRenderer.invoke('kiosk:stopDiscovery'),
  refreshCatalog: () => ipcRenderer.invoke('kiosk:refreshCatalog'),
  priceCart: (lines: KioskCartLine[]) =>
    ipcRenderer.invoke('kiosk:priceCart', lines),
  charge: (lines: KioskCartLine[]) => ipcRenderer.invoke('kiosk:charge', lines),
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
};

contextBridge.exposeInMainWorld('kioskApi', api);
