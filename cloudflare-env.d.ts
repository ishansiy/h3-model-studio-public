declare namespace Cloudflare {
  interface Env {
    SITE_ACCESS_VERIFIER?: string;
    SITE_SESSION_SECRET?: string;
    BOOTSTRAP_OWNER_ID?: string;
    DB?: D1Database;
    BUCKET?: R2Bucket;
    KAGGLE_CIPHER_KEY?: string;
    BOOTSTRAP_KAGGLE_TOKEN?: string;
    BOOTSTRAP_KAGGLE_USERNAME?: string;
    BOOTSTRAP_JOB_JSON?: string;
  }
}
