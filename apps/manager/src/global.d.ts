import type { StoreApi } from '@shul-store/shared';

declare global {
  interface Window {
    storeApi: StoreApi;
  }
}
export {};
