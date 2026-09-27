declare namespace Cloudflare {
  interface Env {
    TRIO_AUTH_PROVIDER?: string;
    TRIO_ACCESS_TEAM_DOMAIN?: string;
    TRIO_ACCESS_AUD?: string;
    TRIO_ACCESS_ALLOWED_EMAILS?: string;
    TRIO_CREDENTIAL_KEY?: string;
    TRIO_WORKSPACE_OPENAI_KEY?: string;
    TRIO_WORKSPACE_CLAUDE_KEY?: string;
    TRIO_WORKSPACE_GEMINI_KEY?: string;
    DB?: D1Database;
    ASSETS?: Fetcher;
    BUCKET?: R2Bucket;
  }
}
