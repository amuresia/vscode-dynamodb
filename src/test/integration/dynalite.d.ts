declare module "dynalite" {
  export default function dynalite(options?: {
    createTableMs?: number;
  }): import("node:http").Server;
}
