export {};
declare global {
  namespace Cloudflare {
    interface Env {
      WS_TICKET_SECRET: string;
      REALTIME_INTERNAL_SECRET: string;
    }
  }
}
