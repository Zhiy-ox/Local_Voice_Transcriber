declare global {
  interface Window {
    require?: NodeJS.Require;
  }
}

export interface OpenDialogFilter {
  name: string;
  extensions: string[];
}

export interface OpenDialogResult {
  canceled: boolean;
  filePaths: string[];
}

export interface DialogModule {
  dialog: {
    showOpenDialog(options: {
      properties: string[];
      filters: OpenDialogFilter[];
    }): Promise<OpenDialogResult>;
  };
}

interface ElectronModule {
  remote?: DialogModule;
}

export function requireApi<T>(moduleName: string): T {
  const req = window.require;
  if (!req) {
    throw new Error('Desktop APIs are unavailable in this context.');
  }
  return req(moduleName) as T;
}

export function requireDialogModule(): DialogModule {
  const electron = requireApi<ElectronModule>('electron');
  return electron.remote ?? requireApi<DialogModule>('@electron/remote');
}

export function asError(error: unknown): Error {
  if (error instanceof Error) {
    return error;
  }
  return new Error(String(error));
}

export const fs = requireApi<typeof import('fs')>('fs');
export const os = requireApi<typeof import('os')>('os');
export const path = requireApi<typeof import('path')>('path');
export const { spawn, execSync } = requireApi<typeof import('child_process')>('child_process');
