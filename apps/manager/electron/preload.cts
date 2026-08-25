import { contextBridge, ipcRenderer } from 'electron';
import type { StoreApi } from '@shul-store/shared';

const api: StoreApi = {
  kiosk: {
    getSettings: () => ipcRenderer.invoke('kiosk:getSettings'),
    pairCode: () => ipcRenderer.invoke('kiosk:pairCode'),
    revoke: (id) => ipcRenderer.invoke('kiosk:revoke', id),
    setServer: (enabled, port) =>
      ipcRenderer.invoke('kiosk:setServer', enabled, port),
  },
  payments: {
    initiateCharge: (input) =>
      ipcRenderer.invoke('payments:initiateCharge', input),
    getChargeStatus: (chargeReference) =>
      ipcRenderer.invoke('payments:getChargeStatus', chargeReference),
    getPendingTransactions: () =>
      ipcRenderer.invoke('payments:getPendingTransactions'),
    reconcileTransactions: () =>
      ipcRenderer.invoke('payments:reconcileTransactions'),
    listNeedsAttention: () => ipcRenderer.invoke('payments:listNeedsAttention'),
    resolveNeedsAttention: (chargeReference, action, note) =>
      ipcRenderer.invoke(
        'payments:resolveNeedsAttention',
        chargeReference,
        action,
        note,
      ),
  },

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
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (input) => ipcRenderer.invoke('settings:update', input),
    listPrinters: () => ipcRenderer.invoke('settings:listPrinters'),
  },
  checkout: {
    lookupBarcode: (value) =>
      ipcRenderer.invoke('checkout:lookupBarcode', value),
    complete: (input) => ipcRenderer.invoke('checkout:complete', input),
  },
  sales: {
    list: () => ipcRenderer.invoke('sales:list'),
    get: (id) => ipcRenderer.invoke('sales:get', id),
    receipt: (id) => ipcRenderer.invoke('sales:receipt', id),
    print: (id) => ipcRenderer.invoke('sales:print', id),
  },
  labels: {
    render: (input) => ipcRenderer.invoke('labels:render', input),
    print: (input) => ipcRenderer.invoke('labels:print', input),
  },
  customers: {
    list: (includeInactive) =>
      ipcRenderer.invoke('customers:list', includeInactive),
    get: (id) => ipcRenderer.invoke('customers:get', id),
    search: (query, includeInactive) =>
      ipcRenderer.invoke('customers:search', query, includeInactive),
    create: (input) => ipcRenderer.invoke('customers:create', input),
    update: (id, input) => ipcRenderer.invoke('customers:update', id, input),
    setActive: (id, active) =>
      ipcRenderer.invoke('customers:setActive', id, active),
    setBlocked: (id, blocked) =>
      ipcRenderer.invoke('customers:setBlocked', id, blocked),
    generateAccountNumber: () =>
      ipcRenderer.invoke('customers:generateAccountNumber'),
    generateBarcode: () => ipcRenderer.invoke('customers:generateBarcode'),
    lookupBarcode: (barcodeOrAccount) =>
      ipcRenderer.invoke('customers:lookupBarcode', barcodeOrAccount),
    getLedger: (customerId) =>
      ipcRenderer.invoke('customers:getLedger', customerId),
    getStatement: (customerId, options) =>
      ipcRenderer.invoke('customers:getStatement', customerId, options),
    printStatement: (statementData) =>
      ipcRenderer.invoke('customers:printStatement', statementData),
  },
  accountPayments: {
    record: (input) => ipcRenderer.invoke('accountPayments:record', input),
    list: (customerId) =>
      ipcRenderer.invoke('accountPayments:list', customerId),
    get: (id) => ipcRenderer.invoke('accountPayments:get', id),
    receipt: (id) => ipcRenderer.invoke('accountPayments:receipt', id),
    print: (id) => ipcRenderer.invoke('accountPayments:print', id),
  },
  images: {
    choose: () => ipcRenderer.invoke('images:choose'),
    discard: (id) => ipcRenderer.invoke('images:discard', id),
  },
  sync: {
    getConfig: () => ipcRenderer.invoke('sync:getConfig'),
    getStatus: () => ipcRenderer.invoke('sync:getStatus'),
    saveConfig: (input) => ipcRenderer.invoke('sync:saveConfig', input),
    setEnabled: (enabled) => ipcRenderer.invoke('sync:setEnabled', enabled),
    testConnection: (input) => ipcRenderer.invoke('sync:testConnection', input),
    syncNow: () => ipcRenderer.invoke('sync:syncNow'),
    restore: (input) => ipcRenderer.invoke('sync:restore', input),
    isRestoreAvailable: () => ipcRenderer.invoke('sync:isRestoreAvailable'),
  },
  backups: {
    list: () => ipcRenderer.invoke('backups:list'),
    create: () => ipcRenderer.invoke('backups:create'),
    getLastRestoreResult: () =>
      ipcRenderer.invoke('backups:getLastRestoreResult'),
    revealFolder: () => ipcRenderer.invoke('backups:revealFolder'),
    restore: (filename, confirmation) =>
      ipcRenderer.invoke('backups:restore', filename, confirmation),
  },
};

contextBridge.exposeInMainWorld('storeApi', api);
