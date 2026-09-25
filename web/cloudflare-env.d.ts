declare namespace Cloudflare {
  interface Env {
    TRIO_CREDENTIAL_KEY?: string;
    TRIO_WORKSPACE_OPENAI_KEY?: string;
    TRIO_WORKSPACE_CLAUDE_KEY?: string;
    TRIO_WORKSPACE_GEMINI_KEY?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
  }
}
