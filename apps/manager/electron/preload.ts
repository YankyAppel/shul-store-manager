import { contextBridge, ipcRenderer } from 'electron';
import type { StoreApi } from '@shul-store/shared';

const api: StoreApi = {
  categories: {
    list: (includeInactive) =>
      ipcRenderer.invoke('categories:list', includeInactive),
    create: (input) => ipcRenderer.invoke('categories:create', input),
    update: (id, input) => ipcRenderer.invoke('categories:update', id, input),
    setActive: (id, active) =>
      ipcRenderer.invoke('categories:setActive', id, active),
  },
  products: {
    list: (includeInactive) =>
      ipcRenderer.invoke('products:list', includeInactive),
    create: (input) => ipcRenderer.invoke('products:create', input),
    update: (id, input) => ipcRenderer.invoke('products:update', id, input),
    setActive: (id, active) =>
      ipcRenderer.invoke('products:setActive', id, active),
    generateInternalBarcode: () =>
      ipcRenderer.invoke('products:generateBarcode'),
  },
  inventory: {
    addMovement: (input) => ipcRenderer.invoke('inventory:addMovement', input),
    list: (productId) => ipcRenderer.invoke('inventory:list', productId),
  },
  images: { choose: () => ipcRenderer.invoke('images:choose') },
};

contextBridge.exposeInMainWorld('storeApi', api);
