declare namespace Cloudflare {
  interface Env {
    TRIO_CREDENTIAL_KEY?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
