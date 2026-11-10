declare module "dynalite" {
  import type { Server } from "node:http";

  interface DynaliteOptions {
    path?: string;
    createTableMs?: number;
    deleteTableMs?: number;
    updateTableMs?: number;
  }

  export default function dynalite(options?: DynaliteOptions): Server;
}
