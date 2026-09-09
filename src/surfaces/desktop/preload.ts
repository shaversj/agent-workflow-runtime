import { contextBridge, ipcRenderer } from "electron";
import { Value } from "typebox/value";

import { DesktopRequestSchema, validateDesktopResponse } from "./contracts.js";
import type { DesktopAPI } from "./contracts.js";

const api: DesktopAPI = {
  async read(request) {
    if (!Value.Check(DesktopRequestSchema, request))
      return { ok: false, error: "Invalid inspection request." };
    const response: unknown = await ipcRenderer.invoke("history:read", request);
    return validateDesktopResponse(response);
  }
};
contextBridge.exposeInMainWorld("historyDesktop", api);
